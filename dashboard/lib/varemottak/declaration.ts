/**
 * Customs declaration reader — Tolletaten SAD layout as printed by the forwarder (Nor Lines).
 *
 * Deterministic, position based: every value is read from the pdf.js text items under its box
 * label, by x/y and font size. Field values are 10 pt, the goods description 8 pt and labels 6 pt,
 * so a long description running into the origin box is told apart by size, not by string offset.
 *
 * Layout: page 1 = header + goods item 1; later pages hold up to 3 items each; the last page(s)
 * are the VAT summary (one MV row per item, then one total row per VAT rate). Tax block (box 47):
 * page 1 belongs to item 1; on later pages the left column is the 1st item, the right column the
 * 2nd, and the block under "Sum første varepost" the 3rd (its right side is the page SAMMENDRAG).
 *
 * The control rule (sum stat. value + all taxes except MV = sum MV bases) must pass before anything
 * is written to the register.
 */

export interface DeclarationItem {
  varepost: number;
  page: number;
  articleNo: string;
  name: string;
  cn8: string;
  origin: string;
  grossKg: number | null;
  netKg: number | null;
  statValueNok: number | null;
  /** Keyed by the 2-letter code (TL, RT, FA, GP, …), MV excluded. Repeated codes are summed. */
  taxes: Record<string, { amount: number; rate: number | null }>;
}

export interface ParsedDeclaration {
  number: string | null;
  status: "final" | "draft" | "unknown";
  statusText: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  currency: string | null;
  invoiceTotal: number | null;
  rate: number | null;
  itemsDeclared: number | null;
  packages: number | null;
  reference: string | null;
  mvBaseTotal: number;
  items: DeclarationItem[];
}

/** One text item; `top` grows downward from the top of the page (pdfplumber convention). */
interface T {
  s: string;
  x: number;
  x1: number;
  top: number;
  fs: number;
}

const BIG = 9; // field values are 10 pt, descriptions 8 pt
const NUM = /^\d[\d\s ]*(?:,\d+)?$/;
const CODE = /^[A-Z]{2}$/;

const num = (s: string): number => Number(s.replace(/[\s ]/g, "").replace(",", "."));
const isBig = (t: T) => t.fs > BIG;
const byPos = (a: T, b: T) => Math.round(a.top) - Math.round(b.top) || a.x - b.x;

async function readPages(bytes: Uint8Array): Promise<T[][]> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const pages: T[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const h = page.getViewport({ scale: 1 }).height;
    const content = await page.getTextContent();
    const items: T[] = [];
    for (const it of content.items as { str?: string; transform: number[]; width: number }[]) {
      const s = it.str?.trim();
      if (!s) continue;
      const [, , c, d, x, y] = it.transform;
      items.push({ s, x, x1: x + it.width, top: h - y, fs: Math.hypot(c, d) });
    }
    pages.push(items.sort(byPos));
    page.cleanup();
  }
  return pages;
}

/** First label starting with `prefix` below `after` (labels are 6 pt). */
function label(items: T[], prefix: string, after = -Infinity): T | undefined {
  return items.find((t) => t.top > after && t.fs < BIG && t.s.startsWith(prefix));
}

function band(items: T[], x0: number, x1: number, t0: number, t1: number): T[] {
  return items.filter((t) => t.x >= x0 && t.x < x1 && t.top > t0 && t.top < t1);
}

const sameRow = (a: T, b: T) => Math.abs(a.top - b.top) < 2;

// ---- header ---------------------------------------------------------------------------------

function readHeader(p1: T[]) {
  // Values sit in the row under their 6 pt label (the box-7 reference is 7 pt).
  const below = (l: T | undefined, x1: number) => (l ? band(p1, l.x - 2, x1, l.top + 2, l.top + 20).filter((t) => t.fs >= 6.5) : []);
  const L22 = label(p1, "22 Fakturert");
  const L23 = label(p1, "23 Omregning");
  const L24 = label(p1, "24 ");
  const L5 = label(p1, "5 Vareposter");
  const L6 = label(p1, "6 Antall kolli");
  const L7 = label(p1, "7 Referanse");

  const cur = below(L22, L23?.x ?? 450);
  const currency = cur.find((t) => /^[A-Z]{3}$/.test(t.s))?.s ?? null;
  const totalTok = cur.find((t) => NUM.test(t.s) && t.s.includes(","));
  const rateTok = below(L23, L24?.x ?? 516).find((t) => NUM.test(t.s));
  const itemsTok = below(L5, L6?.x ?? 361).find((t) => /^\d+$/.test(t.s));
  const pkgTok = below(L6, L7?.x ?? 422).find((t) => /^\d+$/.test(t.s));
  const refToks = below(L7, Infinity);

  let status: ParsedDeclaration["status"] = "unknown";
  let statusText: string | null = null;
  for (const t of p1) {
    if (/LINJEDEKLARERT/i.test(t.s)) [status, statusText] = ["final", t.s];
    else if (/MANGLER\s+GODKJENNING/i.test(t.s)) [status, statusText] = ["draft", t.s];
    if (statusText) break;
  }
  const d = p1.find((t) => /^20\d{6}$/.test(t.s))?.s;

  return {
    status,
    statusText,
    date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
    currency,
    invoiceTotal: totalTok ? num(totalTok.s) : null,
    rate: rateTok ? num(rateTok.s) : null,
    itemsDeclared: itemsTok ? Number(itemsTok.s) : null,
    packages: pkgTok ? Number(pkgTok.s) : null,
    reference: refToks.length ? refToks.map((t) => t.s).join(" ") : null,
  };
}

// ---- goods items ----------------------------------------------------------------------------

function readItem(items: T[], anchor: T, page: number): Omit<DeclarationItem, "varepost"> & { varepost: number | null } {
  const y = anchor.top - 20;
  const L34 = label(items, "34 Kode", y);
  const L35 = label(items, "35 Brutto", y);
  const L36 = label(items, "36", y);
  const L37 = items.find((t) => t.top > y && t.fs < BIG && /^37(\s|$)/.test(t.s));
  const L38 = label(items, "38 Netto", y);
  const L39 = label(items, "39 Kvot", y);
  const L46 = label(items, "46 Statist", y);
  const big = items.filter(isBig);
  const small = items.filter((t) => !isBig(t));

  // Box 32/33: varepost and tariff number, on or near the "Merke:" line.
  let varepost: number | null = null;
  let cn8 = "";
  const cnTok = big.find((t) => /^\d{4}\.\d{2}(\s+\d{2})?$/.test(t.s) && Math.abs(t.top - anchor.top) < 14);
  if (cnTok) {
    const [head, tail] = cnTok.s.split(/\s+/);
    const sub = tail ?? big.find((t) => /^\d{2}$/.test(t.s) && t.x > cnTok.x1 && sameRow(t, cnTok))?.s;
    if (sub) cn8 = head.replace(".", "") + sub;
    const vp = big.filter((t) => /^\d{1,4}$/.test(t.s) && t.x1 < cnTok.x && t.x > 300 && Math.abs(t.top - anchor.top) < 14);
    if (vp.length) varepost = Number(vp[vp.length - 1].s);
  }

  // ArtikkelNr: same text block as "Merke:", above the box-34 label row.
  let articleNo = "";
  const art = small.find((t) => t.s.includes("ArtikkelNr:") && t.top > anchor.top - 6 && t.top < (L34?.top ?? anchor.top + 14));
  if (art) {
    const after = art.s.split("ArtikkelNr:")[1].trim();
    articleNo = after
      ? after.split(/\s+/)[0]
      : (small.find((t) => t.x >= art.x1 - 1 && sameRow(t, art))?.s.split(/\s+/)[0] ?? "");
  }

  let origin = "";
  let grossKg: number | null = null;
  let netKg: number | null = null;
  let statValueNok: number | null = null;
  let name = "";
  if (L34 && L35 && L36 && L37) {
    const o = band(big, L34.x - 8, L35.x - 5, L34.top + 2, L37.top - 2).find((t) => /^[A-Z]{2}$/.test(t.s));
    if (o) origin = o.s;
    const g = band(big, L35.x, L36.x, L35.top + 2, L37.top - 2);
    if (g.length) grossKg = num(g.map((t) => t.s).join(" "));
    // Description: 8 pt text from "Vareslag:" down to the box-37 row (may wrap).
    const vs = small.find((t) => t.s.startsWith("Vareslag:") && t.top > L34.top - 15 && t.top < L37.top);
    if (vs) {
      name = band(small, vs.x, Infinity, vs.top - 2, L37.top - 2)
        .sort(byPos)
        .map((t) => t.s)
        .join(" ")
        .replace(/^Vareslag:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  if (L38 && L39) {
    const n = band(big, L38.x, L39.x, L38.top + 2, L38.top + 20);
    if (n.length) netKg = num(n.map((t) => t.s).join(" "));
  }
  if (L46) {
    const v = band(big, L46.x, Infinity, L46.top + 2, L46.top + 18).filter((t) => NUM.test(t.s));
    if (v.length) statValueNok = num(v.map((t) => t.s).join(""));
  }
  return { varepost, page, articleNo, name, cn8, origin, grossKg, netKg, statValueNok, taxes: {} };
}

// ---- box 47: tax rows -----------------------------------------------------------------------

interface TaxRow {
  code: string;
  rate: number;
  amount: number;
  x: number;
  top: number;
}

/** "TL  90,00  24,68  2 221  K": code, base, rate, amount, optional BM letter. */
function taxRows(items: T[], fromTop: number, toTop: number, split: number): TaxRow[] {
  const rows: TaxRow[] = [];
  for (const c of items) {
    if (!CODE.test(c.s) || !isBig(c) || c.top <= fromTop || c.top >= toTop) continue;
    const colEnd = c.x < split ? split : Infinity;
    const nums = items.filter((t) => t.x > c.x1 && t.x < colEnd && sameRow(t, c) && NUM.test(t.s)).sort((a, b) => a.x - b.x);
    if (nums.length < 3) continue; // SAMMENDRAG rows have no base/rate
    rows.push({ code: c.s, rate: num(nums[1].s), amount: num(nums[2].s), x: c.x, top: c.top });
  }
  return rows;
}

function assignTaxes(items: T[], pageItems: DeclarationItem[], firstPage: boolean) {
  const headers = items.filter((t) => t.s === "Type" && t.fs < BIG).sort(byPos);
  if (!headers.length || !pageItems.length) return;
  const head = headers[0];
  const right = headers.find((t) => t.x > head.x + 150 && sameRow(t, head));
  const split = right ? right.x - 2 : (label(items, "48 ", head.top - 2)?.x ?? 316) - 2;
  const first = items.find((t) => t.s.startsWith("Sum første varepost"));
  const third = items.find((t) => t.s.startsWith("Sum tredje varepost"));
  const end = third?.top ?? items.find((t) => t.s === "Sum:" && t.top > head.top)?.top ?? Infinity;

  const add = (idx: number, r: TaxRow) => {
    const it = pageItems[idx];
    if (!it || r.code === "MV") return;
    const cur = it.taxes[r.code];
    it.taxes[r.code] = { amount: round2((cur?.amount ?? 0) + r.amount), rate: r.rate };
  };
  if (firstPage || !first) {
    for (const r of taxRows(items, head.top, end, split)) if (r.x < split) add(0, r);
    return;
  }
  for (const r of taxRows(items, head.top, first.top, split)) add(r.x < split ? 0 : 1, r);
  for (const r of taxRows(items, first.top, end, split)) if (r.x < split) add(2, r);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- VAT summary ----------------------------------------------------------------------------

/** Sum of the MV bases on the summary page(s): the per-rate total rows (no Ln# in front). */
function readSummary(pages: T[][]): { mvBaseTotal: number; number: string | null; date: string | null } {
  const start = pages.findIndex((p) => p.some((t) => t.s === "Ln#" || t.s.startsWith("OppdragsNr")));
  if (start < 0) return { mvBaseTotal: 0, number: null, date: null };
  let totals = 0;
  let lines = 0;
  let found = false;
  for (const items of pages.slice(start)) {
    for (const mv of items.filter((t) => t.s === "MV")) {
      const row = items.filter((t) => t !== mv && sameRow(t, mv) && NUM.test(t.s));
      const left = row.filter((t) => t.x < mv.x);
      const rightNums = row.filter((t) => t.x > mv.x).sort((a, b) => a.x - b.x);
      if (!rightNums.length) continue;
      if (left.length) lines += num(rightNums[0].s);
      else if (rightNums.length >= 3) {
        totals += num(rightNums[0].s);
        found = true;
      }
    }
  }
  const sp = pages[start];
  const right = (lab: string) => {
    const l = sp.find((t) => t.s.startsWith(lab));
    return l ? sp.filter((t) => t.x > l.x1 && Math.abs(t.top - l.top) < 3 && t.fs >= 8).sort((a, b) => a.x - b.x)[0]?.s : undefined;
  };
  const no = right("OppdragsNr");
  const dm = right("DeklarasjonsID")?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return {
    mvBaseTotal: found ? totals : lines,
    number: no && /^\d+$/.test(no) ? no : null,
    date: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null,
  };
}

// ---- public API -----------------------------------------------------------------------------

export async function parseDeclaration(bytes: Uint8Array): Promise<ParsedDeclaration> {
  const pages = await readPages(bytes);
  const header = readHeader(pages[0] ?? []);
  const items: DeclarationItem[] = [];
  pages.forEach((pageItems, i) => {
    const anchors = pageItems.filter((t) => t.s.includes("Merke:")).sort((a, b) => a.top - b.top);
    const onPage: DeclarationItem[] = [];
    for (const a of anchors) {
      const it = readItem(pageItems, a, i + 1);
      const prev = onPage[onPage.length - 1] ?? items[items.length - 1];
      onPage.push({ ...it, varepost: it.varepost ?? (prev ? prev.varepost + 1 : 1) });
    }
    assignTaxes(pageItems, onPage, i === 0);
    items.push(...onPage);
  });
  const summary = readSummary(pages);
  return { number: summary.number, ...header, date: header.date ?? summary.date, mvBaseTotal: summary.mvBaseTotal, items };
}

const sumTaxes = (it: DeclarationItem) => Object.entries(it.taxes).reduce((s, [k, v]) => (k === "MV" ? s : s + v.amount), 0);
const fmt = (n: number) => Math.round(n).toLocaleString("nb-NO");

export function controlDeclaration(d: ParsedDeclaration): { ok: boolean; checks: Array<{ code: string; ok: boolean; text: string }> } {
  const checks: Array<{ code: string; ok: boolean; text: string }> = [];
  const stat = d.items.reduce((s, it) => s + (it.statValueNok ?? 0), 0);
  const taxes = d.items.reduce((s, it) => s + sumTaxes(it), 0);
  const diff = stat + taxes - d.mvBaseTotal;
  checks.push({
    code: "mv-base",
    ok: d.mvBaseTotal > 0 && Math.abs(diff) <= 1,
    text:
      d.mvBaseTotal > 0
        ? `Statistisk verdi + avgifter ${fmt(stat + taxes)} kr, MVA-grunnlag ${fmt(d.mvBaseTotal)} kr` +
          (Math.abs(diff) <= 1 ? "" : ` (avvik ${fmt(diff)} kr)`)
        : "Fant ikke MVA-grunnlag i sammendraget",
  });

  const count = d.itemsDeclared;
  checks.push({
    code: "item-count",
    ok: count !== null && d.items.length === count,
    text: count === null ? `Fant ikke antall vareposter (felt 5); lest ${d.items.length}` : `${d.items.length} av ${count} vareposter lest`,
  });

  const missing = d.items.map((it, i) => (it.varepost === i + 1 ? null : i + 1)).filter((n): n is number => n !== null);
  checks.push({
    code: "sequence",
    ok: d.items.length > 0 && missing.length === 0,
    text: missing.length ? `Varepostnummer ikke fortløpende fra post ${missing[0]}` : `Vareposter 1–${d.items.length} uten hull`,
  });

  const incomplete = d.items.filter((it) => !it.cn8 || it.statValueNok === null || it.netKg === null).map((it) => it.varepost);
  checks.push({
    code: "fields",
    ok: incomplete.length === 0,
    text: incomplete.length ? `Mangler varenummer, vekt eller verdi på post ${incomplete.slice(0, 10).join(", ")}` : "Alle poster har varenummer, nettovekt og verdi",
  });

  // Warning only: box 45 adjustments (freight etc.) make the statistical value differ from invoice × rate.
  if (d.invoiceTotal !== null && d.rate !== null) {
    const expected = d.invoiceTotal * d.rate;
    const pct = expected ? ((stat - expected) / expected) * 100 : 0;
    checks.push({
      code: "stat-value",
      ok: true,
      text:
        `Statistisk verdi ${fmt(stat)} kr, faktura × kurs ${fmt(expected)} kr` +
        (Math.abs(pct) <= 1 ? "" : ` (avvik ${pct.toFixed(1).replace(".", ",")} %, sjekk justering i felt 45)`),
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** Duty per net kg = (TL + RT) ÷ net weight, 2 decimals. FA is never included.
 *  Exact halves round to even (145 ÷ 40 = 3.625 → 3.62), as the client's reference output does. */
export function dutyKrPerKg(item: DeclarationItem): number | null {
  if (!item.netKg) return null;
  const q = ((item.taxes.TL?.amount ?? 0) + (item.taxes.RT?.amount ?? 0)) / item.netKg;
  // A double is an exact 2-decimal tie only at .125/.375/.625/.875; toFixed rounds the exact
  // binary value otherwise (12.925 is stored as 12.92500…07 → 12.93).
  if (Number.isInteger(q * 8) && !Number.isInteger(q * 4)) return (2 * Math.round((q * 100) / 2)) / 100;
  return Number(q.toFixed(2));
}

const PACKAGING = ["GP", "MP", "GG", "GB", "MB", "MG", "GA"];

/** Beverage packaging fees (GP, MP, GG, GB, MB, MG, GA) on the item, NOK. */
export function packagingFeesNok(item: DeclarationItem): number {
  return round2(PACKAGING.reduce((s, c) => s + (item.taxes[c]?.amount ?? 0), 0));
}
