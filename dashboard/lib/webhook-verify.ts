/**
 * Verifying that a webhook really came from Resend.
 *
 * The inbound endpoint has to be reachable without a session — Resend is not a
 * browser and has no login. The signature is therefore the ONLY thing standing
 * between "a supplier sent a price list" and "anyone on the internet can inject
 * prices into your comparison". It is checked before the body is parsed, let
 * alone trusted.
 *
 * Resend signs with Svix's scheme: HMAC-SHA256 over `id.timestamp.body`, keyed
 * on the base64 secret after its `whsec_` prefix. Hand-rolled because that is a
 * well-specified twelve lines, and a dependency here would be carrying a whole
 * SDK for one hash.
 */
import crypto from "node:crypto";

/** Replay window. A signature older than this is refused even if it verifies,
 *  so a captured request cannot be replayed later. */
const TOLERANCE_SECONDS = 5 * 60;

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): VerifyResult {
  if (!secret) return { ok: false, reason: "RESEND_WEBHOOK_SECRET mangler" };

  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");

  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "mangler signaturheadere" };
  }

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) return { ok: false, reason: "ugyldig tidsstempel" };
  if (Math.abs(Date.now() / 1000 - sent) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "tidsstempel utenfor vinduet (mulig replay)" };
  }

  // `whsec_` prefixes the base64 key material; everything after it is the key.
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  // The header carries a space-separated list of `v1,<sig>` so a secret can be
  // rotated without an outage — any one matching is enough.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  }

  return { ok: false, reason: "signaturen stemmer ikke" };
}

/**
 * Constant-time bearer-token check, for the endpoints machines call with a
 * shared secret rather than a signature.
 */
export function verifyBearer(req: Request, expected: string): boolean {
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
