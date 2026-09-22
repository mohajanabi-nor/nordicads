/**
 * Where finished drops are read from.
 *
 * Renders used to write into the worker's local `output/` folder and the
 * dashboard read straight off that disk. A run now happens on a GitHub Actions
 * runner whose filesystem is discarded the moment it finishes, so the assets are
 * uploaded to Supabase Storage instead and recorded in the `drops` table.
 *
 * Both sources are still supported, chosen the same way the generate route
 * chooses where to run: configured for Actions means read from Supabase,
 * otherwise read the local folder. That keeps a laptop-only setup working
 * exactly as before.
 *
 * Server-only.
 */
import fs from "node:fs";
import { usesGitHubActions } from "./github-actions";
import { createSignedUrl, downloadObject } from "./supabase-storage";
import { sbSelect, sbSelectOne, eq } from "./supabase";
import { listDrops as listLocalDrops, resolveDropFile } from "./worker";
import type { DropSummary } from "./types";

export const DROPS_BUCKET = "drops";

/** Drop folder names are used in URLs and storage paths, so they are restricted
 *  to the shape the worker produces and nothing else. */
const DROP_RE = /^drop_\d{4}-\d{2}-\d{2}(_\d+)?$/;
/** No separators, no traversal — a file is a plain name inside one folder. */
const FILE_RE = /^[A-Za-z0-9._-]{1,150}$/;

interface DropRow {
  dir: string;
  created_at: string;
  pdf: string | null;
  reels: string[] | null;
  asset_count: number;
}

export function dropsAreRemote(): boolean {
  return usesGitHubActions();
}

export async function listAllDrops(): Promise<DropSummary[]> {
  if (!dropsAreRemote()) return listLocalDrops();

  const rows = await sbSelect<DropRow>("drops", { order: "created_at.desc", limit: 200 });
  return rows.map((row) => ({
    dir: row.dir,
    createdAt: row.created_at,
    pdf: row.pdf,
    reels: row.reels ?? [],
    assetCount: row.asset_count,
  }));
}

export type DropFileTarget =
  | { kind: "redirect"; url: string }
  | { kind: "local"; path: string };

/**
 * Resolve one asset to something the route can serve.
 *
 * Remotely this is a short-lived signed URL the browser is redirected to, rather
 * than bytes proxied through here: Supabase honours Range requests on those URLs,
 * so video scrubbing keeps working, and a 40 MB reel never has to travel through
 * a serverless function to reach the person who asked for it.
 */
export async function resolveDropTarget(dir: string, file: string): Promise<DropFileTarget | null> {
  if (!DROP_RE.test(dir) || !FILE_RE.test(file)) return null;

  if (!dropsAreRemote()) {
    const path = resolveDropFile(dir, file);
    return path ? { kind: "local", path } : null;
  }

  // Only serve what the drop actually claims to contain, so a signed URL cannot
  // be minted for an arbitrary path in the bucket.
  const row = await sbSelectOne<DropRow>("drops", { dir: eq(dir) });
  if (!row) return null;
  const known = new Set([row.pdf, ...(row.reels ?? [])].filter(Boolean) as string[]);
  if (!known.has(file)) return null;

  const url = await createSignedUrl(DROPS_BUCKET, `${dir}/${file}`);
  return { kind: "redirect", url };
}

/**
 * Read a drop asset's bytes server-side.
 *
 * Used where the file has to be handled rather than handed to the browser —
 * attaching the catalogue PDF to a campaign, most of all, including when
 * resuming a send weeks later. That attachment has to be byte-identical to what
 * the first recipients got, which is exactly why it is re-read from the stored
 * drop rather than regenerated.
 */
export async function readDropFile(dir: string, file: string): Promise<Buffer | null> {
  const target = await resolveDropTarget(dir, file);
  if (!target) return null;
  if (target.kind === "local") return fs.readFileSync(target.path);
  try {
    return await downloadObject(DROPS_BUCKET, `${dir}/${file}`);
  } catch {
    return null;
  }
}
