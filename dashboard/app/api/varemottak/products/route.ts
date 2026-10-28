import { handle } from "@/lib/varemottak/http";
import { searchForPicker } from "@/lib/varemottak/suggest-service";

export const dynamic = "force-dynamic";

/**
 * Product lookup for the match picker. Read-only.
 *   ?q=words            search titles
 *   ?q=1234567890123    an article number or EAN: looked up as a tag and as a barcode
 *   ?ids=1,2            products by id
 */
export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  const ids = (params.get("ids") ?? "").split(",").filter((x) => /^\d+$/.test(x)).slice(0, 20);
  return handle(async (ctx) => {
    if (ids.length) return Array.from((await ctx.shopify.productsByIds(ids)).values());
    return searchForPicker(ctx, q);
  });
}
