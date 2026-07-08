"""Local inventory snapshot store (SQLite) for Modell A.

Each run records inventory per SKU. The next run compares against the previous
snapshot to detect *arrivals* (inventory increased). Read previous BEFORE
committing the new run.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

_SCHEMA = """
CREATE TABLE IF NOT EXISTS latest_inventory (
    sku        TEXT PRIMARY KEY,
    quantity   INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    item_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_items (
    run_id   INTEGER NOT NULL REFERENCES runs(id),
    sku      TEXT NOT NULL,
    quantity INTEGER NOT NULL
);
"""


class SnapshotStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "SnapshotStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def is_first_run(self) -> bool:
        cur = self._conn.execute("SELECT COUNT(*) FROM runs")
        return cur.fetchone()[0] == 0

    def latest_run(self) -> dict | None:
        """Most recent committed baseline run, or None if none exists yet.

        Returns {"id", "ts", "item_count"} — the dashboard reads this for the
        baseline status card (and the restock warning when it's None)."""
        cur = self._conn.execute(
            "SELECT id, ts, item_count FROM runs ORDER BY id DESC LIMIT 1"
        )
        row = cur.fetchone()
        if row is None:
            return None
        return {"id": row[0], "ts": row[1], "item_count": row[2]}

    def previous_quantities(self) -> dict[str, int]:
        cur = self._conn.execute("SELECT sku, quantity FROM latest_inventory")
        return {sku: qty for sku, qty in cur.fetchall()}

    def commit_run(self, items: Iterable[tuple[str, int]]) -> int:
        """Persist a new snapshot. items = iterable of (sku, quantity)."""
        items = [(sku, int(qty)) for sku, qty in items if sku]
        ts = datetime.now(timezone.utc).isoformat()
        cur = self._conn.execute(
            "INSERT INTO runs (ts, item_count) VALUES (?, ?)", (ts, len(items))
        )
        run_id = cur.lastrowid
        self._conn.executemany(
            "INSERT INTO run_items (run_id, sku, quantity) VALUES (?, ?, ?)",
            [(run_id, sku, qty) for sku, qty in items],
        )
        self._conn.executemany(
            "INSERT INTO latest_inventory (sku, quantity, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(sku) DO UPDATE SET quantity=excluded.quantity, "
            "updated_at=excluded.updated_at",
            [(sku, qty, ts) for sku, qty in items],
        )
        self._conn.commit()
        return run_id
