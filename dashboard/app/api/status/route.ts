/**
 * Baseline + config status for the dashboard home card. Read-only.
 *
 * Read straight from Postgres rather than by shelling out to `worker status`.
 * The baseline lives there now (a CI runner's disk does not survive the job),
 * and asking a Python process for four numbers the database already holds would
 * mean this card could not load at all on a host without Python.
 */
import { NextResponse } from "next/server";

import { sbSelect } from "@/lib/supabase";
import type { BaselineStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

interface RunRow {
  id: number;
  ts: string;
  item_count: number;
}

export async function GET() {
  try {
    const runs = await sbSelect<RunRow>("snapshot_runs", {
      select: "id,ts,item_count",
      order: "id.desc",
      limit: 1,
    });
    const last = runs[0] ?? null;

    const payload: BaselineStatus = {
      store_domain: process.env.SHOPIFY_STORE_DOMAIN || "nordic-engros.myshopify.com",
      // Drops live in Supabase Storage now; there is no local folder to name.
      output_dir: process.env.WORKER_OUTPUT_DIR || "supabase:drops",
      baseline: {
        is_first_run: last === null,
        last_run: last ? { id: last.id, ts: last.ts, item_count: last.item_count } : null,
      },
      config: {
        // Same defaults as the worker's config.py, so the card cannot disagree
        // with the run it is describing.
        new_window_days: Number(process.env.NEW_WINDOW_DAYS || "7"),
        restock_window_days: Number(process.env.RESTOCK_WINDOW_DAYS || "3"),
      },
    };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    );
  }
}
