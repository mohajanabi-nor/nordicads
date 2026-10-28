import { fillOpenDuties } from "@/lib/varemottak/bulk-import";
import { addRate, applyDeclaration, deleteRate, listRates } from "@/lib/varemottak/customs-service";
import { handle, jsonBody } from "@/lib/varemottak/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = () => handle((ctx) => listRates(ctx));

/**
 * POST { action: "rate", scope, cn8?, supplier?, idx?, dutyPerKg, kind, sourceRef? }
 *      { action: "declaration", number, date?, items: [{ cn8, dutyNok, netWeightKg }] }
 *      { action: "delete", id }
 */
export async function POST(req: Request) {
  const body = await jsonBody<Record<string, unknown>>(req);
  return handle(async (ctx) => {
    switch (body.action) {
      case "rate": {
        const rate = await addRate(ctx, {
          scope: body.scope === "cn8" ? "cn8" : "product",
          cn8: typeof body.cn8 === "string" ? body.cn8 : undefined,
          supplier: typeof body.supplier === "string" ? body.supplier : undefined,
          idx: typeof body.idx === "string" ? body.idx : undefined,
          dutyPerKg: Number(body.dutyPerKg),
          kind: body.kind === "declaration" ? "declaration" : "estimate",
          sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : undefined,
          date: typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined,
        });
        // A rate answered here should reach the open shipments that were waiting for it.
        const filledOpenLines = await fillOpenDuties(ctx);
        return { ...rate, filledOpenLines };
      }
      case "declaration":
        return applyDeclaration(ctx, {
          number: String(body.number ?? ""),
          date: typeof body.date === "string" && body.date ? body.date : null,
          items: Array.isArray(body.items)
            ? body.items.map((i: Record<string, unknown>) => ({ cn8: String(i.cn8 ?? ""), dutyNok: Number(i.dutyNok), netWeightKg: Number(i.netWeightKg) }))
            : [],
        });
      case "delete":
        await deleteRate(ctx, String(body.id ?? ""));
        return { ok: true };
      default:
        throw new Error("Ugyldig handling");
    }
  });
}
