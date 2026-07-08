/**
 * Trigger a worker `generate` job and stream progress to the browser over SSE.
 *
 * Contract (spec §1): trigger → progress events → done with the drop folder.
 * We spawn the worker, tail its stdout line-by-line, map known log prefixes to
 * named steps, and forward both step transitions and raw log lines. Generation
 * runs entirely in the worker process — never in this request's thread.
 *
 * Body (JSON): { mock?: boolean, commit?: boolean }
 *   mock=true  → offline prototype data (commits nothing)
 *   commit=false (real only) → pass --no-commit (skip the baseline)
 */
import { spawnWorker, OUTPUT_DIR } from "@/lib/worker";
import path from "node:path";

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

export async function POST(req: Request) {
  let body: { mock?: boolean; commit?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults below */
  }
  const args = ["generate"];
  if (body.mock) args.push("--mock");
  else if (body.commit === false) args.push("--no-commit");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );

      const child = spawnWorker(args);
      let stepIdx = -1; // highest step reached
      let buf = "";
      let dropDir: string | null = null;
      let assetCount = 0;
      let closed = false;

      const advanceTo = (idx: number) => {
        if (idx <= stepIdx) return;
        // mark every step from the old position up to (and including) idx
        for (let i = stepIdx + 1; i <= idx; i++) {
          send("step", { key: STEPS[i].key, label: STEPS[i].label, status: i < idx ? "done" : "active" });
        }
        stepIdx = idx;
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        send("log", { line });
        // capture the produced drop folder
        const m = /->\s*(\S+)\s*$/.exec(line);
        if (line.includes("drop written:") && m) {
          dropDir = path.basename(m[1]);
        }
        const am = /1 PDF \+ (\d+) mp4/.exec(line);
        if (am) assetCount = parseInt(am[1], 10) + 1;
        // step detection (scan from current step forward)
        for (let i = STEPS.length - 1; i > stepIdx; i--) {
          if (STEPS[i].match(line)) {
            advanceTo(i);
            break;
          }
        }
      };

      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", (d) => send("log", { line: d.toString().trimEnd(), stderr: true }));

      child.on("error", (err) => {
        if (closed) return;
        send("error", { message: String(err.message) });
        finish();
      });

      child.on("close", (code) => {
        if (closed) return;
        if (buf.trim()) handleLine(buf);
        // mark the final reached step done
        if (stepIdx >= 0) send("step", { key: STEPS[stepIdx].key, label: STEPS[stepIdx].label, status: "done" });
        if (code === 0) {
          send("done", { drop: dropDir, assets: assetCount, outputDir: OUTPUT_DIR });
        } else {
          send("error", { message: `worker exited with code ${code}` });
        }
        finish();
      });

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Kill the worker if the client disconnects.
      req.signal.addEventListener("abort", () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        finish();
      });
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
