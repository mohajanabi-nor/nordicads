/**
 * OPT-IN: one real call to Claude with the Stanro PDF, compared with the same invoice's CSV.
 *
 *   CLAUDE_PDF_LIVE=1 npx vitest run lib/varemottak/pdf-claude.live.test.ts
 *
 * The raw answer is cached in fwter/ (git-ignored), so later runs compare without calling the API again.
 * The API key is read from dashboard/.env.local into memory only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractInvoiceFromPdf } from "./suppliers/pdf-claude";
import { parseStanroCsv } from "./suppliers/stanro";

const F = path.resolve(__dirname, "../../../fwter");
const PDF = path.join(F, "000033-S33-2026.pdf");
const CSV = path.join(F, "000033_S33_2026_spec.csv");
const CACHE = path.join(F, "claude-extraction-stanro.json");
const enabled = (process.env.CLAUDE_PDF_LIVE === "1" || existsSync(CACHE)) && existsSync(PDF) && existsSync(CSV);

function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const env = readFileSync(path.resolve(__dirname, "../../.env.local"), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (line) process.env.ANTHROPIC_API_KEY = line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

describe.skipIf(!enabled)("Claude reads the Stanro PDF", () => {
  it("gives the same lines as the CSV", async () => {
    let text: string;
    let model = "cached";
    if (existsSync(CACHE)) {
      ({ text, model } = JSON.parse(readFileSync(CACHE, "utf8")));
    } else {
      loadKey();
      let captured = { text: "", model: "" };
      const { callClaude } = await import("../price-extraction");
      await extractInvoiceFromPdf(new Uint8Array(readFileSync(PDF)), {
        supplier: "Stanro",
        currency: "PLN",
        call: async (content, max, callOpts) => {
          captured = await callClaude(content as never, max, callOpts);
          writeFileSync(CACHE, JSON.stringify(captured));
          return captured;
        },
      }).catch((e) => console.log("EXTRACTION ERROR:", e.message));
      ({ text, model } = captured);
    }
    // The Stanro PDF prints no article numbers, so mapExtraction refuses it (correctly). Compare the raw reading instead:
    // every PDF line must have a CSV line with the same quantity and value.
    const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as {
      net_total: number;
      lines: Array<[number, string | null, string, number, string, number, number]>;
      services: Array<[string, number]>;
    };
    const csv = parseStanroCsv(new Uint8Array(readFileSync(CSV)), "spec.csv");
    const pool = csv.lines.map((l) => ({ qty: l.qty ?? 0, value: l.lineValue ?? 0, used: false }));
    let unmatched = 0;
    for (const l of raw.lines) {
      // Supplier lines are rounded to the cent one by one, so allow a cent of difference.
      const hit = pool.find((c) => !c.used && Math.abs(c.qty - l[3]) < 0.001 && Math.abs(c.value - l[6]) <= 0.011);
      if (hit) hit.used = true;
      else unmatched++;
    }
    const csvValue = csv.lines.reduce((a, l) => a + (l.lineValue ?? 0), 0);
    const pdfValue = raw.lines.reduce((a, l) => a + l[6], 0);
    console.log("CLAUDE MODEL:", model);
    console.log("PDF LINES:", raw.lines.length, "| CSV LINES:", csv.lines.length, "| PDF lines without a CSV line of same qty+value:", unmatched);
    console.log("VALUE: pdf lines", pdfValue.toFixed(2), "| csv lines", csvValue.toFixed(2), "| services", raw.services.map((x) => x[1]).join("+"), "| printed total", raw.net_total);
    expect(unmatched).toBe(0);
  }, 600_000);
});
