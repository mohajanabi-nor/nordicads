import { handle, jsonBody } from "@/lib/varemottak/http";
import { deleteShipment, getShipmentView, patchShipment } from "@/lib/varemottak/service";
import { liveWritesEnabled } from "@/lib/varemottak/shopify";

export const dynamic = "force-dynamic";

/** The shipment, its invoices and rows — plus which Shopify this would talk to, so the screen can say so. */
export const GET = (_req: Request, { params }: { params: { id: string } }) =>
  handle(async (ctx) => ({
    ...(await getShipmentView(ctx, params.id)),
    shopifyMode: ctx.shopify.mode,
    liveWritesEnabled: ctx.shopify.mode === "live" && liveWritesEnabled(),
  }));

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await jsonBody(req);
  return handle((ctx) => patchShipment(ctx, params.id, body));
}

export const DELETE = (_req: Request, { params }: { params: { id: string } }) =>
  handle(async (ctx) => {
    await deleteShipment(ctx, params.id);
    return { ok: true };
  });
