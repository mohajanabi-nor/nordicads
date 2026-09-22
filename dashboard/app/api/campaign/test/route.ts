/**
 * Send ONE test message to the operator's own address.
 *
 * This is the gate the real send button sits behind: nothing goes to customers
 * until the operator has seen the exact rendered mail land in a real inbox. It
 * exercises the whole path — domain verification, API key, template, and the
 * attachment — against one recipient instead of five hundred.
 */
import { campaignHeaders, idempotencyKey, unsubscribeMailto } from "@/lib/campaign-shared";
import { renderCampaign } from "@/lib/email-template";
import { configProblems, isDryRun, sendOne } from "@/lib/resend";
import { isValidEmail, normalizeEmail } from "@/lib/contacts";
import { readDropFile } from "@/lib/drops";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Resend's ceiling is 40 MB after base64; stop well short of it. */
const MAX_ATTACHMENT_BYTES = 35 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      to?: string;
      subject?: string;
      headline?: string;
      body?: string;
      ctaUrl?: string;
      ctaLabel?: string;
      preheader?: string;
      dropDir?: string | null;
      attach?: boolean;
    };

    const to = normalizeEmail(body.to ?? "");
    if (!to || !isValidEmail(to)) {
      return Response.json({ error: "ugyldig testadresse" }, { status: 400 });
    }

    const problems = configProblems();
    if (problems.length) {
      return Response.json({ error: problems.join(" · ") }, { status: 400 });
    }

    // Attach the catalogue only when asked, and only via the path-traversal
    // guard the drops route already uses.
    let attachment: { filename: string; content: string } | null = null;
    if (body.attach && body.dropDir) {
      const buf = await readDropFile(body.dropDir, "katalog.pdf");
      if (!buf) {
        return Response.json(
          { error: `fant ingen katalog.pdf i ${body.dropDir}` },
          { status: 400 },
        );
      }
      const content = buf.toString("base64");
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return Response.json({ error: "vedlegget er for stort" }, { status: 413 });
      }
      attachment = { filename: `katalog-${body.dropDir}.pdf`, content };
    }

    const { html, text } = renderCampaign({
      headline: (body.headline ?? "").trim() || "Nyheter fra Nordic Engros",
      body: body.body ?? "",
      ctaUrl: (body.ctaUrl ?? "").trim(),
      ctaLabel: (body.ctaLabel ?? "").trim() || "Se nyhetene i nettbutikken",
      attachmentName: attachment?.filename ?? null,
      unsubscribeMailto: unsubscribeMailto(),
      preheader: body.preheader ?? "",
    });

    const result = await sendOne({
      to,
      subject: `[TEST] ${(body.subject ?? "").trim() || "Nyheter fra Nordic Engros"}`,
      html,
      text,
      headers: campaignHeaders(),
      attachment,
      // A fresh key per test, so repeated tests aren't deduplicated by Resend.
      idempotencyKey: idempotencyKey(`test-${Date.now()}`, to),
    });

    if (!result.ok) {
      return Response.json(
        { error: result.message, kind: result.kind, status: result.status },
        { status: 502 },
      );
    }
    return Response.json({
      sent: true,
      id: result.id,
      dryRun: isDryRun(),
      attached: Boolean(attachment),
      attachmentKb: attachment ? Math.round(attachment.content.length / 1024) : 0,
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
