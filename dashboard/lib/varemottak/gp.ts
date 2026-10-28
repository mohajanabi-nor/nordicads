/**
 * Grønt Punkt: the packaging report for imported beverages, filed every two months
 * as "Vareimportør".
 *
 * Periods are fixed two-month terms named like the portal's: 2026-RT3 = 1 May – 30 June,
 * with the report due on the 22nd of the month after the term ends.
 *
 * Quantity per code = units imported in the period (by the shipment's arrival date).
 * Plastic bottles are reported in kg, so each such product carries the packaging weight
 * of one bottle; every other category is reported in pieces.
 */
import { DRINK_HS_PREFIXES } from "./calc";

export interface Term {
  /** "2026-RT3" */
  code: string;
  year: number;
  /** 1–6 */
  number: number;
  /** ISO dates, inclusive. */
  start: string;
  end: string;
  /** The 22nd of the month after the term. */
  deadline: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function termOf(year: number, number: number): Term {
  const startMonth = (number - 1) * 2 + 1;
  const endMonth = startMonth + 1;
  const deadlineMonth = endMonth === 12 ? 1 : endMonth + 1;
  const deadlineYear = endMonth === 12 ? year + 1 : year;
  return {
    code: `${year}-RT${number}`,
    year,
    number,
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay(year, endMonth))}`,
    deadline: `${deadlineYear}-${pad(deadlineMonth)}-22`,
  };
}

/** The term a date (ISO, YYYY-MM-DD) falls in. */
export function termForDate(date: string): Term {
  const [y, m] = date.split("-").map(Number);
  return termOf(y, Math.ceil(m / 2));
}

export function previousTerm(t: Term): Term {
  return t.number === 1 ? termOf(t.year - 1, 6) : termOf(t.year, t.number - 1);
}

export function sameTermLastYear(t: Term): Term {
  return termOf(t.year - 1, t.number);
}

export function parseTermCode(code: string): Term | null {
  const m = code.match(/^(\d{4})-RT([1-6])$/);
  return m ? termOf(Number(m[1]), Number(m[2])) : null;
}

export const isBeverageHs = (hs: string | null | undefined) => {
  const d = (hs ?? "").replace(/\D/g, "");
  return DRINK_HS_PREFIXES.some((p) => d.startsWith(p));
};

// ------------------------------------------------------------------ suggestions

export interface GpSuggestion {
  code: string | null;
  /** Why — shown next to the suggestion. The operator confirms; nothing is assigned silently. */
  reason: string;
}

/** Millilitres written in a drink's name: "0,5l", "0.25 l", "330ml", "2.0l". */
export function volumeMl(name: string): number | null {
  const t = name.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  const m = t.match(/(?<![\d.])(\d+(?:\.\d+)?)\s*(ml|cl|l|ltr)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "ml" ? n : m[2] === "cl" ? n * 10 : n * 1000;
}

/**
 * A starting suggestion from the product name, for the operator to confirm once per
 * product. It only ever suggests codes that exist in the client's list; a small
 * aluminium can (0–250 ml) has no code there, so it says so instead of guessing.
 */
export function suggestGpCode(name: string): GpSuggestion {
  const t = name.toLowerCase();
  const ml = volumeMl(name);
  const pet = /\bpet\b|plastic|plast\b/.test(t);
  const glass = /\bglass\b|\bglas\b|\bszk/.test(t);
  const can = /\bcans?\b|\bcan\b|\bpus[zk]|\bdose\b|\bboks\b|alumin/.test(t);
  const carton = /\bcarton\b|\bkarton|tetra/.test(t);

  if (pet) return { code: "1017", reason: "Plastflaske – rapporteres i kg (legg inn vekt per flaske)" };
  if (carton) return { code: "2001", reason: "Drikkekartong" };
  if (glass) {
    if (ml !== null && ml <= 250) return { code: "4005", reason: "Glass 0–250 ml" };
    return { code: null, reason: "Glass over 250 ml – ingen kode i listen, legg til kategori" };
  }
  if (can) {
    if (ml !== null && ml >= 251 && ml <= 500) return { code: "5020", reason: "Aluminium 251–500 ml" };
    if (ml !== null && ml <= 250) return { code: null, reason: "Aluminiumsboks 0–250 ml – ingen kode i listen, legg til kategori" };
    return { code: null, reason: "Boks, men størrelsen er ukjent" };
  }
  return { code: null, reason: "Emballasjetype kunne ikke leses av navnet" };
}

// ------------------------------------------------------------------ the report

export interface GpCategory {
  code: string;
  name: string;
  unit: "kg" | "pcs";
  sort: number;
}

export interface GpRate {
  code: string;
  valid_from: string;
  rate: number;
}

/** The rate in force on a date: the latest one that started on or before it. */
export function rateOn(rates: GpRate[], code: string, date: string): number | null {
  const hit = rates
    .filter((r) => r.code === code && r.valid_from <= date)
    .sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0];
  return hit ? hit.rate : null;
}

export interface GpImportedUnits {
  /** The shipment's arrival date. */
  arrivalDate: string;
  code: string;
  /** Units imported: pieces. */
  units: number;
  /** Packaging weight per piece, kg — needed only for kg categories. */
  packagingKg: number | null;
  /** For the trail back to what was counted. */
  idx?: string;
  name?: string;
}

export interface GpReportLine {
  code: string;
  name: string;
  unit: "kg" | "pcs";
  quantity: number;
  rate: number | null;
  sum: number | null;
  previousPeriod: number;
  sameLastYear: number;
}

export interface GpReport {
  term: Term;
  previous: Term;
  lastYear: Term;
  lines: GpReportLine[];
  total: number;
  /** Items that could not be counted, so the total is not silently low. */
  problems: string[];
}

function quantityFor(rows: GpImportedUnits[], cat: GpCategory, term: Term): { quantity: number; missingWeight: string[] } {
  let quantity = 0;
  const missingWeight: string[] = [];
  for (const r of rows) {
    if (r.code !== cat.code || r.arrivalDate < term.start || r.arrivalDate > term.end) continue;
    if (cat.unit === "kg") {
      if (r.packagingKg === null || !(r.packagingKg > 0)) {
        missingWeight.push(r.name ?? r.idx ?? "?");
        continue;
      }
      quantity += r.units * r.packagingKg;
    } else quantity += r.units;
  }
  return { quantity, missingWeight };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildReport(
  term: Term,
  categories: GpCategory[],
  rates: GpRate[],
  rows: GpImportedUnits[],
): GpReport {
  const previous = previousTerm(term);
  const lastYear = sameTermLastYear(term);
  const problems: string[] = [];
  const lines: GpReportLine[] = [];

  for (const cat of [...categories].sort((a, b) => a.sort - b.sort)) {
    const now = quantityFor(rows, cat, term);
    if (now.missingWeight.length) {
      problems.push(`${cat.code}: mangler vekt per flaske for ${Array.from(new Set(now.missingWeight)).join(", ")}`);
    }
    const rate = rateOn(rates, cat.code, term.end);
    if (rate === null && now.quantity > 0) problems.push(`${cat.code}: ingen sats gjelder for ${term.code}`);
    lines.push({
      code: cat.code,
      name: cat.name,
      unit: cat.unit,
      quantity: r2(now.quantity),
      rate,
      sum: rate === null ? null : r2(now.quantity * rate),
      previousPeriod: r2(quantityFor(rows, cat, previous).quantity),
      sameLastYear: r2(quantityFor(rows, cat, lastYear).quantity),
    });
  }

  const known = new Set(categories.map((c) => c.code));
  const stray = rows.filter((r) => !known.has(r.code) && r.arrivalDate >= term.start && r.arrivalDate <= term.end);
  if (stray.length) problems.push(`Ukjent kategori brukt på: ${Array.from(new Set(stray.map((r) => r.code))).join(", ")}`);

  return { term, previous, lastYear, lines, total: r2(lines.reduce((a, l) => a + (l.sum ?? 0), 0)), problems };
}

/** CSV the client can read while typing into the portal: the portal's own column order. */
export function reportCsv(report: GpReport): string {
  const esc = (s: string | number | null) => {
    const v = s === null ? "" : String(s);
    return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const num = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
  const rows = [
    ["Kode", "Emballasjetype/produkt", "Enhet", "Forrige periode", "Samme periode i fjor", "Denne perioden", "Pris pr. enhet", "Sum"],
    ...report.lines.map((l) => [l.code, l.name, l.unit === "kg" ? "kg" : "stk", num(l.previousPeriod), num(l.sameLastYear), num(l.quantity), num(l.rate), num(l.sum)]),
    ["", "", "", "", "", "", "Totalbeløp (ekskl. mva.)", num(report.total)],
  ];
  return rows.map((r) => r.map(esc).join(";")).join("\r\n");
}
