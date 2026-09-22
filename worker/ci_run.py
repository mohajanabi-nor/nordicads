"""Run a worker command on a CI runner and report progress to Supabase.

The dashboard used to watch a render by tailing the child process it had
spawned. On a GitHub Actions runner there is nothing to tail — Actions only
publishes a run's logs after it finishes, and a render takes minutes, so the
operator would be left watching nothing at all.

This script is the replacement pipe: it runs the same CLI with the same flags,
and forwards each stdout line into `worker_job_logs` as it appears. The
dashboard streams from there. The lines are untouched, so the progress UI that
matches on them keeps working without knowing the job moved to a different
machine.

It also does what the runner's disposable filesystem cannot: uploads the
finished PDF and reels to Supabase Storage, and records the drop, before the
machine is thrown away.

Usage:
    python ci_run.py --job-id <id> -- generate --mock --no-slider
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable

import requests

WORKER_DIR = Path(__file__).resolve().parent
SRC_DIR = WORKER_DIR / "src"
OUTPUT_DIR = Path(os.environ.get("WORKER_OUTPUT_DIR", WORKER_DIR / "output"))
DROPS_BUCKET = "drops"

# Flush when either trigger fires, so a chatty step does not spam one request
# per line and a slow step does not sit on unsent output.
FLUSH_EVERY_LINES = 25
FLUSH_EVERY_SECONDS = 2.0

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Same shape the dashboard parses: the path legitimately contains spaces, so
# take everything after the arrow rather than a non-space run.
DROP_LINE = re.compile(r"->\s*(.+?)\s*$")

# The `customers` command prints its result as one sentinel-prefixed JSON line.
CUSTOMERS_SENTINEL = "CUSTOMERS_JSON "


def _headers(extra: dict | None = None) -> dict:
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        **(extra or {}),
    }


def _post(path: str, payload, prefer: str = "return=minimal") -> None:
    """Best-effort write. Reporting must never be able to kill the render it is
    describing — a dropped log line is a worse outcome than a lost render only
    if you value the commentary over the work."""
    if not SUPABASE_URL or not SERVICE_KEY:
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{path}",
            headers=_headers({"Prefer": prefer}),
            data=json.dumps(payload),
            timeout=20,
        )
        if resp.status_code >= 400:
            print(f"[ci] supabase {path} -> {resp.status_code} {resp.text[:200]}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[ci] supabase {path} failed: {exc}", file=sys.stderr)


def _patch(path: str, payload: dict) -> None:
    if not SUPABASE_URL or not SERVICE_KEY:
        return
    try:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/{path}",
            headers=_headers({"Prefer": "return=minimal"}),
            data=json.dumps(payload),
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[ci] supabase patch {path} failed: {exc}", file=sys.stderr)


def set_status(job_id: str, **fields) -> None:
    _patch(f"worker_jobs?id=eq.{job_id}", fields)


def claim_job(job_id: str, command: str, argv: list[str]) -> None:
    """Mark the job running, creating the row if it isn't there.

    The dashboard normally inserts it before dispatching. Upserting anyway is
    what lets the workflow be triggered straight from the Actions UI with no
    dashboard involved — which is how this gets tested, and how a render can
    still be kicked off by hand if the dashboard is down.
    """
    _post(
        "worker_jobs?on_conflict=id",
        {
            "id": job_id,
            "command": command,
            "inputs": {"argv": argv},
            "status": "running",
            "started_at": "now()",
        },
        prefer="resolution=merge-duplicates,return=minimal",
    )


def push_lines(job_id: str, start_seq: int, lines: Iterable[str]) -> None:
    rows = [{"job_id": job_id, "seq": start_seq + i, "line": line} for i, line in enumerate(lines)]
    if rows:
        _post("worker_job_logs", rows)


def upload_drop(job_id: str, drop_dir: str) -> None:
    """Move the run's artefacts somewhere that outlives the runner."""
    folder = OUTPUT_DIR / drop_dir
    if not folder.is_dir():
        print(f"[ci] no such drop folder: {folder}", file=sys.stderr)
        return

    pdf: str | None = None
    reels: list[str] = []

    for item in sorted(folder.iterdir()):
        if not item.is_file():
            continue
        content_type = mimetypes.guess_type(item.name)[0] or "application/octet-stream"
        try:
            resp = requests.post(
                f"{SUPABASE_URL}/storage/v1/object/{DROPS_BUCKET}/{drop_dir}/{item.name}",
                headers={
                    "apikey": SERVICE_KEY,
                    "Authorization": f"Bearer {SERVICE_KEY}",
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
                data=item.read_bytes(),
                timeout=300,
            )
            if resp.status_code >= 400:
                print(f"[ci] upload {item.name} -> {resp.status_code} {resp.text[:200]}", file=sys.stderr)
                continue
        except Exception as exc:  # noqa: BLE001
            print(f"[ci] upload {item.name} failed: {exc}", file=sys.stderr)
            continue

        low = item.name.lower()
        if low.endswith(".pdf"):
            pdf = item.name
        elif low.endswith(".mp4"):
            reels.append(item.name)

    # montage first, then alphabetical — matches how a drop reads top-down
    reels.sort(key=lambda n: (0 if "montage" in n else 1, n))
    _post(
        "drops?on_conflict=dir",
        {
            "dir": drop_dir,
            "job_id": job_id,
            "pdf": pdf,
            "reels": reels,
            "asset_count": (1 if pdf else 0) + len(reels),
        },
        prefer="resolution=merge-duplicates,return=minimal",
    )
    print(f"[ci] uploaded {(1 if pdf else 0) + len(reels)} asset(s) from {drop_dir}")


def post_customers(payload_json: str) -> None:
    """Hand the fetched customer list to the dashboard to merge.

    The fetching lives here because the Shopify client does — paginated GraphQL
    with a version-dependent field spelling, not worth rewriting twice. The
    merging deliberately does not: consent may only ever be tightened, never
    loosened, and that rule has one home.
    """
    base = os.environ.get("DASHBOARD_URL", "").rstrip("/")
    token = os.environ.get("WORKER_SERVICE_TOKEN", "")
    if not base or not token:
        print("[ci] DASHBOARD_URL/WORKER_SERVICE_TOKEN not set — skipping sync callback",
              file=sys.stderr)
        return
    try:
        resp = requests.post(
            f"{base}/api/internal/sync-customers",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            data=payload_json.encode("utf-8"),
            timeout=300,
        )
        if resp.status_code >= 400:
            print(f"[ci] sync callback -> {resp.status_code} {resp.text[:300]}", file=sys.stderr)
        else:
            print(f"[ci] sync callback ok: {resp.text[:200]}")
    except Exception as exc:  # noqa: BLE001
        print(f"[ci] sync callback failed: {exc}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("rest", nargs=argparse.REMAINDER,
                        help="the worker command and flags, after a bare --")
    ns = parser.parse_args()

    argv = [a for a in ns.rest if a != "--"]
    if not argv:
        print("[ci] no worker command given", file=sys.stderr)
        return 2

    job_id = ns.job_id
    claim_job(job_id, argv[0], argv)

    env = {
        **os.environ,
        "PYTHONPATH": str(SRC_DIR),
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
    }

    proc = subprocess.Popen(
        [sys.executable, "-m", "nordic_social.cli", *argv],
        cwd=str(WORKER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    seq = 0
    pending: list[str] = []
    last_flush = time.monotonic()
    drop_dir: str | None = None
    customers_payload: str | None = None

    def flush() -> None:
        nonlocal pending, seq, last_flush
        if pending:
            push_lines(job_id, seq, pending)
            seq += len(pending)
            pending = []
        last_flush = time.monotonic()

    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        # Keep it in the Actions log too, so a failed run is still diagnosable
        # from GitHub alone if Supabase was unreachable.
        print(line, flush=True)
        pending.append(line)

        if line.startswith(CUSTOMERS_SENTINEL):
            customers_payload = line[len(CUSTOMERS_SENTINEL):]

        if "drop written:" in line:
            m = DROP_LINE.search(line)
            if m:
                drop_dir = m.group(1).replace("\\", "/").rstrip("/").split("/")[-1] or None

        if len(pending) >= FLUSH_EVERY_LINES or (time.monotonic() - last_flush) >= FLUSH_EVERY_SECONDS:
            flush()

    code = proc.wait()
    flush()

    if drop_dir:
        upload_drop(job_id, drop_dir)

    if code == 0 and customers_payload:
        post_customers(customers_payload)

    set_status(
        job_id,
        status="done" if code == 0 else "failed",
        exit_code=code,
        drop_dir=drop_dir,
        ended_at="now()",
        error_message=None if code == 0 else f"worker avsluttet med kode {code}",
    )
    return code


if __name__ == "__main__":
    sys.exit(main())
