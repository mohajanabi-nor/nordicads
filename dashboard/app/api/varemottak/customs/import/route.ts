import { importRates } from "@/lib/varemottak/bulk-import";
import { handle } from "@/lib/varemottak/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** multipart/form-data: file (CSV/Excel with duty rates), supplier (optional, for rows without a supplier column). */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const supplier = form.get("supplier");
  return handle(async (ctx) => {
    if (!(file instanceof File) || file.size === 0) throw new Error("Velg en fil først");
    if (file.size > 15 * 1024 * 1024) throw new Error("Filen er for stor (maks 15 MB)");
    return importRates(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }, { supplier: typeof supplier === "string" && supplier.trim() ? supplier.trim() : undefined });
  });
}
