/**
 * One campaign: its status snapshot (for a page load without SSE), plus the
 * resume and cancel actions.
 *
 * Resume re-runs only the recipients with no terminal outcome recorded, reusing
 * the frozen manifest so the message is identical to what earlier recipients
 * received.
 */
import { cancelCampaign, clearCancel, runCampaignBatch } from "@/lib/campaign-runner";
import {
  isValidCampaignId,
  readCampaign,
  readRecipients,
  summarize,
} from "@/lib/campaign-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isValidCampaignId(params.id)) {
    return Response.json({ error: "ugyldig kampanje-id" }, { status: 400 });
  }
  const manifest = await readCampaign(params.id);
  if (!manifest) {
    return Response.json({ error: "fant ikke kampanjen" }, { status: 404 });
  }
  return Response.json({
    ...(await summarize(manifest)),
    recipients: await readRecipients(params.id),
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isValidCampaignId(params.id)) {
      return Response.json({ error: "ugyldig kampanje-id" }, { status: 400 });
    }
    const { action } = (await req.json()) as { action?: string };

    if (action === "cancel") {
      // Takes effect within one send: every driver checks this per recipient.
      await cancelCampaign(params.id);
      return Response.json({ cancelled: true });
    }

    if (action === "resume") {
      const manifest = await readCampaign(params.id);
      if (!manifest) {
        return Response.json({ error: "fant ikke kampanjen" }, { status: 404 });
      }
      // An explicit resume overrides an earlier cancel, then sends what fits in
      // this request. Anything left over is picked up by the cron sweep, so the
      // button makes immediate progress without blocking until the very end.
      await clearCancel(params.id);
      const result = await runCampaignBatch(params.id, {
        budgetMs: 45_000,
        signal: req.signal,
      });
      if (!result.ran) {
        return Response.json({ error: "kampanjen kjører allerede" }, { status: 409 });
      }
      return Response.json({ resumed: true, ...(await summarize(manifest)) });
    }

    return Response.json({ error: "ukjent handling" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
