import { handle, jsonBody } from "@/lib/varemottak/http";
import { createShipment, listShipments } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

export const GET = () => handle((ctx) => listShipments(ctx));

export async function POST(req: Request) {
  const body = await jsonBody<{ name?: string; supplierName?: string; arrivalDate?: string | null }>(req);
  return handle((ctx) => createShipment(ctx, { name: body.name ?? "", supplierName: body.supplierName ?? "", arrivalDate: body.arrivalDate ?? null }), { status: 201 });
}
