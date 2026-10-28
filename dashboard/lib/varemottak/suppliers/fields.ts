/** The fields a supplier file can provide. Client-safe: no file-reading code here. */
export type Field =
  | "no" | "idx" | "name" | "qty" | "unit" | "cartons" | "country" | "hs"
  | "netWeight" | "grossWeight" | "netValue" | "unitPrice" | "invoice" | "currency" | "ean" | "eanBox";

/** A mapping value meaning "this file has no such column". */
export const NO_COLUMN = "-";

export const FIELD_LABELS: Record<Field, string> = {
  idx: "Varenummer",
  name: "Navn",
  qty: "Antall",
  unit: "Enhet (stk/kg)",
  netValue: "Linjeverdi",
  unitPrice: "Enhetspris",
  netWeight: "Nettovekt",
  grossWeight: "Bruttovekt",
  hs: "Tollnummer",
  country: "Opprinnelsesland",
  cartons: "Antall kartonger",
  ean: "EAN (stk)",
  eanBox: "EAN (kartong)",
  invoice: "Fakturanummer",
  currency: "Valuta",
  no: "Linjenummer",
};
export const REQUIRED_FIELDS: Field[] = ["idx", "name", "qty"];
