/**
 * The checklist steps a render moves through, and how to spot each one in the
 * worker's stdout.
 *
 * These used to live in the route files that stream a run. They are here now
 * because the streaming route is no longer the only thing that needs them: a
 * connection that lasts the length of a render is not something to depend on,
 * and when it drops the browser falls back to polling /api/generate/status.
 * That poller has to be able to say where the run got to as well, or the
 * checklist freezes on whichever step was active when the stream died and
 * stays there for the rest of the run — showing "Henter produkter" while the
 * log underneath it scrolls through the reels.
 *
 * One definition, both readers.
 */
import type { Step } from "./worker-stream";

/** The weekly drop: fetch, classify, render, and commit a new baseline. */
export const GENERATE_STEPS: Step[] = [
  { key: "fetch", label: "Henter produkter", match: (l) => l.includes("[shopify] fetching") || l.startsWith("[mock]") },
  { key: "classify", label: "Klassifiserer", match: (l) => l.includes("[ai] labelling") || l.startsWith("categories=") },
  { key: "images", label: "Cacher bilder", match: (l) => l.includes("[images] caching") },
  { key: "pdf", label: "Bygger PDF", match: (l) => l.startsWith("catalogue PDF:") },
  { key: "baseline", label: "Baseline lagret", match: (l) => l.includes("snapshot baseline committed") },
  { key: "reels", label: "Rendrer reels", match: (l) => l.startsWith("drop written:") || l.includes("manual drop written:") },
];

/** The manual flow, which renders a hand-picked selection and commits no baseline. */
export const SELECT_STEPS: Step[] = [
  { key: "fetch", label: "Henter produkter", match: (l) => l.includes("[shopify] fetching") },
  { key: "classify", label: "Klassifiserer", match: (l) => l.includes("[select]") || l.startsWith("categories=") },
  { key: "images", label: "Cacher bilder", match: (l) => l.includes("[images] caching") },
  { key: "pdf", label: "Bygger PDF", match: (l) => l.startsWith("catalogue PDF:") },
  { key: "reels", label: "Rendrer reels", match: (l) => l.includes("drop written:") },
];

/**
 * The checklist as it stands after `lines`, for a caller holding a whole log
 * rather than watching one arrive.
 *
 * Matches the live tracker's rule exactly: a step becomes active when its line
 * appears, and reaching a later step marks every earlier one done — so a step
 * whose own line was never printed (a cached image pass that had nothing to do)
 * still resolves instead of sitting unticked forever.
 */
export function stepsFromLines(
  steps: Step[],
  lines: string[],
): Array<{ key: string; label: string; status: "done" | "active" }> {
  let furthest = -1;
  for (const line of lines) {
    // Scan from the end: a line matching several steps belongs to the latest
    // one, and a step already passed never pulls the checklist backwards.
    for (let i = steps.length - 1; i > furthest; i--) {
      if (steps[i].match(line)) {
        furthest = i;
        break;
      }
    }
  }
  return steps
    .slice(0, furthest + 1)
    .map((s, i) => ({ key: s.key, label: s.label, status: i < furthest ? "done" : "active" }));
}
