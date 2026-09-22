/** List drop folders, newest-first. Reads Supabase when renders run on GitHub
 *  Actions, or the worker's local output folder when they run on this machine. */
import { NextResponse } from "next/server";
import { listAllDrops } from "@/lib/drops";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ drops: await listAllDrops() });
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    );
  }
}
