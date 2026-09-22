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
import { OUTPUT_DIR } from "@/lib/worker";
import { usesGitHubActions, type RenderInputs } from "@/lib/github-actions";
import { sseResponse, streamLocal, streamRemote, type Step } from "@/lib/worker-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel caps this; the job outlives the connection anyway

// Ordered pipeline steps shown as a checklist in the UI. `match` detects the
// step's START from a worker stdout line; reaching a later step marks earlier
// ones done.
const STEPS: Step[] = [
  { key: "fetch", label: "Henter produkter", match: (l) => l.includes("[shopify] fetching") || l.startsWith("[mock]") },
  { key: "classify", label: "Klassifiserer", match: (l) => l.includes("[ai] labelling") || l.startsWith("categories=") },
  { key: "images", label: "Cacher bilder", match: (l) => l.includes("[images] caching") },
  { key: "pdf", label: "Bygger PDF", match: (l) => l.startsWith("catalogue PDF:") },
  { key: "baseline", label: "Baseline lagret", match: (l) => l.includes("snapshot baseline committed") },
  { key: "reels", label: "Rendrer reels", match: (l) => l.startsWith("drop written:") || l.includes("manual drop written:") },
];


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

  const remote = usesGitHubActions();
  return sseResponse(
    (send, signal) =>
      remote
        ? streamRemote(send, signal, STEPS, inputs)
        : streamLocal(send, signal, STEPS, args, OUTPUT_DIR),
    req.signal,
  );
}
