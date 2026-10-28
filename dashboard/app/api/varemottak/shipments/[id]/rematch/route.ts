import { handle } from "@/lib/varemottak/http";
import { rematch } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = (_req: Request, { params }: { params: { id: string } }) => handle((ctx) => rematch(ctx, params.id));
