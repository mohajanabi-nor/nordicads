/**
 * Watch a running campaign over SSE.
 *
 * This is an OBSERVER, and the distinction is the whole point: unlike
 * api/generate and api/select — which kill their child process when the client
 * disconnects — aborting this request only detaches the viewer. The send keeps
 * going. Closing the tab mid-campaign must never leave half a customer list
 * mailed and the other half not.
 *
 * Frames use the same `event:`/`data:` contract as the other SSE routes, so the
 * client parser is unchanged.
 */
import { subscribe } from "@/lib/campaign-runner";
import { isValidCampaignId, readCampaign, summarize } from "@/lib/campaign-store";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel caps this; the job outlives the connection anyway

export async function GET(_req: Request, { params }: { params: { id: string } }) {
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

      const unsubscribe = subscribe(id, (frame) => {
        send(frame.event, frame.data);
        if (frame.event === "done") finish();
      });

      if (!unsubscribe) {
        // No live runner: the campaign finished earlier (or this process was
        // restarted). Serve the stored outcome so the page still shows results.
        const manifest = await readCampaign(id);
        if (!manifest) {
          send("error", { message: "fant ikke kampanjen" });
        } else {
          const s = await summarize(manifest);
          send("progress", { sent: s.sent, failed: s.failed, skipped: s.skipped, total: s.total });
          send("done", {
            campaignId: s.id,
            sent: s.sent,
            failed: s.failed,
            skipped: s.skipped,
            total: s.total,
            dryRun: s.dryRun,
            restored: true,
          });
        }
        finish();
        return;
      }

      // Detaching a viewer must NOT stop the campaign — only unsubscribe.
      _req.signal.addEventListener("abort", () => {
        unsubscribe();
        finish();
      });
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
