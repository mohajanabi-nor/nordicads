/**
 * Shapes shared by the supplier readers, the merge, the matcher and the screens.
 * Nothing here touches I/O.
 */

export type Unit = "pcs" | "kilo";

/** One line of a supplier invoice, as read from the file — before any merging. */
export interface InvoiceLine {
  /** The supplier's own line number; reports refer to lines by it. */
  no: number;
  /** The supplier's article number, exactly as printed (this is what Shopify carries as a tag). */
  idx: string;
  name: string;
  qty: number;
  unit: Unit;
  /** Number of cartons on the line ("Packaging"). Can be fractional. Null when the file has none. */
  cartons: number | null;
  /** ISO 3166 alpha-2, upper case. */
  country: string;
  /** Customs tariff number as printed, digits only. */
  hs: string | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  /** Line value in the invoice currency. */
  lineValue: number | null;
  invoiceNo: string;
  /** EAN of one piece, digits only, when the file has it. */
  ean?: string | null;
  /** EAN of the carton/box. */
  eanBox?: string | null;
}

/** A line on the paper invoice that is not a product (customs clearance, pallets…). */
export interface ExtraLine {
  no: number;
  name: string;
  qty: number;
  unit: string;
  value: number;
}

/** What the paper invoice says, used to check the spec file against. */
export interface InvoiceTotals {
  invoiceNo: string | null;
  invoiceDate: string | null;
  currency: string | null;
  /** Net total as printed (excl. VAT). */
  netTotal: number | null;
  /** VAT charged by the supplier — on an export invoice this should be zero. */
  vatTotal: number | null;
  grossTotal: number | null;
  netWeightKg: number | null;
  /** Every item line the PDF shows, so the spec can be cross-checked and the extras found. */
  items: Array<{ no: number; name: string; qty: number; unit: string; unitPrice: number; value: number }>;
  extraLines: ExtraLine[];
}

export interface ParsedInvoice {
  supplier: string;
  invoiceNo: string;
  currency: string | null;
  lines: InvoiceLine[];
  warnings: string[];
  /** When one file carries several invoices: what each of them holds, so the totals can still be read per invoice. */
  parts?: Array<{ invoiceNo: string; lines: number; value: number; netWeightKg: number }>;
}

/** One product after lines with the same article number were merged. */
export interface MergedLine {
  idx: string;
  name: string;
  unit: Unit;
  qty: number;
  cartons: number | null;
  country: string;
  /** Customs tariff number after the leading-zero fix. */
  hs: string | null;
  /** True when the fix added a digit — the screen highlights these. */
  hsFixed: boolean;
  netWeightKg: number | null;
  lineValue: number | null;
  /** Value ÷ quantity over the whole merged line. */
  unitPrice: number | null;
  /** The distinct unit prices the source lines had, when they differ — flagged for the operator. */
  priceConflict: Array<{ unitPrice: number; qty: number; lines: number[] }> | null;
  /** Pieces per carton according to this invoice: quantity ÷ cartons, when it comes out whole. */
  pcsPerCartonInvoice: number | null;
  /** EANs from the file (piece and carton), used to confirm or contradict the article-number match. */
  ean: string | null;
  eanBox: string | null;
  /** Source line numbers, for the trail back to the file. */
  lines: number[];
  issues: string[];
}
