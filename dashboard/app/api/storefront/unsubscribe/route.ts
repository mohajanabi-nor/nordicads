/**
 * "Meld deg av" in campaign emails: unsubscribe from all email from Nordic Engros.
 *
 * Each recipient's link carries their contact's random token (db/010). Opening it shows
 * a confirm button — mail scanners open links by themselves and must not unsubscribe
 * anyone — and Gmail's and Outlook's own one-click "Unsubscribe" POSTs here (RFC 8058)
 * and takes effect straight away.
 *
 * Unsubscribing stops campaigns (contacts.subscribed) and wishlist alerts, which for
 * most customers follow that consent anyway, and records a choice for the ones who had
 * ticked the wishlist box themselves: asking to stop means stop everything. Shopify's
 * own marketing flag is not changed (the app can only read customers); the nightly
 * sync never re-subscribes a contact, so the unsubscribe holds.
 *
 * Open in middleware (/api/storefront/); the token is the authorisation.
 */
import { eq, inList, sbSelect, sbSelectOne } from "@/lib/supabase";
import { setSubscribed } from "@/lib/contacts";
import { setAlerts } from "@/lib/wishlist";
import { logInfo } from "@/lib/eventlog";
import { maskEmail } from "@/lib/resend";

export const dynamic = "force-dynamic";

interface ContactRow {
  email: string;
  shopify_id: string | null;
  subscribed: boolean;
}

async function contactFor(url: URL): Promise<ContactRow | null> {
  const token = url.searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  return sbSelectOne<ContactRow>("contacts", { unsubscribe_token: eq(token), select: "email,shopify_id,subscribed" });
}

async function unsubscribe(c: ContactRow): Promise<void> {
  const changed = await setSubscribed([c.email], false);
  if (changed) {
    await logInfo("contacts", "contact.unsubscribed", `${maskEmail(c.email)} meldte seg av med lenken i e-posten.`, {
      email: c.email,
      source: "email-link",
    });
  }

  // The same customer's wishlist, found by Shopify id or by address.
  const ids = [c.shopify_id?.split("/").pop()].filter((x): x is string => !!x && /^\d+$/.test(x));
  const wishlists = [
    ...(ids.length ? await sbSelect<{ customer_id: string; alerts_choice: string | null }>("wishlist_customers", { customer_id: inList(ids), select: "customer_id,alerts_choice" }) : []),
    ...(await sbSelect<{ customer_id: string; alerts_choice: string | null }>("wishlist_customers", { email: eq(c.email), select: "customer_id,alerts_choice" })),
  ];
  for (const w of Array.from(new Map(wishlists.map((w) => [w.customer_id, w])).values())) {
    if (w.alerts_choice !== "out") await setAlerts(w.customer_id, { optIn: false });
  }
}

const ASK = "Vil du slutte å få e-post fra Nordic Engros?";
const DONE = "Du er meldt av og får ikke flere e-poster fra oss. Ombestemmer du deg, kan du kontakte oss på post@nordicengros.no.";
const INVALID =
  "Denne lenken fungerer ikke. Er det en test- eller forhåndsvisningslenke, er det riktig — i ekte e-poster fungerer den.";

function page(message: string, form?: { action: string; button: string }) {
  const html = `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meld deg av – Nordic Engros</title>
<style>
  body{margin:0;background:#f7f0de;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2d2d34}
  main{max-width:480px;margin:12vh auto;padding:32px 24px;background:#fbf6ea;border:1px solid #e7ddc6;border-radius:16px;text-align:center}
  h1{font-size:20px;margin:0 0 12px} p{line-height:1.6;margin:0 0 20px}
  button{background:#ef781c;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:15px;font-weight:bold;cursor:pointer}
  a{color:#ef781c}
</style></head>
<body><main>
  <h1>Nordic Engros</h1>
  <p>${message}</p>
  ${form ? `<form method="post" action="${form.action}"><button type="submit">${form.button}</button></form>` : ""}
  <p><a href="https://www.nordicengros.com">Gå til nettbutikken</a></p>
</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const c = await contactFor(url);
  if (!c) return page(INVALID);
  if (!c.subscribed) return page(DONE);
  return page(ASK, { action: `${url.pathname}${url.search}`, button: "Ja, meld meg av" });
}

/** The confirm button, and mail clients' one-click unsubscribe. */
export async function POST(req: Request) {
  const c = await contactFor(new URL(req.url));
  if (!c) return page(INVALID);
  await unsubscribe(c);
  return page(DONE);
}
