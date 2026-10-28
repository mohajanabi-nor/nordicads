import { importKgProducts } from "@/lib/varemottak/bulk-import";
import { handle } from "@/lib/varemottak/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** multipart/form-data: file (CSV/Excel of the products sold by kg: article numbers, name, box size). */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  return handle(async (ctx) => {
    if (!(file instanceof File) || file.size === 0) throw new Error("Velg en fil først");
    if (file.size > 15 * 1024 * 1024) throw new Error("Filen er for stor (maks 15 MB)");
    return importKgProducts(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
  });
}
