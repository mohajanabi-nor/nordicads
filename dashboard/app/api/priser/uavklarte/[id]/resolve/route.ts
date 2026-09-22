/** Record an operator's decision about a product match. */
import { resolveAlias } from "@/lib/product-matching";
import { currentUser } from "@/lib/auth";
import { logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json()) as {
      action?: string;
      productId?: string;
      canonicalName?: string;
      baseUnit?: string;
    };
    const user = await currentUser();
    const who = user?.email ?? "ukjent";

    let action;
    if (body.action === "match" && body.productId) {
      action = { type: "match" as const, productId: body.productId };
    } else if (body.action === "new" && body.canonicalName?.trim()) {
      action = { type: "new" as const, canonicalName: body.canonicalName, baseUnit: body.baseUnit };
    } else if (body.action === "ignore") {
      action = { type: "ignore" as const };
    } else {
      return Response.json({ error: "ugyldig handling" }, { status: 400 });
    }

    const alias = await resolveAlias(params.id, action, who);
    if (!alias) return Response.json({ error: "fant ikke raden" }, { status: 404 });

    await logInfo("priser", "priser.resolved", `Produktkobling avklart av ${who}: ${alias.raw_name}`, {
      aliasId: alias.id,
      action: body.action,
    });
    return Response.json({ ok: true, alias });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
