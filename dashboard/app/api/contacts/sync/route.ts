/**
 * Pull the contact list from Shopify, on demand.
 *
 * The work itself lives in lib/scheduler.ts and is shared with the automatic
 * daily run, so both go through the same lock, the same completeness guard and
 * the same logging. A manual sync must not be able to do something the automatic
 * one cannot — otherwise the two drift and only one of them is ever tested.
 */
import { contactStats, readContacts } from "@/lib/contacts";
import { runSync, syncStatus } from "@/lib/scheduler";
import { dispatchRender, usesGitHubActions } from "@/lib/github-actions";
import { createJob, newJobId } from "@/lib/worker-jobs";
import { logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
// 800+ customers is several paginated Shopify calls; well inside this.
export const maxDuration = 300;

export async function POST() {
  try {
    // Hosted, the Shopify fetch happens on a runner and reports back to
    // /api/internal/sync-customers — a paginated customer fetch does not fit in
    // a serverless function, and there is no Python here to run it with.
    if (usesGitHubActions()) {
      const jobId = newJobId();
      await createJob(jobId, "customers", { trigger: "manual" });
      await dispatchRender(jobId, { command: "customers" });
      await logInfo("sync", "sync.dispatched", "Synk startet manuelt.", { jobId });
      return Response.json({
        started: true,
        jobId,
        notes: ["Synken kjorer i bakgrunnen. Oppdater om et minutt for a se resultatet."],
        ...contactStats(await readContacts()),
        sync: await syncStatus(),
      });
    }

    const outcome = await runSync("manual");
    return Response.json({
      ...outcome,
      ...contactStats(await readContacts()),
      sync: await syncStatus(),
    });
  } catch (err) {
    // runSync has already logged the detail; surface it for the operator too.
    return Response.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 502 },
    );
  }
}
