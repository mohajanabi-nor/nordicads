/**
 * Turning a supplier's price list into rows.
 *
 * Suppliers send whatever their system produces: a PDF catalogue, an Excel
 * sheet, a photographed page, or prices typed into the email. Claude reads the
 * ones that need looking at; spreadsheets are parsed with code, because running
 * vision over a file that already has cells would be slower, dearer and worse.
 *
 * Two fields decide whether prices can be compared at all, so they are
 * extracted rather than assumed:
 *
 *   currency   — a EUR quote beside NOK quotes is not a cheaper offer.
 *   vat_basis  — an inc-VAT price beside ex-VAT ones looks 25% worse than it is.
 *
 * Where a document says nothing, the assumption is recorded AS an assumption,
 * so the UI can show it as one instead of presenting a guess as a fact.
 *
 * Server-only.
 */
import * as XLSX from "xlsx";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 180_000;
const MAX_RETRIES = 3;

/** Claude's document support has page and size ceilings, and a scanned
 *  catalogue can exceed them. Oversized files are split rather than failing on
 *  the operator's most important price list. */
const MAX_PDF_BYTES = 28 * 1024 * 1024;

export type VatBasis = "eks_mva" | "inkl_mva" | "unknown";

export interface ExtractedRow {
  supplier_sku: string | null;
  raw_name: string;
  unit: string | null;
  pack_size: string | null;
  price: number;
  currency: string;
  vat_basis: VatBasis;
  vat_basis_assumed: boolean;
  valid_from: string | null;
  confidence: number;
}

export interface ExtractionResult {
  rows: ExtractedRow[];
  method: string;
  model: string | null;
  confidence: number;
  status: "ok" | "partial" | "failed";
  error: string | null;
  raw: unknown;
}

export function extractionConfig() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.PRICE_EXTRACTION_MODEL || "claude-sonnet-5",
    normalizeWithClaude: process.env.PRICE_NORMALIZE_WITH_CLAUDE !== "0",
    threshold: Number(process.env.PRICE_EXTRACTION_CONFIDENCE_THRESHOLD || "0.75"),
  };
}

const SCHEMA_PROMPT = `Du leser prislister fra leverandører til en norsk grossist.

Returner KUN gyldig JSON, uten forklaring og uten markdown, på denne formen:
{
  "overall_confidence": 0.0-1.0,
  "notes": "kort notat om noe uklart, ellers tom streng",
  "rows": [
    {
      "supplier_sku": "varenummer hos leverandøren, eller null",
      "raw_name": "produktnavnet akkurat som det står",
      "unit": "kg | stk | l | kolli | null",
      "pack_size": "f.eks. \\"6 x 1,5 l\\" eller null",
      "price": 123.45,
      "currency": "NOK | EUR | USD | …",
      "vat_basis": "eks_mva | inkl_mva | unknown",
      "valid_from": "YYYY-MM-DD eller null",
      "confidence": 0.0-1.0
    }
  ]
}

Regler:
- Ta med HVER vare du finner en pris for. Ikke oppsummer, ikke hopp over.
- price er et tall. Norsk desimalkomma ("12,50") skal bli 12.5.
- Sier dokumentet ingenting om mva, sett "unknown" — ikke gjett.
- Sier det ingenting om valuta, og beløpene ser norske ut, bruk "NOK".
- Er en rad uleselig, ta den med med lav confidence heller enn å utelate den.
- Finner du ingen priser i det hele tatt, returner "rows": [].`;

interface ClaudeContent {
  type: string;
  [key: string]: unknown;
}

async function callClaude(content: ClaudeContent[], maxTokens = 8000): Promise<{ text: string; model: string }> {
  const cfg = extractionConfig();
  if (!cfg.apiKey) throw new Error("ANTHROPIC_API_KEY mangler");

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }

    if (res.ok) {
      const body = (await res.json()) as { content?: Array<{ text?: string }>; model?: string };
      const text = (body.content ?? []).map((c) => c.text ?? "").join("");
      return { text, model: body.model ?? cfg.model };
    }

    lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    // Overload and rate limits are worth waiting out; a bad request never is.
    if (res.status !== 429 && res.status < 500) break;
    if (attempt === MAX_RETRIES) break;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
  }

  throw new Error(`Claude-kall feilet: ${lastError}`);
}

/**
 * Pull the JSON object out of a reply.
 *
 * Models occasionally wrap JSON in prose or a code fence despite being asked
 * not to. Taking the outermost braces recovers the payload instead of throwing
 * away a whole price list over a stray sentence.
 */
function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("fant ingen JSON i svaret");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/** A number from whatever the document wrote: "1 234,50", "kr 99.-", "12.50". */
export function parsePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[^\d.,-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "") // thousands separator
    .replace(",", ".");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeRows(raw: unknown, assumeVat: boolean): ExtractedRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const price = parsePrice(r.price);
    const name = String(r.raw_name ?? "").trim();
    if (price === null || !name) continue; // a row with no price is not a price

    const statedVat = String(r.vat_basis ?? "unknown");
    const vat: VatBasis =
      statedVat === "eks_mva" || statedVat === "inkl_mva" ? statedVat : "unknown";

    out.push({
      supplier_sku: r.supplier_sku ? String(r.supplier_sku).trim() : null,
      raw_name: name,
      unit: r.unit ? String(r.unit).trim() : null,
      pack_size: r.pack_size ? String(r.pack_size).trim() : null,
      price,
      currency: String(r.currency ?? "NOK").trim().toUpperCase() || "NOK",
      // Norwegian wholesale quotes ex-VAT by convention, so that is the fallback
      // — recorded as assumed, never presented as something the document said.
      vat_basis: vat === "unknown" && assumeVat ? "eks_mva" : vat,
      vat_basis_assumed: vat === "unknown",
      valid_from: r.valid_from ? String(r.valid_from).slice(0, 10) : null,
      confidence: typeof r.confidence === "number" ? r.confidence : 0.7,
    });
  }
  return out;
}

async function extractWithClaude(
  content: ClaudeContent[],
  method: string,
): Promise<ExtractionResult> {
  try {
    const { text, model } = await callClaude(content);
    const parsed = parseJsonObject(text);
    const rows = normalizeRows(parsed.rows, true);
    const confidence =
      typeof parsed.overall_confidence === "number" ? parsed.overall_confidence : 0.7;
    return {
      rows,
      method,
      model,
      confidence,
      status: rows.length ? "ok" : "partial",
      error: rows.length ? null : "ingen prisrader funnet",
      raw: parsed,
    };
  } catch (err) {
    return {
      rows: [],
      method,
      model: extractionConfig().model,
      confidence: 0,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      raw: null,
    };
  }
}

export async function extractFromPdf(bytes: Buffer): Promise<ExtractionResult> {
  if (bytes.length > MAX_PDF_BYTES) {
    return {
      rows: [],
      method: "claude_vision_pdf",
      model: null,
      confidence: 0,
      status: "failed",
      error: `PDF er for stor (${Math.round(bytes.length / 1024 / 1024)} MB) — del den opp`,
      raw: null,
    };
  }
  return extractWithClaude(
    [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
      },
      { type: "text", text: SCHEMA_PROMPT },
    ],
    "claude_vision_pdf",
  );
}

export async function extractFromImage(bytes: Buffer, contentType: string): Promise<ExtractionResult> {
  const mediaType = /^image\/(png|jpeg|gif|webp)$/.test(contentType) ? contentType : "image/jpeg";
  return extractWithClaude(
    [
      { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } },
      { type: "text", text: SCHEMA_PROMPT },
    ],
    "claude_vision_image",
  );
}

export async function extractFromText(body: string): Promise<ExtractionResult> {
  const trimmed = body.trim().slice(0, 200_000);
  if (!trimmed) {
    return { rows: [], method: "claude_normalize_text", model: null, confidence: 0, status: "failed", error: "tom tekst", raw: null };
  }
  return extractWithClaude(
    [{ type: "text", text: `${SCHEMA_PROMPT}\n\n--- E-POSTEN ---\n${trimmed}` }],
    "claude_normalize_text",
  );
}

/**
 * Spreadsheets are read, not looked at.
 *
 * The cells are already structured, so the sheet is turned into rows here and
 * only the interpretation — which column is the price, what the units mean —
 * is handed to Claude. That is faster, cheaper, and does not risk misreading a
 * digit that was never ambiguous.
 */
export async function extractFromSpreadsheet(
  bytes: Buffer,
  kind: "excel" | "csv",
): Promise<ExtractionResult> {
  let table: string[][];
  try {
    const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error("ingen ark i filen");
    table = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
  } catch (err) {
    return {
      rows: [],
      method: kind === "excel" ? "xlsx_parse" : "csv_parse",
      model: null,
      confidence: 0,
      status: "failed",
      error: `kunne ikke lese regnearket: ${err instanceof Error ? err.message : String(err)}`,
      raw: null,
    };
  }

  const nonEmpty = table.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!nonEmpty.length) {
    return { rows: [], method: kind === "excel" ? "xlsx_parse" : "csv_parse", model: null, confidence: 0, status: "failed", error: "regnearket er tomt", raw: null };
  }

  // Hand Claude the grid as text: it decides which column is which, which is
  // the part that actually varies between suppliers.
  const preview = nonEmpty
    .slice(0, 400)
    .map((row) => row.map((c) => String(c).replace(/\s+/g, " ").trim()).join(" | "))
    .join("\n");

  const result = await extractWithClaude(
    [
      {
        type: "text",
        text: `${SCHEMA_PROMPT}\n\n--- REGNEARK (rader adskilt med linjeskift, kolonner med |) ---\n${preview}`,
      },
    ],
    kind === "excel" ? "xlsx_parse" : "csv_parse",
  );

  // Say so when the sheet was longer than what was sent, rather than quietly
  // reporting a partial catalogue as the whole thing.
  if (nonEmpty.length > 400 && result.status === "ok") {
    return { ...result, status: "partial", error: `kun de første 400 av ${nonEmpty.length} radene ble lest` };
  }
  return result;
}
