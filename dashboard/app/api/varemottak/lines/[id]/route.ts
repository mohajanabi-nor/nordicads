import { handle, jsonBody } from "@/lib/varemottak/http";
import { patchLine } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

/** Autosave of one row: duty, pcs per carton, sales unit, our price, chosen price, done. */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await jsonBody(req);
  return handle((ctx) => patchLine(ctx, params.id, body));
}
