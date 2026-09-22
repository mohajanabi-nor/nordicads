/**
 * Trigger a worker `generate` job and stream progress to the browser over SSE.
 *
 * Contract (spec §1): trigger → progress events → done with the drop folder.
 * That contract is unchanged; where the job runs is not.
 *
 * Two paths, chosen by whether GitHub Actions is configured:
 *
 *   remote — dispatch a workflow run, then stream the log lines the runner
 *            writes into Supabase. This is what production uses: Vercel cannot
 *            spawn Python, and a render needs more memory than any free
 *            always-on host offers.
 *   local  — spawn the worker as a child process, as before. Kept so that
 *            developing on a laptop does not mean pushing to GitHub to test
 *            every change.
 *
 * Both feed the same lines through the same step detection, so the browser
 * cannot tell which one produced them.
 *
 * Note the remote path deliberately does NOT cancel the run when the browser
 * disconnects: a render takes minutes, any proxy in front of this will time out
 * first, and killing the work because nobody was watching would be absurd. The
 * job keeps going and the next connection resumes from where this one stopped.
 */
import { spawnWorker, OUTPUT_DIR } from "@/lib/worker";
import { dispatchRender, findRun, usesGitHubActions, type RenderInputs } from "@/lib/github-actions";
import { createJob, failJob, getJob, isTerminal, newJobId, readLogs, attachRun } from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // a full render can take minutes

// Ordered pipeline steps shown as a checklist in the UI. `match` detects the
// step's START from a worker stdout line; reaching a later step marks earlier
// ones done.
const STEPS: { key: string; label: string; match: (l: string) => boolean }[] = [
  { key: "fetch", label: "Henter produkter", match: (l) => l.includes("[shopify] fetching") || l.startsWith("[mock]") },
  { key: "classify", label: "Klassifiserer", match: (l) => l.includes("[ai] labelling") || l.startsWith("categories=") },
  { key: "images", label: "Cacher bilder", match: (l) => l.includes("[images] caching") },
  { key: "pdf", label: "Bygger PDF", match: (l) => l.startsWith("catalogue PDF:") },
  { key: "baseline", label: "Baseline lagret", match: (l) => l.includes("snapshot baseline committed") },
  { key: "reels", label: "Rendrer reels", match: (l) => l.startsWith("drop written:") || l.includes("manual drop written:") },
];

/** How often to ask Supabase for new log lines. Fast enough to feel live,
 *  slow enough that a long render is not thousands of queries. */
const POLL_INTERVAL_MS = 1_500;
/** Give up waiting on a job that never reports. The workflow caps itself at 45
 *  minutes; this is the backstop for a run that never started at all. */
const REMOTE_TIMEOUT_MS = 50 * 60_000;

type Send = (event: string, data: unknown) => void;

/** Shared step tracking, fed one stdout line at a time by either path. */
function createLineHandler(send: Send) {
  let stepIdx = -1;
  let dropDir: string | null = null;
  let assetCount = 0;

  const advanceTo = (idx: number) => {
    if (idx <= stepIdx) return;
    for (let i = stepIdx + 1; i <= idx; i++) {
      send("step", { key: STEPS[i].key, label: STEPS[i].label, status: i < idx ? "done" : "active" });
    }
    stepIdx = idx;
  };

  return {
    handle(line: string) {
      if (!line.trim()) return;
      send("log", { line });
      // Capture the produced drop folder, on macOS, Windows and a Linux runner
      // alike. Take everything after the arrow — NOT a \S+ run — because the
      // output path legitimately contains spaces ("D:\dashboard with resend\..").
      const m = /->\s*(.+?)\s*$/.exec(line);
      if (line.includes("drop written:") && m) {
        dropDir = m[1].split(/[\\/]/).filter(Boolean).pop() ?? null;
      }
      const am = /1 PDF \+ (\d+) mp4/.exec(line);
      if (am) assetCount = parseInt(am[1], 10) + 1;
      for (let i = STEPS.length - 1; i > stepIdx; i--) {
        if (STEPS[i].match(line)) {
          advanceTo(i);
          break;
        }
      }
    },
    finishSteps() {
      if (stepIdx >= 0) {
        send("step", { key: STEPS[stepIdx].key, label: STEPS[stepIdx].label, status: "done" });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dispatch to GitHub Actions, then stream what the runner reports back. */
async function runRemote(
  send: Send,
  signal: AbortSignal,
  inputs: RenderInputs,
): Promise<void> {
  const tracker = createLineHandler(send);
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

    const lines = await readLogs(jobId, lastSeq);
    for (const entry of lines) {
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
      const tail = await readLogs(jobId, lastSeq);
      for (const entry of tail) {
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
function runLocal(send: Send, signal: AbortSignal, args: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const tracker = createLineHandler(send);

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

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        tracker.handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => send("log", { line: d.toString().trimEnd(), stderr: true }));

    child.on("error", (err) => {
      send("error", { message: String(err.message) });
      finish();
    });

    child.on("close", (code) => {
      if (buf.trim()) tracker.handle(buf);
      tracker.finishSteps();
      if (code === 0) {
        send("done", { drop: tracker.dropDir, assets: tracker.assetCount, outputDir: OUTPUT_DIR });
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

export async function POST(req: Request) {
  let body: { mock?: boolean; commit?: boolean; slider?: boolean; origin?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults below */
  }

  // Only forward a shape the worker understands (never raw body text as an arg).
  const rawOrigin = (body.origin ?? "none").trim();
  const origin = /^(auto|[A-Za-z]{2})$/.test(rawOrigin) ? rawOrigin : "none";

  const inputs: RenderInputs = {
    command: "generate",
    mock: Boolean(body.mock),
    commit: body.commit !== false,
    slider: body.slider !== false,
    origin,
  };

  const args = ["generate"];
  if (inputs.mock) args.push("--mock");
  else if (!inputs.commit) args.push("--no-commit");
  if (!inputs.slider) args.push("--no-slider");
  if (origin !== "none") args.push("--origin", origin);

  const encoder = new TextEncoder();
  const remote = usesGitHubActions();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send: Send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        if (remote) await runRemote(send, req.signal, inputs);
        else await runLocal(send, req.signal, args);
      } catch (err) {
        send("error", { message: String(err instanceof Error ? err.message : err) });
      } finally {
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
