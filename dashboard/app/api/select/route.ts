/**
 * Manual-select render: build a catalogue PDF + reels for EXACTLY the products
 * the operator picked, streaming progress to the browser over SSE.
 *
 * This is the product-picker's "Lag annonser + katalog" action. It spawns the
 * worker `select --ids <gids>` command, which runs in manual mode and NEVER
 * commits an inventory baseline (force_ids path). Generation happens entirely
 * in the worker process — never in this request's thread.
 *
 * Body (JSON): { ids: string[], mode?: "full" | "tilbud", title?: string,
 *                slider?: boolean }
 *   - "full"   (default): montage + per-category + kampanje reels + PDF
 *   - "tilbud": ONLY the offer (kampanje) reel over the on-offer picks — the
 *     "Lag tilbud annonse" button. Worker filters picks to is_offer and renders
 *     only_kampanje (førpris = compare_at_price).
 *   - title: optional campaign headline for the montage (intro) reel.
 *   - slider: default true. Adds an EXTRA slider reel per category with more
 *     than 3 picks, paging through every one of them; the normal 3-vare reel is
 *     rendered either way. false sends --no-slider.
 *   - origin: origin chip on the reels — "none" (default, no chip), "auto"
 *     (only when every product in a reel shares one origin), or an ISO-2 code
 *     ("PL") to print that country on every reel.
 */
import { spawnWorker, OUTPUT_DIR } from "@/lib/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // a render can take minutes

// Pipeline steps for the manual flow (no baseline commit).
const STEPS: { key: string; label: string; match: (l: string) => boolean }[] = [
  { key: "fetch", label: "Henter produkter", match: (l) => l.includes("[shopify] fetching") },
  { key: "classify", label: "Klassifiserer", match: (l) => l.includes("[select]") || l.startsWith("categories=") },
  { key: "images", label: "Cacher bilder", match: (l) => l.includes("[images] caching") },
  { key: "pdf", label: "Bygger PDF", match: (l) => l.startsWith("catalogue PDF:") },
  { key: "reels", label: "Rendrer reels", match: (l) => l.includes("drop written:") },
];

export async function POST(req: Request) {
  let body: {
    ids?: string[];
    mode?: string;
    title?: string;
    slider?: boolean;
    origin?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }
  const ids = (body.ids ?? []).filter((s) => typeof s === "string" && s.trim());
  if (ids.length === 0) {
    return Response.json({ error: "no product ids provided" }, { status: 400 });
  }

  const args = ["select", "--ids", ids.join(",")];
  if (body.mode === "tilbud") args.push("--tilbud");
  if (body.slider === false) args.push("--no-slider");
  // Only ever forward a shape the worker understands — never pass raw body text
  // through to a subprocess argument.
  const origin = (body.origin ?? "none").trim();
  if (origin !== "none" && /^(auto|[A-Za-z]{2})$/.test(origin)) {
    args.push("--origin", origin);
  }
  const title = (body.title ?? "").trim();
  if (title) args.push("--title", title);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );

      // Resolving the interpreter can fail (no venv, no Python on PATH). Report
      // that as a normal SSE error so it lands in the operator's log panel,
      // instead of throwing out of start() as a bodyless 500.
      let child: ReturnType<typeof spawnWorker>;
      try {
        child = spawnWorker(args);
      } catch (err) {
        send("error", { message: String(err instanceof Error ? err.message : err) });
        controller.close();
        return;
      }

      let stepIdx = -1;
      let buf = "";
      let dropDir: string | null = null;
      let assetCount = 0;
      let closed = false;

      const advanceTo = (idx: number) => {
        if (idx <= stepIdx) return;
        for (let i = stepIdx + 1; i <= idx; i++) {
          send("step", { key: STEPS[i].key, label: STEPS[i].label, status: i < idx ? "done" : "active" });
        }
        stepIdx = idx;
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        send("log", { line });
        // Everything after the arrow (paths contain spaces on macOS and Windows
        // alike), split on both separators — see the same parse in api/generate.
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
        if (stepIdx >= 0) send("step", { key: STEPS[stepIdx].key, label: STEPS[stepIdx].label, status: "done" });
        if (code === 0) send("done", { drop: dropDir, assets: assetCount, outputDir: OUTPUT_DIR });
        else send("error", { message: `worker exited with code ${code}` });
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
