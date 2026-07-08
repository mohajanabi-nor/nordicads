"""Per-drop output folders.

A "drop" is one coherent publish: the catalogue PDF plus all the social mp4s,
living together in a single dated folder so nothing is ever mixed or
overwritten. Two drops on the same day get a running suffix (_2, _3, ...).

    output/drop_2026-06-05/        katalog.pdf + *.mp4
    output/drop_2026-06-05_2/      (a second drop the same day)
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

from .config import CONFIG


def new_drop_dir(base: Optional[Path] = None, today: Optional[date] = None,
                 create: bool = True) -> Path:
    """Allocate a fresh, never-colliding drop folder and return its path."""
    base = Path(base) if base is not None else (CONFIG.output_dir)
    today = today or date.today()
    stamp = today.isoformat()
    cand = base / f"drop_{stamp}"
    n = 2
    while cand.exists():
        cand = base / f"drop_{stamp}_{n}"
        n += 1
    if create:
        cand.mkdir(parents=True, exist_ok=True)
    return cand
