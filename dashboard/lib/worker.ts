/**
 * Bridge between the dashboard (Next.js) and the Python worker.
 *
 * The worker is the heavy-generation engine; the dashboard NEVER renders inside
 * a web request — it only spawns worker jobs and reads the `output/` folder it
 * writes. Everything here is server-only (Node child_process + fs).
 *
 * Paths are resolved relative to the repo layout (dashboard/ next to worker/),
 * overridable via env for other setups.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/** Absolute path to the worker package root (…/nordicads/worker). */
export const WORKER_DIR =
  process.env.WORKER_DIR || path.resolve(process.cwd(), "..", "worker");

/**
 * The worker's virtualenv interpreter, in the order we look for it.
 *
 * The same `.venv` puts python in a different place per platform: POSIX
 * (macOS/Linux, where this tool is normally set up) uses `bin/python`, Windows
 * uses `Scripts/python.exe`. We check the POSIX layout first so the established
 * setup keeps winning, then the Windows one — so the repo runs on either
 * machine without an env var or a per-machine edit.
 */
const VENV_CANDIDATES = [
  path.join("bin", "python"),
  path.join("Scripts", "python.exe"),
];

/**
 * System interpreters to try when there is no venv. `python3` stays first (the
 * previous behaviour, and correct on macOS/Linux); `python` and the `py`
 * launcher are the Windows spellings.
 */
const SYSTEM_CANDIDATES = ["python3", "python", "py"];

const PYTHON_HELP =
  "Fant ingen Python-tolker for worker'en. Sett opp et virtualenv i " +
  `${path.join(WORKER_DIR, ".venv")} (python -m venv .venv && pip install -r requirements.txt), ` +
  "installer Python og legg den i PATH, eller pek WORKER_PYTHON mot en tolker.";

/**
 * Does `cmd` actually start a Python? On Windows, `python3` and `python` are
 * commonly the Microsoft Store alias stub, which is present on PATH but exits
 * 9009 printing "Python was not found" instead of running anything — so merely
 * finding the name resolves proves nothing, and spawning it produces a
 * confusing failure deep inside a render. Run `--version` and insist on a real
 * Python banner (some builds print it on stderr, so we check both streams).
 */
function isPython(cmd: string): boolean {
  try {
    const res = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return false;
    return /^Python \d/.test(`${res.stdout ?? ""}${res.stderr ?? ""}`.trim());
  } catch {
    return false;
  }
}

// Resolved once per server process: `undefined` = not looked up yet, `null` =
// looked up and nothing worked (don't re-probe on every request).
let cachedPython: string | null | undefined;

/**
 * The interpreter to run the worker with: WORKER_PYTHON if set, else the venv
 * (POSIX layout, then Windows), else a system Python that verifiably runs.
 * Throws with an actionable message when there is none — better than spawning a
 * command we know will fail and leaving the operator with an errno.
 */
export function resolvePython(): string {
  if (cachedPython === null) throw new Error(PYTHON_HELP);
  if (cachedPython !== undefined) return cachedPython;

  const override = process.env.WORKER_PYTHON?.trim();
  if (override) {
    if (!isPython(override)) {
      cachedPython = null;
      throw new Error(`WORKER_PYTHON="${override}" kjører ikke som Python.`);
    }
    return (cachedPython = override);
  }

  for (const rel of VENV_CANDIDATES) {
    const candidate = path.join(WORKER_DIR, ".venv", rel);
    if (fs.existsSync(candidate)) return (cachedPython = candidate);
  }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (isPython(candidate)) return (cachedPython = candidate);
  }

  cachedPython = null;
  throw new Error(PYTHON_HELP);
}

/** Where the worker writes one folder per drop. */
export const OUTPUT_DIR =
  process.env.WORKER_OUTPUT_DIR || path.join(WORKER_DIR, "output");

/**
 * Spawn `python -m nordic_social.cli <args…>` with PYTHONPATH=src so the worker
 * package resolves. Returns the ChildProcess; caller wires up stdout/stderr.
 */
export function spawnWorker(args: string[]) {
  return spawn(resolvePython(), ["-m", "nordic_social.cli", ...args], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      PYTHONPATH: path.join(WORKER_DIR, "src"),
      PYTHONUNBUFFERED: "1", // stream stdout line-by-line for live progress
      // Decode this stream as UTF-8 on both platforms. Piped (non-tty) stdout
      // falls back to the locale encoding, which on Windows is cp1252 — so the
      // Norwegian log lines arrive mojibake'd ("slider=p?", "?" for the bullets)
      // while Node decodes them as UTF-8. Already the default on macOS; setting
      // it explicitly makes the two machines agree.
      PYTHONIOENCODING: "utf-8",
    },
  });
}

/**
 * Run a short worker command to completion and return its stdout. Use ONLY for
 * fast, read-only commands (e.g. `status`) — never for a render.
 */
export function runWorker(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker '${args.join(" ")}' timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** A drop folder summarised for the UI. */
export interface DropSummary {
  dir: string; // folder name, e.g. "drop_2026-06-07_3"
  createdAt: string; // ISO mtime of the folder
  pdf: string | null; // "katalog.pdf" if present
  reels: string[]; // *.mp4 file names (sorted, montage first)
  assetCount: number; // pdf + reels
}

const DROP_RE = /^drop_\d{4}-\d{2}-\d{2}(_\d+)?$/;

/** List real drop folders newest-first by reading the output directory. */
export function listDrops(): DropSummary[] {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const out: DropSummary[] = [];
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    if (!DROP_RE.test(name)) continue;
    const full = path.join(OUTPUT_DIR, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const files = fs.readdirSync(full);
    const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf")) ?? null;
    const reels = files
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .sort((a, b) => {
        // montage first, then alphabetical — matches how a drop reads top-down
        const am = a.includes("montage") ? 0 : 1;
        const bm = b.includes("montage") ? 0 : 1;
        return am - bm || a.localeCompare(b);
      });
    out.push({
      dir: name,
      createdAt: stat.mtime.toISOString(),
      pdf,
      reels,
      assetCount: (pdf ? 1 : 0) + reels.length,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Resolve a `<dir>/<file>` request to an absolute path INSIDE the output dir,
 * or null if it escapes (path-traversal guard for the file-serving route).
 */
export function resolveDropFile(dir: string, file: string): string | null {
  if (!DROP_RE.test(dir)) return null;
  const target = path.resolve(OUTPUT_DIR, dir, file);
  const root = path.resolve(OUTPUT_DIR) + path.sep;
  if (!target.startsWith(root)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return target;
}
