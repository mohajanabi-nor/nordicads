import { handle } from "@/lib/varemottak/http";
import { buildWorkbook } from "@/lib/varemottak/export";
import { getShipmentView } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

export const GET = (_req: Request, { params }: { params: { id: string } }) =>
  handle(async (ctx) => {
    const view = await getShipmentView(ctx, params.id);
    const file = buildWorkbook(view.shipment, view.invoices, view.lines);
    const name = view.shipment.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "forsendelse";
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
      },
    });
  });
