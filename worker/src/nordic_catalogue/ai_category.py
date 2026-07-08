"""AI product categorisation (catalogue + social share this).

Why: store collections are temperature/structural buckets (Frysevarer, Kjølevarer,
Tørrvarer, Hovedside), product_type holds a *price number*, and vendor is useless
(Mondelez makes both ice cream and chocolate). So we classify each product into a
real food category from its NAME (+ image only when ambiguous), once, cheaply.

Pipeline:
  1. cache  — classify each product once, keyed by id + a hash of its title, in
              SQLite (state/categories.sqlite3). Re-classify only if title changes.
  2. model  — uncached products go to a cheap LLM (Anthropic Haiku) in batches,
              constrained to a closed TAXONOMY. Collections are passed only as a
              hint. No key available → deterministic keyword fallback.
  3. override— state/category_overrides.json ({id|sku|title: category}) wins over
              everything (manual corrections).

Optionally writes the resolved category back to Shopify as a tag/metafield.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Iterable, Optional

import requests

from .config import CONFIG
from .models import Product

# Closed taxonomy — the model must map every product into exactly one of these.
TAXONOMY = [
    "Iskrem", "Kjøtt", "Fisk & Sjømat", "Frukt & Grønt", "Meieri & Ost",
    "Bakeri", "Ferdigmat", "Hermetikk", "Ris & Pasta", "Krydder & Sauser",
    "Snacks", "Sjokolade", "Godteri", "Søtsaker", "Drikke", "Kaffe & Te",
    "Husholdning", "Annet",
]
# Display order in the catalogue / social (fresh & frozen first, non-food last).
DISPLAY_ORDER = {c: i for i, c in enumerate(TAXONOMY)}
FALLBACK = "Annet"

_MODEL = os.getenv("AI_CATEGORY_MODEL", "claude-3-5-haiku-20241022")
_API = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/") + "/v1/messages"


# --------------------------------------------------------------------------- #
# cache                                                                        #
# --------------------------------------------------------------------------- #
def _db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE IF NOT EXISTS category_cache ("
        " product_id TEXT PRIMARY KEY, title_hash TEXT, category TEXT, source TEXT)"
    )
    return con


def _title_hash(title: str) -> str:
    return hashlib.sha1(title.strip().lower().encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# keyword fallback (used when no API key; also a safety net for model misses)  #
# --------------------------------------------------------------------------- #
_KEYWORDS: list[tuple[str, str]] = [
    # order matters — first match wins
    ("Iskrem", r"\b(ice ?lolly|ice cream|iskrem|sunlolly|\bice\b|gelato|saft.?is)\b"),
    ("Kjøtt", r"\b(kylling|kyckling|chicken|kjøtt|kjott|beef|kalv|lamb|lam|pølse|polse|sausage|kebab|kjøttdeig|hjerna|kalvlägg|meat)\b"),
    ("Fisk & Sjømat", r"\b(fisk|fish|tuna|tunfisk|sardine|reker|shrimp|laks|salmon|seafood)\b"),
    ("Kaffe & Te", r"\b(tea|\bte\b|chai|ahmad|coffee bean|cardamom coffee|kaffe|haseeb)\b"),
    ("Drikke", r"\b(drink|soda|brus|cola|energy|energidrikk|juice|nectar|red bull|monster|fanta|pepsi|mirinda|mountain dew|nescafe|latte|water|vann)\b"),
    ("Sjokolade", r"\b(chocolate|sjokolade|milka|kakao|cocoa bar|praline|nutella)\b"),
    ("Snacks", r"\b(chips|crisps|cheetos|lays|wafer|waffle|cracker|kjeks|popcorn|snack|nachos|pretzel|góralka|goralka|prince polo)\b"),
    ("Godteri", r"\b(candy|candies|caramel|toffee|gummi|godteri|jelly|lollipop|drops|pastiller|fizzy|toffelini|binky)\b"),
    ("Søtsaker", r"\b(halawa|halva|maamoul|baklava|tahin|tahini|dessert|pudding|søt|sweets)\b"),
    ("Bakeri", r"\b(bread|brød|brod|croissant|bun|bakery|bakeri|cake|kake|pita|lavash|bread stick|kjeksbrød|knekkebrød)\b"),
    ("Meieri & Ost", r"\b(cheese|ost|cream|fløte|flote|melk(?!.?pulver)|milk(?! flavored)|yoghurt|smør|butter|labneh)\b"),
    ("Frukt & Grønt", r"\b(okra|beans|broad bean|artichoke|molokhia|vegetable|grønnsak|frukt|fruit|tomato|onion|potato|spinach|garlic)\b"),
    ("Hermetikk", r"\b(olives|oliven|dolmeh|dolma|canned|hermetikk|paste\b|pickled|vine leaves|chickpeas|hummus|foul|fava)\b"),
    ("Ris & Pasta", r"\b(rice|ris|basmati|pasta|spaghetti|noodle|nudler|bulgur|couscous|freekeh|vermicelli)\b"),
    ("Krydder & Sauser", r"\b(sauce|saus|syrup|sirup|ketchup|mayonnaise|spice|krydder|pepper paste|molasses|vinegar|oil|olje|salt|seasoning)\b"),
    ("Ferdigmat", r"\b(falafel|ready meal|ferdigmat|soup|suppe|pizza\b|lasagne|sambousek|spring roll)\b"),
    ("Husholdning", r"\b(shisha|charcoal|kull|non food|coal|briquettes|napkin|foil|bag|cup|plate|cleaning|tobacco|snus)\b"),
]
_KW = [(cat, re.compile(rx, re.IGNORECASE)) for cat, rx in _KEYWORDS]


def heuristic_category(title: str, collections: Iterable[str] = ()) -> str:
    text = title + " " + " ".join(collections)
    for cat, rx in _KW:
        if rx.search(text):
            return cat
    return FALLBACK


# --------------------------------------------------------------------------- #
# LLM batch classify                                                           #
# --------------------------------------------------------------------------- #
def _api_key() -> str:
    return os.getenv("ANTHROPIC_API_KEY", "").strip()


def _api_classify(items: list[Product], batch: int = 40) -> dict[str, str]:
    """Classify products via the cheap model. items must be uncached.

    Returns {product_id: category}. Falls back to heuristic on any failure so a
    transient API problem never blocks a drop.
    """
    key = _api_key()
    out: dict[str, str] = {}
    if not key:
        return {p.id: heuristic_category(p.title, p.collections) for p in items}

    sys = (
        "You categorise grocery/wholesale products for a Norwegian importer. "
        "Return STRICT JSON: an array of {\"i\": <index>, \"c\": <category>}. "
        "Category MUST be exactly one of: " + ", ".join(TAXONOMY) + ". "
        "Decide from the product name; collections are only a weak hint "
        "(they are temperature buckets, not categories). If unsure use \"Annet\"."
    )
    for s in range(0, len(items), batch):
        chunk = items[s:s + batch]
        lines = [
            {"i": i, "name": p.title, "hint": [c for c in p.collections][:3]}
            for i, p in enumerate(chunk)
        ]
        body = {
            "model": _MODEL,
            "max_tokens": 1500,
            "system": sys,
            "messages": [{"role": "user", "content": json.dumps(lines, ensure_ascii=False)}],
        }
        try:
            r = requests.post(
                _API,
                headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json=body, timeout=60,
            )
            r.raise_for_status()
            txt = r.json()["content"][0]["text"]
            arr = json.loads(txt[txt.index("["):txt.rindex("]") + 1])
            got = {int(o["i"]): o["c"] for o in arr}
            for i, p in enumerate(chunk):
                c = got.get(i)
                out[p.id] = c if c in DISPLAY_ORDER else heuristic_category(p.title, p.collections)
        except Exception:  # noqa: BLE001 — never block on the model
            for p in chunk:
                out[p.id] = heuristic_category(p.title, p.collections)
        time.sleep(0.1)
    return out


# --------------------------------------------------------------------------- #
# overrides                                                                    #
# --------------------------------------------------------------------------- #
def load_overrides(path: Optional[Path] = None) -> dict[str, str]:
    path = path or (CONFIG.state_dir / "category_overrides.json")
    try:
        return {str(k): str(v) for k, v in json.loads(Path(path).read_text()).items()}
    except Exception:  # noqa: BLE001
        return {}


def _apply_override(p: Product, overrides: dict[str, str]) -> Optional[str]:
    for keyish in (p.id, p.sku, p.barcode, p.title):
        if keyish and keyish in overrides:
            cat = overrides[keyish]
            return cat if cat in DISPLAY_ORDER else cat  # allow custom override labels
    return None


# --------------------------------------------------------------------------- #
# public                                                                       #
# --------------------------------------------------------------------------- #
def classify_products(products: list[Product], db_path: Optional[Path] = None,
                      refresh: bool = False) -> dict[str, str]:
    """Return {product_id: category} for every product, using cache + model.

    Cheap-once: only products absent from cache (or whose title changed) hit the
    model. Manual overrides win. Results are persisted back to the cache.
    """
    db_path = db_path or (CONFIG.state_dir / "categories.sqlite3")
    overrides = load_overrides()
    con = _db(db_path)
    cached: dict[str, tuple[str, str]] = {}
    for pid, th, cat, _src in con.execute(
            "SELECT product_id, title_hash, category, source FROM category_cache"):
        cached[pid] = (cat, th)  # (category, title_hash)

    result: dict[str, str] = {}
    todo: list[Product] = []
    for p in products:
        h = _title_hash(p.title)
        if not refresh and p.id in cached and cached[p.id][1] == h:
            result[p.id] = cached[p.id][0]
        else:
            todo.append(p)

    if todo:
        fresh = _api_classify(todo)
        rows = []
        src = "ai" if _api_key() else "heuristic"
        for p in todo:
            cat = fresh.get(p.id) or heuristic_category(p.title, p.collections)
            result[p.id] = cat
            rows.append((p.id, _title_hash(p.title), cat, src))
        con.executemany(
            "INSERT OR REPLACE INTO category_cache VALUES (?,?,?,?)", rows)
        con.commit()

    # overrides win, last
    by_id = {p.id: p for p in products}
    for pid in list(result):
        ov = _apply_override(by_id[pid], overrides)
        if ov:
            result[pid] = ov
    con.close()
    return result


def seed_cache(mapping: dict[str, str], source: str = "ai",
               products: Optional[list[Product]] = None,
               db_path: Optional[Path] = None) -> int:
    """Write known {product_id: category} into the cache (used to seed the
    current drop's AI categories when the sandbox has no API key)."""
    db_path = db_path or (CONFIG.state_dir / "categories.sqlite3")
    titlehash = {p.id: _title_hash(p.title) for p in (products or [])}
    con = _db(db_path)
    rows = [(pid, titlehash.get(pid, ""), cat, source) for pid, cat in mapping.items()]
    con.executemany("INSERT OR REPLACE INTO category_cache VALUES (?,?,?,?)", rows)
    con.commit()
    n = con.total_changes
    con.close()
    return n
