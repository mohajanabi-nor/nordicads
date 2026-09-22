/**
 * Render the campaign template from composer state. Sends nothing — this only
 * feeds the in-page preview iframe and the plain-text tab.
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
    });
    return Response.json({ html, text });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
