/**
 * Number and text helpers for supplier files. Norwegian and Polish suppliers write
 * "1.234,50"; some re-saved files use "1,234.50" or "1.5". Each reader says what it
 * expects, so the shared parser stays honest about ambiguity instead of guessing.
 */

/** "1.234,50" → 1234.5 ; "9,814" → 9.814 ; "80" → 80 ; a lone "1.234" is a thousands group. */
export function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = String(s).trim().replace(/\s/g, "");
  if (!t) return null;
  let norm: string;
  if (t.includes(",")) norm = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) norm = t.replace(/\./g, "");
  else norm = t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decode a supplier file. Polish suppliers write Windows-1250; a file re-saved from
 * Excel may be UTF-8 with or without a BOM. Reading cp1250 as UTF-8 turns every Polish
 * letter into a replacement character, which breaks title matching, so try strict UTF-8
 * first and fall back.
 */
export function decodeSupplierText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8 (BOM)" };
  }
  if (bytes.some((b) => b > 0x7f)) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
    } catch {
      /* not UTF-8 → cp1250 */
    }
  }
  return { text: new TextDecoder("windows-1250").decode(bytes), encoding: "windows-1250" };
}

/** Split one CSV line on `delim`, honouring double quotes. */
export function splitCsvLine(line: string, delim = ";"): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** ="71806000AXE" → 71806000AXE (Excel's way of keeping leading zeros), else trimmed as is. */
export function cleanCell(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^="(.*)"$/);
  return (m ? m[1] : t.replace(/^"|"$/g, "")).trim().normalize("NFC");
}

export const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
