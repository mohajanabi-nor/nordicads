import { handle } from "@/lib/varemottak/http";
import { inspectImport } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;

/** multipart/form-data: spec (CSV/Excel), mapping (JSON, optional). Read-only: nothing is imported. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const form = await req.formData();
  const file = form.get("spec");
  return handle(async (ctx) => {
    if (!(file instanceof File) || file.size === 0) throw new Error("Velg en fil først");
    if (file.size > MAX_BYTES) throw new Error(`Filen «${file.name}» er for stor (maks 15 MB)`);
    let mapping: Record<string, string> | undefined;
    const raw = form.get("mapping");
    if (typeof raw === "string" && raw.trim()) {
      try {
        mapping = JSON.parse(raw);
      } catch {
        throw new Error("Ugyldig kolonnekobling");
      }
    }
    return inspectImport(ctx, params.id, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }, mapping);
  });
}
