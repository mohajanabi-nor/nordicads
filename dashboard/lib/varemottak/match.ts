/**
 * Matching an invoice line to its Shopify product.
 *
 * Order of trust:
 *   1. a link the operator saved earlier (supplier + article number → product);
 *   2. the article number as a Shopify tag — and when two products carry it (105080 is
 *      on both a Duru and a Burjonka product), the vendor and title decide;
 *   3. nothing — the line goes to the picker.
 *
 * Never silent: a match that contradicts itself (the tag fits but neither the brand nor
 * a single word of the title does) is "doubtful" and is shown to the operator.
 */
import type { ShopProduct } from "./shopify/types";

export type MatchStatus = "matched" | "doubtful" | "unmatched";
export type MatchVia = "link" | "tag" | "ean" | "none";

export interface MatchResult {
  status: MatchStatus;
  via: MatchVia;
  productId: string | null;
  /** Other products the operator may pick between, best first. */
  candidates: string[];
  reason: string;
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

const STOP = new Set(["with", "and", "the", "for", "pcs", "kg", "ltr", "drs", "til", "med", "og"]);

/** Words that identify a product: letters only, 3+ long, no sizes or stop words. */
export function tokens(text: string): Set<string> {
  return new Set(
    strip(text)
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/**
 * Pack sizes written in a name, in grams or millilitres: "28G" → 28, "0,5L" → 500, "2.4kg" → 2400. A multipack
 * ("6 x 1kg") counts as its parts and as its total, so "6kg" in the other name still agrees.
 */
export function packSizes(text: string): number[] {
  const out: number[] = [];
  const unitFactor: Record<string, number> = { kg: 1000, g: 1, gr: 1, ml: 1, cl: 10, l: 1000, ltr: 1000 };
  // "6 x 1kg" and "12g x 200" are both multipacks
  const re = /(?:(\d+)\s*[x\u00d7]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|cl|ltr|l)\b(?:\s*[x\u00d7]\s*(\d+)\b)?/gi;
  for (const m of text.toLowerCase().matchAll(re)) {
    const each = Number(m[2].replace(",", ".")) * unitFactor[m[3]];
    out.push(each);
    const count = Number(m[1] ?? m[4] ?? 0);
    if (count > 1) out.push(each * count);
  }
  return out;
}

/** Both names give a pack size and none of them agree (28 g on the invoice, 45 g on the product). */
function sizesConflict(invoiceName: string, productTitle: string): { invoice: number; product: number } | null {
  // A product sold per kg carries its carton weight in the title ("ca 5kg i kasse"), which says nothing about the pack.
  if (/pris\s*p[rå]\s*kg|per\s*kg/i.test(productTitle)) return null;
  const a = packSizes(invoiceName);
  const b = packSizes(productTitle);
  if (!a.length || !b.length) return null;
  const agree = a.some((x) => b.some((y) => Math.abs(x - y) <= Math.max(x, y) * 0.02));
  return agree ? null : { invoice: a[0], product: b[0] };
}

function vendorIn(name: string, vendor: string): boolean {
  const v = strip(vendor).replace(/[^a-z0-9 ]/g, "").trim();
  return v.length >= 3 && strip(name).includes(v);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  a.forEach((w) => {
    if (b.has(w)) n++;
  });
  return n;
}

export interface LineForMatch {
  idx: string;
  name: string;
  /** EAN of one piece / of the carton, digits only, when the invoice file has them. */
  ean?: string | null;
  eanBox?: string | null;
}

/** Barcodes compare equal ignoring leading zeros (EAN-13 vs GTIN-14 vs UPC-A written with padding). */
const barcodeKey = (b: string) => b.replace(/^0+/, "");

export function matchLine(
  line: LineForMatch,
  /** Products from the shop that carry this article number as a tag. */
  tagged: ShopProduct[],
  /** A saved link's product, if the operator picked one before and it still exists. */
  linked: ShopProduct | null,
  /** Products whose barcode is one of the invoice's EANs (see Shopify productsByBarcodes). */
  byEan: ShopProduct[] = [],
): MatchResult {
  if (linked) {
    return { status: "matched", via: "link", productId: linked.id, candidates: [], reason: "Koblingen du lagret tidligere" };
  }

  // What the invoice's EANs say, independent of what the article-number tag says.
  const eanKeys = [line.ean, line.eanBox].filter((e): e is string => !!e).map(barcodeKey);
  const eanHits = eanKeys.length
    ? byEan.filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i && p.barcodes.some((b) => eanKeys.includes(barcodeKey(b))))
    : [];

  const idx = line.idx.toLowerCase();
  const hits = tagged.filter((p) => p.tags.some((t) => t.toLowerCase() === idx));

  if (!hits.length) {
    // No product carries the article number — but the barcode may still say which one it is.
    if (eanHits.length === 1) {
      return {
        status: "matched",
        via: "ean",
        productId: eanHits[0].id,
        candidates: [],
        reason: `Funnet på EAN (ingen vare har varenummeret ${line.idx} som tagg)`,
      };
    }
    if (eanHits.length > 1) {
      return {
        status: "doubtful",
        via: "ean",
        productId: null,
        candidates: eanHits.map((p) => p.id),
        reason: `EAN finnes på ${eanHits.length} produkter og varenummeret finnes ikke som tagg – velg riktig`,
      };
    }
    return { status: "unmatched", via: "none", productId: null, candidates: [], reason: "Ingen produkt har dette varenummeret som tagg" };
  }

  const lineTokens = tokens(line.name);
  const scored = hits
    .map((p) => ({ p, vendor: vendorIn(line.name, p.vendor), shared: overlap(lineTokens, tokens(p.title)) }))
    .sort((a, b) => Number(b.vendor) - Number(a.vendor) || b.shared - a.shared);

  if (hits.length === 1) {
    const [only] = scored;

    if (eanHits.length) {
      if (eanHits.some((p) => p.id === only.p.id)) {
        // Two independent keys agree: this is the product, whatever the names look like.
        return { status: "matched", via: "tag", productId: only.p.id, candidates: [], reason: "Varenummer-tagg og EAN stemmer" };
      }
      // The barcode belongs to a different product than the tag does: one of them is wrong, and a price
      // written to the wrong product is worse than a question. The operator decides.
      return {
        status: "doubtful",
        via: "tag",
        productId: only.p.id,
        candidates: eanHits.map((p) => p.id),
        reason: `Varenummeret peker på «${only.p.title}», men EAN peker på «${eanHits[0].title}» – kontroller hvilken som er riktig`,
      };
    }

    if (!only.vendor && only.shared === 0) {
      return {
        status: "doubtful",
        via: "tag",
        productId: only.p.id,
        candidates: [],
        reason: "Varenummeret passer, men verken merke eller tittel ligner – kontroller",
      };
    }
    const sizes = sizesConflict(line.name, only.p.title);
    if (sizes) {
      return {
        status: "doubtful",
        via: "tag",
        productId: only.p.id,
        candidates: [],
        reason: `Varenummeret passer, men størrelsen er ikke den samme (faktura ${sizes.invoice} g/ml, Shopify ${sizes.product} g/ml) – kontroller at det er riktig produkt`,
      };
    }
    return { status: "matched", via: "tag", productId: only.p.id, candidates: [], reason: "Varenummer-tagg" };
  }

  // The article number is on several products: the EAN, then the vendor, must single one out.
  const byBarcode = scored.filter((s) => eanHits.some((p) => p.id === s.p.id));
  if (byBarcode.length === 1) {
    return {
      status: "matched",
      via: "tag",
      productId: byBarcode[0].p.id,
      candidates: [],
      reason: `Varenummeret finnes på ${hits.length} produkter – valgt etter EAN`,
    };
  }
  const vendorHits = scored.filter((s) => s.vendor);
  if (vendorHits.length === 1) {
    return {
      status: "matched",
      via: "tag",
      productId: vendorHits[0].p.id,
      candidates: [],
      reason: `Varenummeret finnes på ${hits.length} produkter – valgt etter merke (${vendorHits[0].p.vendor})`,
    };
  }
  return {
    status: "doubtful",
    via: "tag",
    productId: null,
    candidates: scored.map((s) => s.p.id),
    reason: `Varenummeret finnes på ${hits.length} produkter og merket avgjør ikke – velg riktig`,
  };
}
