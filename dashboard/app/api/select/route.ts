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
import { OUTPUT_DIR } from "@/lib/worker";
import { usesGitHubActions, type RenderInputs } from "@/lib/github-actions";
import { sseResponse, streamLocal, streamRemote, type Step } from "@/lib/worker-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel caps this; the job outlives the connection anyway

// Pipeline steps for the manual flow (no baseline commit).
const STEPS: Step[] = [
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

  // Only ever forward a shape the worker understands — never pass raw body text
  // through as a flag.
  const rawOrigin = (body.origin ?? "none").trim();
  const origin = /^(auto|[A-Za-z]{2})$/.test(rawOrigin) ? rawOrigin : "none";
  const title = (body.title ?? "").trim().slice(0, 200);

  // The arguments select needs beyond the shared ones. These go to the runner as
  // JSON and reach the CLI as argv, so the title's free text never touches a
  // shell.
  const extraArgs = ["--ids", ids.join(",")];
  if (body.mode === "tilbud") extraArgs.push("--tilbud");
  if (title) extraArgs.push("--title", title);

  const inputs: RenderInputs = {
    command: "select",
    slider: body.slider !== false,
    origin,
    extraArgs,
  };

  // The local path still builds one argv, since there is no workflow in between.
  const args = ["select", ...extraArgs];
  if (body.slider === false) args.push("--no-slider");
  if (origin !== "none") args.push("--origin", origin);

  const remote = usesGitHubActions();
  return sseResponse(
    (send, signal) =>
      remote
        ? streamRemote(send, signal, STEPS, inputs)
        : streamLocal(send, signal, STEPS, args, OUTPUT_DIR),
    req.signal,
  );
}
