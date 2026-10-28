import { importDeclarationPdf } from "@/lib/varemottak/declaration-service";
import { handle } from "@/lib/varemottak/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** multipart/form-data: file (the forwarder's customs declaration, PDF). */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  return handle(async (ctx) => {
    if (!(file instanceof File) || file.size === 0) throw new Error("Velg en PDF først");
    if (file.size > 20 * 1024 * 1024) throw new Error("Filen er for stor (maks 20 MB)");
    return importDeclarationPdf(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
  });
}
