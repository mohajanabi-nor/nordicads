/**
 * Deciding when two suppliers are quoting the same product.
 *
 * This is where a wrong answer is most expensive and least visible: merge two
 * different products and the comparison confidently reports a "cheapest" that
 * does not exist. So the rule is that only evidence gets to decide
 * automatically, and everything else is asked about.
 *
 *   trusted   — a supplier reusing their OWN SKU, or their own exact wording.
 *               That is a supplier identifying their own product.
 *   suggested — a different supplier using identical wording. Two firms both
 *               writing "Tomater 5kg" is a coincidence, not proof, so it is
 *               offered for one-click confirmation rather than applied.
 *   asked     — anything Claude is not confident about.
 *
 * Server-only.
 */
import { eq, inList, is, sbInsert, sbSelect, sbUpdate } from "./supabase";

export interface ProductRow {
  id: string;
  canonical_name: string;
  normalized_name: string;
  base_unit: string | null;
}

export interface AliasRow {
  id: string;
  supplier_id: string;
  supplier_sku: string | null;
  raw_name: string;
  normalized_name: string;
  product_id: string | null;
  match_method: string | null;
  confidence: number;
  needs_review: boolean;
  ignored: boolean;
  suggested_name: string | null;
}

export type MatchMethod =
  | "exact_sku"
  | "normalized_name"
  | "cross_supplier"
  | "claude_fuzzy"
  | "manual";

export interface MatchOutcome {
  productId: string | null;
  method: MatchMethod | null;
  confidence: number;
  needsReview: boolean;
  suggestedName: string | null;
}

/**
 * Reduce a product name to something comparable.
 *
 * Case, punctuation and spacing differ between suppliers for the same goods;
 * quantities do not, so digits and units are kept. "Tomater 5 KG." and
 * "tomater 5kg" should meet, "Tomater 5kg" and "Tomater 10kg" must not.
 */
export function normalizeProductName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9æøå]+/gi, " ")
    // Split digit/letter boundaries so "5kg" and "5 KG." meet. Without this the
    // SAME supplier writing a size two ways produces two aliases and two review
    // items, which buries the genuine ambiguities under noise.
    .replace(/(\d)([a-zæøå])/gi, "$1 $2")
    .replace(/([a-zæøå])(\d)/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchThreshold(): number {
  return Number(process.env.PRODUCT_MATCH_AUTO_THRESHOLD || "0.90");
}

/** An existing alias for this supplier, by SKU first and then by wording. */
async function findSupplierAlias(
  supplierId: string,
  sku: string | null,
  normalized: string,
): Promise<AliasRow | null> {
  if (sku) {
    const bySku = await sbSelect<AliasRow>("product_aliases", {
      supplier_id: eq(supplierId),
      supplier_sku: eq(sku),
      limit: 1,
    });
    if (bySku.length) return bySku[0];
  }
  const byName = await sbSelect<AliasRow>("product_aliases", {
    supplier_id: eq(supplierId),
    normalized_name: eq(normalized),
    limit: 1,
  });
  return byName[0] ?? null;
}

/** The same wording already mapped by SOMEBODY — a strong hint, not a verdict. */
async function findCrossSupplierAlias(normalized: string): Promise<AliasRow | null> {
  const rows = await sbSelect<AliasRow>("product_aliases", {
    normalized_name: eq(normalized),
    product_id: "not.is.null",
    limit: 1,
  });
  return rows[0] ?? null;
}

/**
 * Resolve one extracted row to a canonical product.
 *
 * Returns what it decided AND whether a human should look, so the caller can
 * record a price against a product or park it — never silently drop it.
 */
export async function matchProduct(
  supplierId: string,
  rawName: string,
  sku: string | null,
): Promise<{ alias: AliasRow; outcome: MatchOutcome }> {
  const normalized = normalizeProductName(rawName);

  // Already known for this supplier: reuse the decision, including a previous
  // manual one, so review is never asked for twice.
  const existing = await findSupplierAlias(supplierId, sku, normalized);
  if (existing) {
    return {
      alias: existing,
      outcome: {
        productId: existing.product_id,
        method: (existing.match_method as MatchMethod) ?? null,
        confidence: existing.confidence,
        needsReview: existing.needs_review || existing.product_id === null,
        suggestedName: existing.suggested_name,
      },
    };
  }

  // Another supplier uses the identical wording. Offered, not applied.
  const cross = await findCrossSupplierAlias(normalized);
  const product = cross?.product_id
    ? (await sbSelect<ProductRow>("products", { id: eq(cross.product_id), limit: 1 }))[0]
    : undefined;

  const outcome: MatchOutcome = cross?.product_id
    ? {
        productId: cross.product_id,
        method: "cross_supplier",
        confidence: 0.6,
        needsReview: true,
        suggestedName: product?.canonical_name ?? null,
      }
    : { productId: null, method: null, confidence: 0, needsReview: true, suggestedName: null };

  const inserted = await sbInsert<AliasRow>(
    "product_aliases",
    {
      supplier_id: supplierId,
      supplier_sku: sku,
      raw_name: rawName,
      normalized_name: normalized,
      product_id: outcome.productId,
      match_method: outcome.method,
      confidence: outcome.confidence,
      needs_review: outcome.needsReview,
      suggested_name: outcome.suggestedName,
    },
    { returning: true },
  );

  return { alias: inserted[0], outcome };
}

/** Everything waiting on a human: unmatched, or matched on a guess. */
export async function reviewQueue(limit = 100): Promise<AliasRow[]> {
  return sbSelect<AliasRow>("product_aliases", {
    needs_review: is(true),
    ignored: is(false),
    order: "created_at.desc",
    limit,
  });
}

export async function countReviewQueue(): Promise<number> {
  const rows = await sbSelect<{ id: string }>("product_aliases", {
    select: "id",
    needs_review: is(true),
    ignored: is(false),
    limit: 1000,
  });
  return rows.length;
}

/**
 * Apply an operator's decision.
 *
 * Resolving an alias can unblock prices that were recorded against it before
 * anyone knew which product it was, so the caller backfills afterwards — the
 * decision is only useful if the numbers it unlocks actually appear.
 */
export async function resolveAlias(
  aliasId: string,
  action: { type: "match"; productId: string } | { type: "new"; canonicalName: string; baseUnit?: string } | { type: "ignore" },
  reviewedBy: string,
): Promise<AliasRow | null> {
  const now = new Date().toISOString();

  if (action.type === "ignore") {
    const rows = await sbUpdate<AliasRow>(
      "product_aliases",
      { id: eq(aliasId) },
      { ignored: true, needs_review: false, reviewed_by: reviewedBy, reviewed_at: now, updated_at: now },
    );
    return rows[0] ?? null;
  }

  let productId: string;
  if (action.type === "new") {
    const created = await sbInsert<ProductRow>(
      "products",
      {
        canonical_name: action.canonicalName.trim(),
        normalized_name: normalizeProductName(action.canonicalName),
        base_unit: action.baseUnit ?? null,
      },
      { returning: true },
    );
    productId = created[0].id;
  } else {
    productId = action.productId;
  }

  const rows = await sbUpdate<AliasRow>(
    "product_aliases",
    { id: eq(aliasId) },
    {
      product_id: productId,
      match_method: "manual",
      confidence: 1,
      needs_review: false,
      ignored: false,
      reviewed_by: reviewedBy,
      reviewed_at: now,
      updated_at: now,
    },
  );
  return rows[0] ?? null;
}

/** Candidate products for the review screen's dropdown, nearest wording first. */
export async function suggestProducts(rawName: string, limit = 8): Promise<ProductRow[]> {
  const normalized = normalizeProductName(rawName);
  const words = normalized.split(" ").filter((w) => w.length > 2).slice(0, 3);
  if (!words.length) {
    return sbSelect<ProductRow>("products", { order: "canonical_name.asc", limit });
  }
  // `ilike` on the longest words is a cheap stand-in for real similarity, and
  // the operator sees the full list anyway — this only orders the shortlist.
  const rows = await sbSelect<ProductRow>("products", {
    normalized_name: `ilike.*${words[0]}*`,
    limit,
  });
  if (rows.length) return rows;
  return sbSelect<ProductRow>("products", { order: "canonical_name.asc", limit });
}

/** Products referenced by a set of aliases, for rendering a review list. */
export async function productsByIds(ids: string[]): Promise<Map<string, ProductRow>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Map();
  const rows = await sbSelect<ProductRow>("products", { id: inList(unique), limit: unique.length });
  return new Map(rows.map((r) => [r.id, r]));
}
