/** Baseline + config status for the dashboard home card. Read-only. */
import { NextResponse } from "next/server";
import { runWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { code, stdout, stderr } = await runWorker(["status"]);
    if (code !== 0) {
      return NextResponse.json(
        { error: `worker status exited ${code}`, stderr },
        { status: 502 },
      );
    }
    // The worker prints other lines too on some setups; take the JSON line.
    const line = stdout
      .trim()
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (!line) {
      return NextResponse.json(
        { error: "no JSON in worker status output", stdout },
        { status: 502 },
      );
    }
    return NextResponse.json(JSON.parse(line));
  } catch (err) {
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    );
  }
}
