/**
 * The suppliers Varemottak knows how to read, and what each one sends.
 *
 * The supplier is chosen when a shipment is created — before any file is uploaded — because
 * the files are read differently: Stanro sends a Windows-1250 CSV plus a paper PDF, another
 * supplier sends only an Excel sheet with its own column names. The choice decides which
 * reader runs, which currency applies, and which upload fields the import form shows.
 *
 * A supplier we have no profile for ("other") still works through the generic reader, but the
 * operator has to say the currency, and unusual column names may need a mapping.
 */
import type { Mapping } from "./generic";

export type ReaderKind = "stanro" | "generic";

export interface SupplierProfile {
  id: string;
  /** What the shipment shows and stores as the supplier name. It must be the name used in the client's rate and history files. */
  label: string;
  /** Older names for the same supplier, so shipments saved under them keep their profile. */
  aliases?: string[];
  reader: ReaderKind;
  /** Fixed invoice currency, or null when the operator must say. */
  currency: string | null;
  /** What to upload, in words the operator reads before choosing a file. */
  accepts: { spec: string; pdf: string | null };
  /** Is the PDF read at all (totals check)? False for a supplier who sends only a spreadsheet. */
  usesPdf: boolean;
  /** Column names this supplier uses, when they are not the usual ones. */
  mapping?: Mapping;
  note?: string;
}

export const SUPPLIER_PROFILES: SupplierProfile[] = [
  {
    id: "stanro",
    label: "Stanro",
    reader: "stanro",
    currency: "PLN",
    accepts: {
      spec: "Spesifikasjons-CSV (semikolon, Windows-1250) – f.eks. 000033_S33_2026_spec.csv",
      pdf: "Faktura-PDF – anbefalt: da kontrolleres sum, antall og ekstrakostnader",
    },
    usesPdf: true,
  },
  {
    id: "excel-pl-01",
    label: "Maspo",
    aliases: ["Supplier 01 (Excel, PLN)"],
    reader: "generic",
    currency: "PLN",
    accepts: {
      spec: "Én Excel/CSV-fil med kolonnene INDEX, NAME_ENG, QUANTITY, NET_VALUE, CODE_INTRASTAT, NET WEIGHT, GROSS_WEIGHT, NUMBER_OF_BOXES, COUNTRY_OF_ORIGIN, EAN PCS … (kan inneholde flere fakturaer)",
      pdf: null,
    },
    usesPdf: false,
    note: "Sender ingen PDF, så summen kan ikke kontrolleres mot en papirfaktura.",
  },
  {
    id: "leis",
    label: "Leis",
    reader: "generic",
    currency: "EUR",
    accepts: {
      spec: "Leis sin Excel-spesifikasjon (tyske kolonner: Artikelnummer, Bezeichnung 1, Berechnet, Zolltarifnummer, Gesamtpreis Belegwährung …)",
      pdf: "Faktura-PDF (lagres; summene kan ikke leses automatisk ennå)",
    },
    usesPdf: false,
    // Leis names its columns in German, and "Berechnet" is the quantity.
    mapping: {
      idx: "Artikelnummer",
      name: "Bezeichnung 1",
      qty: "Berechnet",
      unit: "Basismengeneinheit_Wert",
      hs: "Zolltarifnummer",
      country: "Ursprungsland_Wert",
      netValue: "Gesamtpreis Belegwährung",
      netWeight: "SUM Netto",
      grossWeight: "Sum Brutto",
      currency: "Wkz Belegwährung_Wert",
    },
  },
  {
    id: "swf",
    label: "SWF Global",
    reader: "generic",
    currency: "EUR",
    accepts: { spec: "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn, og du kan velge kolonner selv", pdf: "Faktura-PDF (valgfri)" },
    usesPdf: false,
  },
  {
    id: "united-gross",
    label: "United Gross",
    reader: "generic",
    currency: "SEK",
    accepts: { spec: "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn, og du kan velge kolonner selv", pdf: "Faktura-PDF (valgfri)" },
    usesPdf: false,
    note: "Ingen opprinnelseserklæring på fakturaen: vanlig toll selv for EU-varer. Legg paller til i frakten.",
  },
  {
    id: "plivit",
    label: "Plivit",
    reader: "generic",
    currency: "SEK",
    accepts: { spec: "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn, og du kan velge kolonner selv", pdf: "Faktura-PDF (valgfri)" },
    usesPdf: false,
  },
  {
    id: "fmcg",
    label: "FMCG Solution",
    reader: "generic",
    currency: "EUR",
    accepts: { spec: "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn, og du kan velge kolonner selv", pdf: "Faktura-PDF (valgfri)" },
    usesPdf: false,
    note: "Fakturaen har ikke varenummer: koblingen gjøres på navn.",
  },
  {
    id: "other",
    label: "Annen leverandør",
    reader: "generic",
    currency: null,
    accepts: {
      spec: "Excel/CSV med overskriftsrad (minst varenummer, navn og antall) – eller la den stå tom og last opp bare PDF, så leses den med AI",
      pdf: "Faktura-PDF (valgfri)",
    },
    usesPdf: false,
  },
];

/** The profile for a shipment's stored supplier name; unknown names read like "other". */
export function profileFor(supplierName: string): SupplierProfile {
  const n = supplierName.trim().toLowerCase();
  return (
    SUPPLIER_PROFILES.find((p) => p.label.toLowerCase() === n || (p.aliases ?? []).some((a) => a.toLowerCase() === n)) ??
    SUPPLIER_PROFILES.find((p) => p.id !== "other" && n.includes(p.id === "excel-pl-01" ? "supplier 01" : p.id)) ??
    { ...SUPPLIER_PROFILES[SUPPLIER_PROFILES.length - 1], label: supplierName }
  );
}
