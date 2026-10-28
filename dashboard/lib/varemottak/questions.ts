/**
 * "Questions for you": everything the app could not decide by itself, grouped by cause, with the products
 * it concerns and — where the app can offer one — the fix. Pure and client-safe: the review screen builds the
 * list from the same calculated rows the table shows, and the import cards build theirs from what an import skipped.
 *
 * A question is never a vague "something is wrong": it says what is missing, which products it affects, why it
 * matters, and what to do. A fix is a control on the item (a number to type, a choice to click, a product to pick).
 */
import type { CustomsRate } from "./customs";
import { priceAlert } from "./history";
import { GIFT_WARNING, ICE_CREAM_WARNING, SANCTIONS_WARNING, SAUSAGE_WARNING, type CalculatedLine, type ShipmentRow } from "./lines";

/** Text in both languages; the screen shows the one the operator chose. */
export interface Bi {
  no: string;
  en: string;
}

export interface Choice {
  value: number;
  label: string;
  hint?: string;
}

/** What the app asked about in a customs file, with what it needs to save the answer. */
export interface RateAsk {
  kind: "supplier" | "two-rates" | "duty";
  scope: "cn8" | "product";
  cn8: string | null;
  idx: string | null;
  supplier: string | null;
  name: string;
  note: string;
  /** The rates the file gave for this row ("2.64 / 7.62" gives two). */
  options: number[];
  rateKind: "declaration" | "estimate";
  sourceRef: string;
  date: string;
  /** Suppliers that sell this article number according to the history, the register or the file itself. */
  guesses: string[];
}

export type LineField = "duty_per_kg" | "pcs_per_carton" | "net_weight_kg" | "sales_unit_kg" | "price_override" | "chosen_unit_price";

export type ItemFix =
  | { kind: "number"; field: LineField; unit: Bi; choices?: Choice[]; suggest?: { value: number; why: Bi } }
  | { kind: "pick" }
  | { kind: "shipment-rate"; currency: string }
  | { kind: "shipment-number"; field: "freight_amount"; unit: Bi }
  | { kind: "shipment-date"; field: "arrival_date" }
  | { kind: "rate-ask"; ask: RateAsk };

export interface QItem {
  key: string;
  lineId?: string;
  /** A product ("123 · Name") or, for shipment-level questions, text in both languages. */
  label: Bi | string;
  /** Server text in Norwegian (translated on screen) or text in both languages. */
  sub?: Bi | string;
  fix: ItemFix | null;
}

export interface Question {
  id: string;
  /** "blocking" stops the row (or the whole push); "check" is something to look at, the push is still possible. */
  severity: "blocking" | "check";
  title: Bi;
  why: Bi;
  /** What to do when the app has no fix of its own for these items. */
  howTo?: Bi;
  items: QItem[];
}

const num = (v: number) => (Math.round(v * 10000) / 10000).toString().replace(".", ",");
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The rates a code has been declared at, when there is more than one: the operator picks the one that applies. */
export function declaredOptions(hs: string | null, rates: CustomsRate[] | null): Choice[] {
  const cn8 = digits(hs).slice(0, 8);
  if (!rates || cn8.length < 8) return [];
  const byRate = new Map<string, { value: number; refs: string[] }>();
  for (const r of rates) {
    if (r.scope !== "cn8" || r.source_kind !== "declaration" || digits(r.cn8) !== cn8) continue;
    const key = r.duty_per_kg.toFixed(4);
    const entry = byRate.get(key) ?? { value: r.duty_per_kg, refs: [] };
    entry.refs.push(r.source_ref);
    byRate.set(key, entry);
  }
  if (byRate.size < 2) return [];
  return [...byRate.values()]
    .sort((a, b) => b.value - a.value)
    .map((e) => ({ value: e.value, label: `${num(e.value)} kr/kg`, hint: e.refs.slice(0, 2).join(", ") }));
}

/**
 * Fixed duty the client has stated for whole groups (package 6_special_cases.md). Only ever a suggestion the person
 * clicks: the app never applies a rate from the product group by itself.
 */
function clientRuleDuty(hs: string): { value: number; why: Bi } | null {
  if (/^09/.test(hs)) return { value: 0, why: { no: "Klientens regel: te og krydder (kapittel 09) har 0 i toll", en: "Client rule: tea and spices (chapter 09) carry 0 duty" } };
  if (/^121190/.test(hs)) return { value: 0, why: { no: "Klientens regel: tørket mynte (1211.90) har 0 i toll", en: "Client rule: dried mint (1211.90) carries 0 duty" } };
  if (/^040520/.test(hs)) return { value: 12.04, why: { no: "Klientens regel: kajmak og ABC-ost (0405.20) er 12,04 kr/kg (11,69 + 0,35)", en: "Client rule: kajmak and ABC cheese (0405.20) are 12.04 kr/kg (11.69 + 0.35)" } };
  return null;
}

export function shipmentQuestions(rows: CalculatedLine[], shipment: ShipmentRow, freightMissingRate: boolean, rates: CustomsRate[] | null): Question[] {
  const out: Question[] = [];
  const name = (c: CalculatedLine) => `${c.line.idx} · ${c.line.shopify?.title ?? c.line.name}`;
  const push = (q: Omit<Question, "items"> & { items: QItem[] }) => {
    if (q.items.length) out.push(q);
  };

  // ---- the shipment as a whole ----------------------------------------------------------------
  const noRate = new Set<string>();
  for (const c of rows) if (!c.input.rateToNok && c.line.currency) noRate.add(c.line.currency);
  if (freightMissingRate) noRate.add(shipment.freight_currency);
  push({
    id: "rates",
    severity: "blocking",
    title: { no: `Mangler kurs for ${[...noRate].join(", ")}`, en: `Missing exchange rate for ${[...noRate].join(", ")}` },
    why: {
      no: "Uten kurs kan varene ikke regnes om til kroner, så ingen kostpris eller pris kan beregnes. Bruk kursen på fakturaen eller fra banken den dagen.",
      en: "Without a rate the goods cannot be converted to kroner, so no cost or price can be calculated. Use the rate on the invoice or from the bank that day.",
    },
    items: [...noRate].map((currency) => ({ key: `rate-${currency}`, label: `1 ${currency} = ? NOK`, fix: { kind: "shipment-rate" as const, currency } })),
  });

  if (rows.length && (shipment.freight_amount === null || Number(shipment.freight_amount) === 0)) {
    push({
      id: "freight",
      severity: "check",
      title: { no: "Frakt er ikke lagt inn", en: "Freight has not been entered" },
      why: { no: "Alle kostpriser blir uten frakt og dermed for lave. Legg inn total frakt for forsendelsen (valutaen velger du i innstillingene).", en: "Every cost will be without freight and therefore too low. Enter the total freight for the shipment (choose its currency in the settings)." },
      items: [{ key: "freight", label: { no: `Total frakt i ${shipment.freight_currency}`, en: `Total freight in ${shipment.freight_currency}` }, fix: { kind: "shipment-number", field: "freight_amount", unit: { no: shipment.freight_currency, en: shipment.freight_currency } } }],
    });
  }
  if (rows.length && !shipment.arrival_date) {
    push({
      id: "arrival",
      severity: "check",
      title: { no: "Ankomstdato mangler", en: "Arrival date is missing" },
      why: { no: "Uten ankomstdato telles ikke varene i Grønt Punkt-rapporten.", en: "Without an arrival date the goods are not counted in the Grønt Punkt report." },
      items: [{ key: "arrival", label: { no: "Ankomstdato", en: "Arrival date" }, fix: { kind: "shipment-date", field: "arrival_date" } }],
    });
  }

  // ---- matching ----------------------------------------------------------------------------------
  push({
    id: "unmatched",
    severity: "blocking",
    title: { no: `${count(rows, (c) => c.line.match_status === "unmatched" || !c.line.shopify_product_id)} varer er ikke koblet til et Shopify-produkt`, en: `${count(rows, (c) => c.line.match_status === "unmatched" || !c.line.shopify_product_id)} items are not connected to a Shopify product` },
    why: {
      no: "Appen fant ikke produktet på varenummer, tagg eller strekkode. Uten kobling vet den ikke hvilket produkt prisen skal til. Velg produktet selv – valget huskes til neste gang.",
      en: "The app found no product by article number, tag or barcode. Without a link it does not know which product the price belongs to. Pick the product yourself – the choice is remembered for next time.",
    },
    items: rows
      .filter((c) => c.line.match_status === "unmatched" || !c.line.shopify_product_id)
      .map((c) => ({ key: `un-${c.line.id}`, lineId: c.line.id, label: `${c.line.idx} · ${c.line.name}`, sub: c.line.ean ? `EAN ${c.line.ean}` : undefined, fix: { kind: "pick" as const } })),
  });
  push({
    id: "doubtful",
    severity: "blocking",
    title: { no: `${count(rows, (c) => c.line.match_status === "doubtful")} koblinger er usikre`, en: `${count(rows, (c) => c.line.match_status === "doubtful")} matches are uncertain` },
    why: {
      no: "Appen foreslår et produkt, men er ikke sikker på at det er riktig. Se på forslaget og bekreft det, eller velg et annet.",
      en: "The app suggests a product but is not sure it is the right one. Look at the suggestion and confirm it, or pick another.",
    },
    items: rows
      .filter((c) => c.line.match_status === "doubtful")
      .map((c) => ({ key: `db-${c.line.id}`, lineId: c.line.id, label: name(c), sub: c.line.match_reason, fix: { kind: "pick" as const } })),
  });
  const dupes = rows.filter((c) => c.blocked.some((b) => b.startsWith("Samme Shopify-produkt")));
  push({
    id: "duplicate-product",
    severity: "blocking",
    title: { no: `${dupes.length} rader peker på samme Shopify-produkt som en annen rad`, en: `${dupes.length} rows point at the same Shopify product as another row` },
    why: { no: "Ett produkt kan bare få én pris. Står det på to rader, ville den siste overstyrt den første. Velg riktig produkt på én av radene.", en: "A product can only get one price. On two rows the last would overwrite the first. Pick the right product on one of the rows." },
    items: dupes.map((c) => ({ key: `dup-${c.line.id}`, lineId: c.line.id, label: name(c), fix: { kind: "pick" as const } })),
  });
  const variants = rows.filter((c) => c.line.shopify && c.line.shopify.variantCount > 1);
  push({
    id: "variants",
    severity: "blocking",
    title: { no: `${variants.length} produkter har flere varianter`, en: `${variants.length} products have several variants` },
    why: { no: "Prisene settes på produktets eneste variant. Har produktet flere, vet ikke appen hvilken som menes.", en: "Prices are set on the product's only variant. With several, the app cannot tell which one is meant." },
    howTo: { no: "Gjør produktet om til ett med én variant i Shopify, eller la raden stå og prisen på dette produktet endres for hånd i Shopify.", en: "Make the product a single-variant product in Shopify, or leave the row and change this product's price by hand in Shopify." },
    items: variants.map((c) => ({ key: `var-${c.line.id}`, lineId: c.line.id, label: name(c), fix: null })),
  });

  // ---- duty ---------------------------------------------------------------------------------------
  const noDuty = rows.filter((c) => c.result.flags.missingDuty);
  const ambiguous = noDuty.filter((c) => declaredOptions(c.line.hs, rates).length > 1).length;
  push({
    id: "duty",
    severity: "blocking",
    title: { no: `${noDuty.length} varer mangler toll`, en: `${noDuty.length} ${plural(noDuty.length, "item has", "items have")} no duty rate` },
    why: {
      no: `Toll er en del av kostprisen, så uten den kan prisen ikke regnes ut. Tollregisteret har ingen sats som kan brukes av seg selv${ambiguous ? " (noen koder er deklarert med flere ulike satser, og da gjetter appen aldri)" : ""}. Velg eller skriv inn satsen i kr per kg – den huskes for denne varen til neste gang.`,
      en: `Duty is part of the cost, so without it the price cannot be calculated. The customs register has no rate the app may use on its own${ambiguous ? " (some codes have been declared at several different rates, and then the app never guesses)" : ""}. Choose or type the rate in kr per kg – it is remembered for this product next time.`,
    },
    items: noDuty.map((c) => {
      const choices = declaredOptions(c.line.hs, rates);
      const hs = digits(c.line.hs);
      const sameCode = !choices.length && hs.length >= 6
        ? rows.find((o) => o.line.id !== c.line.id && o.line.duty_per_kg !== null && digits(o.line.hs).slice(0, 6) === hs.slice(0, 6))
        : undefined;
      return {
        key: `duty-${c.line.id}`,
        lineId: c.line.id,
        label: name(c),
        sub: hs
          ? { no: `Tollnr ${c.line.hs}${choices.length ? " – deklarert med ulike satser, velg den som gjelder" : ""}`, en: `Customs code ${c.line.hs}${choices.length ? " – declared at different rates, choose the one that applies" : ""}` }
          : { no: "Mangler tollnummer", en: "No customs code" },
        fix: {
          kind: "number" as const,
          field: "duty_per_kg" as const,
          unit: { no: "kr/kg", en: "kr/kg" },
          choices: choices.length ? choices : undefined,
          suggest: sameCode
            ? { value: Number(sameCode.line.duty_per_kg), why: { no: `Samme tollkode som ${sameCode.line.idx} i denne forsendelsen`, en: `Same customs code as ${sameCode.line.idx} in this shipment` } }
            : (!choices.length && clientRuleDuty(hs)) || undefined,
        },
      };
    }),
  });

  // ---- quantities and weights ---------------------------------------------------------------------
  const noPcs = rows.filter((c) => !c.line.pcs_per_carton);
  push({
    id: "pcs",
    severity: "blocking",
    title: { no: `${noPcs.length} varer mangler antall stk per kartong`, en: `${noPcs.length} ${plural(noPcs.length, "item is", "items are")} missing pieces per carton` },
    why: { no: "Shopify-prisen er per kartong, så appen må vite hvor mange stk det er i en kartong. Det står ikke på fakturaen og er ikke lest ut av produktet.", en: "The Shopify price is per carton, so the app needs to know how many pieces a carton holds. It is not on the invoice and could not be read from the product." },
    items: noPcs.map((c) => {
      const cartons = Number(c.line.cartons) || 0;
      const qty = Number(c.line.qty) || 0;
      const derived = c.line.unit === "pcs" && cartons > 0 && Number.isInteger(qty / cartons) ? qty / cartons : null;
      return {
        key: `pcs-${c.line.id}`,
        lineId: c.line.id,
        label: name(c),
        sub: c.line.shopify?.title && c.line.shopify.title !== c.line.name ? c.line.name : undefined,
        fix: { kind: "number" as const, field: "pcs_per_carton" as const, unit: { no: "stk/kartong", en: "pcs/carton" }, suggest: derived ? { value: derived, why: { no: `${qty} stk ÷ ${cartons} kartonger på fakturaen`, en: `${qty} pcs ÷ ${cartons} cartons on the invoice` } } : undefined },
      };
    }),
  });
  const noKgUnit = rows.filter((c) => c.line.unit === "kilo" && !c.line.sales_unit_kg);
  push({
    id: "kg-unit",
    severity: "blocking",
    title: { no: `${noKgUnit.length} kilovarer mangler salgsenhet`, en: `${noKgUnit.length} ${plural(noKgUnit.length, "kg item is", "kg items are")} missing a selling unit` },
    why: { no: "Fakturaen er per kilo, men du selger per pakke eller boks. Oppgi hvor mange kilo en salgsenhet er (for eksempel 1 eller 2,4), ellers blir marginen meningsløs. Huskes for varen.", en: "The invoice is per kilo but you sell per pack or box. Enter how many kilos one selling unit is (for example 1 or 2.4), otherwise the margin is meaningless. Remembered for the product." },
    items: noKgUnit.map((c) => ({ key: `kg-${c.line.id}`, lineId: c.line.id, label: name(c), fix: { kind: "number" as const, field: "sales_unit_kg" as const, unit: { no: "kg per enhet", en: "kg per unit" } } })),
  });
  const noWeight = rows.filter((c) => c.result.flags.missingWeight && !c.result.isDrink);
  push({
    id: "weight",
    severity: "check",
    title: { no: `${noWeight.length} varer mangler nettovekt`, en: `${noWeight.length} ${plural(noWeight.length, "item has", "items have")} no net weight` },
    why: { no: "Toll og frakt fordeles etter vekt, så en vare uten vekt får ingen av delene – kostprisen blir for lav.", en: "Duty and freight are shared by weight, so an item without weight gets neither – its cost comes out too low." },
    items: noWeight.map((c) => ({ key: `w-${c.line.id}`, lineId: c.line.id, label: name(c), fix: { kind: "number" as const, field: "net_weight_kg" as const, unit: { no: "kg totalt for raden", en: "kg total for the row" } } })),
  });

  // ---- prices --------------------------------------------------------------------------------------
  const conflicts = rows.filter((c) => c.line.price_conflict && c.line.chosen_unit_price === null);
  push({
    id: "price-conflict",
    severity: "blocking",
    title: { no: `${conflicts.length} varenumre står med ulik pris på fakturaen`, en: `${conflicts.length} article ${plural(conflicts.length, "number appears", "numbers appear")} at different prices on the invoice` },
    why: { no: "Samme varenummer er fakturert til to eller flere priser (for eksempel en kampanjepris). Appen kan ikke vite hvilken som skal være kostprisen. Velg prisen per enhet.", en: "The same article number is invoiced at two or more prices (for example a promotional price). The app cannot know which one is the cost. Choose the price per unit." },
    items: conflicts.map((c) => ({
      key: `pc-${c.line.id}`,
      lineId: c.line.id,
      label: name(c),
      fix: {
        kind: "number" as const,
        field: "chosen_unit_price" as const,
        unit: { no: c.line.currency, en: c.line.currency },
        choices: (c.line.price_conflict ?? []).map((p) => ({ value: p.unitPrice, label: `${num(p.unitPrice)} ${c.line.currency}`, hint: `${p.qty} stk` })),
      },
    })),
  });
  const kept = rows.filter((c) => c.result.casePriceKept && c.line.shopify && c.line.price_override === null);
  push({
    id: "price-kept",
    severity: "check",
    title: { no: `${kept.length} produkter har en pris i Shopify som ikke går opp`, en: `${kept.length} ${plural(kept.length, "product has", "products have")} a Shopify price that does not add up` },
    why: { no: "Shopify-prisen er ikke stk-prisen ganger antall i kartongen (eller stk-prisen mangler). Da beholder appen prisen i Shopify uendret og regner ikke ut en ny. Vil du endre den, skriv inn din egen pris per stk.", en: "The Shopify price is not the piece price times the pieces per carton (or the piece price is missing). The app then keeps the Shopify price unchanged and does not calculate a new one. To change it, type your own price per piece." },
    items: kept.map((c) => ({
      key: `kept-${c.line.id}`,
      lineId: c.line.id,
      label: name(c),
      sub: c.line.shopify ? { no: `Shopify: ${c.line.shopify.productType || "ingen stk-pris"} × ${c.line.pcs_per_carton ?? "?"} ≠ ${c.line.shopify.variantPrice}`, en: `Shopify: ${c.line.shopify.productType || "no piece price"} × ${c.line.pcs_per_carton ?? "?"} ≠ ${c.line.shopify.variantPrice}` } : undefined,
      fix: { kind: "number" as const, field: "price_override" as const, unit: { no: "kr per stk", en: "kr per piece" } },
    })),
  });

  const barcode = rows.filter((c) => c.warnings.some((w) => w.startsWith("Strekkoden i Shopify") || w.startsWith("Produktet mangler strekkode")));
  push({
    id: "barcode",
    severity: "check",
    title: { no: `${barcode.length} strekkoder stemmer ikke med Shopify`, en: `${barcode.length} ${plural(barcode.length, "barcode does", "barcodes do")} not match Shopify` },
    why: { no: "Koblingen ble gjort på varenummeret, så prisen går til riktig produkt. Men strekkoden på fakturaen er en annen enn den i Shopify – kan være feil produkt eller en gammel strekkode.", en: "The match was made on the article number, so the price goes to the right product. But the invoice barcode differs from Shopify's – it may be the wrong product or an old barcode." },
    howTo: { no: "Sjekk produktet i Shopify. Appen endrer aldri strekkoder.", en: "Check the product in Shopify. The app never changes barcodes." },
    items: barcode.map((c) => ({ key: `bc-${c.line.id}`, lineId: c.line.id, label: name(c), sub: c.warnings.find((w) => w.includes("trekkode")), fix: null })),
  });

  // ---- price increase alert (the client's step 12) --------------------------------------------------
  const alerts = rows
    .map((c) => ({ c, alert: priceAlert(c.line.history?.change, c.line.history?.previous, c.result.costInclVat) }))
    .filter((x) => x.alert)
    .sort((a, b) => Math.max(b.alert!.costPct ?? 0, b.alert!.supplierPct ?? 0) - Math.max(a.alert!.costPct ?? 0, a.alert!.supplierPct ?? 0));
  push({
    id: "price-alert",
    severity: "check",
    title: { no: `${alerts.length} varer har fått prisvarsel`, en: `${alerts.length} ${plural(alerts.length, "item has", "items have")} a price alert` },
    why: {
      no: "Leverandørprisen er opp 10 % eller mer, eller kostprisen inkl. mva er opp 15 % eller mer, mot forrige kjøp. En kostpris på nøyaktig 8,00 regnes som plassholder og telles ikke.",
      en: "The supplier price is up 10 % or more, or the cost incl. VAT is up 15 % or more, against the previous purchase. A previous cost of exactly 8.00 is a placeholder and is not counted.",
    },
    howTo: { no: "Se på prisen vår: er den fortsatt riktig med den nye kosten? Skriv inn ny pris på raden om ikke.", en: "Look at our price: is it still right with the new cost? Type a new price on the row if not." },
    items: alerts.map(({ c, alert }) => ({
      key: `alert-${c.line.id}`,
      lineId: c.line.id,
      label: name(c),
      sub: {
        no: [alert!.supplierPct !== null ? `leverandør +${num(alert!.supplierPct * 100)} %` : "", alert!.costPct !== null ? `kost +${num(alert!.costPct * 100)} %` : ""].filter(Boolean).join(" · "),
        en: [alert!.supplierPct !== null ? `supplier +${num(alert!.supplierPct * 100)} %` : "", alert!.costPct !== null ? `cost +${num(alert!.costPct * 100)} %` : ""].filter(Boolean).join(" · "),
      },
      fix: null,
    })),
  });

  // ---- the client's special cases: never priced without a person looking ------------------------------
  const special = (id: string, warning: string, title: (n: number) => Bi, why: Bi, howTo: Bi) => {
    const hit = rows.filter((c) => c.warnings.includes(warning));
    push({ id, severity: "check", title: title(hit.length), why, howTo, items: hit.map((c) => ({ key: `${id}-${c.line.id}`, lineId: c.line.id, label: name(c), sub: { no: `Opprinnelse ${c.line.country || "?"}, HS ${c.line.hs ?? "?"}`, en: `Origin ${c.line.country || "?"}, HS ${c.line.hs ?? "?"}` }, fix: null })) });
  };
  special(
    "sanctions",
    SANCTIONS_WARNING,
    (n) => ({ no: `${n} varer kommer fra Russland eller Belarus`, en: `${n} ${plural(n, "item comes", "items come")} from Russia or Belarus` }),
    { no: "Varer med opprinnelse Russland eller Belarus skal gjennom en sanksjonssjekk før de sendes.", en: "Items of Russian or Belarusian origin must go through a sanctions check before they are sent." },
    { no: "Gjør sjekken, og la raden stå ufullført til den er gjort.", en: "Do the check, and leave the row not done until it is done." },
  );
  special(
    "sausage",
    SAUSAGE_WARNING,
    (n) => ({ no: `${n} pølser (HS 1601) må sjekkes`, en: `${n} ${plural(n, "sausage", "sausages")} (HS 1601) must be checked` }),
    { no: "Samme pølse har hatt 84,31 kr/kg på noen deklarasjoner og 0 på andre (tollkvote). Appen antar aldri 0.", en: "The same sausage has had 84.31 kr/kg on some declarations and 0 on others (tariff quota). The app never assumes 0." },
    { no: "Sjekk satsen mot siste deklarasjon, og skriv den inn på raden. Tollen kan bli større enn innkjøpsprisen.", en: "Check the rate against the latest declaration and type it on the row. The duty can be larger than the purchase price." },
  );
  special(
    "ice-cream",
    ICE_CREAM_WARNING,
    (n) => ({ no: `${n} iskrem-varer (HS 2105) har ukjent toll`, en: `${n} ice cream ${plural(n, "item", "items")} (HS 2105) with unknown duty` }),
    { no: "Iskrem har høy norsk toll som ikke er kjent før deklarasjonen kommer. Kostprisen i Shopify blir for lav til da.", en: "Ice cream carries high Norwegian duty that is not known until the declaration arrives. The cost in Shopify is too low until then." },
    { no: "Skriv inn et anslag på raden nå, og regn om når deklarasjonen er kommet.", en: "Type an estimate on the row now, and recalculate when the declaration has arrived." },
  );
  special(
    "gift",
    GIFT_WARNING,
    (n) => ({ no: `${n} varer har nesten null i enhetspris`, en: `${n} ${plural(n, "item has", "items have")} almost no unit price` }),
    { no: "Enhetspris på 0,05 eller lavere er ofte en gave i leveransen. Da består kostprisen bare av frakt og toll.", en: "A unit price of 0.05 or less is often a gift in the delivery. The cost is then only freight and duty." },
    { no: "Bestem om varen skal prises. Beholder du den, sjekk kostprisen og prisen.", en: "Decide whether the item should be priced. If you keep it, check the cost and the price." },
  );

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
}

function count(rows: CalculatedLine[], f: (c: CalculatedLine) => boolean) {
  return rows.filter(f).length;
}

/**
 * The rows a customs-rate import could not use but could ask about, as questions: who sells an article, which of
 * two rates applies, what the missing rate is. Rows with no way to ask stay in the plain list of skipped rows.
 */
export function rateQuestions(skipped: Array<{ row: number; reason: string; ask?: RateAsk }>): Question[] {
  const out: Question[] = [];
  const asks = skipped.filter((s): s is { row: number; reason: string; ask: RateAsk } => !!s.ask);
  const item = (s: { row: number; ask: RateAsk }): QItem => {
    const a = s.ask;
    const code = a.idx ?? a.cn8 ?? "";
    return {
      key: `row-${s.row}`,
      label: `${code}${a.name ? ` · ${a.name}` : ""}`,
      sub: { no: `Rad ${s.row} i filen${a.note ? ` – ${a.note}` : ""}`, en: `Row ${s.row} in the file${a.note ? ` – ${a.note}` : ""}` },
      fix: { kind: "rate-ask", ask: a },
    };
  };
  const of = (kind: RateAsk["kind"]) => asks.filter((s) => s.ask.kind === kind);

  const noSupplier = of("supplier");
  if (noSupplier.length) {
    const n = noSupplier.length;
    out.push({
      id: "rate-supplier",
      severity: "blocking",
      title: { no: `${n} ${plural(n, "sats", "satser")} mangler leverandør`, en: `${n} ${plural(n, "rate has", "rates have")} no supplier` },
      why: {
        no: "En sats for en bestemt vare gjelder bare varenummeret hos én leverandør, for ulike leverandører kan bruke samme nummer. Filen sier ikke hvem som selger varen, så satsen er ikke lagret. Velg leverandør per vare – der appen kjenner varenummeret fra før, er leverandøren foreslått.",
        en: "A rate for a specific product applies to that article number at one supplier, because different suppliers can use the same number. The file does not say who sells the product, so the rate was not saved. Choose the supplier for each product – where the app already knows the article number, the supplier is suggested.",
      },
      items: noSupplier.map(item),
    });
  }
  const two = of("two-rates");
  if (two.length) {
    const n = two.length;
    out.push({
      id: "rate-two",
      severity: "blocking",
      title: { no: `${n} ${plural(n, "rad har", "rader har")} to satser i samme celle`, en: `${n} ${plural(n, "row holds", "rows hold")} two rates in one cell` },
      why: {
        no: "Samme tollnummer er deklarert med to ulike satser (for eksempel etter hva slags vare det er). Appen kan ikke velge selv. Registrerer du begge, bruker appen aldri tollnummeret automatisk, og du velger sats per vare på gjennomgangssiden. Velger du bare én, brukes den på alle varer med dette nummeret.",
        en: "The same customs code was declared at two different rates (for example depending on the kind of product). The app cannot choose. If you register both, the app never fills this code in automatically, and you choose the rate per product on the review screen. If you choose just one, it is used for every product with this code.",
      },
      items: two.map(item),
    });
  }
  const noRate = of("duty");
  if (noRate.length) {
    const n = noRate.length;
    out.push({
      id: "rate-duty",
      severity: "blocking",
      title: { no: `${n} ${plural(n, "rad har", "rader har")} ingen brukbar sats`, en: `${n} ${plural(n, "row has", "rows have")} no usable rate` },
      why: { no: "Toll kr/kg er tom eller ikke et tall. Skriv inn satsen, eller rett den i filen og last den opp igjen.", en: "Duty kr/kg is empty or not a number. Type the rate, or correct it in the file and upload it again." },
      items: noRate.map(item),
    });
  }
  return out;
}
