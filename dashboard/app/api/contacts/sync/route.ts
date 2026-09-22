/**
 * Pull the contact list from Shopify, on demand.
 *
 * The work itself lives in lib/scheduler.ts and is shared with the automatic
 * daily run, so both go through the same lock, the same completeness guard and
 * the same logging. A manual sync must not be able to do something the automatic
 * one cannot — otherwise the two drift and only one of them is ever tested.
 */
import { contactStats } from "@/lib/contacts";
import { runSync, syncStatus } from "@/lib/scheduler";

export const dynamic = "force-dynamic";
// 800+ customers is several paginated Shopify calls; well inside this.
export const maxDuration = 300;

export async function POST() {
  try {
    const outcome = await runSync("manual");
    return Response.json({ ...outcome, ...contactStats(), sync: syncStatus() });
  } catch (err) {
    // runSync has already logged the detail; surface it for the operator too.
    return Response.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 502 },
    );
  }
}
