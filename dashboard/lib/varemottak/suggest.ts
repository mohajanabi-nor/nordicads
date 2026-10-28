/**
 * When the system cannot tell which Shopify product an invoice line is, it proposes the ones it
 * thinks it may be — ranked, each with the reasons — and the operator picks one. This is the ranking.
 *
 * It never decides anything: a high score only puts a candidate higher in the list. The picker
 * also lets the operator search for any product, because the proposals can be wrong or incomplete.
 *
 * Signals, strongest first: the barcode, the article number as a tag, the pack size, the size in the
 * name ("130 g"), the brand, and words the two names share.
 */
import { titlePackCount } from "./carton";
import { tokens } from "./match";
import type { ShopProduct } from "./shopify/types";

export interface CandidateInput {
  idx: string;
  name: string;
  ean?: string | null;
  eanBox?: string | null;
  /** Pieces per carton according to the invoice, when it divides evenly. */
  pcsPerCarton?: number | null;
}

export interface RankedCandidate {
  product: ShopProduct;
  score: number;
  /** Short Norwegian phrases shown next to the candidate. */
  reasons: string[];
}

const barcodeKey = (b: string) => b.replace(/^0+/, "");

/** Sizes written in a name, normalised to grams or millilitres: "130G" → 130, "1,5 kg" → 1500, "0.5l" → 500. */
export function sizesIn(text: string): number[] {
  const t = text.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(kg|g|gr|ml|cl|dl|l|ltr)\b/g)) {
    const n = Number(m[1]);
    const unit = m[2];
    out.push(unit === "kg" || unit === "l" || unit === "ltr" ? n * 1000 : unit === "cl" ? n * 10 : unit === "dl" ? n * 100 : n);
  }
  return out;
}

const strip = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");

export function rankCandidates(line: CandidateInput, pool: ShopProduct[], limit = 8): RankedCandidate[] {
  const wanted = tokens(line.name);
  const lineSizes = sizesIn(line.name);
  const eanKeys = [line.ean, line.eanBox].filter((e): e is string => !!e).map(barcodeKey);
  const idx = line.idx.toLowerCase();
  const nameText = strip(line.name);

  const seen = new Set<string>();
  const ranked: RankedCandidate[] = [];
  for (const product of pool) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);

    let score = 0;
    const reasons: string[] = [];

    if (eanKeys.length && product.barcodes.some((b) => eanKeys.includes(barcodeKey(b)))) {
      score += 12;
      reasons.push("EAN stemmer");
    }
    if (product.tags.some((t) => t.toLowerCase() === idx)) {
      score += 10;
      reasons.push("Varenummeret er tagg på produktet");
    }

    const shared = Array.from(tokens(`${product.title} ${product.vendor}`)).filter((w) => wanted.has(w));
    if (shared.length) {
      score += 2 * shared.length;
      reasons.push(`${shared.length} felles ord (${shared.slice(0, 3).join(", ")})`);
    }

    const vendor = strip(product.vendor).replace(/[^a-z0-9 ]/g, "").trim();
    if (vendor.length >= 3 && nameText.includes(vendor)) {
      score += 4;
      reasons.push(`Merket «${product.vendor}» står i navnet`);
    }

    const productSizes = sizesIn(product.title);
    const sameSize = lineSizes.find((s) => productSizes.some((p) => Math.abs(p - s) <= Math.max(1, s * 0.01)));
    if (sameSize !== undefined) {
      score += 4;
      reasons.push(`Samme størrelse (${sameSize >= 1000 ? `${sameSize / 1000} kg/l` : `${sameSize} g/ml`})`);
    }

    const pack = titlePackCount(product.title);
    if (line.pcsPerCarton && pack === line.pcsPerCarton) {
      score += 2;
      reasons.push(`Samme antall per kartong (${pack})`);
    }

    // A new product is a draft, so a draft is slightly more likely than a long-established product.
    if (score > 0 && product.status === "DRAFT") {
      score += 1;
      reasons.push("Utkast (ny vare)");
    }

    if (score > 0) ranked.push({ product, score, reasons });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The words worth searching for: the longest distinctive ones, brand-like words first. */
export function searchWords(name: string, max = 3): string[] {
  const words = Array.from(tokens(name)).filter((w) => w.length >= 4);
  return words.sort((a, b) => b.length - a.length).slice(0, max);
}
