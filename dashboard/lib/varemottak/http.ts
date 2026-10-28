/**
 * One wrapper for every Varemottak route: build the context (database, Shopify, who is
 * signed in), run the handler, and turn errors into sensible JSON.
 *
 * Auth is not done here — middleware.ts already refuses every /api/ request without a
 * session, because this prefix is not one of its open routes.
 */
import { NotFoundError, defaultCtx, type Ctx } from "./service";
import { LiveWritesDisabledError } from "./shopify/types";

export async function handle(fn: (ctx: Ctx) => Promise<unknown>, init?: { status?: number }): Promise<Response> {
  try {
    const ctx = await defaultCtx();
    const result = await fn(ctx);
    if (result instanceof Response) return result;
    return Response.json(result ?? { ok: true }, { status: init?.status ?? 200 });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof LiveWritesDisabledError) return Response.json({ error: err.message, code: "live-writes-disabled" }, { status: 403 });
    const message = err instanceof Error ? err.message : String(err);
    // The app's own validation throws a plain Error with a message written for the operator: that is a
    // 400. Anything with its own class (database, Shopify, network, a bug's TypeError) is ours: 500.
    const status = err instanceof Error && err.constructor === Error ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

/** A JSON body, or {} when there is none. */
export async function jsonBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
