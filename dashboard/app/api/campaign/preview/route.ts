/**
 * Render the campaign template from composer state. Sends nothing — this only
 * feeds the in-page preview iframe and the plain-text tab.
 *
 * Always the light design. The preview is an iframe, so it otherwise follows
 * the operator's own dark mode and shows a dark email to someone composing a
 * light one. What the composer approves should be one fixed thing.
 */
import { renderCampaign } from "@/lib/email-template";
import { unsubscribeMailto } from "@/lib/campaign-shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      headline?: string;
      body?: string;
      ctaUrl?: string;
      ctaLabel?: string;
      attachmentName?: string | null;
      preheader?: string;
    };
    const { html, text } = renderCampaign({
      headline: (body.headline ?? "").trim() || "Nyheter fra Nordic Engros",
      body: body.body ?? "",
      ctaUrl: (body.ctaUrl ?? "").trim(),
      ctaLabel: (body.ctaLabel ?? "").trim() || "Se nyhetene i nettbutikken",
      attachmentName: body.attachmentName ?? null,
      unsubscribeMailto: unsubscribeMailto(),
      preheader: body.preheader ?? "",
    }, { forceLight: true });
    return Response.json({ html, text });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
