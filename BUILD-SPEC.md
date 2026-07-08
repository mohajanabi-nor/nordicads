# Nordic Engros – NYHETER-katalog · Byggespesifikasjon

Mål: et verktøy som henter produkter fra Shopify og genererer en flersides A4-PDF
(«NYHETER & KAMPANJE»). Manuell kjøring via en knapp; output er en nedlastbar PDF.
Prototypen `build_catalogue.py` er den autoritative kilden for alle eksakte
piksel- og fargeverdier i designet — denne speccen beskriver datakontrakt og logikk.

---

## 1. Datakilde

- **Shopify Admin API.** Scopes: `read_products`, `read_inventory`.
- Hentes per kjøring. Ingen brukerinput utover et «Generer»-trykk.

### Produktfelter

| Felt i katalogen      | Kilde i Shopify                                  |
|-----------------------|--------------------------------------------------|
| Tittel                | `product.title`                                  |
| Leverandør            | `product.vendor`                                 |
| Opprinnelsesland      | **Produkt-metafield** (verdi = landnavn på engelsk, f.eks. «Poland») |
| Pris                  | `product.product_type` (tall, **inkl. mva**) → formateres «kr 34,90» |
| Kategori              | `product`-collections (se §4)                    |
| SKU                   | `variant.sku`                                    |
| Strekkode             | `variant.barcode` → Code128 (mangler → vis «N/A») |
| Bilde                 | Første produktbilde, 1024×1024, **alltid hvit bakgrunn, alltid til stede** |
| Opprettet             | `product.created_at` (for nyhet-vindu)           |
| Tilbud                | `variant.compare_at_price` satt = tilbud         |
| Lager                 | `variant.inventory_quantity` (for restock-deteksjon) |

> Metafield-navnet (namespace.key) for opprinnelsesland må bekreftes i Shopify-admin
> ved implementering.

---

## 2. Hva kommer med i utgaven + merkelogikk (Modell A — med tilstand)

Verktøyet **lagrer et øyeblikksbilde av lager per SKU hver kjøring** (liten lokal fil/db)
og sammenligner mot forrige kjøring for å finne hva som har ankommet.

Per produkt:

1. **Lager økt siden forrige øyeblikksbilde?** Hvis nei → ikke med i utgaven.
   Hvis ja → med i utgaven, og klassifiseres slik:
2. **`compare_at_price` satt** → **TILBUD** (vinner over alt annet). Vis kun ny pris.
3. Ellers **`created_at` < 7 dager** → **NYHET**.
4. Ellers → **RESTOCK** (ankommet, men gammel vare) → **intet merke**.

Merker på kort: NYHET (amber-trekant øvre høyre), TILBUD (samme plass, vinner over NYHET),
RESTOCK = ingen. Prisen viser alltid bare gjeldende pris.

- **Nyhet-vindu:** 7 dager (rullerende fra kjøretidspunkt).
- **Første kjøring** (ingen forrige snapshot): behandle alt med `created_at` < 7 dager som
  NYHET; lagre snapshot. (Implementeringsdetalj — bekreft ønsket oppførsel.)

---

## 3. Bildepipeline (per produkt)

**Bakgrunnsfjerning MÅ være ML-basert** (segmenterer selve produktet uansett farge),
f.eks. `rembg` (U2-Net) eller tilsvarende. Enkel farge-/flood-fill kan **ikke** brukes:
mange varer er hvite/lyse pakker på hvit bakgrunn (Raffaello og annet konfekt), og en
hvithetsbasert metode «lekker» inn i og ødelegger produktet.

> **Verifisert i prototypen:** flood-fill fungerte fint på fargerike pakker (Cheetos),
> men spiste det meste av den hvite Raffaello-boksen. ML-segmentering løser dette fordi
> den finner objektet, ikke fargen. (Modellen lastes ned første gang eller bundles;
> i dette prototyp-miljøet var nedlasting nettverksblokkert, derfor bruker prototypens
> `process_product()` fortsatt flood-fill — bytt til ML i produksjon.)

Deretter, per kort:
1. **Utklipp** via ML-segmentering → trim til innhold.
2. **Glans:** subtilt lyst skinn i øvre del, maskert til produktet.
3. **Bakkeskygge:** flat, myk ellipse på «gulvet» — bredde `0.94 × bredde`,
   høyde `0.18 × bredde`, opacitet `120`, gaussisk blur `~10`.
4. Skaler inn i boks ~`222 × 248 px`, sentrert, bunn-justert mot gulvet.

---

## 4. Kategorier (mellomsider)

- Kategori = produktets collection, **minus** «Siste ankomst» og tilbud-collectionen
  (disse ignoreres alltid som kategori).
- Rekkefølge er ikke kritisk, men **Frysevarer og Kjølevarer prioriteres øverst**;
  resten følger etter.
- Ligger en vare i flere kategori-collections → bruk den med høyest prioritet (Frysevarer/
  Kjølevarer først, ellers visningsrekkefølgen).
- Kategori-tittel = **collection-navnet**. **Ingen undertittel** (ingen collection-
  beskrivelser finnes). Mellomsiden viser: nummer (01, 02 …), kategorinavn, amber-strek,
  og «{antall} nye varer i denne kategorien».
- Tom kategori (ingen varer denne uka) → hopp over hele mellomsiden + produktsiden.

---

## 5. Forside – region-motor for etiketten

Flaggene = **alle land i utgaven** (unike, sortert etter antall varer). Etiketten velges slik:

- Kun ett land → «IMPORTERT FRA {LAND}».
- Alle land i samme region → «IMPORTERT FRA {BALKAN / ØST-EUROPA / SØR-EUROPA /
  VEST-EUROPA / NORDEN / ASIA / MIDTØSTEN}».
- Flere europeiske regioner → «IMPORTERT FRA EUROPA».
- Spenner over verdensdeler → «IMPORTERTE NYHETER» (nøytral fallback).

Region-settene og `caption_for()` ligger i prototypen og er enkle lister å justere.
Landnavn fra metafield (engelsk) mappes til ISO-kode før flagg/region slås opp.

- **Flagg:** bruk et **ekte ISO-kodet flagg-ikonsett (SVG)**, ikke prototypens
  håndtegnede. Ukjent/umappet land → fallback-brikke med landkoden.
- Maks ~9 flagg på rad; flere → 8 + «+N»-brikke.

---

## 6. Låst design (se `build_catalogue.py` for eksakte verdier)

- **Lerret:** 1240 × 1754 px (A4 @ 150 DPI). Font: **Montserrat** (variabel) på alt.
- **Palett:** mørk `#282A36`, cream `#F7F0DE`, amber (logo) `#FEBD59`,
  dyp amber `#E0951F` (pris, merker, tekst på lyse flater).
- **Sidestruktur:** Forside (mørk) → Mellomside 01 (cream) → Produktside(r) → … per kategori
  → Kontaktside (mørk).
- **Produktkort:** 347 × 672, radius 26, faste rader (bilde → navn ≤2 linjer → leverandør →
  pris (dyp amber) → «inkl. mva · SKU …» → Code128 → nummer). 3×2 = 6 per side, paginert,
  rad/grid sentrert. NYHET/TILBUD-merke = trekant øvre høyre, tekst sentrert i tyngdepunkt,
  klippet til avrundet hjørne.
- **Forside v2:** sol-glød bak logoen, ekte logo, wordmark + amber-strek + tagline,
  «NYHETER & KAMPANJE» + uke-«pill», dynamisk flagg/region-stripe, sentrert QR.
- **Mellomside (cream-v2):** stort faint nummer, kategorinavn, amber-strek, antall,
  logo som svakt vannmerke nede til høyre.
- **Kontaktside:** mørk, logo, firmainfo, QR/kontakt i amber.

---

## 7. Kjøring & output

- **Trigger:** manuelt — én «Generer»-knapp.
- **Output:** ferdig PDF til nedlasting.
- **Tilstand:** lager-snapshot lagres lokalt mellom kjøringer (kreves for restock i §2).
- **Uke/årstall** på forsiden: utledes fra dagens dato (ISO-uke) — bekreft format «Uke 23 · 2026».

---

## 8. Åpne detaljer å avklare ved implementering

1. Eksakt metafield namespace.key for opprinnelsesland.
2. Navnet på tilbud-collectionen (skal ignoreres som kategori), om den finnes.
3. Komplett liste over kategori-collections (verktøyet kan også bare lese alle og
   ekskludere «Siste ankomst» + tilbud).
4. Ønsket oppførsel ved aller første kjøring (ingen forrige snapshot).
5. Hvor lager-snapshot skal lagres (lokal fil holder for manuell kjøring).

Referanse-implementasjon for alt visuelt: **`build_catalogue.py`** (prototype, kjørende).

---

## 9. Sosialt: Story/Reel-system (andre output)

Egen output ved siden av katalogen. **Deler samme Shopify-data, samme cutout-pipeline (§3)
og samme merkevare.** Mens katalogen er fullstendig, er sosialt en *teaser* som sender folk
til katalogen/nettbutikken.

### 9.1 Format & design
- **9:16, 1080×1920.** To former: **mp4-reel** (animert) og **stillbilde-story**.
- Cream `#F7F0DE`-bunn, tynn **amber-ramme** (`#E0951F`) med myke, litt ulike hjørner
  (radier 70/34/70/34), logo (oransje merke + «NORDIC» mørk + «ENGROS» oransje), myke
  sirkler bak produktene, oransje CTA-stripe **«BESTILL I NETTBUTIKKEN · nordicengros.no»**,
  sub-linje. **Ingen pris** (pris bor i katalogen).
- Merkefarge er konsistent (oransje/amber). Variasjon skjer på **layout**, ikke farge.

### 9.2 Post-typer (innholdsmotor)
1. **Montasje-reel** – rullende vegg av **samtlige** nye + restockede varer, teller som
   klikker opp («X VARER I DENNE LEVERANSEN» – nøytral, dekker nye + restock), «BESTILL I NETTBUTIKKEN»-CTA til slutt.
   Rolig scroll-fart. Viser bredden; ingen vare utelates her.
2. **Kategori-reel** – én per ikke-tom kategori. Viser **alle nyhetene** i kategorien,
   **3 per scene** over flere scener (rangering = rekkefølge, ikke utvalg). Restock-varer
   med «TILBAKE PÅ LAGER»-merke.
3. **«Tilbake på lager»-reel** – for etterspurte restocks (ferskvarer som Twaróg). Egen
   urgency-linje, f.eks. «Fersk vare – bestill før den er borte».
4. **Merke-drop-reel** – når ett merke har mange nye varianter (f.eks. 10 Milka):
   «X NYE MILKA INNE», vis 2–3 representative + tallet, send til katalog for resten.
5. **Hero-reel** – enkeltvare-spotlight for utvalgte flaggskip-merker.
6. **Opprinnelse-spotlight** – «Nytt fra Polen / Ukraina / Tyskland», gruppert per land,
   med flagg. Unik B2B-vinkel.

### 9.3 Utvelgelse & rangering
- **Nyheter:** ALLE fremheves – ingen utelates. 3 per scene, sterkeste først.
- **Restock:** ALLE vises (montasje + katalog). I reels **deduplisert per merke**
  (maks ~2 per merke i én reel) for variasjon; mange av ett merke → merke-drop-reel (§9.2.4).
- **«Topp»/rekkefølge = rangeringsscore** (bestemmer rekkefølge + hero-plass, ikke om en
  vare er med):
  - **Salgstall** (krever `read_orders`) – best-selgere først. Sterkeste signal; gjelder
    restock/eksisterende varer (nyheter har ingen historikk ennå).
  - **Manuell «fremhev»-tag** i Shopify – eierens overstyring, vinner alltid.
  - **Boosts:** tilbud (`compare_at_price`), høy-etterspørsel-restock (var 0 → tilbake),
    kjent merke.
  - **Tiebreak:** nyeste + har godt bilde.
- Per-merke-tak (~2) i alle reels → unngå repetisjon (ikke 10 like Milka i én reel).

### 9.4 Merker & flagg
- Per vare et lite **merke/chip**: **NY** / **TILBAKE PÅ LAGER** / (valgfritt **TILBUD**).
  Nyhet vs restock kommer fra Modell A (§2, lager-snapshot).
- **Opprinnelse-flagg-chip**: ISO-flagg + «FRA {LAND}», fra land-metafelten (§1). Bruk ekte
  ISO-flaggsett; ukjent land → utelat chip.

### 9.5 Bevegelse (reels, ~5–8 sek)
- Logo + overskrift glir/fader inn → produkter **popper inn** forskjøvet nedenfra
  (ease-out) → lett **float**/bob (sinus, faseforskjøvet) → **glans-sveip** over hero-vare
  → flagg/merke **pop** (ease-out-back) → **CTA glir opp**. mp4, 24 fps.

### 9.6 Layouts (roterer for variasjon, samme farger)
- **fan** (tett, sentrert), **diagonal** (kaskade), **stagger** (ulike høyder),
  **hero** (1 vare). Verktøyet roterer/velger ut fra antall varer (1→hero, 2→diagonal/
  stagger, 3→fan, 3+→flere scener).

### 9.7 Enhet = DROP (ikke uke). Story-sett vs Reels
- **Enhet = drop (lastebil).** ~2–3 drops/uke. **Trigger:** eier kjører «Generer» når en
  drop lander → lager-snapshotet (§2) fanger akkurat den droppens nye + restockede varer.
- **Story-sett (per drop) = ALT.** Verktøyet lager en **sekvens 9:16-frames** med samtlige
  varer i droppen, gruppert per kategori, med NY / TILBAKE PÅ LAGER + flagg. Eier poster
  hele sekvensen på Story (24t, efemert → volum er forventet). Dette er eierens eksisterende
  vane og tar volumet.
- **Reels (per drop / uke) = KURATERT.** Montasje + de beste kategori-reelene + evt.
  tilbake-på-lager / merke-drop / hero. Til feed (permanent, algoritmisk rekkevidde).
  **Flere korte reels** (5–8 sek) slår én lang — frekvens + høy completion. Dryppes/
  planlegges i bulk (Meta Business Suite, TikTok scheduler).
- **Ingen auto-post, ingen bryter:** verktøyet lager settet, eier poster manuelt (Story-
  sekvensen + utvalgte reels).
- Samme filer gjenbrukes på **Instagram, Facebook, TikTok, WhatsApp Status**.
- **Lenke:** URL alltid trykt på bildet (WhatsApp Status kan ikke legge klikkbar lenke på
  bilde; Instagram/Facebook Story har link-sticker). Standard destinasjon = **live
  «Siste ankomst»/nyheter-collection** på nordicengros.no, med PDF som «Last ned katalog».

### 9.8 Cutout
- Som §3: **ML-først** (rembg/U2-Net), **kant-basert fallback** for hvit-på-hvit
  (verifisert nødvendig på hvite pakker; flood-fill ødelegger dem).

### 9.9 Referanse-prototyper (kjørende)
- `build_social_v5.py` – låst still-story (cream, amber-ramme, ingen pris).
- `build_social_v7.py` – layout-varianter (fan/diagonal/stagger/hero).
- `build_reel.py` – animert reel (pop-in/float/glans/CTA).
- `build_reel_choc.py` – kategori-reel + opprinnelse-flagg (diagonal).
- `build_reel_snacks.py` – 3-vare kategori-reel (fan) + flagg.
- `build_reel_restock.py` – «TILBAKE PÅ LAGER»-reel.
- `build_montage.py` – «X VARER INN DENNE UKEN» montasje med teller.

---

## 10. Åpne detaljer (sosialt)

1. `read_orders`-tilgang for salgstall-rangering (ellers fall tilbake på fremhev-tag + merke + nyhet).
2. Navn på «fremhev»-tag/metafield i Shopify.
3. Liste over «kjente merker» som får boost (valgfritt).
4. Endelig standard-destinasjon for CTA-lenken (live collection-URL).
5. Maks lengde per reel før split/carousel (Stories-frames cap ~15 sek).

---

## 11. Kampanje-/tilbudsbygger (manuell, på forespørsel)

Separat fra drop-automatikken. Eier kjører den når et tilbud skal ut.

- **Flyt:** eier setter tilbudet i Shopify FØRST (standard: `price` = ny tilbudspris,
  `compare_at_price` = original) → i verktøyet **velger eier bare varen(e)** → verktøyet
  leser **ny pris = `price`** og **før-pris = `compare_at_price`**, regner ut **−X %**, og
  genererer en **tilbuds-reel**. Ingen manuell skriving (samme kilde som webshop + katalog).
  Valgfri overstyring: skriv pris manuelt hvis posten lages før Shopify endres.
- **Eneste post-type med pris.** Viser: ny pris (stor, amber), «før»-pris overstrøket,
  **«−X %»-sticker**. Overskrift «TILBUD». CTA **«BESTILL NÅ · nordicengros.no»**.
- **9:16 reel (animert):** samme bevegelse som øvrige reels + pris-elementene popper inn.
- Deler merke + cutout-pipeline (§3, §9). Output = nedlastbar mp4 (+ evt. still).
- Flere varer i én tilbudspost: hver vare får sin egen ny-pris (eier skriver per vare),
  «før» hentes per vare fra Shopify. (Bekreft detalj ved bygging.)
- Referanse-prototyp: `build_reel_kampanje.py`.
