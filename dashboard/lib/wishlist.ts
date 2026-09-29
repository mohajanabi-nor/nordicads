/**
 * Logged-in customers' wishlists, and their consent to alert emails.
 *
 * Every function takes the customer id the App Proxy signed (see verifyAppProxy);
 * nothing here accepts an identity from the storefront.
 *
 * Server-only.
 */
import { eq, inList, sbDelete, sbInsert, sbSelect, sbSelectOne, sbUpdate } from "./supabase";
import { customerEmail, lookupHandles } from "./shopify-admin";
import { logInfo } from "./eventlog";
import { maskEmail } from "./resend";

/** A list longer than this is someone scripting the endpoint, not shopping. */
export const MAX_ITEMS = 300;

/** Shopify handles are lowercase letters, digits and dashes; allow a little slack. */
const HANDLE_RE = /^[a-z0-9][a-z0-9\-_.]{0,254}$/i;

export function validHandle(h: unknown): h is string {
  return typeof h === "string" && HANDLE_RE.test(h);
}

interface CustomerRow {
  customer_id: string;
  email: string | null;
  alerts_opt_in: boolean;
  alerts_choice: "in" | "out" | null;
}

// ---------------------------------------------------------------- consent ------

/**
 * Whether a customer gets wishlist alerts, and why.
 *
 *   choice     they ticked or unticked the box on the wishlist page, or clicked
 *              "Meld deg av" in an alert. Always wins.
 *   marketing  no choice yet: their email-marketing consent decides. Subscribed to
 *              Nordic Engros's emails means subscribed to the alerts too (the client's
 *              decision, 2026-09-29); unsubscribed, bounced or gone from Shopify means no.
 */
export interface Consent {
  optIn: boolean;
  via: "choice" | "marketing";
}

interface ContactRow {
  email: string;
  shopify_id: string | null;
  subscribed: boolean;
  invalid_email: boolean;
  missing_in_shopify: boolean;
}

/** The same rule campaigns use (isMailable in lib/contacts.ts). */
const mailable = (c: ContactRow) => c.subscribed && !c.invalid_email && !c.missing_in_shopify;

export async function consentFor(
  customers: Array<Pick<CustomerRow, "customer_id" | "email" | "alerts_opt_in" | "alerts_choice">>,
): Promise<Map<string, Consent>> {
  const out = new Map<string, Consent>();
  const undecided = customers.filter((c) => {
    if (c.alerts_choice) out.set(c.customer_id, { optIn: c.alerts_choice === "in", via: "choice" });
    return !c.alerts_choice;
  });
  if (!undecided.length) return out;

  // Contacts are matched on the Shopify id (stored there as a gid), then on email for
  // anyone the customer sync hasn't linked yet.
  const byGid = new Map<string, ContactRow>();
  const byEmail = new Map<string, ContactRow>();
  const gids = undecided.map((c) => `gid://shopify/Customer/${c.customer_id}`);
  const emails = undecided.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e);
  const cols = "email,shopify_id,subscribed,invalid_email,missing_in_shopify";
  for (let i = 0; i < gids.length; i += 100) {
    for (const r of await sbSelect<ContactRow>("contacts", { shopify_id: inList(gids.slice(i, i + 100)), select: cols })) {
      if (r.shopify_id) byGid.set(r.shopify_id, r);
    }
  }
  for (let i = 0; i < emails.length; i += 100) {
    for (const r of await sbSelect<ContactRow>("contacts", { email: inList(emails.slice(i, i + 100)), select: cols })) {
      byEmail.set(r.email.toLowerCase(), r);
    }
  }
  for (const c of undecided) {
    const contact = byGid.get(`gid://shopify/Customer/${c.customer_id}`) ?? (c.email ? byEmail.get(c.email.toLowerCase()) : undefined);
    out.set(c.customer_id, { optIn: !!contact && mailable(contact), via: "marketing" });
  }
  return out;
}

interface ItemRow {
  handle: string;
  variant_id: string | null;
  added_at: string;
}

export interface WishlistState {
  items: Array<{ handle: string; variantId: string | null; addedAt: string }>;
  alerts: { optIn: boolean };
}

// -------------------------------------------------------------- the list ------

/** Make sure the customer has a row; the email is filled in from Shopify on first sight. */
async function ensureCustomer(customerId: string): Promise<CustomerRow> {
  const existing = await sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) });
  if (existing) return existing;
  const email = await customerEmail(customerId).catch(() => null);
  await sbInsert("wishlist_customers", { customer_id: customerId, email }, { onConflict: "customer_id", ignoreDuplicates: true });
  return (await sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) }))!;
}

export async function getState(customerId: string): Promise<WishlistState> {
  const [customer, items] = await Promise.all([
    sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) }),
    sbSelect<ItemRow>("wishlist_items", {
      customer_id: eq(customerId),
      select: "handle,variant_id,added_at",
      order: "added_at.desc",
      limit: MAX_ITEMS,
    }),
  ]);
  // The box shows what will actually happen, so a subscriber sees it ticked.
  const consent = (
    await consentFor([customer ?? { customer_id: customerId, email: null, alerts_opt_in: false, alerts_choice: null }])
  ).get(customerId)!;
  return {
    items: items.map((i) => ({ handle: i.handle, variantId: i.variant_id, addedAt: i.added_at })),
    alerts: { optIn: consent.optIn },
  };
}

/**
 * Save items. Existing ones are left untouched, so re-saving never resets the
 * price a product was saved at (which is what a later price drop is measured from).
 * Handles Shopify doesn't know are skipped.
 */
export async function addItems(
  customerId: string,
  wanted: Array<{ handle: string; variantId?: string | null; addedAt?: string | null }>,
): Promise<void> {
  if (!wanted.length) return;
  await ensureCustomer(customerId);

  const current = await sbSelect<{ handle: string }>("wishlist_items", {
    customer_id: eq(customerId),
    select: "handle",
  });
  const have = new Set(current.map((c) => c.handle));
  const fresh = wanted.filter((w) => !have.has(w.handle)).slice(0, Math.max(0, MAX_ITEMS - have.size));
  if (!fresh.length) return;

  const info = await lookupHandles(fresh);
  const rows = fresh
    .filter((w) => info.has(w.handle))
    .map((w) => {
      const i = info.get(w.handle)!;
      const added = w.addedAt && !Number.isNaN(Date.parse(w.addedAt)) ? new Date(w.addedAt) : new Date();
      return {
        customer_id: customerId,
        handle: w.handle,
        product_id: i.productId,
        variant_id: i.variantId,
        price_at_save: i.price,
        available_at_save: i.available,
        inventory_item_id: i.inventoryItemId,
        // The alert check starts from what the customer saw when saving.
        baseline_price: i.price,
        last_price: i.price,
        last_available: i.available,
        checked_at: new Date().toISOString(),
        // A date from the browser is only kept if it's plausible; never in the future.
        added_at: (added.getTime() > Date.now() ? new Date() : added).toISOString(),
      };
    });
  if (rows.length) {
    await sbInsert("wishlist_items", rows, { onConflict: "customer_id,handle", ignoreDuplicates: true });
  }
}

export async function removeItems(customerId: string, handles: string[]): Promise<void> {
  if (!handles.length) return;
  await sbDelete("wishlist_items", { customer_id: eq(customerId), handle: inList(handles) });
}

/**
 * The customer's own choice: alerts on or off. From then on it overrides their
 * email-marketing consent (see consentFor).
 *
 * Opting in refreshes the email from Shopify, since that is the address the
 * customer is consenting for. Every choice is logged: a consent change with no
 * record can't be shown later to have been the customer's own.
 */
export async function setAlerts(
  customerId: string,
  change: { optIn: boolean },
): Promise<WishlistState["alerts"]> {
  const before = await ensureCustomer(customerId);
  const was = (await consentFor([before])).get(customerId)!;
  const now = new Date().toISOString();

  let email = before.email;
  const patch: Record<string, unknown> = { updated_at: now, alerts_opt_in: change.optIn, alerts_choice: change.optIn ? "in" : "out" };
  if (change.optIn) {
    email = (await customerEmail(customerId)) ?? before.email;
    if (!email) throw new Error("Fant ingen e-postadresse på kontoen");
    Object.assign(patch, { opt_in_at: now, email });
  } else {
    patch.opt_out_at = now;
  }
  await sbUpdate("wishlist_customers", { customer_id: eq(customerId) }, patch, { returning: false });

  if (before.alerts_choice !== patch.alerts_choice) {
    await logInfo(
      "wishlist",
      change.optIn ? "wishlist.optIn" : "wishlist.optOut",
      change.optIn
        ? `${maskEmail(email ?? "")} slo på varsler for ønskelisten.`
        : `${maskEmail(email ?? "")} slo av varsler for ønskelisten.`,
      { customerId, source: "storefront", before: was },
    );
  }
  return { optIn: change.optIn };
}
