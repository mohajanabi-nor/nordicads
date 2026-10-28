import { handle, jsonBody } from "@/lib/varemottak/http";
import { setDone } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = await jsonBody<{ lineIds?: string[]; done?: boolean }>(req);
  return handle(async (ctx) => ({ updated: await setDone(ctx, params.id, (body.lineIds ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)), body.done !== false) }));
}
