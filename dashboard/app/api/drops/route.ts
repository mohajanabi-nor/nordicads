/** List drop folders (newest-first) by reading the worker output directory. */
import { NextResponse } from "next/server";
import { listDrops } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ drops: listDrops() });
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    );
  }
}
