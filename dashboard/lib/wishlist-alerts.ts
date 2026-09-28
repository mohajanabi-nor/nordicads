/**
 * Price-drop and back-in-stock emails for the storefront wishlist.
 *
 * Detection runs when Shopify says a product changed (webhook, seconds after the
 * edit) and again every hour for every saved product, so a missed webhook costs an
 * hour, not an alert. Either way it ends in checkProducts, which compares each saved
 * item with Shopify now:
 *
 *   price drop     the price is at least 5 % under the item's baseline — the price it
 *                  was saved at, or the last price we emailed about. The baseline only
 *                  moves down, so a drop is announced once, and a price that goes up
 *                  and back down again isn't news.
 *   back in stock  sold out last time we looked, buyable now. Announced at most once a
 *                  week per item, counted from the last back-in-stock EMAIL (not the last
 *                  restock), so stock that flickers 0 → 1 → 0 doesn't become three emails
 *                  but a product that keeps selling out is still announced every week.
 *
 * Each detection is claimed with a conditional UPDATE (… WHERE baseline_price = <old>),
 * so a webhook and the hourly run looking at the same change can't both announce it.
 * What's found becomes a row in wishlist_events; deliver() emails them straight away,
 * after checking once more that each one is still true. Changes that land within half
 * an hour of a customer's last alert wait for the hourly run and go out together.
 *
 * Only customers who ticked the opt-in on the wishlist page are ever emailed.
 *
 * Server-only.
 */
import crypto from "node:crypto";
import { eq, inList, is, sbInsert, sbSelect, sbUpdate } from "./supabase";
import { productsNow, type ProductNow } from "./shopify-admin";
import { esc, renderCampaign } from "./email-template";
import { isAllowedRecipient, maskEmail, sendOne } from "./resend";
import { logInfo, logWarn } from "./eventlog";

/** A drop smaller than this isn't worth an email. */
const MIN_DROP = 0.05;
/** A drop bigger than this is more likely a typo in Shopify than a sale: held for a human. */
const SUSPICIOUS_DROP = 0.7;
const RESTOCK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** After an alert email, new changes wait this long and go out together in the hourly run. */
const QUIET_PERIOD_MS = 30 * 60 * 1000;

const STORE_URL = (process.env.STOREFRONT_URL || "https://www.nordicengros.com").replace(/\/+$/, "");
const DASHBOARD_URL = (process.env.DASHBOARD_PUBLIC_URL || "https://ads.nordicengros.no").replace(/\/+$/, "");

interface ItemRow {
  customer_id: string;
  handle: string;
  product_id: string | null;
  variant_id: string | null;
  baseline_price: number | null;
  last_price: number | null;
  last_available: boolean | null;
  last_back_in_stock_at: string | null;
}

interface CustomerRow {
  customer_id: string;
  email: string | null;
  alerts_opt_in: boolean;
  token: string;
  last_alert_at: string | null;
}

interface EventRow {
  id: number;
  customer_id: string;
  handle: string;
  product_id: string | null;
  kind: "price_drop" | "back_in_stock";
  old_price: number | null;
  new_price: number | null;
}

const ITEM_COLUMNS =
  "customer_id,handle,product_id,variant_id,baseline_price,last_price,last_available,last_back_in_stock_at";
const CUSTOMER_COLUMNS = "customer_id,email,alerts_opt_in,token,last_alert_at";

/** The saved variant if it still exists, else the first one that can be bought. */
function variantFor(p: ProductNow, variantId: string | null) {
  const saved = variantId ? p.variants.get(variantId) : undefined;
  if (saved) return { id: variantId!, ...saved };
  const id = p.order.find((v) => p.variants.get(v)!.available) ?? p.order[0];
  return id ? { id, ...p.variants.get(id)! } : null;
}

const unique = <T>(xs: T[]) => Array.from(new Set(xs));

// ---------------------------------------------------------------- detection ------

/**
 * Compare the saved items for these products with Shopify now, record what changed,
 * and email instant customers. Safe to run twice on the same change.
 */
export async function checkProducts(
  productIds: string[],
): Promise<{ checked: number; found: number; sent: number }> {
  const ids = unique(productIds.filter(Boolean));
  if (!ids.length) return { checked: 0, found: 0, sent: 0 };

  const items: ItemRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    items.push(
      ...(await sbSelect<ItemRow>("wishlist_items", { product_id: inList(ids.slice(i, i + 100)), select: ITEM_COLUMNS })),
    );
  }
  if (!items.length) return { checked: 0, found: 0, sent: 0 };

  const now = await productsNow(unique(items.map((i) => i.product_id!)));
  const customers = new Map(
    (
      await sbSelect<CustomerRow>("wishlist_customers", {
        customer_id: inList(unique(items.map((i) => i.customer_id))),
        select: CUSTOMER_COLUMNS,
      })
    ).map((c) => [c.customer_id, c]),
  );

  const nowIso = new Date().toISOString();
  const touched = new Set<string>();
  let found = 0;

  for (const item of items) {
    const p = now.get(item.product_id!);
    const v = p ? variantFor(p, item.variant_id) : null;
    const available = !!(p && p.active && v && v.available);
    const price = v && v.price > 0 ? v.price : null;
    const c = customers.get(item.customer_id);
    const optedIn = !!(c && c.alerts_opt_in && c.email);
    const key = { customer_id: eq(item.customer_id), handle: eq(item.handle) };

    // ---- price drop
    if (price !== null && item.baseline_price && price <= Math.floor(item.baseline_price * (1 - MIN_DROP))) {
      const claimed = await sbUpdate<ItemRow>(
        "wishlist_items",
        { ...key, baseline_price: eq(item.baseline_price) },
        { baseline_price: price },
      );
      if (claimed.length && optedIn) {
        const suspicious = price < item.baseline_price * (1 - SUSPICIOUS_DROP);
        await sbInsert("wishlist_events", {
          customer_id: item.customer_id,
          handle: item.handle,
          product_id: item.product_id,
          kind: "price_drop",
          old_price: item.baseline_price,
          new_price: price,
          status: suspicious ? "held" : "pending",
          note: suspicious ? "Prisen falt mer enn 70 % — holdt tilbake til noen har sjekket den." : null,
        });
        if (suspicious) {
          await logWarn(
            "wishlist",
            "wishlist.dropHeld",
            `Prisfall på ${p?.title ?? item.handle} holdt tilbake: ${kr(item.baseline_price)} → ${kr(price)}. Sjekk prisen i Shopify.`,
            { handle: item.handle, oldPrice: item.baseline_price, newPrice: price },
          );
        } else {
          touched.add(item.customer_id);
          found++;
        }
      }
    }

    // ---- stock
    if (available && item.last_available === false) {
      const claimed = await sbUpdate<ItemRow>(
        "wishlist_items",
        { ...key, last_available: is(false) },
        { last_available: true },
      );
      // last_back_in_stock_at is the last time this customer was TOLD, so the week is
      // counted from the email. A restock inside the week doesn't restart it.
      const recentlyAnnounced =
        !!item.last_back_in_stock_at && Date.now() - Date.parse(item.last_back_in_stock_at) < RESTOCK_COOLDOWN_MS;
      if (claimed.length && optedIn && !recentlyAnnounced) {
        await sbUpdate("wishlist_items", key, { last_back_in_stock_at: nowIso }, { returning: false });
        await sbInsert("wishlist_events", {
          customer_id: item.customer_id,
          handle: item.handle,
          product_id: item.product_id,
          kind: "back_in_stock",
          new_price: price,
        });
        touched.add(item.customer_id);
        found++;
      }
    } else if (!available && item.last_available !== false) {
      await sbUpdate("wishlist_items", key, { last_available: false }, { returning: false });
    } else if (available && item.last_available === null) {
      await sbUpdate("wishlist_items", key, { last_available: true }, { returning: false });
    }

    if (price !== item.last_price) {
      await sbUpdate("wishlist_items", key, { last_price: price, checked_at: nowIso }, { returning: false });
    }
  }

  const sent = touched.size ? (await deliver(Array.from(touched))).sent : 0;
  return { checked: items.length, found, sent };
}

/** Every saved product, checked. The hourly safety net behind the webhooks. */
export async function checkAll(): Promise<{ checked: number; found: number; sent: number }> {
  const rows = await sbSelect<{ product_id: string | null }>("wishlist_items", { select: "product_id" });
  return checkProducts(unique(rows.map((r) => r.product_id!).filter(Boolean)));
}

// ------------------------------------------------------------------ sending ------

/** Send what's pending, one email per opted-in customer, respecting the quiet period. */
export async function deliver(customerIds?: string[]): Promise<{ sent: number; skipped: number }> {
  const filter: Record<string, string> = { alerts_opt_in: is(true), select: CUSTOMER_COLUMNS };
  if (customerIds?.length) filter.customer_id = inList(customerIds);
  const customers = await sbSelect<CustomerRow>("wishlist_customers", filter);

  let sent = 0;
  let skipped = 0;
  for (const c of customers) {
    if (c.last_alert_at && Date.now() - Date.parse(c.last_alert_at) < QUIET_PERIOD_MS) {
      continue; // the hourly run sends these together
    }
    const result = await deliverTo(c);
    sent += result.sent;
    skipped += result.skipped;
  }
  return { sent, skipped };
}

async function deliverTo(c: CustomerRow): Promise<{ sent: number; skipped: number }> {
  const pending = await sbSelect<EventRow>("wishlist_events", {
    customer_id: eq(c.customer_id),
    status: eq("pending"),
    order: "detected_at.asc",
  });
  if (!pending.length) return { sent: 0, skipped: 0 };

  // Claim them first, so an overlapping run (webhook + hourly) finds nothing to send.
  const claimed = await sbUpdate<EventRow>(
    "wishlist_events",
    { id: inList(pending.map((e) => e.id)), status: eq("pending") },
    { status: "sent", sent_at: new Date().toISOString() },
  );
  if (!claimed.length) return { sent: 0, skipped: 0 };

  const release = (ids: number[], status: "pending" | "skipped", note: string | null) =>
    ids.length
      ? sbUpdate("wishlist_events", { id: inList(ids) }, { status, sent_at: null, note }, { returning: false })
      : Promise.resolve([]);

  // Still true? (A change that waited out the quiet period may have been undone since.)
  const items = await sbSelect<ItemRow>("wishlist_items", {
    customer_id: eq(c.customer_id),
    handle: inList(unique(claimed.map((e) => e.handle))),
    select: ITEM_COLUMNS,
  });
  const itemByHandle = new Map(items.map((i) => [i.handle, i]));
  const now = await productsNow(unique(claimed.map((e) => e.product_id!).filter(Boolean)));

  // One line per product: the newest event of each kind wins.
  const latest = new Map<string, EventRow>();
  for (const e of claimed) latest.set(`${e.handle}:${e.kind}`, e);

  const lines: AlertLine[] = [];
  const stale: number[] = [];
  for (const e of claimed) {
    const item = itemByHandle.get(e.handle);
    const p = e.product_id ? now.get(e.product_id) : undefined;
    const v = p && item ? variantFor(p, item.variant_id) : null;
    const available = !!(p && p.active && v && v.available);
    const stillTrue =
      latest.get(`${e.handle}:${e.kind}`) === e &&
      !!item &&
      !!p &&
      !!v &&
      (e.kind === "price_drop" ? p.active && v.price > 0 && v.price <= (e.new_price ?? 0) : available);
    if (!stillTrue) {
      stale.push(e.id);
      continue;
    }
    lines.push({
      kind: e.kind,
      title: p!.title + (v!.title && v!.title !== "Default Title" ? ` – ${v!.title}` : ""),
      url: `${STORE_URL}/products/${p!.handle}`,
      imageUrl: p!.imageUrl,
      oldPrice: e.kind === "price_drop" ? e.old_price : null,
      price: v!.price,
      available,
    });
  }
  await release(stale, "skipped", "Ikke lenger aktuelt da e-posten skulle sendes.");
  const sending = claimed.filter((e) => !stale.includes(e.id)).map((e) => e.id);
  if (!sending.length) return { sent: 0, skipped: stale.length };

  if (!c.email) {
    await release(sending, "skipped", "Ingen e-postadresse.");
    return { sent: 0, skipped: claimed.length };
  }
  if (!isAllowedRecipient(c.email)) {
    await release(sending, "skipped", "Ikke i EMAIL_ALLOWLIST (testmodus).");
    await logInfo("wishlist", "wishlist.alertSkipped", `Varsel til ${maskEmail(c.email)} ikke sendt: ikke i EMAIL_ALLOWLIST.`, {
      customerId: c.customer_id,
    });
    return { sent: 0, skipped: claimed.length };
  }

  const { subject, html, text, headers } = renderAlert(c, lines);
  const result = await sendOne({
    to: c.email,
    subject,
    html,
    text,
    headers,
    // Same events → same key, so a retry after a timeout can't deliver twice.
    idempotencyKey: `wishlist-${crypto.createHash("sha256").update(sending.join(",")).digest("hex").slice(0, 40)}`,
  });

  if (result.ok) {
    await sbUpdate("wishlist_events", { id: inList(sending) }, { resend_id: result.id, note: result.dryRun ? "dry-run" : null }, { returning: false });
    await sbUpdate("wishlist_customers", { customer_id: eq(c.customer_id) }, { last_alert_at: new Date().toISOString() }, { returning: false });
    await logInfo(
      "wishlist",
      "wishlist.alertSent",
      `Varsel sendt til ${maskEmail(c.email)}: ${lines.map((l) => l.title).join(", ")}${result.dryRun ? " (dry-run)" : ""}.`,
      { customerId: c.customer_id, events: sending },
    );
    return { sent: 1, skipped: stale.length };
  }

  // Transient: try again next hour. Anything else: don't keep retrying a bad address.
  const retry = result.kind === "transient";
  await release(sending, retry ? "pending" : "skipped", retry ? null : `Resend: ${result.message}`);
  await logWarn("wishlist", "wishlist.alertFailed", `Varsel til ${maskEmail(c.email)} feilet: ${result.message}`, {
    customerId: c.customer_id,
    retry,
  });
  return { sent: 0, skipped: retry ? 0 : claimed.length };
}

// ------------------------------------------------------------------- email ------

interface AlertLine {
  kind: "price_drop" | "back_in_stock";
  title: string;
  url: string;
  imageUrl: string | null;
  oldPrice: number | null;
  price: number;
  available: boolean;
}

/** "1 584,00 kr" — how the prices read in Norwegian. */
function kr(ore: number): string {
  return `${new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ore / 100)} kr`;
}

function thumb(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set("width", "160");
    return u.toString();
  } catch {
    return url;
  }
}

export function prefsUrl(token: string, action: "off"): string {
  return `${DASHBOARD_URL}/api/storefront/wishlist-prefs?t=${encodeURIComponent(token)}&a=${action}`;
}

function renderAlert(c: CustomerRow, lines: AlertLine[]) {
  const drops = lines.filter((l) => l.kind === "price_drop");
  const subject =
    lines.length === 1
      ? `${lines[0].kind === "price_drop" ? "Lavere pris" : "Tilbake på lager"}: ${lines[0].title}`
      : `${lines.length} varer på ønskelisten din har nyheter`;

  const intro =
    lines.length === 1
      ? lines[0].kind === "price_drop"
        ? "En vare du har lagret i ønskelisten har fått lavere pris."
        : "En vare du har lagret i ønskelisten er tilbake på lager."
      : drops.length === lines.length
        ? "Flere varer du har lagret i ønskelisten har fått lavere pris."
        : drops.length === 0
          ? "Flere varer du har lagret i ønskelisten er tilbake på lager."
          : "Varer du har lagret i ønskelisten har fått lavere pris eller er tilbake på lager.";

  const rows = lines
    .map((l) => {
      const img = thumb(l.imageUrl);
      const pct = l.oldPrice ? Math.round((1 - l.price / l.oldPrice) * 100) : 0;
      const priceHtml =
        l.kind === "price_drop" && l.oldPrice
          ? `<span class="item-mute" style="text-decoration:line-through;color:#968c78;">${esc(kr(l.oldPrice))}</span>&nbsp;
             <strong class="item-price" style="color:#ef781c;">${esc(kr(l.price))}</strong>
             <span class="item-mute" style="color:#968c78;">(−${pct}&nbsp;%)</span>`
          : `<strong class="item-ok" style="color:#1a7f37;">Tilbake på lager</strong> · ${esc(kr(l.price))}`;
      // The classes carry the dark-mode colours (see the template's dark rules); the
      // inline styles are the light design every client gets by default.
      return `<tr>
        <td class="item-cell" width="88" valign="top" style="padding:12px 16px 12px 0;border-bottom:1px solid #e7ddc6;">
          ${img ? `<a href="${esc(l.url)}"><img src="${esc(img)}" width="80" alt="" style="display:block;width:80px;max-height:80px;object-fit:contain;border:0;background:#ffffff;border-radius:8px;"></a>` : ""}
        </td>
        <td class="item-cell" valign="middle" style="padding:12px 0;border-bottom:1px solid #e7ddc6;font-size:15px;line-height:1.5;color:#2d2d34;">
          <a class="item-title" href="${esc(l.url)}" style="color:#2d2d34;font-weight:bold;text-decoration:none;">${esc(l.title)}</a><br>
          ${priceHtml}<br>
          <a class="item-link" href="${esc(l.url)}" style="color:#ef781c;font-size:14px;">Se varen</a>
        </td>
      </tr>`;
    })
    .join("");

  const off = prefsUrl(c.token, "off");

  const { html, text } = renderCampaign({
    headline: "Nytt fra ønskelisten din",
    body: intro,
    itemsHtml: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`,
    itemsText: lines
      .map((l) =>
        l.kind === "price_drop" && l.oldPrice
          ? `${l.title}: ${kr(l.oldPrice)} → ${kr(l.price)}\n${l.url}`
          : `${l.title}: tilbake på lager (${kr(l.price)})\n${l.url}`,
      )
      .join("\n\n"),
    ctaUrl: `${STORE_URL}/pages/onskeliste`,
    ctaLabel: "Se ønskelisten",
    unsubscribeMailto: off,
    footerReason: "Du får denne e-posten fordi du har slått på varsler for ønskelisten din hos Nordic Engros.",
    preheader: lines.map((l) => l.title).join(" · "),
  });

  return {
    subject,
    html,
    text,
    // One-click unsubscribe (RFC 8058): Gmail and Outlook show their own button for it.
    headers: { "List-Unsubscribe": `<${off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
