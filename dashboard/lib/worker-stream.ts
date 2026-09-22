/**
 * Streaming a worker job to the browser, wherever it runs.
 *
 * Both the automatic render (`generate`) and the manual one (`select`) want the
 * same thing: start a job, follow its stdout, turn known log lines into a step
 * checklist, and finish with the drop it produced. Only the command and the step
 * definitions differ, so that is all either caller supplies.
 *
 * Remote jobs deliberately survive the browser disconnecting. A render takes
 * minutes, any proxy in front of this times out sooner, and killing the work
 * because nobody was watching would throw away the whole job. A local child
 * process IS tied to its request, so that one is killed — the difference is
 * intentional, not an oversight.
 */
import { spawnWorker } from "./worker";
import { dispatchRender, findRun, type RenderInputs } from "./github-actions";
import { attachRun, createJob, failJob, getJob, isTerminal, newJobId, readLogs } from "./worker-jobs";

export interface Step {
  key: string;
  label: string;
  match: (line: string) => boolean;
}

export type Send = (event: string, data: unknown) => void;

/** How often to ask Supabase for new log lines. Fast enough to feel live,
 *  slow enough that a long render is not thousands of queries. */
const POLL_INTERVAL_MS = 1_500;
/** Backstop for a run that never reports at all; the workflow caps itself at 45
 *  minutes, so this only catches a job that never started. */
const REMOTE_TIMEOUT_MS = 50 * 60_000;

/**
 * How often to send a keep-alive when there is nothing to report.
 *
 * A render goes quiet for a minute or more while it encodes video, and a
 * connection carrying no bytes for that long is liable to be closed by a
 * browser, a proxy or the platform. The client then sees the stream end with no
 * result and waits forever on a job that actually finished. An SSE comment
 * costs nothing and is ignored by every parser.
 */
const HEARTBEAT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Step tracking, fed one stdout line at a time. */
export function createLineHandler(send: Send, steps: Step[]) {
  let stepIdx = -1;
  let dropDir: string | null = null;
  let assetCount = 0;

  const advanceTo = (idx: number) => {
    if (idx <= stepIdx) return;
    for (let i = stepIdx + 1; i <= idx; i++) {
      send("step", { key: steps[i].key, label: steps[i].label, status: i < idx ? "done" : "active" });
    }
    stepIdx = idx;
  };

  return {
    handle(line: string) {
      if (!line.trim()) return;
      send("log", { line });
      // Take everything after the arrow — NOT a \S+ run — because the output
      // path legitimately contains spaces on every platform this runs on.
      const m = /->\s*(.+?)\s*$/.exec(line);
      if (line.includes("drop written:") && m) {
        dropDir = m[1].split(/[\\/]/).filter(Boolean).pop() ?? null;
      }
      const am = /1 PDF \+ (\d+) mp4/.exec(line);
      if (am) assetCount = parseInt(am[1], 10) + 1;
      for (let i = steps.length - 1; i > stepIdx; i--) {
        if (steps[i].match(line)) {
          advanceTo(i);
          break;
        }
      }
    },
    finishSteps() {
      if (stepIdx >= 0) {
        send("step", { key: steps[stepIdx].key, label: steps[stepIdx].label, status: "done" });
      }
    },
    get dropDir() {
      return dropDir;
    },
    get assetCount() {
      return assetCount;
    },
  };
}

/** Dispatch to GitHub Actions, then stream what the runner reports back. */
export async function streamRemote(
  send: Send,
  signal: AbortSignal,
  steps: Step[],
  inputs: RenderInputs,
): Promise<void> {
  const tracker = createLineHandler(send, steps);
  const jobId = newJobId();

  await createJob(jobId, inputs.command ?? "generate", inputs as Record<string, unknown>);
  try {
    await dispatchRender(jobId, inputs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(jobId, message);
    send("error", { message });
    return;
  }

  // Structured, not just a log line: the client keeps this so it can pick the
  // job back up if the connection dies mid-render.
  send("job", { jobId });
  send("log", { line: `[dashboard] sendte jobb til GitHub Actions (${jobId})` });

  let lastSeq = -1;
  let runLinked = false;
  const startedAt = Date.now();

  while (!signal.aborted) {
    if (Date.now() - startedAt > REMOTE_TIMEOUT_MS) {
      const message = "tidsavbrudd: kjøringen rapporterte aldri ferdig";
      await failJob(jobId, message);
      send("error", { message });
      return;
    }

    for (const entry of await readLogs(jobId, lastSeq)) {
      tracker.handle(entry.line);
      lastSeq = entry.seq;
    }

    const job = await getJob(jobId);

    // Link the GitHub run once, so the operator can open the real log if
    // something goes wrong. Best-effort: a missing run id is not a failure.
    if (!runLinked && job && !job.github_run_id) {
      try {
        const run = await findRun(jobId);
        if (run) {
          runLinked = true;
          await attachRun(jobId, run.id);
          send("log", { line: `[dashboard] kjører på GitHub: ${run.htmlUrl}` });
        }
      } catch {
        /* the run link is a convenience, never a reason to fail the job */
      }
    }

    if (job && isTerminal(job.status)) {
      // Drain anything written between the last read and the status change.
      for (const entry of await readLogs(jobId, lastSeq)) {
        tracker.handle(entry.line);
        lastSeq = entry.seq;
      }
      tracker.finishSteps();

      if (job.status === "done") {
        send("done", { drop: tracker.dropDir ?? job.drop_dir, assets: tracker.assetCount, jobId });
      } else {
        send("error", { message: job.error_message ?? `jobben endte som ${job.status}`, jobId });
      }
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/** Spawn the worker locally — the original path, for development. */
export function streamLocal(
  send: Send,
  signal: AbortSignal,
  steps: Step[],
  args: string[],
  outputDir?: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const tracker = createLineHandler(send, steps);

    let child: ReturnType<typeof spawnWorker>;
    try {
      child = spawnWorker(args);
    } catch (err) {
      send("error", { message: String(err instanceof Error ? err.message : err) });
      resolve();
      return;
    }

    let buf = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        tracker.handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => send("log", { line: d.toString().trimEnd(), stderr: true }));

    child.on("error", (err) => {
      send("error", { message: String(err.message) });
      finish();
    });

    child.on("close", (code) => {
      if (buf.trim()) tracker.handle(buf);
      tracker.finishSteps();
      if (code === 0) {
        send("done", { drop: tracker.dropDir, assets: tracker.assetCount, outputDir });
      } else {
        send("error", { message: `worker exited with code ${code}` });
      }
      finish();
    });

    // A local child process is tied to this request; killing it on disconnect
    // is right here, and wrong for a remote run.
    signal.addEventListener("abort", () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish();
    });
  });
}

/** Wrap either path in the SSE response both routes return. */
export function sseResponse(
  run: (send: Send, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const raw = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send: Send = (event, data) =>
        raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Keeps the connection warm through the long silences in a render. An SSE
      // comment is ignored by every parser and costs a handful of bytes.
      const heartbeat = setInterval(() => raw(": ping\n\n"), HEARTBEAT_MS);

      try {
        await run(send, signal);
      } catch (err) {
        send("error", { message: String(err instanceof Error ? err.message : err) });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
