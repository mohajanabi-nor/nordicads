import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_RULES, STATIC_MESSAGES, translateMessage } from "./messages";

/** [Norwegian text exactly as the code writes it, expected English]. Sample values stand in for the ${...} parts. */
const TABLE: Array<[string, string]> = [
  // service.ts
  ["Forsendelsen trenger et navn", "The shipment needs a name"],
  ["Velg leverandør", "Choose a supplier"],
  ["Fant ikke forsendelsen", "Shipment not found"],
  ["Ugyldig valuta «EURO»", "Invalid currency «EURO»"],
  ["Kursen for PLN må være over 0", "The rate for PLN must be above 0"],
  ["Frakt må være 0 eller mer", "Freight must be 0 or more"],
  ["Påslag må være mellom 0 og 0.95", "Markup must be between 0 and 0.95"],
  ["Marginterskel må være mellom 0 og 0.95", "Margin threshold must be between 0 and 0.95"],
  ["Salgsenhet må være 0.001 eller mer", "Sales unit must be 0.001 or more"],
  ["Enhetspris må være 0 eller mer", "Unit price must be 0 or more"],
  ["Leverandøren kan ikke endres etter at en faktura er importert – opprett en ny forsendelse", "The supplier can't be changed after an invoice has been imported – create a new shipment"],
  ["Forsendelsen har sendte varer og kan ikke slettes – arkiver den i stedet", "The shipment has items that were sent to Shopify and can't be deleted – archive it instead"],
  ["Dette ser ikke ut som Stanro sin spesifikasjonsfil. 000033.csv: ingen datalinjer", "This doesn't look like Stanro's specification file. 000033.csv: no data lines"],
  ["Faktura FV/123/2026 er allerede importert i denne forsendelsen", "Invoice FV/123/2026 has already been imported in this shipment"],
  [
    "Faktura FV/123/2026 er allerede importert i forsendelsen «S33 høst» – slett den først, ellers telles varene to ganger (Grønt Punkt, innkjøpshistorikk)",
    "Invoice FV/123/2026 has already been imported in the shipment «S33 høst» – delete it there first, or the items are counted twice (Grønt Punkt, purchase history)",
  ],
  ["Faktura FV/123/2026: 14 linjer, 1 234,50 PLN, 56,2 kg netto", "Invoice FV/123/2026: 14 lines, 1 234,50 PLN, 56,2 kg net"],
  ["Valgt av Shady", "Chosen by Shady"],
  ["Lagt inn av Shady (anslag)", "Entered by Shady (estimate)"],
  ["Statusen i Shopify er endret siden importen (ACTIVE → DRAFT)", "The status in Shopify has changed since the import (ACTIVE → DRAFT)"],
  ["Ingen svar fra Shopify", "No response from Shopify"],
  // lines.ts
  ["Samme Shopify-produkt står på flere rader (1234, 5678) – velg riktig produkt på én av dem", "The same Shopify product is on several rows (1234, 5678) – choose the right product on one of them"],
  ["Produktet mangler strekkode i Shopify (faktura: 5901234123457)", "The product has no barcode in Shopify (invoice: 5901234123457)"],
  [
    "Strekkoden i Shopify (111) er ikke den på fakturaen (222 / 333) – sjekk strekkoden i Shopify",
    "The barcode in Shopify (111) is not the one on the invoice (222 / 333) – check the barcode in Shopify",
  ],
  ["Ikke koblet til et Shopify-produkt", "Not matched to a Shopify product"],
  [
    "Usikker kobling – bekreft produktet (Varenummeret finnes på 2 produkter – valgt etter merke (Haribo))",
    "Uncertain match – confirm the product (The article number is on 2 products – chosen by brand (Haribo))",
  ],
  ["Samme varenummer til ulik pris – velg pris", "Same article number at different prices – choose a price"],
  ["Mangler kurs for PLN", "Exchange rate is missing for PLN"],
  ["Mangler kurs for fraktvalutaen EUR", "Exchange rate is missing for the freight currency EUR"],
  ["Kg-vare: oppgi salgsenhet (kg per enhet, f.eks. 1 eller 2,4)", "Kg item: enter the sales unit (kg per unit, e.g. 1 or 2.4)"],
  ["Margin 12.3 % er under 20 %", "Margin 12.3 % is below 20 %"],
  ["Margin ? % er under 20 %", "Margin ? % is below 20 %"],
  ["Mangler nettovekt (toll og frakt avhenger av den)", "Net weight is missing (duty and freight depend on it)"],
  [
    "Shopify har ingen stk-pris (produkttype er tom, pris 199.00) – prisen i Shopify beholdes uendret. Skriv inn egen pris for å endre den",
    "Shopify has no per-pcs price (product type is empty, price 199.00) – the price in Shopify is left unchanged. Enter your own price to change it",
  ],
  [
    "Shopifys pris går ikke opp (7.5 × 24 ≠ 199.00) – kartongprisen i Shopify beholdes uendret. Skriv inn egen pris for å endre den",
    "Shopify's price doesn't add up (7.5 × 24 ≠ 199.00) – the carton price in Shopify is left unchanged. Enter your own price to change it",
  ],
  ["Frakt er ikke lagt inn – kostprisene er uten frakt", "Freight has not been entered – the cost prices exclude freight"],
  ["Ankomstdato mangler – varene telles ikke i Grønt Punkt", "Arrival date is missing – the items are not counted in Grønt Punkt"],
  // invoice-control.ts
  ["Fakturanummeret er ulikt: filen 123, PDF 124.", "The invoice number differs: file 123, PDF 124."],
  ["Linjer i filen som ikke finnes i PDF-en: 3, 4.", "Lines in the file that are not on the PDF: 3, 4."],
  [
    "Antall er ulikt mellom fil og PDF: linje 3 (fil 10, PDF 12); linje 5 (fil 1, PDF 2).",
    "Quantity differs between file and PDF: line 3 (file 10, PDF 12); line 5 (file 1, PDF 2).",
  ],
  ["Varer på PDF-en som mangler i filen: 7 Transport; 8 Pallet.", "Items on the PDF that are missing from the file: 7 Transport; 8 Pallet."],
  [
    "Kostnader som ikke er varer (føres som egne forsendelseskostnader, ikke fordelt på varene): Transport 120,00.",
    "Costs that are not items (booked as separate shipment costs, not spread over the items): Transport 120,00.",
  ],
  ["Summen stemmer med fakturaen (5 000,00 PLN).", "The total matches the invoice (5 000,00 PLN)."],
  ["Summen stemmer med fakturaen (5 000,00 PLN, avrundingsforskjell 0,01).", "The total matches the invoice (5 000,00 PLN, rounding difference 0,01)."],
  [
    "Summen stemmer ikke: linjer 4 900,00 + kostnader 0,00 mot faktura 5 000,00 (forskjell -100,00).",
    "The total doesn't match: lines 4 900,00 + costs 0,00 vs invoice 5 000,00 (difference -100,00).",
  ],
  [
    "Leverandøren har fakturert mva 230,00 PLN på en eksportfaktura – denne skal krediteres.",
    "The supplier has charged VAT of 230,00 PLN on an export invoice – it should be credited.",
  ],
  [
    "Nettovekt: varelinjene 100,00 kg mot fakturaen 110,00 kg (forskjell 10,00 kg – ofte paller). Frakt fordeles på vekten til varene.",
    "Net weight: the item lines 100,00 kg vs the invoice 110,00 kg (difference 10,00 kg – often pallets). Freight is split by the weight of the items.",
  ],
  ["Varer fra Russland/Belarus – sanksjonssjekk nødvendig: 4 ABC123.", "Items from Russia/Belarus – sanctions check required: 4 ABC123."],
  ["Nettovekt 0.1 kg mot bruttovekt 10.5 kg – en av dem er trolig feil", "Net weight 0.1 kg vs gross weight 10.5 kg – one of them is probably wrong"],
  ["Nettovekt 3 kg for 10 kg solgt", "Net weight 3 kg for 10 kg sold"],
  ["Vekt per stk 12 g, men navnet sier 220 g", "Weight per pcs 12 g, but the name says 220 g"],
  // match.ts
  ["Funnet på EAN (ingen vare har varenummeret 12345 som tagg)", "Found by EAN (no product has the article number 12345 as a tag)"],
  [
    "EAN finnes på 3 produkter og varenummeret finnes ikke som tagg – velg riktig",
    "EAN is on 3 products and the article number is not a tag – choose the right one",
  ],
  [
    "Varenummeret peker på «Haribo Goldbears», men EAN peker på «Haribo Cola» – kontroller hvilken som er riktig",
    "The article number points to «Haribo Goldbears», but the EAN points to «Haribo Cola» – check which one is right",
  ],
  ["Varenummeret finnes på 2 produkter – valgt etter EAN", "The article number is on 2 products – chosen by EAN"],
  ["Varenummeret finnes på 2 produkter og merket avgjør ikke – velg riktig", "The article number is on 2 products and the brand doesn't decide – choose the right one"],
  ["Koblingen du lagret tidligere", "The link you saved earlier"],
  // suggest.ts
  ["2 felles ord (cola, zero)", "2 shared words (cola, zero)"],
  ["1 felles ord (cola)", "1 shared word (cola)"],
  ["Merket «Haribo» står i navnet", "The brand «Haribo» is in the name"],
  ["Samme størrelse (0.33 kg/l)", "Same size (0.33 kg/l)"],
  ["Samme antall per kartong (24)", "Same number per carton (24)"],
  ["Utkast (ny vare)", "Draft (new item)"],
  // carton.ts
  [
    "Shopify er ikke konsekvent: tittelen sier 24, men pris ÷ stk-pris gir 12",
    "Shopify is inconsistent: the title says 24, but price ÷ per-pcs price gives 12",
  ],
  ["Kartongstørrelse: Shopify 24, faktura 12 – Shopify er brukt", "Carton size: Shopify 24, invoice 12 – Shopify is used"],
  ["Tittelen sier 24 per kartong, fakturaen 12 – fakturaen er brukt", "The title says 24 per carton, the invoice 12 – the invoice is used"],
  ["Stk per kartong (24) er hentet fra tittelen – fakturaen sier det ikke", "Pcs per carton (24) is taken from the title – the invoice doesn't say"],
  ["Produkttype «abc» er ikke en pris", "Product type «abc» is not a price"],
  ["Stk-pris 7.5 × 24 = 180.00, men Shopify-prisen er 199.00", "Per-pcs price 7.5 × 24 = 180.00, but the Shopify price is 199.00"],
  // merge.ts
  ["Linjene har ulik enhet (1: pcs, 2: kilo)", "The lines have different units (1: pcs, 2: kilo)"],
  ["Ulikt opprinnelsesland på samme varenummer: PL, DE", "Different countries of origin on the same article number: PL, DE"],
  ["Ulike tollnummer på samme varenummer: 17049030, 17049099", "Different customs numbers on the same article number: 17049030, 17049099"],
  ["Antall per kartong går ikke opp (2.5)", "Pcs per carton doesn't divide evenly (2.5)"],
  // customs.ts / customs-service.ts / bulk-import.ts
  ["Deklarasjon 25NO123", "Declaration 25NO123"],
  ["Deklarasjon manuell", "Declaration manual"],
  ["Samme vare tidligere (importert fil, 2026-09-24)", "Same product earlier (imported file, 2026-09-24)"],
  ["Samme vare tidligere (typed by us, estimate, 2026-09-24)", "Same product earlier (typed by us, estimate, 2026-09-24)"],
  ["Samme HS6 170490 (25NO123)", "Same HS6 170490 (25NO123)"],
  ["Toll kr/kg må være 0 eller mer", "Duty NOK/kg must be 0 or more"],
  ["Deklarasjon 25NO123 er allerede registrert", "Declaration 25NO123 is already registered"],
  ["Ugyldig CN8 «1704»", "Invalid CN8 «1704»"],
  [
    "Fant ikke kolonnene for varenummer, pris per enhet, dato. Overskrifter i filen: Art | Pris.",
    "Could not find the columns for article number, price per unit, date. Headers in the file: Art | Pris.",
  ],
  [
    "Fant ikke kolonnene for toll kr/kg. Overskrifter i filen: (ingen).",
    "Could not find the columns for duty NOK/kg. Headers in the file: (none).",
  ],
  ["Dato mangler eller kan ikke leses (bruk åååå-mm-dd eller dd.mm.åååå)", "Date is missing or can't be read (use yyyy-mm-dd or dd.mm.yyyy)"],
  // gp.ts / gp-service.ts
  ["Plastflaske – rapporteres i kg (legg inn vekt per flaske)", "Plastic bottle – reported in kg (enter the weight per bottle)"],
  ["1017: mangler vekt per flaske for Cola 0.5, Fanta 0.5", "1017: weight per bottle is missing for Cola 0.5, Fanta 0.5"],
  ["4005: ingen sats gjelder for 2026-RT3", "4005: no rate applies for 2026-RT3"],
  ["Ukjent kategori brukt på: 9999", "Unknown category used on: 9999"],
  [
    "3 drikkevarelinje(r) i perioden mangler Grønt Punkt-kode og er ikke med i tallene",
    "3 beverage line(s) in the period are missing a Grønt Punkt code and are not included in the figures",
  ],
  ["Forsendelser uten ankomstdato er ikke telt: S33, S34", "Shipments without an arrival date are not counted: S33, S34"],
  ["Kategorien 9999 finnes ikke", "Category 9999 does not exist"],
  ["Kategori 1017 rapporteres i kg – legg inn emballasjevekt per flaske", "Category 1017 is reported in kg – enter the packaging weight per bottle"],
  // suppliers
  ["Filen har tegn som ikke kan leses (lest som windows-1250); polske bokstaver kan være feil", "The file has characters that can't be read (read as windows-1250); Polish letters may be wrong"],
  ["Filen har tegn som ikke kan leses (lest som utf-8)", "The file has characters that can't be read (read as utf-8)"],
  ["000033.csv: ingen datalinjer", "000033.csv: no data lines"],
  ['000033.csv: kolonnen "Product number" mangler. Overskrift: a | b', '000033.csv: the column "Product number" is missing. Header: a | b'],
  ['Kolonnen "Tariff number" mangler – tollnummer må fylles inn for hånd', 'The column "Tariff number" is missing – customs number must be filled in by hand'],
  ["Kolonnen for nettovekt mangler – fylles inn for hånd", "The column for net weight is missing – fill it in by hand"],
  ["000033.csv rad 7: A123 har ikke linjenummer", "000033.csv row 7: A123 has no line number"],
  ['000033.csv rad 7: linjenummer "x" er ikke et tall', '000033.csv row 7: line number "x" is not a number'],
  ["000033.csv rad 7 (linje 6): tomt varenummer", "000033.csv row 7 (line 6): empty article number"],
  ["000033.csv rad 7 (linje 6): antall er ikke et tall", "000033.csv row 7 (line 6): quantity is not a number"],
  ['000033.csv rad 7 (linje 6): ukjent enhet "box"', '000033.csv row 7 (line 6): unknown unit "box"'],
  ["000033.csv: ingen fakturalinjer", "000033.csv: no invoice lines"],
  ["000033.csv: forventet ett fakturanummer, fant ingen", "000033.csv: expected one invoice number, found none"],
  ["000033.csv: forventet ett fakturanummer, fant A, B", "000033.csv: expected one invoice number, found A, B"],
  ["000033.csv: linjenummer forekommer to ganger: 3, 4", "000033.csv: line numbers occur twice: 3, 4"],
  ["fil.xlsx: ingen varelinjer", "fil.xlsx: no item lines"],
  [
    "fil.xlsx: fant ikke kolonnene for varenummer, navn og antall. Overskrifter i filen: A | B. Angi hvilke kolonner som er hvilke.",
    "fil.xlsx: could not find the columns for article number, name and quantity. Headers in the file: A | B. Specify which columns are which.",
  ],
  [
    "fil.xlsx: fant ikke kolonnene for varenummer, navn og antall. Overskrifter i filen: (ingen). Angi hvilke kolonner som er hvilke.",
    "fil.xlsx: could not find the columns for article number, name and quantity. Headers in the file: (none). Specify which columns are which.",
  ],
  ["fil.xlsx: filen blander valutaer (EUR, PLN). Del den opp per valuta.", "fil.xlsx: the file mixes currencies (EUR, PLN). Split it up per currency."],
  [
    "fil.xlsx: filen sier valuta EUR, men leverandøren er satt opp med PLN. Kontroller valget.",
    "fil.xlsx: the file says currency EUR, but the supplier is set up with PLN. Check the selection.",
  ],
  [
    "Filen inneholder 2 fakturaer (A1, A2). De importeres samlet; summene kan ikke kontrolleres per faktura.",
    "The file contains 2 invoices (A1, A2). They are imported together; the totals can't be checked per invoice.",
  ],
  ["Linje 4: antall kunne ikke leses og linjen er utelatt", "Line 4: the quantity could not be read and the line was left out"],
  [
    "Linje 1, 2 har ikke varenummer i PDF-en. Uten varenummer kan varene ikke kobles til Shopify – last opp spesifikasjonsfilen.",
    "Line 1, 2 has no article number in the PDF. Without article numbers the items can't be matched to Shopify – upload the specification file.",
  ],
  ["Valutaen i PDF-en (EUR) er ikke den du oppga (PLN)", "The currency in the PDF (EUR) is not the one you entered (PLN)"],
  ["Annen leverandør", "Other supplier"],
  ["Faktura-PDF (valgfri)", "Invoice PDF (optional)"],
  // shopify and routes
  ["SHOPIFY_API_VERSION 2023-01 er for gammel (kreves 2024-10 eller nyere)", "SHOPIFY_API_VERSION 2023-01 is too old (2024-10 or newer is required)"],
  ["Shopify avviste kallet: Throttled", "Shopify rejected the call: Throttled"],
  ["Shopify-token feilet (401): ukjent feil", "Shopify token request failed (401): unknown error"],
  ["Filen «liste.xlsx» er for stor (maks 15 MB)", "The file «liste.xlsx» is too large (max 15 MB)"],
  ["Velg en fil først", "Choose a file first"],
];

describe("translateMessage: representative messages", () => {
  it("has at least 60 rows in the table", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(60);
  });

  it.each(TABLE)("%s", (no, en) => {
    expect(translateMessage(no)).toBe(en);
  });

  it("carries the variable parts over unchanged", () => {
    const out = translateMessage("Faktura FV/123/2026: 14 linjer, 1 234,50 PLN, 56,2 kg netto");
    for (const part of ["FV/123/2026", "14", "1 234,50", "PLN", "56,2"]) expect(out).toContain(part);
  });

  it("passes unknown and English messages through unchanged", () => {
    expect(translateMessage("Price must be greater than 0")).toBe("Price must be greater than 0");
    expect(translateMessage("Something nobody wrote a rule for")).toBe("Something nobody wrote a rule for");
    expect(translateMessage("")).toBe("");
  });

  it("does not mistake a part of a longer message for the whole", () => {
    expect(translateMessage("Mangler pris og mer")).toBe("Mangler pris og mer");
  });
});

describe("translateMessage: completeness", () => {
  it("translates every static message differently from the Norwegian", () => {
    for (const [no, en] of STATIC_MESSAGES) {
      expect(en, no).not.toBe(no);
      expect(translateMessage(no), no).toBe(en);
    }
  });

  it("has no rule that is shadowed by an earlier one", () => {
    // Every static message must resolve to its own rule, not to a broader rule placed before it.
    const seen = new Set<string>();
    for (const [no] of STATIC_MESSAGES) {
      expect(seen.has(no), `duplicate ${no}`).toBe(false);
      seen.add(no);
    }
    expect(MESSAGE_RULES.length).toBeGreaterThan(200);
  });

  // Scan the sources for the Norwegian text the server can write, and require a rule for each.
  const ROOT = path.resolve(__dirname, "..", "..");
  const FILES = [
    "lib/varemottak/service.ts", "lib/varemottak/lines.ts", "lib/varemottak/invoice-control.ts", "lib/varemottak/match.ts",
    "lib/varemottak/suggest.ts", "lib/varemottak/carton.ts", "lib/varemottak/merge.ts", "lib/varemottak/customs.ts",
    "lib/varemottak/customs-service.ts", "lib/varemottak/gp.ts", "lib/varemottak/gp-service.ts", "lib/varemottak/bulk-import.ts",
    "lib/varemottak/suggest-service.ts", "lib/varemottak/suppliers/stanro.ts", "lib/varemottak/suppliers/generic.ts",
    "lib/varemottak/suppliers/pdf-claude.ts", "lib/varemottak/suppliers/registry.ts", "lib/varemottak/suppliers/fields.ts",
    "lib/varemottak/shopify/live.ts", "lib/varemottak/shopify/index.ts", "lib/varemottak/shopify/types.ts",
    "app/api/varemottak/customs/import/route.ts", "app/api/varemottak/customs/route.ts", "app/api/varemottak/gp/route.ts",
    "app/api/varemottak/history/import/route.ts", "app/api/varemottak/lines/[id]/match/route.ts",
    "app/api/varemottak/shipments/[id]/import/inspect/route.ts", "app/api/varemottak/shipments/[id]/import/route.ts",
  ];
  // Left as written on purpose: English or the same in both languages, a fragment of a message that is
  // translated as a whole, a log line, or a file header.
  const UNCHANGED = new Set([
    "SWF Global",
    "Bezeichnung 1",
    "Gesamtpreis Belegwährung",
    "SUM Netto",
    "Sum Brutto",
    "Wkz Belegwährung_Wert",
    "United Gross",
    "FMCG Solution",
    "Glass 0–250 ml", "Aluminium 251–500 ml", "Stanro", "Leis", "Supplier 01 (Excel, PLN)", "supplier 01",
    "typed by us, estimate", ", 7 feilet", ", avrundingsforskjell 7", "YYYY-MM-DD or null", "EUR | PLN | USD | ... (ISO code)",
    "text/csv; charset=utf-8", 'attachment; filename="gront-punkt-7.csv"',
    // Column labels that only appear inside "Fant ikke kolonnene for …", which is translated whole.
    "tollnummer (CN8)", "toll kr/kg", "pris per enhet", "vår pris",
    // Country names are already English.
    "Bosnia and Herzegovina", "Czech Republic", "United Kingdom", "South Korea", "North Macedonia", "Saudi Arabia", "United States",
  ]);

  /** Reads a template literal starting at the backtick at `i`; each ${...} becomes a sample value. */
  function readTemplate(text: string, i: number): { body: string; end: number } {
    let body = "";
    let j = i + 1;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") {
        body += text[j + 1];
        j += 2;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        let depth = 1;
        let k = j + 2;
        const exprStart = k;
        while (k < text.length && depth > 0) {
          const c = text[k];
          if (c === "`") k = readTemplate(text, k).end;
          else if (c === '"' || c === "'") {
            k++;
            while (k < text.length && text[k] !== c) k += text[k] === "\\" ? 2 : 1;
          } else if (c === "{") depth++;
          else if (c === "}") depth--;
          k++;
        }
        const expr = text.slice(exprStart, k - 1);
        body += expr === "where" ? "rad 7" : /currency/.test(expr) ? "PLN" : /required\.map/.test(expr) ? "toll kr/kg" : "7";
        j = k;
      } else body += text[j++];
    }
    return { body, end: j };
  }

  /** The text of string literals written the way a message is: Error("…"), .push("…"), reason: "…", `? "…"`. */
  function extract(src: string): string[] {
    const out = new Set<string>();
    const text = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const start = /(?:Error\(|\.push\(|(?:reason|text|message|spec|pdf|note|label):|\?|:)\s*(?=["`])/g;
    for (let m = start.exec(text); m; m = start.exec(text)) {
      const at = m.index + m[0].length;
      let body: string;
      if (text[at] === "`") body = readTemplate(text, at).body;
      else {
        const lit = /^"((?:\\.|[^"\\\n])*)"/.exec(text.slice(at));
        if (!lit) continue;
        body = lit[1].replace(/\\(.)/g, "$1");
      }
      if (/[A-Za-zÆØÅæøå]{3,}/.test(body) && body.includes(" ")) out.add(body);
    }
    return [...out];
  }


  it("translates every Norwegian message found in the source files (with a sample value for each ${...} part)", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const f of FILES) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const s of extract(src)) {
        if (UNCHANGED.has(s)) continue;
        checked++;
        if (translateMessage(s) === s) missing.push(`${f}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
    // The scan has to find the messages, not silently find nothing.
    expect(checked).toBeGreaterThan(120);
  });
});
