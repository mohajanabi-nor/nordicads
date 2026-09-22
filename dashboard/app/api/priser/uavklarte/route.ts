/** Everything waiting on a human decision. */
import { emailsNeedingAttention, unknownSenderEmails } from "@/lib/price-pipeline";
import { productsByIds, reviewQueue, suggestProducts } from "@/lib/product-matching";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const aliases = await reviewQueue();
    const products = await productsByIds(
      aliases.map((a) => a.product_id).filter(Boolean) as string[],
    );

    // A suggestion per item, so resolving is a choice rather than a search.
    const items = await Promise.all(
      aliases.slice(0, 40).map(async (a) => ({
        id: a.id,
        supplierId: a.supplier_id,
        rawName: a.raw_name,
        sku: a.supplier_sku,
        suggestedProductId: a.product_id,
        suggestedName: a.product_id ? products.get(a.product_id)?.canonical_name ?? null : a.suggested_name,
        matchMethod: a.match_method,
        confidence: a.confidence,
        candidates: (await suggestProducts(a.raw_name)).map((p) => ({ id: p.id, name: p.canonical_name })),
      })),
    );

    return Response.json({
      products: items,
      emails: await emailsNeedingAttention(),
      unknownSenders: await unknownSenderEmails(20),
      total: aliases.length,
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
