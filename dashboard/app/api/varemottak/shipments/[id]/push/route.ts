import { handle, jsonBody } from "@/lib/varemottak/http";
import { pushLog, pushShipment } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // ~100 rows in batches of 20, each a round trip to Shopify

/**
 * POST { dryRun?: boolean, lineIds?: string[], acknowledgeWarnings?: boolean }
 *
 * dryRun defaults to TRUE: a caller has to say dryRun:false to send anything. Against the
 * live store a real push additionally needs VAREMOTTAK_LIVE_WRITES=1, which the owner sets
 * — without it the live Shopify port refuses and this route answers 403.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = await jsonBody<{ dryRun?: boolean; lineIds?: string[]; acknowledgeWarnings?: boolean }>(req);
  return handle((ctx) =>
    pushShipment(ctx, params.id, {
      dryRun: body.dryRun !== false,
      lineIds: body.lineIds,
      acknowledgeWarnings: body.acknowledgeWarnings === true,
    }),
  );
}

export const GET = (_req: Request, { params }: { params: { id: string } }) => handle((ctx) => pushLog(ctx, params.id));
