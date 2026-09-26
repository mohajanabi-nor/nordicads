"""Inventory snapshot store for Modell A.

Each run records inventory per SKU. The next run compares against the previous
snapshot to detect *arrivals* (inventory increased). Read previous BEFORE
committing the new run.

Two backends, same interface:

  Postgres — used whenever SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
             which is the case on a CI runner. A runner's filesystem is thrown
             away when the job ends, so a local database there would mean every
             run looked like the first one and NOTHING was ever detected as a
             restock. That failure is silent: the catalogue still builds, it is
             just quietly wrong.
  SQLite   — the original, still used on a developer machine where there is a
             disk that persists and no reason to need the network.

The backend is chosen by environment rather than by a flag, so no caller has to
know which one it got.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import requests

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

# PostgREST caps a response; page through rather than silently truncating the
# baseline, which would read as "everything is new".
_PAGE = 1000
# Writes are chunked so one run's 5000+ SKUs do not become one enormous request.
_BATCH = 500


def _parse_ts(raw: str | None) -> Optional[datetime]:
    """Snapshot timestamps, as either backend stores them.

    SQLite keeps whatever isoformat() produced; PostgREST returns an ISO string
    with a timezone. Anything unparseable is treated as absent rather than
    guessed at, because these timestamps decide which baseline a product is
    compared against — a wrong one silently mislabels a delivery.
    """
    if not raw:
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _supabase_config() -> Optional[tuple[str, str]]:
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    return (url, key) if url and key else None


class _SqliteBackend:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def is_first_run(self) -> bool:
        return self._conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0

    def latest_run(self) -> dict | None:
        row = self._conn.execute(
            "SELECT id, ts, item_count FROM runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return {"id": row[0], "ts": row[1], "item_count": row[2]}

    def previous_quantities(self) -> dict[str, int]:
        cur = self._conn.execute("SELECT sku, quantity FROM latest_inventory")
        return {sku: qty for sku, qty in cur.fetchall()}

    def run_timestamps(self, limit: int) -> list[tuple[int, datetime]]:
        rows = self._conn.execute(
            "SELECT id, ts FROM runs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [(r[0], _parse_ts(r[1])) for r in rows if _parse_ts(r[1])]

    def quantities_at_runs(self, run_ids: Iterable[int]) -> dict[int, dict[str, int]]:
        out: dict[int, dict[str, int]] = {}
        for run_id in run_ids:
            cur = self._conn.execute(
                "SELECT sku, quantity FROM run_items WHERE run_id = ?", (run_id,)
            )
            out[run_id] = {sku: qty for sku, qty in cur.fetchall()}
        return out

    def commit_run(self, items: list[tuple[str, int]]) -> int:
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


class _PostgresBackend:
    """Same store over PostgREST. Tables live in db/001_init.sql."""

    def __init__(self, url: str, key: str):
        self.base = f"{url}/rest/v1"
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def close(self) -> None:
        pass

    def _get(self, path: str, headers: dict | None = None) -> requests.Response:
        resp = requests.get(
            f"{self.base}/{path}",
            headers={**self.headers, **(headers or {})},
            timeout=60,
        )
        resp.raise_for_status()
        return resp

    def _post(self, path: str, payload, prefer: str = "return=minimal") -> requests.Response:
        resp = requests.post(
            f"{self.base}/{path}",
            headers={**self.headers, "Prefer": prefer},
            data=json.dumps(payload),
            timeout=120,
        )
        resp.raise_for_status()
        return resp

    def is_first_run(self) -> bool:
        return self.latest_run() is None

    def latest_run(self) -> dict | None:
        rows = self._get(
            "snapshot_runs?select=id,ts,item_count&order=id.desc&limit=1"
        ).json()
        if not rows:
            return None
        row = rows[0]
        return {"id": row["id"], "ts": row["ts"], "item_count": row["item_count"]}

    def previous_quantities(self) -> dict[str, int]:
        out: dict[str, int] = {}
        offset = 0
        while True:
            resp = self._get(
                f"latest_inventory?select=sku,quantity&order=sku.asc",
                headers={"Range-Unit": "items", "Range": f"{offset}-{offset + _PAGE - 1}"},
            )
            rows = resp.json()
            for r in rows:
                out[r["sku"]] = r["quantity"]
            if len(rows) < _PAGE:
                break
            offset += _PAGE
        return out

    def run_timestamps(self, limit: int) -> list[tuple[int, datetime]]:
        rows = self._get(
            f"snapshot_runs?select=id,ts&order=id.desc&limit={int(limit)}"
        ).json()
        out = []
        for r in rows:
            ts = _parse_ts(r["ts"])
            if ts:
                out.append((r["id"], ts))
        return out

    def quantities_at_runs(self, run_ids: Iterable[int]) -> dict[int, dict[str, int]]:
        ids = [int(r) for r in run_ids]
        out: dict[int, dict[str, int]] = {rid: {} for rid in ids}
        if not ids:
            return out
        id_list = ",".join(str(i) for i in ids)
        offset = 0
        while True:
            resp = self._get(
                f"snapshot_run_items?select=run_id,sku,quantity"
                f"&run_id=in.({id_list})&order=run_id.asc,sku.asc",
                headers={"Range-Unit": "items", "Range": f"{offset}-{offset + _PAGE - 1}"},
            )
            rows = resp.json()
            for r in rows:
                out[r["run_id"]][r["sku"]] = r["quantity"]
            if len(rows) < _PAGE:
                break
            offset += _PAGE
        return out

    def commit_run(self, items: list[tuple[str, int]]) -> int:
        ts = datetime.now(timezone.utc).isoformat()
        created = self._post(
            "snapshot_runs",
            {"ts": ts, "item_count": len(items)},
            prefer="return=representation",
        ).json()
        run_id = created[0]["id"]

        for i in range(0, len(items), _BATCH):
            chunk = items[i : i + _BATCH]
            self._post(
                "snapshot_run_items",
                [{"run_id": run_id, "sku": sku, "quantity": qty} for sku, qty in chunk],
            )
            self._post(
                "latest_inventory?on_conflict=sku",
                [{"sku": sku, "quantity": qty, "updated_at": ts} for sku, qty in chunk],
                prefer="resolution=merge-duplicates,return=minimal",
            )
        return run_id


class SnapshotStore:
    def __init__(self, db_path: Path):
        cfg = _supabase_config()
        if cfg:
            self._backend: _SqliteBackend | _PostgresBackend = _PostgresBackend(*cfg)
            self.backend_name = "postgres"
        else:
            self._backend = _SqliteBackend(db_path)
            self.backend_name = "sqlite"
        self.db_path = Path(db_path)

    def close(self) -> None:
        self._backend.close()

    def __enter__(self) -> "SnapshotStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def is_first_run(self) -> bool:
        return self._backend.is_first_run()

    def latest_run(self) -> dict | None:
        """Most recent committed baseline run, or None if none exists yet.

        Returns {"id", "ts", "item_count"} — the dashboard reads this for the
        baseline status card (and the restock warning when it's None)."""
        return self._backend.latest_run()

    def previous_quantities(self) -> dict[str, int]:
        return self._backend.previous_quantities()

    def baselines_before(
        self, moments: Iterable[Optional[datetime]], history: int = 12
    ) -> dict[Optional[datetime], dict[str, int]]:
        """For each moment, stock as it stood at the last run BEFORE it.

        The picker asks "what arrived recently", and answers it by comparing
        current stock against a baseline. Which baseline is the whole question.
        Against the NEWEST one it is wrong in a specific and damaging way: a
        `generate` commits a new baseline as part of its run, so for the rest of
        the day every delivery it just recorded reads as "no change" — the goods
        land, the drop is built from them, and the picker goes blind to them
        minutes later. That is not an edge case; it is what happens every time
        a drop is generated on a delivery day.

        Comparing each product against the last run before ITS OWN last stock
        change removes the coupling: a baseline committed after the delivery is
        simply not the one that delivery is measured against.

        Returns a map keyed by the moments passed in, so the caller can look up
        per product without re-deriving anything. Only the runs actually needed
        are read.
        """
        runs = self._backend.run_timestamps(history)  # newest first
        if not runs:
            return {}

        # Which run answers each moment: the newest one that predates it. A
        # moment older than every run we hold falls back to the oldest, where
        # the delta is 0 by construction — the change is already baked in.
        oldest_id = runs[-1][0]
        chosen: dict[Optional[datetime], int] = {}
        for moment in moments:
            if moment is None:
                chosen[moment] = runs[0][0]
                continue
            pick = next((rid for rid, ts in runs if ts < moment), oldest_id)
            chosen[moment] = pick

        quantities = self._backend.quantities_at_runs(set(chosen.values()))
        return {moment: quantities.get(rid, {}) for moment, rid in chosen.items()}

    def commit_run(self, items: Iterable[tuple[str, int]]) -> int:
        """Persist a new snapshot. items = iterable of (sku, quantity).

        The same SKU can appear on more than one product in Shopify — this
        catalogue carries a handful — so the pairs are collapsed before they are
        stored, the last value winning. That is what the store already did with
        its running inventory; only the per-run copy kept both rows, and nothing
        reads it. Postgres will not accept the duplicates either way: the key on
        (run_id, sku) rejects them, and an upsert cannot touch the same row
        twice in one statement.
        """
        deduped: dict[str, int] = {}
        for sku, qty in items:
            if sku:
                deduped[sku] = int(qty)
        return self._backend.commit_run(list(deduped.items()))
