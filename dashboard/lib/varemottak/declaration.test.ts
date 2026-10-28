/**
 * Customs declaration reader against the client's answer key: four real Nor Lines declarations
 * (fwter/package/B_Customs_register_module5) and the expected per-item CSV + summary totals
 * produced by the reference parser. Client files: skipped where absent.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { controlDeclaration, dutyKrPerKg, packagingFeesNok, parseDeclaration, type ParsedDeclaration } from "./declaration";

const BASE = path.resolve(__dirname, "../../../fwter/package/B_Customs_register_module5");
const PDF = (n: string) => path.join(BASE, "1_example_declarations", `${n}.pdf`);
const CSV = (n: string) => path.join(BASE, "2_expected_output", `${n}.csv`);
const TOTALS = path.join(BASE, "2_expected_output", "summary_totals.json");
const FILES = ["87566", "89492", "89060", "88405"];
const have = existsSync(TOTALS) && FILES.every((n) => existsSync(PDF(n)) && existsSync(CSV(n)));

/** Comma separated, double quotes around fields that need them. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) {
      if (ch === String.fromCharCode(13) && text[i + 1] === String.fromCharCode(10)) i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/**
 * Known gaps in the answer key: these items carry "ArtikkelNr: …" in the PDF (same place as every
 * other item), but the reference parser's pdftotext line split missed it, so the CSV has it empty.
 * The reader returns the printed number; here we only require that one was found.
 */
const ARTICLE_MISSING_IN_KEY: Record<string, number[]> = {
  "89492": [5, 14, 20, 23, 38, 44, 47, 65, 68, 71, 80, 92],
};

const n = (s: string) => (s === "" ? null : Number(s));
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

interface Totals {
  goods_items: number;
  currency: string;
  invoice_total: number;
  rate: number;
  date?: string;
  mv_base_total: number;
  stat_value_total: number;
  tax_totals: Record<string, number>;
}

describe.skipIf(!have)("customs declaration reader vs the expected output", () => {
  const totals = have ? (JSON.parse(readFileSync(TOTALS, "utf8")) as Record<string, Totals>) : {};

  for (const file of FILES) {
    it(
      `${file}: every goods item and the header match`,
      async () => {
        const t0 = Date.now();
        const d: ParsedDeclaration = await parseDeclaration(new Uint8Array(readFileSync(PDF(file))));
        const ms = Date.now() - t0;
        const expected = parseCsv(readFileSync(CSV(file), "utf8"));
        const codes = Object.keys(expected[0]).filter((k) => k.endsWith("_amount")).map((k) => k.slice(0, 2));

        expect(d.items.length).toBe(expected.length);
        const diffs: string[] = [];
        const near = (a: number | null | undefined, b: number | null, tol = 0.005) =>
          (a ?? null) === null || b === null ? (a ?? null) === b : Math.abs(a! - b) <= tol;
        expected.forEach((e, i) => {
          const it = d.items[i];
          const at = `${file} vp ${e.varepost}`;
          const want: Array<[string, unknown, unknown, boolean]> = [
            ["varepost", it.varepost, Number(e.varepost), it.varepost === Number(e.varepost)],
            ["page", it.page, Number(e.page), it.page === Number(e.page)],
            ARTICLE_MISSING_IN_KEY[file]?.includes(Number(e.varepost)) && e.article_no === ""
              ? ["article_no", it.articleNo, "a printed number", /^\d+$/.test(it.articleNo)]
              : ["article_no", it.articleNo, e.article_no, it.articleNo === e.article_no],
            ["name", ws(it.name), ws(e.name), ws(it.name) === ws(e.name)],
            ["cn8", it.cn8, e.cn8, it.cn8 === e.cn8],
            ["origin", it.origin, e.origin, it.origin === e.origin],
            ["gross_kg", it.grossKg, n(e.gross_kg), near(it.grossKg, n(e.gross_kg))],
            ["net_kg", it.netKg, n(e.net_kg), near(it.netKg, n(e.net_kg))],
            ["stat_value_nok", it.statValueNok, n(e.stat_value_nok), near(it.statValueNok, n(e.stat_value_nok))],
            ["duty_kr_per_kg", dutyKrPerKg(it), n(e.duty_kr_per_kg_TL_RT), near(dutyKrPerKg(it), n(e.duty_kr_per_kg_TL_RT), 0.006)],
          ];
          for (const c of codes) {
            const amount = it.taxes[c]?.amount ?? 0;
            const rate = it.taxes[c]?.rate ?? null;
            want.push([`${c}_amount`, amount, n(e[`${c}_amount`]) ?? 0, near(amount, n(e[`${c}_amount`]) ?? 0)]);
            want.push([`${c}_rate`, rate, n(e[`${c}_rate`]), near(rate, n(e[`${c}_rate`]))]);
          }
          const extra = Object.keys(it.taxes).filter((c) => !codes.includes(c));
          if (extra.length) diffs.push(`${at}: codes not in the CSV: ${extra.join(", ")}`);
          for (const [field, got, exp, ok] of want) if (!ok) diffs.push(`${at} ${field}: got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
        });
        expect(diffs).toEqual([]);

        const tot = totals[file];
        expect(d.number).toBe(file);
        expect(d.status).toBe(file === "89492" ? "final" : "draft"); // README: only 89492 is LINJEDEKLARERT
        expect(d.reference?.startsWith(`${file} - `)).toBe(true);
        expect(d.packages).toBeGreaterThan(0);
        expect(d.itemsDeclared).toBe(tot.goods_items);
        expect(d.currency).toBe(tot.currency);
        expect(d.invoiceTotal).toBeCloseTo(tot.invoice_total, 2);
        expect(d.rate).toBeCloseTo(tot.rate, 4);
        if (tot.date) expect(d.date).toBe(tot.date);
        expect(d.mvBaseTotal).toBeCloseTo(tot.mv_base_total, 2);
        expect(d.items.reduce((s, it) => s + (it.statValueNok ?? 0), 0)).toBeCloseTo(tot.stat_value_total, 2);
        const taxTotals: Record<string, number> = {};
        for (const it of d.items) for (const [c, v] of Object.entries(it.taxes)) taxTotals[c] = (taxTotals[c] ?? 0) + v.amount;
        for (const c of Object.keys(taxTotals)) if (taxTotals[c] === 0 && !(c in tot.tax_totals)) delete taxTotals[c];
        expect(Object.keys(taxTotals).sort()).toEqual(Object.keys(tot.tax_totals).sort());
        for (const [c, v] of Object.entries(tot.tax_totals)) expect(taxTotals[c]).toBeCloseTo(v, 2);
        const pack = d.items.reduce((s, it) => s + packagingFeesNok(it), 0);
        const packWant = ["GP", "MP", "GG", "GB", "MB", "MG", "GA"].reduce((s, c) => s + (tot.tax_totals[c] ?? 0), 0);
        expect(pack).toBeCloseTo(packWant, 2);

        const control = controlDeclaration(d);
        expect(control.checks.filter((c) => !c.ok)).toEqual([]);
        expect(control.ok).toBe(true);
        console.log(`${file}: ${d.items.length} items, ${d.status}, ${d.date}, ${ms} ms\n  ` + control.checks.map((c) => `${c.code}: ${c.text}`).join("\n  "));
      },
      240_000,
    );
  }
});
