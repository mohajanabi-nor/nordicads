/**
 * The storefront wishlist's server side, reached through Shopify's App Proxy.
 *
 *   nordicengros.com/apps/onskeliste/<action>  →  /api/storefront/wishlist/<action>
 *
 * Open in middleware because shoppers have no dashboard session. What protects it is
 * the proxy signature (verifyAppProxy): only requests Shopify forwarded get through,
 * and the customer is whoever Shopify says is logged in — the browser can't choose.
 * Guests get 401; their list stays in their browser.
 *
 *   GET  state                      → the customer's list and alert settings
 *   POST add     { handle, variantId? }
 *   POST remove  { handle }
 *   POST merge   { items: [{ handle, variantId?, addedAt? }] }   (a guest list, on first login)
 *   POST alerts  { optIn }
 *
 * Every response carries the full state, so the page never has to guess what was saved.
 */
import { verifyAppProxy } from "@/lib/shopify-admin";
import {
  MAX_ITEMS,
  addItems,
  getState,
  removeItems,
  setAlerts,
  validHandle,
} from "@/lib/wishlist";
import { logError } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function identify(req: Request): { customerId: string } | Response {
  const check = verifyAppProxy(new URL(req.url));
  if (!check.ok) return json({ error: check.reason }, 401);
  if (!check.identity.customerId) return json({ error: "ikke innlogget" }, 401);
  return { customerId: check.identity.customerId };
}

function action(params: { path?: string[] }): string {
  return (params.path ?? []).join("/");
}

export async function GET(req: Request, { params }: { params: { path?: string[] } }) {
  const who = identify(req);
  if (who instanceof Response) return who;
  if (action(params) !== "state") return json({ error: "ukjent handling" }, 404);

  try {
    return json(await getState(who.customerId));
  } catch (err) {
    return failed("state", who.customerId, err);
  }
}

export async function POST(req: Request, { params }: { params: { path?: string[] } }) {
  const who = identify(req);
  if (who instanceof Response) return who;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "ugyldig JSON" }, 400);
  }

  const act = action(params);
  try {
    switch (act) {
      case "add": {
        if (!validHandle(body.handle)) return json({ error: "ugyldig produkt" }, 400);
        await addItems(who.customerId, [{ handle: body.handle, variantId: variantOf(body.variantId) }]);
        break;
      }
      case "remove": {
        if (!validHandle(body.handle)) return json({ error: "ugyldig produkt" }, 400);
        await removeItems(who.customerId, [body.handle]);
        break;
      }
      case "merge": {
        const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
        await addItems(
          who.customerId,
          items
            .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
            .filter((i) => validHandle(i.handle))
            .map((i) => ({
              handle: i.handle as string,
              variantId: variantOf(i.variantId),
              addedAt: typeof i.addedAt === "string" ? i.addedAt : null,
            })),
        );
        break;
      }
      case "alerts": {
        if (typeof body.optIn !== "boolean") return json({ error: "ingenting å endre" }, 400);
        await setAlerts(who.customerId, { optIn: body.optIn });
        break;
      }
      default:
        return json({ error: "ukjent handling" }, 404);
    }
    return json(await getState(who.customerId));
  } catch (err) {
    return failed(act, who.customerId, err);
  }
}

function variantOf(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  return /^\d{1,20}$/.test(s) ? s : null;
}

async function failed(act: string, customerId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await logError("wishlist", "wishlist.requestFailed", `Ønskeliste (${act}) feilet: ${message}`, { customerId });
  return json({ error: "Noe gikk galt. Prøv igjen." }, 500);
}
