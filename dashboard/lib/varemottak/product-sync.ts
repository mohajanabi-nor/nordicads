/**
 * A full refresh of the dashboard's Shopify product list, started when an invoice is imported.
 *
 * Matching an invoice already asks Shopify directly about the article numbers on it, so the shipment never works from
 * stale data. This is the other thing: the shared product list (the picker and the price pages) is rebuilt from the
 * WHOLE catalogue by the same job the schedule runs every two hours, so it is current for whoever opens it next.
 *
 * It only dispatches the job (the runner fetches the catalogue and posts it back). It never throws and never waits for
 * the runner: an import must not fail because the refresh could not be started. A refresh that is already queued or
 * running, or was started in the last ten minutes, is joined instead of repeated.
 */
import { dispatchRender, usesGitHubActions } from "@/lib/github-actions";
import { logError, logInfo } from "@/lib/eventlog";
import { activeJobFor, createJob, listJobs, newJobId } from "@/lib/worker-jobs";
import { fakeShopifyEnabled } from "./shopify";

export type ProductSyncResult = "started" | "already-running" | "recent" | "unavailable" | "failed";

const COOLDOWN_MS = 10 * 60_000;

export async function requestProductSync(): Promise<ProductSyncResult> {
  // On a laptop with the fake shop or the local file store there is nothing real to refresh.
  if (fakeShopifyEnabled() || process.env.VAREMOTTAK_STORE === "memory" || process.env.VAREMOTTAK_STORE === "file") return "unavailable";
  if (!usesGitHubActions()) return "unavailable";
  try {
    if (await activeJobFor("products")) return "already-running";
    const recent = (await listJobs(10)).find((j) => j.command === "products" && Date.now() - new Date(j.created_at).getTime() < COOLDOWN_MS);
    if (recent) return "recent";
    const jobId = newJobId();
    await createJob(jobId, "products", { trigger: "varemottak-import" });
    await dispatchRender(jobId, { command: "products" });
    await logInfo("scheduler", "products.dispatched", "Produktsynk startet (faktura importert i Varemottak).", { jobId });
    return "started";
  } catch (err) {
    await logError("scheduler", "products.dispatchFailed", `Kunne ikke starte produktsynk fra Varemottak: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    return "failed";
  }
}
