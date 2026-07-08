"""Region engine + country-name mapping for the cover label (BUILD-SPEC §5).

The origin metafield holds an ENGLISH country name (e.g. "Poland"). We map it to
an ISO-3166-1 alpha-2 code, then resolve the cover caption from region sets.
"""
from __future__ import annotations

from typing import Optional

# --- region sets (ISO-2) ---
BALKAN = {"RS", "HR", "SI", "BA", "MK", "AL", "ME", "XK", "BG"}
OST_EUROPA = BALKAN | {"PL", "UA", "LV", "LT", "EE", "CZ", "SK", "HU", "RO", "BY", "RU", "MD"}
SOR_EUROPA = {"IT", "ES", "PT", "GR", "MT"}
VEST_EUROPA = {"DE", "NL", "FR", "BE", "LU", "AT", "CH", "IE", "GB"}
NORDEN = {"NO", "SE", "DK", "FI", "IS"}
ASIA = {"CN", "TH", "VN", "IN", "JP", "KR", "ID", "MY", "PH", "PK", "BD"}
MIDTOSTEN = {"TR", "LB", "SY", "IL", "JO", "SA", "AE", "IR", "IQ"}
EUROPA = OST_EUROPA | SOR_EUROPA | VEST_EUROPA | NORDEN | {"TR"}

REGION_ORDER = [
    (BALKAN, "BALKAN"),
    (NORDEN, "NORDEN"),
    (SOR_EUROPA, "SØR-EUROPA"),
    (VEST_EUROPA, "VEST-EUROPA"),
    (OST_EUROPA, "ØST-EUROPA"),
    (ASIA, "ASIA"),
    (MIDTOSTEN, "MIDTØSTEN"),
]

# Norwegian display names for single-country caption.
NAME_NO = {
    "PL": "POLEN", "DE": "TYSKLAND", "NL": "NEDERLAND", "RS": "SERBIA", "HR": "KROATIA",
    "SI": "SLOVENIA", "IT": "ITALIA", "TR": "TYRKIA", "UA": "UKRAINA", "LV": "LATVIA",
    "LT": "LITAUEN", "EE": "ESTLAND", "CZ": "TSJEKKIA", "SK": "SLOVAKIA", "HU": "UNGARN",
    "RO": "ROMANIA", "BG": "BULGARIA", "GR": "HELLAS", "ES": "SPANIA", "FR": "FRANKRIKE",
    "PT": "PORTUGAL", "CN": "KINA", "TH": "THAILAND", "VN": "VIETNAM", "IN": "INDIA",
    "BA": "BOSNIA-HERCEGOVINA", "MK": "NORD-MAKEDONIA", "AL": "ALBANIA", "ME": "MONTENEGRO",
    "XK": "KOSOVO", "BY": "HVITERUSSLAND", "RU": "RUSSLAND", "MD": "MOLDOVA",
    "MT": "MALTA", "BE": "BELGIA", "LU": "LUXEMBOURG", "AT": "ØSTERRIKE", "CH": "SVEITS",
    "IE": "IRLAND", "GB": "STORBRITANNIA", "NO": "NORGE", "SE": "SVERIGE", "DK": "DANMARK",
    "FI": "FINLAND", "IS": "ISLAND", "JP": "JAPAN", "KR": "SØR-KOREA", "ID": "INDONESIA",
    "MY": "MALAYSIA", "PH": "FILIPPINENE", "PK": "PAKISTAN", "BD": "BANGLADESH",
    "LB": "LIBANON", "SY": "SYRIA", "IL": "ISRAEL", "JO": "JORDAN", "SA": "SAUDI-ARABIA",
    "AE": "DE FORENTE ARABISKE EMIRATER", "IR": "IRAN", "IQ": "IRAK",
}

# Country name -> ISO-2. The store metafield is free-text and messy (misspellings,
# Norwegian names, adjectival forms, US states/cities). Map every observed variant.
ENGLISH_TO_ISO = {
    "poland": "PL", "germany": "DE", "netherlands": "NL", "the netherlands": "NL",
    "holland": "NL", "serbia": "RS", "croatia": "HR", "slovenia": "SI", "italy": "IT",
    "turkey": "TR", "turkiye": "TR", "türkiye": "TR", "ukraine": "UA", "latvia": "LV",
    "lithuania": "LT", "estonia": "EE", "czech republic": "CZ", "czechia": "CZ",
    "slovakia": "SK", "hungary": "HU", "romania": "RO", "bulgaria": "BG", "greece": "GR",
    "spain": "ES", "france": "FR", "portugal": "PT", "china": "CN", "thailand": "TH",
    "vietnam": "VN", "viet nam": "VN", "india": "IN",
    "bosnia and herzegovina": "BA", "bosnia": "BA", "bosnia-herzegovina": "BA",
    "north macedonia": "MK", "macedonia": "MK", "albania": "AL", "montenegro": "ME",
    "kosovo": "XK", "belarus": "BY", "russia": "RU", "moldova": "MD", "malta": "MT",
    "belgium": "BE", "luxembourg": "LU", "austria": "AT", "switzerland": "CH",
    "ireland": "IE", "united kingdom": "GB", "great britain": "GB", "uk": "GB",
    "england": "GB", "norway": "NO", "sweden": "SE", "denmark": "DK", "finland": "FI",
    "iceland": "IS", "japan": "JP", "south korea": "KR", "korea": "KR", "indonesia": "ID",
    "malaysia": "MY", "philippines": "PH", "pakistan": "PK", "bangladesh": "BD",
    "lebanon": "LB", "syria": "SY", "israel": "IL", "jordan": "JO", "saudi arabia": "SA",
    "united arab emirates": "AE", "uae": "AE", "iran": "IR", "iraq": "IQ",
}

# Observed real-store variants: Norwegian names, misspellings, adjectival forms,
# US states/cities, and extra origins. Junk values (Frugo, Apetina, "Må sjekke
# land", brand names) stay unmapped -> chip omitted.
ENGLISH_TO_ISO.update({
    # Norwegian spellings
    "polen": "PL", "tyskland": "DE", "nederland": "NL", "netherland": "NL",
    "danmark": "DK", "norge": "NO", "sverige": "SE", "frankrike": "FR",
    "spania": "ES", "italia": "IT", "hellas": "GR", "tyrkia": "TR", "ungarn": "HU",
    "irak": "IQ", "kina": "CN", "japansk": "JP", "sveits": "CH", "østerrike": "AT",
    "tsjekkia": "CZ", "litauen": "LT", "kroatia": "HR", "slovenia": "SI",
    # UK pieces / US variants
    "scotland": "GB", "england": "GB", "wales": "GB", "london": "GB",
    "usa": "US", "u.s.a": "US", "u.s.a.": "US", "us": "US", "america": "US",
    "united states of america": "US", "california": "US",
    # misspellings / adjectival
    "hungaria": "HU", "romanian": "RO", "romina": "RO", "romana": "RO",
    "ukrainsk": "UA", "ukranisk": "UA", "ukraina": "UA", "urikane": "UA",
    "ukrainian": "UA", "sirbja": "RS", "serbian": "RS", "syra": "SY", "syira": "SY",
    "syrian": "SY", "syrien": "SY", "labanon": "LB", "lebanese": "LB",
    "eygpt": "EG", "egyptian": "EG", "marocco": "MA", "moroccan": "MA",
    "spanien": "ES", "korean": "KR", "vietnamese": "VN", "polish": "PL",
    "german": "DE", "italian": "IT", "bulgarian": "BG", "greek": "GR",
    # additional real origins
    "egypt": "EG", "morocco": "MA", "tunisia": "TN", "algeria": "DZ",
    "oman": "OM", "taiwan": "TW", "georgia": "GE", "mexico": "MX", "brazil": "BR",
    "argentina": "AR", "afghanistan": "AF", "nigeria": "NG", "sudan": "SD",
    "jamaica": "JM", "south africa": "ZA", "palestine": "PS", "sri lanka": "LK",
    "qatar": "QA", "kuwait": "KW", "bahrain": "BH", "yemen": "YE", "libya": "LY",
    "armenia": "AM", "azerbaijan": "AZ", "kazakhstan": "KZ", "singapore": "SG",
    "cambodia": "KH", "myanmar": "MM", "nepal": "NP", "ghana": "GH", "kenya": "KE",
    "ethiopia": "ET", "somalia": "SO", "eritrea": "ER",
})

# Norwegian display names for new single-country captions.
NAME_NO.update({
    "US": "USA", "EG": "EGYPT", "MA": "MAROKKO", "TN": "TUNISIA", "DZ": "ALGERIE",
    "OM": "OMAN", "TW": "TAIWAN", "GE": "GEORGIA", "MX": "MEXICO", "BR": "BRASIL",
    "AR": "ARGENTINA", "AF": "AFGHANISTAN", "NG": "NIGERIA", "SD": "SUDAN",
    "JM": "JAMAICA", "ZA": "SØR-AFRIKA", "PS": "PALESTINA", "LK": "SRI LANKA",
    "QA": "QATAR", "KW": "KUWAIT", "BH": "BAHRAIN", "YE": "JEMEN", "LY": "LIBYA",
    "AM": "ARMENIA", "AZ": "ASERBAJDSJAN", "KZ": "KASAKHSTAN", "SG": "SINGAPORE",
    "GH": "GHANA", "KE": "KENYA", "ET": "ETIOPIA", "SO": "SOMALIA",
    "ER": "ERITREA",
})

# Extend region sets so caption resolution still works across these origins.
ASIA |= {"LK", "TW", "SG", "KH", "MM", "NP", "KZ", "AF"}
MIDTOSTEN |= {"EG", "PS", "OM", "QA", "KW", "BH", "YE", "LY"}

# Every ISO-2 code we recognise (mapping targets + caption display names).
# Used to gate the "already an ISO code" path so we never invent a country.
KNOWN_ISO = set(ENGLISH_TO_ISO.values()) | set(NAME_NO.keys())


def country_to_iso(name: Optional[str]) -> Optional[str]:
    """Map a free-text origin value to an ISO-2 code, or None.

    Never guesses: a value maps only if it is an explicit known variant or an
    already-valid known ISO code. Unknown/junk -> None -> no flag is shown.
    """
    if not name:
        return None
    key = name.strip().lower()
    if key in ENGLISH_TO_ISO:
        return ENGLISH_TO_ISO[key]
    # Already an ISO-2 code? Only accept codes we actually recognise.
    up = name.strip().upper()
    if len(up) == 2 and up.isalpha() and up in KNOWN_ISO:
        return up
    return None


def caption_for(codes: list[str]) -> str:
    """Cover label from the set of ISO codes in the edition (BUILD-SPEC §5)."""
    s = {c for c in codes if c}
    if not s:
        return "IMPORTERTE NYHETER"
    if len(s) == 1:
        c = next(iter(s))
        return "IMPORTERT FRA " + NAME_NO.get(c, c)
    for region, label in REGION_ORDER:
        if s <= region:
            return "IMPORTERT FRA " + label
    if s <= EUROPA:
        return "IMPORTERT FRA EUROPA"
    return "IMPORTERTE NYHETER"
