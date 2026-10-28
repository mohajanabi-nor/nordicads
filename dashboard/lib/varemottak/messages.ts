/**
 * Messages the server writes in Norwegian (warnings, blocked reasons, errors, notes on a row) shown in
 * English. The server and the database keep the Norwegian text; the screen translates it when the
 * operator has chosen English. A message with no rule is shown as written, never dropped.
 *
 * Rules are tried in order; the first match wins. A rule's `en` can use $1, $2 … for the parts of the
 * message that vary (numbers, product names, file names), which are carried over unchanged. Two more
 * forms are for a captured part that is itself a Norwegian message or label:
 *   $t1  the captured part, translated with the same rules (a reason inside a warning, a label)
 *   $p1  the captured part is a "; "-separated list: each item is translated
 */
export interface MessageRule {
  /** Matches the whole message. */
  no: RegExp;
  en: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

/**
 * Messages that never vary: [Norwegian, English]. Each becomes an exact-match rule. Exported so the
 * test can check that every one of them really translates.
 */
export const STATIC_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  // --- Shipments (service.ts) ---
  ["Forsendelsen trenger et navn", "The shipment needs a name"],
  ["Velg leverandør", "Choose a supplier"],
  ["Fant ikke forsendelsen", "Shipment not found"],
  ["Ugyldig fraktvaluta", "Invalid freight currency"],
  ["Ugyldig påslagsmodus", "Invalid markup mode"],
  ["Ugyldig status", "Invalid status"],
  [
    "Leverandøren kan ikke endres etter at en faktura er importert – opprett en ny forsendelse",
    "The supplier can't be changed after an invoice has been imported – create a new shipment",
  ],
  ["Navnet kan ikke være tomt", "The name can't be empty"],
  [
    "Forsendelsen har sendte varer og kan ikke slettes – arkiver den i stedet",
    "The shipment has items that were sent to Shopify and can't be deleted – archive it instead",
  ],

  // --- Invoice import (service.ts) ---
  [
    "Last opp spesifikasjonsfilen (CSV eller Excel), eller fakturaen som PDF",
    "Upload the specification file (CSV or Excel), or the invoice as a PDF",
  ],
  [
    "Filen i spesifikasjonsfeltet er en PDF. Legg PDF-fakturaen i feltet «Faktura (PDF)», og CSV/Excel i spesifikasjonsfeltet.",
    "The file in the specification field is a PDF. Put the PDF invoice in the «Invoice (PDF)» field, and CSV/Excel in the specification field.",
  ],
  [
    "Stanro-fakturaen har ikke varenummer – last opp spesifikasjonsfilen (CSV)",
    "The Stanro invoice has no article numbers – upload the specification file (CSV)",
  ],
  ["Oppgi fakturaens valuta (f.eks. EUR)", "Enter the invoice currency (e.g. EUR)"],
  [
    "PDF-en er lagret, men summene kan ikke leses automatisk for denne leverandøren ennå",
    "The PDF is saved, but the totals can't be read automatically for this supplier yet",
  ],

  // --- Lines (service.ts, lines.ts) ---
  ["Fant ikke raden", "Row not found"],
  ["Raden er allerede sendt til Shopify", "The row has already been sent to Shopify"],
  ["Fant ikke produktet i Shopify", "Product not found in Shopify"],
  ["Stk per kartong må være et helt tall over 0", "Pcs per carton must be a whole number above 0"],
  ["Produktet finnes ikke lenger i Shopify", "The product no longer exists in Shopify"],
  ["Produktet har flere varianter – ikke støttet", "The product has several variants – not supported"],
  ["Produktet er arkivert i Shopify", "The product is archived in Shopify"],
  ["Ingen svar fra Shopify", "No response from Shopify"],
  ["Ikke koblet til et Shopify-produkt", "Not matched to a Shopify product"],
  ["Samme varenummer til ulik pris – velg pris", "Same article number at different prices – choose a price"],
  ["Mangler toll", "Duty is missing"],
  ["Mangler antall", "Quantity is missing"],
  ["Mangler stk per kartong", "Pcs per carton is missing"],
  ["Mangler pris", "Price is missing"],
  [
    "Kg-vare: oppgi salgsenhet (kg per enhet, f.eks. 1 eller 2,4)",
    "Kg item: enter the sales unit (kg per unit, e.g. 1 or 2.4)",
  ],
  ["Pris under kost", "Price below cost"],
  ["Mangler nettovekt (toll og frakt avhenger av den)", "Net weight is missing (duty and freight depend on it)"],
  ["Mangler fakturaverdi", "The invoice value is missing"],
  ["Negativ fakturaverdi – kreditnota eller feil i filen", "Negative invoice value – a credit note or an error in the file"],
  ["Ugyldig dato – bruk ÅÅÅÅ-MM-DD", "Invalid date – use YYYY-MM-DD"],
  ["Filen kunne ikke leses som en tolldeklarasjon. Last opp PDF-en du fikk fra speditøren.", "The file could not be read as a customs declaration. Upload the PDF you got from the forwarder."],
  ["Stk per kartong må være et helt tall mellom 1 og 100000", "Pieces per carton must be a whole number between 1 and 100000"],
  ["Mangler tollnummer (HS) – drikke- og mva-reglene og tollregisteret kan ikke brukes på raden", "No customs code (HS) – the drink and VAT rules and the customs register cannot be used on the row"],
  ["Mangler opprinnelsesland – sanksjonssjekken og landfeltet i Shopify kan ikke gjøres", "No country of origin – the sanctions check and the country field in Shopify cannot be done"],
  ["Fant ikke kolonnen for varenummer. Første kolonne må hete Art.nr.", "Could not find the article number column. The first column must be called Art.nr."],
  ["Salgsenhet (kg per enhet) mangler eller er ikke et tall", "The selling unit (kg per unit) is missing or not a number"],
  ["Varenummer mangler i filen og tittelen finnes ikke nøyaktig i Shopify – velg salgsenhet på raden når varen kommer på en faktura", "The article number is missing in the file and the title is not found exactly in Shopify – set the selling unit on the row when the product arrives on an invoice"],
  ["Pølse (HS 1601): toll er enten 0 eller 84,31 kr/kg etter tollkvote – bekreft satsen fra deklarasjonen", "Sausage (HS 1601): duty is either 0 or 84.31 kr/kg depending on the tariff quota – confirm the rate from the declaration"],
  ["Iskrem (HS 2105): høy toll som ikke er kjent før deklarasjonen kommer – kostprisen er trolig for lav", "Ice cream (HS 2105): high duty that is not known until the declaration arrives – the cost is probably too low"],
  ["Opprinnelse Russland/Belarus – sanksjonssjekk før sending", "Origin Russia/Belarus – sanctions check before sending"],
  ["Svært lav enhetspris (gave?) – kostprisen er bare frakt og toll, sjekk om varen skal prises", "Very low unit price (a gift?) – the cost is only freight and duty, check whether the item should be priced"],
  ["Leverandøren har hevet prisen – sjekk vår pris", "The supplier has raised the price – check our price"],
  ["Frakt er ikke lagt inn – kostprisene er uten frakt", "Freight has not been entered – the cost prices exclude freight"],
  [
    "Ankomstdato mangler – varene telles ikke i Grønt Punkt",
    "Arrival date is missing – the items are not counted in Grønt Punkt",
  ],

  // --- Invoice control (invoice-control.ts) ---
  [
    "Ingen faktura-PDF lastet opp – summene kan ikke kontrolleres mot fakturaen.",
    "No invoice PDF uploaded – the totals can't be checked against the invoice.",
  ],
  ["Ingen varelinjer kunne leses fra PDF-en.", "No item lines could be read from the PDF."],

  // --- Matching (match.ts) ---
  ["Koblingen du lagret tidligere", "The link you saved earlier"],
  ["Ingen produkt har dette varenummeret som tagg", "No product has this article number as a tag"],
  ["Varenummer-tagg og EAN stemmer", "Article number tag and EAN match"],
  [
    "Varenummeret passer, men verken merke eller tittel ligner – kontroller",
    "The article number fits, but neither brand nor title looks similar – check",
  ],
  ["Varenummer-tagg", "Article number tag"],

  // --- Suggestions (suggest.ts) ---
  ["EAN stemmer", "EAN matches"],
  ["Varenummeret er tagg på produktet", "The article number is a tag on the product"],
  ["Utkast (ny vare)", "Draft (new item)"],

  // --- Duty and sources (customs.ts, customs-service.ts, bulk-import.ts) ---
  ["manuell", "manual"],
  ["importert fil", "imported file"],
  ["ukjent feil", "unknown error"],
  ["CN8 må være 8 siffer", "CN8 must be 8 digits"],
  ["Leverandør og varenummer mangler", "Supplier and article number are missing"],
  ["En CN8-sats må komme fra en deklarasjon", "A CN8 rate must come from a declaration"],
  ["Deklarasjonsnummer mangler", "Declaration number is missing"],
  ["Deklarasjonen har ingen varelinjer", "The declaration has no item lines"],
  [
    "Filen trenger en kolonne for tollnummer (CN8) eller varenummer.",
    "The file needs a column for customs number (CN8) or article number.",
  ],
  ["Toll kr/kg mangler eller er ugyldig", "Duty NOK/kg is missing or invalid"],
  ["Leverandør mangler (egen kolonne, eller velg leverandør)", "Supplier is missing (own column, or choose a supplier)"],
  [
    "Bare 8-sifret CN8 støttes (6-sifret HS6 utledes fra CN8-satser)",
    "Only 8-digit CN8 is supported (6-digit HS6 is derived from CN8 rates)",
  ],
  ["Tollnummeret må ha 8 siffer", "The customs number must have 8 digits"],
  ["Varenummer mangler", "Article number is missing"],
  ["Pris mangler eller er ugyldig", "Price is missing or invalid"],
  [
    "Dato mangler eller kan ikke leses (bruk åååå-mm-dd eller dd.mm.åååå)",
    "Date is missing or can't be read (use yyyy-mm-dd or dd.mm.yyyy)",
  ],
  ["Valuta mangler (egen kolonne, eller velg valuta)", "Currency is missing (own column, or choose a currency)"],
  ["Ugyldig rad", "Invalid row"],
  ["(ingen)", "(none)"],

  // --- Grønt Punkt (gp.ts, gp-service.ts) ---
  [
    "Plastflaske – rapporteres i kg (legg inn vekt per flaske)",
    "Plastic bottle – reported in kg (enter the weight per bottle)",
  ],
  ["Drikkekartong", "Beverage carton"],
  [
    "Glass over 250 ml – ingen kode i listen, legg til kategori",
    "Glass over 250 ml – no code in the list, add a category",
  ],
  [
    "Aluminiumsboks 0–250 ml – ingen kode i listen, legg til kategori",
    "Aluminium can 0–250 ml – no code in the list, add a category",
  ],
  ["Boks, men størrelsen er ukjent", "Can, but the size is unknown"],
  ["Emballasjetype kunne ikke leses av navnet", "The packaging type could not be read from the name"],
  ["Ugyldig periode (bruk f.eks. 2026-RT3)", "Invalid period (use e.g. 2026-RT3)"],
  [
    "Emballasjevekt per enhet må være over 0 og under 5 kg",
    "Packaging weight per unit must be above 0 and below 5 kg",
  ],
  ["Koden må være 3–6 siffer", "The code must be 3–6 digits"],
  ["Navn mangler", "Name is missing"],
  ["Satsen må være 0 eller mer", "The rate must be 0 or more"],
  ["Gyldig fra-dato må være ÅÅÅÅ-MM-DD", "The valid-from date must be YYYY-MM-DD"],
  [
    "Enheten på en eksisterende kategori kan ikke endres",
    "The unit of an existing category can't be changed",
  ],
  ["Produktet mangler", "Product is missing"],

  // --- Routes (app/api/varemottak) ---
  ["Velg en fil først", "Choose a file first"],
  ["Filen er for stor (maks 15 MB)", "The file is too large (max 15 MB)"],
  ["Ugyldig handling", "Invalid action"],
  ["Velg et produkt", "Choose a product"],
  ["Ugyldig kolonnekobling", "Invalid column mapping"],

  // --- Supplier readers (stanro.ts, generic.ts, pdf-claude.ts) ---
  [
    "Hverken linjeverdi eller enhetspris finnes – pris må fylles inn",
    "Neither a line value nor a unit price was found – the price must be filled in",
  ],
  [
    "Linjenummerne i filen var ikke unike og er nummerert på nytt",
    "The line numbers in the file were not unique and have been renumbered",
  ],
  [
    "Kunne ikke avgjøre desimalformatet i filen – tall som 1.234 er lest som tusen. Kontroller vekter og beløp.",
    "Could not determine the decimal format in the file – numbers like 1.234 are read as one thousand. Check weights and amounts.",
  ],
  [
    "PDF-en kunne ikke leses fullstendig (svaret fra Claude var avkortet eller ugyldig). Last opp spesifikasjonsfilen i stedet, eller del opp PDF-en.",
    "The PDF could not be read completely (Claude's response was cut off or invalid). Upload the specification file instead, or split the PDF.",
  ],
  ["Fant ingen varelinjer i PDF-en", "No item lines were found in the PDF"],
  [
    "Linjene er lest fra PDF med AI – sjekk fakturakontrollen nøye",
    "The lines were read from the PDF with AI – check the invoice control carefully",
  ],
  ["Fant ikke fakturaens valuta – oppgi den", "Could not find the invoice currency – enter it"],
  [
    "Ingen varelinjer med antall og varenummer kunne leses fra PDF-en",
    "No item lines with a quantity and article number could be read from the PDF",
  ],

  // --- Supplier profiles (registry.ts) ---
  ["Annen leverandør", "Other supplier"],
  [
    "Spesifikasjons-CSV (semikolon, Windows-1250) – f.eks. 000033_S33_2026_spec.csv",
    "Specification CSV (semicolon, Windows-1250) – e.g. 000033_S33_2026_spec.csv",
  ],
  [
    "Faktura-PDF – anbefalt: da kontrolleres sum, antall og ekstrakostnader",
    "Invoice PDF – recommended: the total, quantities and extra costs are then checked",
  ],
  [
    "Én Excel/CSV-fil med kolonnene INDEX, NAME_ENG, QUANTITY, NET_VALUE, CODE_INTRASTAT, NET WEIGHT, GROSS_WEIGHT, NUMBER_OF_BOXES, COUNTRY_OF_ORIGIN, EAN PCS … (kan inneholde flere fakturaer)",
    "One Excel/CSV file with the columns INDEX, NAME_ENG, QUANTITY, NET_VALUE, CODE_INTRASTAT, NET WEIGHT, GROSS_WEIGHT, NUMBER_OF_BOXES, COUNTRY_OF_ORIGIN, EAN PCS … (can contain several invoices)",
  ],
  [
    "Sender ingen PDF, så summen kan ikke kontrolleres mot en papirfaktura.",
    "Sends no PDF, so the total can't be checked against a paper invoice.",
  ],
  [
    "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn",
    "Excel/CSV – the layout isn't known yet; the app tries common column names",
  ],
  [
    "Leis sin Excel-spesifikasjon (tyske kolonner: Artikelnummer, Bezeichnung 1, Berechnet, Zolltarifnummer, Gesamtpreis Belegwährung …)",
    "Leis's Excel specification (German columns: Artikelnummer, Bezeichnung 1, Berechnet, Zolltarifnummer, Gesamtpreis Belegwährung …)",
  ],
  [
    "Excel/CSV – oppsettet er ikke kjent ennå; appen prøver vanlige kolonnenavn, og du kan velge kolonner selv",
    "Excel/CSV – the layout isn't known yet; the app tries common column names, and you can choose the columns yourself",
  ],
  [
    "Ingen opprinnelseserklæring på fakturaen: vanlig toll selv for EU-varer. Legg paller til i frakten.",
    "No origin declaration on the invoice: ordinary duty even for EU goods. Add pallets to the freight.",
  ],
  ["Fakturaen har ikke varenummer: koblingen gjøres på navn.", "The invoice has no article numbers: matching is done on the name."],
  [
    "Faktura-PDF (lagres; summene kan ikke leses automatisk ennå)",
    "Invoice PDF (saved; the totals can't be read automatically yet)",
  ],
  [
    "Excel/CSV med overskriftsrad (minst varenummer, navn og antall) – eller la den stå tom og last opp bare PDF, så leses den med AI",
    "Excel/CSV with a header row (at least article number, name and quantity) – or leave it empty and upload only a PDF, which is then read with AI",
  ],
  ["Faktura-PDF (valgfri)", "Invoice PDF (optional)"],

  // --- Shopify (shopify/*.ts) ---
  [
    "Skriving mot den ekte Shopify-butikken er avslått. Sett VAREMOTTAK_LIVE_WRITES=1 bare når eieren har gitt tillatelse; bruk SHOPIFY_FAKE=1 for testing.",
    "Writing to the real Shopify store is turned off. Set VAREMOTTAK_LIVE_WRITES=1 only when the owner has given permission; use SHOPIFY_FAKE=1 for testing.",
  ],
  [
    "Fant ikke Nettbutikk-kanalen – produktet ble aktivert, men ikke publisert",
    "Could not find the Online Store channel – the product was activated but not published",
  ],
  [
    "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET mangler i Vercel",
    "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are missing in Vercel",
  ],
  ["Shopify: for mange forsøk (throttled)", "Shopify: too many attempts (throttled)"],

  // --- Field and column labels (suppliers/fields.ts, bulk-import.ts, service.ts) ---
  ["Varenummer", "Article number"],
  ["Navn", "Name"],
  ["Antall", "Quantity"],
  ["Enhet (stk/kg)", "Unit (pcs/kg)"],
  ["Linjeverdi", "Line value"],
  ["Enhetspris", "Unit price"],
  ["Nettovekt", "Net weight"],
  ["Bruttovekt", "Gross weight"],
  ["Tollnummer", "Customs number"],
  ["Opprinnelsesland", "Country of origin"],
  ["Antall kartonger", "Number of cartons"],
  ["EAN (stk)", "EAN (pcs)"],
  ["EAN (kartong)", "EAN (carton)"],
  ["Fakturanummer", "Invoice number"],
  ["Valuta", "Currency"],
  ["Linjenummer", "Line number"],
  ["Frakt", "Freight"],
  ["Påslag", "Markup"],
  ["Marginterskel", "Margin threshold"],
  ["Emballasje", "Packaging"],
  ["Toll", "Duty"],
  ["Toll kr/kg", "Duty NOK/kg"],
  ["Salgsenhet", "Sales unit"],
  ["Pris", "Price"],
  ["tollnummer", "customs number"],
  ["nettovekt", "net weight"],
  ["vekt", "weight"],
  ["verdi", "value"],
];

/**
 * Messages with a varying part. More specific rules come before general ones; the exact-match rules
 * above are tried first.
 */
const PATTERN_RULES: MessageRule[] = [
  // --- Shipments (service.ts) ---
  { no: /^Ugyldig valuta «(.+)»$/, en: "Invalid currency «$1»" },
  { no: /^Kursen for (.+) må være over 0$/, en: "The rate for $1 must be above 0" },
  { no: /^(.+) må være mellom (.+) og (.+)$/, en: "$t1 must be between $2 and $3" },
  { no: /^(.+) må være (.+) eller mer$/, en: "$t1 must be $2 or more" },

  // --- Invoice import (service.ts) ---
  { no: /^Dette ser ikke ut som Stanro sin spesifikasjonsfil\. (.+)$/, en: "This doesn't look like Stanro's specification file. $t1" },
  { no: /^Faktura (.+) er allerede importert i denne forsendelsen$/, en: "Invoice $1 has already been imported in this shipment" },
  {
    no: /^Faktura (.+) er allerede importert i forsendelsen «(.+)» – slett den først, ellers telles varene to ganger \(Grønt Punkt, innkjøpshistorikk\)$/,
    en: "Invoice $1 has already been imported in the shipment «$2» – delete it there first, or the items are counted twice (Grønt Punkt, purchase history)",
  },
  { no: /^Faktura (.+?): (\d+) linjer, (.+) ([A-Z]{3}), (.+) kg netto$/, en: "Invoice $1: $2 lines, $3 $4, $5 kg net" },

  // --- Lines (service.ts, lines.ts) ---
  { no: /^Valgt av (.+)$/, en: "Chosen by $1" },
  { no: /^Lagt inn av (.+) \(anslag\)$/, en: "Entered by $1 (estimate)" },
  { no: /^Lagt inn av (.+) \(prosent av verdi\)$/, en: "Entered by $1 (percentage of value)" },
  { no: /^Lagt inn \(anslag\)$/, en: "Entered (estimate)" },
  { no: /^Statusen i Shopify er endret siden importen \((.+) → (.+)\)$/, en: "The status in Shopify has changed since the import ($1 → $2)" },
  {
    no: /^Samme Shopify-produkt står på flere rader \((.+)\) – velg riktig produkt på én av dem$/,
    en: "The same Shopify product is on several rows ($1) – choose the right product on one of them",
  },
  { no: /^Produktet mangler strekkode i Shopify \(faktura: (.+)\)$/, en: "The product has no barcode in Shopify (invoice: $1)" },
  {
    no: /^Strekkoden i Shopify \((.+?)\) er ikke den på fakturaen \((.+)\) – sjekk strekkoden i Shopify$/,
    en: "The barcode in Shopify ($1) is not the one on the invoice ($2) – check the barcode in Shopify",
  },
  { no: /^Usikker kobling – bekreft produktet \((.+)\)$/, en: "Uncertain match – confirm the product ($t1)" },
  { no: /^Mangler kurs for fraktvalutaen (.+)$/, en: "Exchange rate is missing for the freight currency $1" },
  { no: /^Mangler kurs for (.+)$/, en: "Exchange rate is missing for $1" },
  { no: /^Margin (.+?) % er under (.+?) %$/, en: "Margin $1 % is below $2 %" },
  {
    no: /^Shopify har ingen stk-pris \(produkttype er tom, pris (.+?)\) – prisen i Shopify beholdes uendret\. Skriv inn egen pris for å endre den$/,
    en: "Shopify has no per-pcs price (product type is empty, price $1) – the price in Shopify is left unchanged. Enter your own price to change it",
  },
  {
    no: /^Shopifys pris går ikke opp \((.+?) × (.+?) ≠ (.+?)\) – kartongprisen i Shopify beholdes uendret\. Skriv inn egen pris for å endre den$/,
    en: "Shopify's price doesn't add up ($1 × $2 ≠ $3) – the carton price in Shopify is left unchanged. Enter your own price to change it",
  },

  // --- Invoice control (invoice-control.ts) ---
  { no: /^Fakturanummeret er ulikt: filen (.+), PDF (.+)\.$/, en: "The invoice number differs: file $1, PDF $2." },
  { no: /^Linjer i filen som ikke finnes i PDF-en: (.+)\.$/, en: "Lines in the file that are not on the PDF: $1." },
  { no: /^Antall er ulikt mellom fil og PDF: (.+)\.$/, en: "Quantity differs between file and PDF: $p1." },
  { no: /^linje (.+?) \(fil (.+?), PDF (.+?)\)$/, en: "line $1 (file $2, PDF $3)" },
  { no: /^Varer på PDF-en som mangler i filen: (.+)\.$/, en: "Items on the PDF that are missing from the file: $1." },
  {
    no: /^Kostnader som ikke er varer \(føres som egne forsendelseskostnader, ikke fordelt på varene\): (.+)\.$/,
    en: "Costs that are not items (booked as separate shipment costs, not spread over the items): $1.",
  },
  { no: /^Summen stemmer med fakturaen \((.+?), avrundingsforskjell (.+?)\)\.$/, en: "The total matches the invoice ($1, rounding difference $2)." },
  { no: /^Summen stemmer med fakturaen \((.+)\)\.$/, en: "The total matches the invoice ($1)." },
  {
    no: /^Summen stemmer ikke: linjer (.+?) \+ kostnader (.+?) mot faktura (.+?) \(forskjell (.+?)\)\.$/,
    en: "The total doesn't match: lines $1 + costs $2 vs invoice $3 (difference $4).",
  },
  {
    no: /^Leverandøren har fakturert mva (.+) på en eksportfaktura – denne skal krediteres\.$/,
    en: "The supplier has charged VAT of $1 on an export invoice – it should be credited.",
  },
  {
    no: /^Nettovekt: varelinjene (.+?) kg mot fakturaen (.+?) kg \(forskjell (.+?) kg – ofte paller\)\. Frakt fordeles på vekten til varene\.$/,
    en: "Net weight: the item lines $1 kg vs the invoice $2 kg (difference $3 kg – often pallets). Freight is split by the weight of the items.",
  },
  {
    no: /^Varer fra Russland\/Belarus – sanksjonssjekk nødvendig: (.+)\.$/,
    en: "Items from Russia/Belarus – sanctions check required: $1.",
  },
  {
    no: /^Nettovekt (.+?) kg mot bruttovekt (.+?) kg – en av dem er trolig feil$/,
    en: "Net weight $1 kg vs gross weight $2 kg – one of them is probably wrong",
  },
  { no: /^Nettovekt (.+?) kg for (.+?) kg solgt$/, en: "Net weight $1 kg for $2 kg sold" },
  { no: /^Vekt per stk (.+?) g, men navnet sier (.+?) g$/, en: "Weight per pcs $1 g, but the name says $2 g" },

  // --- Matching (match.ts) ---
  { no: /^(\d+) rader med varenummer ble hoppet over fordi antallet ikke kunne leses som et tall: (.+)\. Sjekk filen\.$/, en: "$1 rows with an article number were skipped because the quantity could not be read as a number: $2. Check the file." },
  { no: /^Ukjent enhet i filen \((.+)\) – regnet som stk\. Er noe solgt per kg, må enheten være kg\.$/, en: "Unknown unit in the file ($1) – counted as pieces. If something is sold per kg, the unit must be kg." },
  { no: /^Ingen produkt har varenummeret (.+) som tagg$/, en: "No product has the article number $1 as a tag" },
  { no: /^Usikker kobling for (.+?) – velg salgsenheten på raden når varen kommer på en faktura$/, en: "Uncertain match for $1 – set the selling unit on the row when the product arrives on an invoice" },
  {
    no: /^Prisvarsel: leverandørprisen er opp (.+?) % \(varsler ved 10 % eller mer\)$/,
    en: "Price alert: the supplier's price is up $1 % (alerts at 10 % or more)",
  },
  {
    no: /^Prisvarsel: kostprisen inkl\. mva er opp (.+?) % fra forrige kjøp \(varsler ved 15 % eller mer\)$/,
    en: "Price alert: the cost incl. VAT is up $1 % from the previous purchase (alerts at 15 % or more)",
  },
  {
    no: /^Varenummeret passer, men størrelsen er ikke den samme \(faktura (.+?) g\/ml, Shopify (.+?) g\/ml\) – kontroller at det er riktig produkt$/,
    en: "The article number fits, but the size is not the same (invoice $1 g/ml, Shopify $2 g/ml) – check that it is the right product",
  },
  {
    no: /^Funnet på EAN \(ingen vare har varenummeret (.+) som tagg\)$/,
    en: "Found by EAN (no product has the article number $1 as a tag)",
  },
  {
    no: /^EAN finnes på (\d+) produkter og varenummeret finnes ikke som tagg – velg riktig$/,
    en: "EAN is on $1 products and the article number is not a tag – choose the right one",
  },
  {
    no: /^Varenummeret peker på «(.+)», men EAN peker på «(.+)» – kontroller hvilken som er riktig$/,
    en: "The article number points to «$1», but the EAN points to «$2» – check which one is right",
  },
  { no: /^Varenummeret finnes på (\d+) produkter – valgt etter EAN$/, en: "The article number is on $1 products – chosen by EAN" },
  { no: /^Varenummeret finnes på (\d+) produkter – valgt etter merke \((.+)\)$/, en: "The article number is on $1 products – chosen by brand ($2)" },
  {
    no: /^Varenummeret finnes på (\d+) produkter og merket avgjør ikke – velg riktig$/,
    en: "The article number is on $1 products and the brand doesn't decide – choose the right one",
  },

  // --- Suggestions (suggest.ts) ---
  { no: /^1 felles ord \((.+)\)$/, en: "1 shared word ($1)" },
  { no: /^(\d+) felles ord \((.+)\)$/, en: "$1 shared words ($2)" },
  { no: /^Merket «(.+)» står i navnet$/, en: "The brand «$1» is in the name" },
  { no: /^Samme størrelse \((.+)\)$/, en: "Same size ($1)" },
  { no: /^Samme antall per kartong \((.+)\)$/, en: "Same number per carton ($1)" },

  // --- Carton size (carton.ts) ---
  {
    no: /^Shopify er ikke konsekvent: tittelen sier (.+?), men pris ÷ stk-pris gir (.+)$/,
    en: "Shopify is inconsistent: the title says $1, but price ÷ per-pcs price gives $2",
  },
  { no: /^Kartongstørrelse: Shopify (.+?), faktura (.+?) – Shopify er brukt$/, en: "Carton size: Shopify $1, invoice $2 – Shopify is used" },
  {
    no: /^Tittelen sier (.+?) per kartong, fakturaen (.+?) – fakturaen er brukt$/,
    en: "The title says $1 per carton, the invoice $2 – the invoice is used",
  },
  {
    no: /^Stk per kartong \((.+?)\) er hentet fra tittelen – fakturaen sier det ikke$/,
    en: "Pcs per carton ($1) is taken from the title – the invoice doesn't say",
  },
  { no: /^Produkttype «(.*)» er ikke en pris$/, en: "Product type «$1» is not a price" },
  {
    no: /^Stk-pris (.+?) × (.+?) = (.+?), men Shopify-prisen er (.+)$/,
    en: "Per-pcs price $1 × $2 = $3, but the Shopify price is $4",
  },

  // --- Merging lines (merge.ts) ---
  { no: /^Linjene har ulik enhet \((.+)\)$/, en: "The lines have different units ($1)" },
  { no: /^Ulikt opprinnelsesland på samme varenummer: (.+)$/, en: "Different countries of origin on the same article number: $1" },
  { no: /^Ulike tollnummer på samme varenummer: (.+)$/, en: "Different customs numbers on the same article number: $1" },
  { no: /^Antall per kartong går ikke opp \((.+)\)$/, en: "Pcs per carton doesn't divide evenly ($1)" },

  // --- Duty sources (customs.ts, customs-service.ts) ---
  { no: /^Deklarasjon (.+) er allerede registrert$/, en: "Declaration $1 is already registered" },
  { no: /^Ugyldig CN8 «(.*)»$/, en: "Invalid CN8 «$1»" },
  { no: /^Deklarasjon (.+)$/, en: "Declaration $t1" },
  { no: /^Samme vare tidligere \((.+), ([^,()]+)\)$/, en: "Same product earlier ($t1, $2)" },
  { no: /^Samme HS6 (\d+) \((.+)\)$/, en: "Same HS6 $1 ($t2)" },
  { no: /^Register CN8 (\d+) \(deklarasjon (.+)\)$/, en: "CN8 register $1 (declaration $2)" },
  { no: /^To satser i samme celle \((.+)\) – oppgi én sats per vare$/, en: "Two rates in the same cell ($1) – give one rate per product" },

  // --- Bulk import (bulk-import.ts) ---
  {
    no: /^Fant ikke kolonnene for toll kr\/kg\. Overskrifter i filen: \(ingen\)\.$/,
    en: "Could not find the columns for duty NOK/kg. Headers in the file: (none).",
  },
  {
    no: /^Fant ikke kolonnene for toll kr\/kg\. Overskrifter i filen: (.+)\.$/,
    en: "Could not find the columns for duty NOK/kg. Headers in the file: $1.",
  },
  {
    no: /^Fant ikke kolonnene for varenummer, pris per enhet, dato\. Overskrifter i filen: \(ingen\)\.$/,
    en: "Could not find the columns for article number, price per unit, date. Headers in the file: (none).",
  },
  {
    no: /^Fant ikke kolonnene for varenummer, pris per enhet, dato\. Overskrifter i filen: (.+)\.$/,
    en: "Could not find the columns for article number, price per unit, date. Headers in the file: $1.",
  },

  // --- Grønt Punkt (gp.ts, gp-service.ts) ---
  { no: /^(.+): mangler vekt per flaske for (.+)$/, en: "$1: weight per bottle is missing for $2" },
  { no: /^(.+): ingen sats gjelder for (.+)$/, en: "$1: no rate applies for $2" },
  { no: /^Ukjent kategori brukt på: (.+)$/, en: "Unknown category used on: $1" },
  {
    no: /^(\d+) drikkevarelinje\(r\) i perioden mangler Grønt Punkt-kode og er ikke med i tallene$/,
    en: "$1 beverage line(s) in the period are missing a Grønt Punkt code and are not included in the figures",
  },
  { no: /^Forsendelser uten ankomstdato er ikke telt: (.+)$/, en: "Shipments without an arrival date are not counted: $1" },
  { no: /^Kategorien (.+) finnes ikke$/, en: "Category $1 does not exist" },
  {
    no: /^Kategori (.+) rapporteres i kg – legg inn emballasjevekt per flaske$/,
    en: "Category $1 is reported in kg – enter the packaging weight per bottle",
  },

  // --- Routes (app/api/varemottak) ---
  { no: /^Filen «(.+)» er for stor \(maks 15 MB\)$/, en: "The file «$1» is too large (max 15 MB)" },

  // --- Supplier readers (stanro.ts, generic.ts, pdf-claude.ts) ---
  {
    no: /^Filen har tegn som ikke kan leses \(lest som (.+?)\); polske bokstaver kan være feil$/,
    en: "The file has characters that can't be read (read as $1); Polish letters may be wrong",
  },
  { no: /^Filen har tegn som ikke kan leses \(lest som (.+)\)$/, en: "The file has characters that can't be read (read as $1)" },
  { no: /^Kolonnen "(.+)" mangler – (.+) må fylles inn for hånd$/, en: 'The column "$1" is missing – $t2 must be filled in by hand' },
  { no: /^Kolonnen for (.+) mangler – fylles inn for hånd$/, en: "The column for $t1 is missing – fill it in by hand" },
  { no: /^(.+): ingen datalinjer$/, en: "$1: no data lines" },
  { no: /^(.+): kolonnen "(.+)" mangler\. Overskrift: (.+)$/, en: '$1: the column "$2" is missing. Header: $3' },
  { no: /^(.+) rad (\d+): (.+) har ikke linjenummer$/, en: "$1 row $2: $3 has no line number" },
  { no: /^(.+) rad (\d+): linjenummer "(.*)" er ikke et tall$/, en: '$1 row $2: line number "$3" is not a number' },
  { no: /^(.+) rad (\d+) \(linje (.+?)\): tomt varenummer$/, en: "$1 row $2 (line $3): empty article number" },
  { no: /^(.+) rad (\d+) \(linje (.+?)\): antall er ikke et tall$/, en: "$1 row $2 (line $3): quantity is not a number" },
  { no: /^(.+) rad (\d+) \(linje (.+?)\): ukjent enhet "(.*)"$/, en: '$1 row $2 (line $3): unknown unit "$4"' },
  { no: /^(.+): ingen fakturalinjer$/, en: "$1: no invoice lines" },
  { no: /^(.+): forventet ett fakturanummer, fant ingen$/, en: "$1: expected one invoice number, found none" },
  { no: /^(.+): forventet ett fakturanummer, fant (.+)$/, en: "$1: expected one invoice number, found $2" },
  { no: /^(.+): linjenummer forekommer to ganger: (.+)$/, en: "$1: line numbers occur twice: $2" },
  { no: /^(.+): ingen varelinjer$/, en: "$1: no item lines" },
  {
    no: /^(.+): fant ikke kolonnene for varenummer, navn og antall\. Overskrifter i filen: \(ingen\)\. Angi hvilke kolonner som er hvilke\.$/,
    en: "$1: could not find the columns for article number, name and quantity. Headers in the file: (none). Specify which columns are which.",
  },
  {
    no: /^(.+): fant ikke kolonnene for varenummer, navn og antall\. Overskrifter i filen: (.+)\. Angi hvilke kolonner som er hvilke\.$/,
    en: "$1: could not find the columns for article number, name and quantity. Headers in the file: $2. Specify which columns are which.",
  },
  { no: /^(.+): filen blander valutaer \((.+)\)\. Del den opp per valuta\.$/, en: "$1: the file mixes currencies ($2). Split it up per currency." },
  {
    no: /^(.+): filen sier valuta (.+), men leverandøren er satt opp med (.+)\. Kontroller valget\.$/,
    en: "$1: the file says currency $2, but the supplier is set up with $3. Check the selection.",
  },
  {
    no: /^Filen inneholder (\d+) fakturaer \((.+)\)\. De importeres samlet; summene kan ikke kontrolleres per faktura\.$/,
    en: "The file contains $1 invoices ($2). They are imported together; the totals can't be checked per invoice.",
  },
  { no: /^Linje (\d+): antall kunne ikke leses og linjen er utelatt$/, en: "Line $1: the quantity could not be read and the line was left out" },
  {
    no: /^Linje (.+?) har ikke varenummer i PDF-en\. Uten varenummer kan varene ikke kobles til Shopify – last opp spesifikasjonsfilen\.$/,
    en: "Line $1 has no article number in the PDF. Without article numbers the items can't be matched to Shopify – upload the specification file.",
  },
  { no: /^Valutaen i PDF-en \((.+?)\) er ikke den du oppga \((.+?)\)$/, en: "The currency in the PDF ($1) is not the one you entered ($2)" },

  // --- Shopify (shopify/*.ts, shopify-admin.ts) ---
  {
    no: /^SHOPIFY_FAKE=1, men ingen øyeblikksbilde finnes \((.+)\)\. Kjør scripts\/snapshot-shopify\.mjs\.$/,
    en: "SHOPIFY_FAKE=1, but no snapshot exists ($1). Run scripts/snapshot-shopify.mjs.",
  },
  {
    no: /^SHOPIFY_API_VERSION (.+) er for gammel \(kreves 2024-10 eller nyere\)$/,
    en: "SHOPIFY_API_VERSION $1 is too old (2024-10 or newer is required)",
  },
  { no: /^Shopify avviste kallet: (.+)$/, en: "Shopify rejected the call: $1" },
  { no: /^Shopify-token feilet \((.+?)\): (.+)$/, en: "Shopify token request failed ($1): $t2" },
  { no: /^Shopify avviste forespørselen \((.+)\)$/, en: "Shopify rejected the request ($1)" },
  { no: /^Shopify svarte (.+)$/, en: "Shopify responded $1" },
  { no: /^GraphQL-feil: (.+)$/, en: "GraphQL error: $1" },
];

export const MESSAGE_RULES: MessageRule[] = [
  ...STATIC_MESSAGES.map(([no, en]) => ({ no: new RegExp(`^${escapeRegExp(no)}$`), en })),
  ...PATTERN_RULES,
];

function expand(en: string, m: RegExpExecArray): string {
  return en.replace(/\$([tp]?)(\d)/g, (_, mode: string, i: string) => {
    const part = m[Number(i)] ?? "";
    if (mode === "t") return translateMessage(part);
    if (mode === "p") return part.split("; ").map(translateMessage).join("; ");
    return part;
  });
}

export function translateMessage(text: string): string {
  for (const rule of MESSAGE_RULES) {
    const m = rule.no.exec(text);
    if (m) return expand(rule.en, m);
  }
  return text;
}
