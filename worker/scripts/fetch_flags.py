"""Bundle a real ISO-3166 flag set (PNG) into worker/assets/flags/.

Run once at setup. Flags are real (flagcdn.com, public CDN of public-domain flags)
and stored locally so runtime never downloads. Re-run to refresh.

    python scripts/fetch_flags.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from nordic_catalogue.config import CONFIG  # noqa: E402
from nordic_catalogue import regions  # noqa: E402

# Every ISO code the catalogue may reference: region sets + named countries +
# every mapping target in ENGLISH_TO_ISO (so no mapped origin lacks a flag).
CODES = sorted(
    regions.OST_EUROPA
    | regions.SOR_EUROPA
    | regions.VEST_EUROPA
    | regions.NORDEN
    | regions.ASIA
    | regions.MIDTOSTEN
    | set(regions.NAME_NO.keys())
    | set(regions.ENGLISH_TO_ISO.values())
)

CDN = "https://flagcdn.com/w320/{code}.png"


def main() -> int:
    out = CONFIG.flags_dir
    out.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    ok, fail = 0, []
    for code in CODES:
        dest = out / f"{code}.png"
        if dest.exists() and dest.stat().st_size > 200:
            ok += 1
            continue
        url = CDN.format(code=code.lower())
        try:
            r = session.get(url, timeout=20)
            r.raise_for_status()
            if not r.content.startswith(b"\x89PNG"):
                raise ValueError("not a PNG")
            dest.write_bytes(r.content)
            ok += 1
            time.sleep(0.05)
        except Exception as e:  # noqa: BLE001
            fail.append((code, str(e)))
    print(f"flags bundled: {ok}/{len(CODES)} -> {out}")
    if fail:
        print("failed:", ", ".join(c for c, _ in fail))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
