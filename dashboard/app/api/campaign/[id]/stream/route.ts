/**
 * Watch a campaign — and, while watching, drive it.
 *
 * This used to be a pure observer of a detached background loop. There is no
 * such loop any more: a serverless instance is frozen once its response is
 * sent, so work only happens inside a request that is waiting for it. Opening
 * the progress view is therefore what starts the send, which is also why a
 * campaign begins the moment the composer creates it.
 *
 * Closing the tab no longer abandons the campaign: the batch stops, the lease
 * is released, and the cron sweep picks it up within a minute. So the guarantee
 * the old design wanted — "a send is not tied to a browser tab" — still holds,
 * it is just kept somewhere that survives.
 *
 * Frames use the same `event:`/`data:` contract as the other SSE routes, so the
 * client parser is unchanged.
 */
import { isValidCampaignId, readCampaign } from "@/lib/campaign-store";
import { campaignProgress, runCampaignBatch } from "@/lib/campaign-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** Leave headroom under maxDuration so the batch stops itself and reports,
 *  rather than being cut off mid-frame by the platform. */
const BUDGET_MS = 700_000;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!isValidCampaignId(id)) {
    return Response.json({ error: "ugyldig kampanje-id" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        const manifest = await readCampaign(id);
        if (!manifest) {
          send("error", { message: "fant ikke kampanjen" });
          finish();
          return;
        }

        const result = await runCampaignBatch(id, {
          budgetMs: BUDGET_MS,
          signal: req.signal,
          emit: (event, data) => send(event, data),
        });

        // Another driver holds the lease, or the campaign was already finished:
        // report the stored outcome so a reloaded page is never blank.
        if (!result.ran) {
          const p = await campaignProgress(manifest);
          send("progress", { sent: p.sent, failed: p.failed, skipped: p.skipped, total: p.total });
          if (p.done) {
            send("done", {
              campaignId: manifest.id,
              sent: p.sent,
              failed: p.failed,
              skipped: p.skipped,
              total: p.total,
              dryRun: manifest.dryRun,
              restored: true,
            });
          } else {
            send("log", { line: "Utsendingen kjører allerede — følger med." });
          }
        }
      } catch (err) {
        send("error", { message: String(err instanceof Error ? err.message : err) });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
