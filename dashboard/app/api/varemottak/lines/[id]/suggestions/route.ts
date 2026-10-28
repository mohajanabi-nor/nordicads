import { handle } from "@/lib/varemottak/http";
import { suggestForLine } from "@/lib/varemottak/suggest-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The products the system thinks a row may be, best first, each with its reasons. Read-only. */
export const GET = (_req: Request, { params }: { params: { id: string } }) => handle((ctx) => suggestForLine(ctx, params.id));
