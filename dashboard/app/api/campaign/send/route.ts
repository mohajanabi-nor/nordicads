/**
 * Create a campaign.
 *
 * Validates, freezes the rendered message into a manifest, and returns
 * `{ campaignId }`. The sending itself happens on /api/campaign/[id]/stream,
 * which the client opens next, with a cron sweep finishing anything left — so
 * closing the tab delays a campaign rather than abandoning it.
 */
import { unsubscribeMailto } from "@/lib/campaign-shared";
import { createCampaign, newCampaignId, type CampaignManifest } from "@/lib/campaign-store";
import { isValidEmail, mailableEmails, normalizeEmail } from "@/lib/contacts";
import { readDropFile } from "@/lib/drops";
import { renderCampaign } from "@/lib/email-template";
import { configProblems, isDryRun, type Attachment } from "@/lib/resend";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // only starts the run; the loop outlives this

/** A deliberate ceiling. The list is meant to be under 500; a much larger send
 *  needs a warm-up plan and a paid quota, not a bigger loop. */
const MAX_RECIPIENTS = 1000;
const MAX_ATTACHMENT_BYTES = 35 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      recipients?: unknown;
      subject?: string;
      headline?: string;
      body?: string;
      ctaUrl?: string;
      ctaLabel?: string;
      preheader?: string;
      dropDir?: string | null;
      attach?: boolean;
    };

    const problems = configProblems();
    if (problems.length) {
      return Response.json({ error: problems.join(" · ") }, { status: 400 });
    }

    const subject = (body.subject ?? "").trim();
    if (!subject) {
      return Response.json({ error: "emnefelt mangler" }, { status: 400 });
    }

    // Recipients must be both requested AND currently subscribed. The contact
    // list is the authority here, never the client's payload.
    const requested = Array.isArray(body.recipients)
      ? body.recipients.filter((e): e is string => typeof e === "string")
      : [];
    // isMailable() is the single rule — it also excludes flagged-invalid
    // addresses and customers no longer in Shopify, not just unticked ones.
    const mailable = await mailableEmails();
    const recipients = Array.from(
      new Set(requested.map(normalizeEmail).filter((e) => isValidEmail(e) && mailable.has(e))),
    );

    if (recipients.length === 0) {
      return Response.json(
        { error: "ingen gyldige mottakere (er de avmeldt?)" },
        { status: 400 },
      );
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return Response.json(
        { error: `for mange mottakere (${recipients.length}, maks ${MAX_RECIPIENTS})` },
        { status: 400 },
      );
    }

    let attachment: Attachment | null = null;
    if (body.attach && body.dropDir) {
      const pdf = await readDropFile(body.dropDir, "katalog.pdf");
      if (!pdf) {
        return Response.json({ error: `fant ingen katalog.pdf i ${body.dropDir}` }, { status: 400 });
      }
      // Encoded ONCE for the whole campaign and reused for every recipient.
      const content = pdf.toString("base64");
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return Response.json({ error: "vedlegget er for stort (maks ~35 MB)" }, { status: 413 });
      }
      attachment = { filename: `katalog-${body.dropDir}.pdf`, content };
    }

    const headline = (body.headline ?? "").trim() || subject;
    const { html, text } = renderCampaign({
      headline,
      body: body.body ?? "",
      ctaUrl: (body.ctaUrl ?? "").trim(),
      ctaLabel: (body.ctaLabel ?? "").trim() || "Se nyhetene i nettbutikken",
      attachmentName: attachment?.filename ?? null,
      unsubscribeMailto: unsubscribeMailto(),
      preheader: body.preheader ?? "",
    });

    const manifest: CampaignManifest = {
      id: newCampaignId(),
      createdAt: new Date().toISOString(),
      subject,
      headline,
      html,
      text,
      recipients,
      dropDir: body.dropDir ?? null,
      attachmentName: attachment?.filename ?? null,
      dryRun: isDryRun(),
    };

    // Awaited: the manifest is what the send replays from, so it must be
    // durably recorded before anything else can pick the campaign up.
    //
    // Nothing is started here. The progress stream the client opens next drives
    // the send, and a cron sweep finishes whatever it does not — a loop launched
    // from this request would simply be frozen along with the instance the
    // moment this response is returned.
    await createCampaign(manifest);

    return Response.json({
      campaignId: manifest.id,
      total: recipients.length,
      dryRun: manifest.dryRun,
      attached: Boolean(attachment),
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
