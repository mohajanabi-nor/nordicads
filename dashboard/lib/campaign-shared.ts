/**
 * Pieces shared by the preview, the test-send and the campaign runner, so all
 * three produce a byte-identical message. Anything that differs between what the
 * operator previews and what customers receive is a bug waiting to happen.
 */
import crypto from "node:crypto";

import { senderIdentity } from "./email-template";

/**
 * The mailto: fallback for "Meld deg av". Kept in List-Unsubscribe beside the https
 * link for the few mail clients that only understand mailto — whoever reads
 * post@nordicengros.no then unsubscribes that person by hand.
 */
export function unsubscribeMailto(): string {
  const to = process.env.EMAIL_UNSUBSCRIBE_TO || senderIdentity().email;
  return `mailto:${to}?subject=${encodeURIComponent("Avmelding nyhetsbrev")}`;
}

const DASHBOARD_URL = (process.env.DASHBOARD_PUBLIC_URL || "https://ads.nordicengros.no").replace(/\/+$/, "");

/**
 * Stands in for the recipient's unsubscribe token in a rendered campaign. The HTML is
 * rendered once per campaign (and stored, so a resume is byte-identical), then each
 * recipient's copy gets their own token at send time — see personalize(). Plain
 * letters and underscores so escaping and URL-encoding leave it untouched.
 */
export const UNSUBSCRIBE_TOKEN = "__AVMELDINGSTOKEN__";

/** The personal "Meld deg av" link: one click, no login (see /api/storefront/unsubscribe). */
export function unsubscribeUrl(token: string = UNSUBSCRIBE_TOKEN): string {
  return `${DASHBOARD_URL}/api/storefront/unsubscribe?t=${token}`;
}

/**
 * This recipient's copy of the rendered campaign. Without a token (a test sent to an
 * address that isn't a contact, or the preview), the link leads to a page saying it
 * isn't a real one, rather than to an unsubscribe for somebody else.
 */
export function personalize(content: string, token: string | null): string {
  return content.split(UNSUBSCRIBE_TOKEN).join(token ?? "forhandsvisning");
}

/**
 * Headers for one recipient. With their token: the https link first, which Gmail and
 * Outlook turn into their own one-click "Unsubscribe" button (RFC 8058 — that is what
 * List-Unsubscribe-Post announces, and /api/storefront/unsubscribe honours it), and
 * the mailto: as a fallback. Without one, only the mailto:.
 */
export function campaignHeaders(token: string | null = null): Record<string, string> {
  if (!token) return { "List-Unsubscribe": `<${unsubscribeMailto()}>` };
  return {
    "List-Unsubscribe": `<${unsubscribeUrl(token)}>, <${unsubscribeMailto()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Per-recipient idempotency key, stable across retries and resumes: the same
 * campaign and address always produce the same key, so Resend refuses a second
 * delivery within its 24 h window even if our own log was lost.
 */
export function idempotencyKey(campaignId: string, email: string): string {
  const hash = crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
  return `${campaignId}:${hash}`;
}
