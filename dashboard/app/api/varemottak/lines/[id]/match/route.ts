import { handle, jsonBody } from "@/lib/varemottak/http";
import { setMatch } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = await jsonBody<{ productId?: string }>(req);
  return handle((ctx) => {
    if (!body.productId || !/^\d+$/.test(body.productId)) throw new Error("Velg et produkt");
    return setMatch(ctx, params.id, body.productId);
  });
}
