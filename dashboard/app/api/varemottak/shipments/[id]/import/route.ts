import { handle } from "@/lib/varemottak/http";
import { requestProductSync } from "@/lib/varemottak/product-sync";
import { importInvoice } from "@/lib/varemottak/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // reading the PDF and asking Shopify about ~250 products

const MAX_BYTES = 15 * 1024 * 1024;

/** multipart/form-data: spec (CSV/Excel), pdf (the paper invoice), currency, invoiceNo, mapping (JSON). */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const form = await req.formData();
  const read = async (field: string) => {
    const f = form.get(field);
    if (!(f instanceof File) || f.size === 0) return undefined;
    if (f.size > MAX_BYTES) throw new Error(`Filen «${f.name}» er for stor (maks 15 MB)`);
    return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
  };
  return handle(async (ctx) => {
    let mapping: Record<string, string> | undefined;
    const rawMapping = form.get("mapping");
    if (typeof rawMapping === "string" && rawMapping.trim()) {
      try {
        mapping = JSON.parse(rawMapping);
      } catch {
        throw new Error("Ugyldig kolonnekobling");
      }
    }
    const result = await importInvoice(ctx, params.id, {
      spec: await read("spec"),
      pdf: await read("pdf"),
      currency: typeof form.get("currency") === "string" ? (form.get("currency") as string) : undefined,
      invoiceNo: typeof form.get("invoiceNo") === "string" && (form.get("invoiceNo") as string).trim() ? (form.get("invoiceNo") as string).trim() : undefined,
      mapping,
    });
    // The invoice is in. Start a full refresh of the dashboard's Shopify product list (never fails the import).
    return { ...result, productSync: await requestProductSync() };
  });
}
