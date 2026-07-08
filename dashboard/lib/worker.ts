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
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/** Absolute path to the worker package root (…/nordicads/worker). */
export const WORKER_DIR =
  process.env.WORKER_DIR || path.resolve(process.cwd(), "..", "worker");

/** Python interpreter — prefer the worker's venv, fall back to system python3. */
export const PYTHON =
  process.env.WORKER_PYTHON ||
  (() => {
    const venv = path.join(WORKER_DIR, ".venv", "bin", "python");
    return fs.existsSync(venv) ? venv : "python3";
  })();

/** Where the worker writes one folder per drop. */
export const OUTPUT_DIR =
  process.env.WORKER_OUTPUT_DIR || path.join(WORKER_DIR, "output");

/**
 * Spawn `python -m nordic_social.cli <args…>` with PYTHONPATH=src so the worker
 * package resolves. Returns the ChildProcess; caller wires up stdout/stderr.
 */
export function spawnWorker(args: string[]) {
  return spawn(PYTHON, ["-m", "nordic_social.cli", ...args], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      PYTHONPATH: path.join(WORKER_DIR, "src"),
      PYTHONUNBUFFERED: "1", // stream stdout line-by-line for live progress
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
