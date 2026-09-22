/**
 * One campaign: its status snapshot (for a page load without SSE), plus the
 * resume and cancel actions.
 *
 * Resume re-runs only the recipients with no terminal outcome recorded, reusing
 * the frozen manifest so the message is identical to what earlier recipients
 * received.
 */
import { cancelCampaign, resumeCampaign } from "@/lib/campaign-runner";
import {
  isValidCampaignId,
  readCampaign,
  readRecipients,
  summarize,
} from "@/lib/campaign-store";
import type { Attachment } from "@/lib/resend";
import { readDropFile } from "@/lib/drops";

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
      const stopped = cancelCampaign(params.id);
      return Response.json({ cancelled: stopped });
    }

    if (action === "resume") {
      const manifest = await readCampaign(params.id);
      if (!manifest) {
        return Response.json({ error: "fant ikke kampanjen" }, { status: 404 });
      }
      // Rebuild the attachment from the same drop the campaign was created with,
      // so resumed recipients get exactly what the first ones got.
      let attachment: Attachment | null = null;
      if (manifest.attachmentName && manifest.dropDir) {
        const pdf = await readDropFile(manifest.dropDir, "katalog.pdf");
        if (!pdf) {
          return Response.json(
            { error: `katalog.pdf mangler i ${manifest.dropDir} — kan ikke fortsette med vedlegg` },
            { status: 400 },
          );
        }
        attachment = {
          filename: manifest.attachmentName,
          content: pdf.toString("base64"),
        };
      }
      const started = await resumeCampaign(params.id, attachment);
      if (!started) {
        return Response.json({ error: "kampanjen kjører allerede" }, { status: 409 });
      }
      return Response.json({ resumed: true, ...(await summarize(manifest)) });
    }

    return Response.json({ error: "ukjent handling" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
