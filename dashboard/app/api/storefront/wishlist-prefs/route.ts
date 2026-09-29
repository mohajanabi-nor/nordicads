/**
 * "Meld deg av" at the bottom of a wishlist alert.
 *
 * It must work without logging in, so the customer is identified by the random token
 * in the link (wishlist_customers.token). Clicking the link asks for a confirming click
 * first, because mail scanners open links on their own and would otherwise unsubscribe
 * people nobody asked for. Mail clients' own one-click unsubscribe (RFC 8058) POSTs here
 * and needs no confirmation.
 */
import { eq, sbSelectOne } from "@/lib/supabase";
import { setAlerts } from "@/lib/wishlist";

export const dynamic = "force-dynamic";

function tokenOf(url: URL): string | null {
  const token = url.searchParams.get("t") ?? "";
  // "a=off" is what the emails send; anything else is not a link we made.
  if (!/^[0-9a-f]{32}$/.test(token) || url.searchParams.get("a") !== "off") return null;
  return token;
}

async function customerFor(token: string) {
  return sbSelectOne<{ customer_id: string; alerts_choice: "in" | "out" | null }>("wishlist_customers", {
    token: eq(token),
    select: "customer_id,alerts_choice",
  });
}

const ASK = "Vil du slutte å få e-post om prisfall og varer som er tilbake på lager?";
const DONE = "Varslene er stoppet. Du kan slå dem på igjen på ønskelistesiden.";
const INVALID = "Lenken er ugyldig eller utløpt.";

function page(message: string, form?: { action: string; button: string }) {
  const html = `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ønskeliste – Nordic Engros</title>
<style>
  body{margin:0;background:#f7f0de;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2d2d34}
  main{max-width:480px;margin:12vh auto;padding:32px 24px;background:#fbf6ea;border:1px solid #e7ddc6;border-radius:16px;text-align:center}
  h1{font-size:20px;margin:0 0 12px} p{line-height:1.6;margin:0 0 20px}
  button{background:#ef781c;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:15px;font-weight:bold;cursor:pointer}
  a{color:#ef781c}
</style></head>
<body><main>
  <h1>Nordic Engros – ønskeliste</h1>
  <p>${message}</p>
  ${form ? `<form method="post" action="${form.action}"><button type="submit">${form.button}</button></form>` : ""}
  <p><a href="https://www.nordicengros.com/pages/onskeliste">Gå til ønskelisten</a></p>
</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = tokenOf(url);
  const c = token && (await customerFor(token));
  if (!c) return page(INVALID);
  // Only an explicit "out" means stopped: someone getting alerts through their email
  // subscription has made no choice yet, and still needs the button.
  if (c.alerts_choice === "out") return page(DONE);
  return page(ASK, { action: `${url.pathname}${url.search}`, button: "Ja, stopp varslene" });
}

/** The confirm button, and mail clients' one-click unsubscribe. */
export async function POST(req: Request) {
  const token = tokenOf(new URL(req.url));
  const c = token && (await customerFor(token));
  if (!c) return page(INVALID);
  await setAlerts(c.customer_id, { optIn: false });
  return page(DONE);
}
