import { reportCsv } from "@/lib/varemottak/gp";
import { archiveCategory, gpOverview, setProductGp, upsertCategory } from "@/lib/varemottak/gp-service";
import { handle, jsonBody } from "@/lib/varemottak/http";

export const dynamic = "force-dynamic";

/** GET ?term=2026-RT3[&format=csv] — the period's report, or the CSV to type into the portal. */
export function GET(req: Request) {
  const url = new URL(req.url);
  const term = url.searchParams.get("term") ?? "";
  return handle(async (ctx) => {
    const overview = await gpOverview(ctx, term);
    if (url.searchParams.get("format") === "csv") {
      return new Response("﻿" + reportCsv(overview.report), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gront-punkt-${overview.report.term.code}.csv"` },
      });
    }
    return overview;
  });
}

/**
 * POST { action: "product", productId, gpCode, gpPackagingKg }
 *      { action: "category", code, name, unit, rate, validFrom }
 *      { action: "archive", code }
 */
export async function POST(req: Request) {
  const body = await jsonBody<Record<string, unknown>>(req);
  return handle(async (ctx) => {
    switch (body.action) {
      case "product":
        if (typeof body.productId !== "string" || !/^\d+$/.test(body.productId)) throw new Error("Produktet mangler");
        return setProductGp(ctx, body.productId, {
          gpCode: body.gpCode ? String(body.gpCode) : null,
          gpPackagingKg: body.gpPackagingKg === null || body.gpPackagingKg === "" || body.gpPackagingKg === undefined ? null : Number(body.gpPackagingKg),
        });
      case "category":
        await upsertCategory(ctx, {
          code: String(body.code ?? ""),
          name: String(body.name ?? ""),
          unit: body.unit === "kg" ? "kg" : "pcs",
          rate: Number(body.rate),
          validFrom: String(body.validFrom ?? ""),
        });
        return { ok: true };
      case "archive":
        await archiveCategory(ctx, String(body.code ?? ""));
        return { ok: true };
      default:
        throw new Error("Ugyldig handling");
    }
  });
}
