/** The comparison grid: current price per supplier for each product. */
import { buildComparison } from "@/lib/price-comparison";
import { countReviewQueue } from "@/lib/product-matching";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;

    // Cheap poll for the nav badge — must not build the whole grid.
    if (sp.get("badge") === "1") {
      return Response.json({ unresolved: await countReviewQueue() });
    }

    const products = await buildComparison();
    const q = (sp.get("q") ?? "").trim().toLowerCase();
    const filtered = q
      ? products.filter((p) => p.productName.toLowerCase().includes(q))
      : products;

    return Response.json({
      products: filtered,
      count: filtered.length,
      unresolved: await countReviewQueue(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
