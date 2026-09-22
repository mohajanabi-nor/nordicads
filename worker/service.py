"""HTTP front door for the worker.

The dashboard used to spawn `python -m nordic_social.cli …` as a local child
process and tail its stdout. Hosted on Vercel it cannot do that: there is no
Python there, no ffmpeg, and no process that may outlive a request. So the
spawning moves here, behind three endpoints, and the dashboard calls them over
HTTPS instead.

What deliberately did NOT change: this still runs the same CLI the same way,
with the same arguments, and streams the same stdout lines. The dashboard's
progress UI matches on those log lines, so keeping them byte-identical means the
whole generate → steps → done pipeline keeps working untouched.

The one real design requirement is that **a job must outlive the connection that
started it**. A render takes minutes; any single HTTP request in front of it
(especially one proxied through a serverless function) will be cut off long
before it finishes. So jobs live in this process, output is buffered per job,
and /jobs/{id}/stream can be reconnected to at any offset — dropping the
connection never kills the work.

Run: uvicorn service:app --host 0.0.0.0 --port $PORT
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, Iterator, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

WORKER_DIR = Path(__file__).resolve().parent
SRC_DIR = WORKER_DIR / "src"

# Long enough to hold a whole render's chatter, bounded so a runaway job cannot
# exhaust the memory of a small instance.
MAX_BUFFERED_LINES = 20_000

# Finished jobs are kept so a browser that reconnects late still gets the tail
# and the exit status, then dropped so they do not accumulate forever.
JOB_RETENTION_SECONDS = 3_600

# Only these may be invoked. The dashboard builds the flags; this list is what
# stops a leaked token from becoming arbitrary command execution.
ALLOWED_COMMANDS = {"generate", "select", "products", "customers", "status", "preview"}

# Arguments are passed to execve directly (never a shell), so this is about
# refusing shapes the CLI itself should never see rather than about quoting.
SAFE_ARG = re.compile(r"^[A-Za-z0-9_.,:=@/+-]{1,200}$")


def _auth_token() -> str:
    return os.environ.get("WORKER_SERVICE_TOKEN", "")


@dataclass
class Job:
    id: str
    command: str
    args: list[str]
    status: str = "running"  # running | done | failed | cancelled
    exit_code: Optional[int] = None
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    lines: Deque[str] = field(default_factory=lambda: deque(maxlen=MAX_BUFFERED_LINES))
    # Index of the first line still in `lines`, so a reconnecting client asking
    # for offset N is told honestly when N has already been evicted.
    first_index: int = 0
    error: Optional[str] = None
    process: Optional[subprocess.Popen] = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def next_index(self) -> int:
        return self.first_index + len(self.lines)

    def append(self, line: str) -> None:
        with self._lock:
            if len(self.lines) == self.lines.maxlen:
                self.first_index += 1
            self.lines.append(line)

    def slice_from(self, index: int) -> tuple[int, list[str]]:
        """Lines from `index` onward, plus the index the caller should ask for
        next. Clamps forward when the requested lines have been evicted."""
        with self._lock:
            start = max(index, self.first_index)
            offset = start - self.first_index
            return start, list(self.lines)[offset:]

    def summary(self) -> dict:
        return {
            "id": self.id,
            "command": self.command,
            "status": self.status,
            "exitCode": self.exit_code,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "lineCount": self.next_index,
            "error": self.error,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def _prune_jobs() -> None:
    cutoff = time.time() - JOB_RETENTION_SECONDS
    with JOBS_LOCK:
        stale = [
            jid for jid, job in JOBS.items()
            if job.ended_at is not None and job.ended_at < cutoff
        ]
        for jid in stale:
            JOBS.pop(jid, None)


def _run_job(job: Job) -> None:
    """Spawn the CLI and pump its output into the job's buffer.

    Runs on a worker thread: the subprocess must keep going after the request
    that created it has returned.
    """
    env = {
        **os.environ,
        "PYTHONPATH": str(SRC_DIR),
        "PYTHONUNBUFFERED": "1",
        # Without this, piped (non-tty) stdout falls back to the locale encoding
        # and the Norwegian log lines arrive mojibake'd.
        "PYTHONIOENCODING": "utf-8",
    }
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "nordic_social.cli", job.command, *job.args],
            cwd=str(WORKER_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # one ordered stream, as the dashboard expects
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = f"kunne ikke starte worker: {exc}"
        job.ended_at = time.time()
        return

    job.process = proc
    assert proc.stdout is not None
    for line in proc.stdout:
        job.append(line.rstrip("\n"))

    code = proc.wait()
    job.exit_code = code
    job.ended_at = time.time()
    if job.status == "cancelled":
        pass
    elif code == 0:
        job.status = "done"
    else:
        job.status = "failed"
        job.error = f"worker avsluttet med kode {code}"


# ------------------------------------------------------------------- api ----

app = FastAPI(title="Nordic Engros worker", docs_url=None, redoc_url=None)


async def require_token(request: Request) -> None:
    expected = _auth_token()
    if not expected:
        # Refuse rather than run unauthenticated: an open endpoint here would
        # let anyone burn the Shopify API quota and the Claude budget.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "WORKER_SERVICE_TOKEN er ikke satt")
    header = request.headers.get("authorization", "")
    presented = header[7:] if header.lower().startswith("bearer ") else ""
    if not secrets.compare_digest(presented, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "ugyldig token")


class JobRequest(BaseModel):
    command: str
    args: list[str] = Field(default_factory=list)


@app.get("/health")
async def health() -> dict:
    """Unauthenticated on purpose: Render pings this, and the dashboard uses it
    to wake a sleeping instance before showing a job as hung."""
    return {"ok": True, "jobs": len(JOBS)}


@app.post("/jobs")
async def create_job(body: JobRequest, _: None = Depends(require_token)) -> dict:
    if body.command not in ALLOWED_COMMANDS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"ukjent kommando: {body.command}")
    for arg in body.args:
        if not SAFE_ARG.match(arg):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"ugyldig argument: {arg!r}")

    _prune_jobs()
    job = Job(id=uuid.uuid4().hex[:16], command=body.command, args=list(body.args))
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    return job.summary()


def _get_job(job_id: str) -> Job:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ukjent jobb")
    return job


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, _: None = Depends(require_token)) -> dict:
    return _get_job(job_id).summary()


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str, _: None = Depends(require_token)) -> dict:
    job = _get_job(job_id)
    if job.status == "running" and job.process is not None:
        job.status = "cancelled"
        try:
            job.process.terminate()
        except Exception:  # noqa: BLE001
            pass
    return job.summary()


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request, since: int = 0, _: None = Depends(require_token)):
    """Replay from `since`, then follow live until the job ends.

    The caller passes the index it has already seen, so a dropped connection
    resumes exactly where it left off instead of replaying a whole render or
    silently skipping the middle of one.
    """
    job = _get_job(job_id)

    async def events() -> Iterator[str]:
        cursor = since
        # Tell the client immediately if the lines it asked for are already gone,
        # so a gap is visible rather than mistaken for quiet progress.
        if cursor < job.first_index:
            yield _sse("gap", {"requested": cursor, "resumedAt": job.first_index})
            cursor = job.first_index

        while True:
            if await request.is_disconnected():
                return

            start, lines = job.slice_from(cursor)
            cursor = start
            for line in lines:
                yield _sse("log", {"line": line, "index": cursor})
                cursor += 1

            if job.status != "running" and cursor >= job.next_index:
                payload = job.summary()
                yield _sse("done" if job.status == "done" else "error", payload)
                return

            await asyncio.sleep(0.25)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
