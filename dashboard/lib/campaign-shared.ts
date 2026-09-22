/**
 * Pieces shared by the preview, the test-send and the campaign runner, so all
 * three produce a byte-identical message. Anything that differs between what the
 * operator previews and what customers receive is a bug waiting to happen.
 */
import crypto from "node:crypto";

import { senderIdentity } from "./email-template";

/**
 * The unsubscribe address. Running on localhost there is no public URL for a
 * clickable link, so opt-out is a mailto: — which is RFC-valid and is what Gmail
 * and Outlook turn into their native "Unsubscribe" button. That button is the
 * difference between an unsubscribe and a spam complaint, so it matters more
 * than its simplicity suggests.
 */
export function unsubscribeMailto(): string {
  const to = process.env.EMAIL_UNSUBSCRIBE_TO || senderIdentity().email;
  return `mailto:${to}?subject=${encodeURIComponent("Avmelding nyhetsbrev")}`;
}

/**
 * Headers set on every campaign message.
 *
 * Only `List-Unsubscribe` is emitted — deliberately NOT `List-Unsubscribe-Post`,
 * which advertises one-click and requires an HTTPS endpoint we do not have.
 * Claiming one-click support and then not honouring it is worse than not
 * claiming it.
 */
export function campaignHeaders(): Record<string, string> {
  return { "List-Unsubscribe": `<${unsubscribeMailto()}>` };
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
