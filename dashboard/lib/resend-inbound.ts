/**
 * Reading emails Resend received for us.
 *
 * The `email.received` webhook carries metadata only — the body and the
 * attachment bytes are fetched separately, which is why ingestion is split in
 * two: the webhook records that an email exists and returns immediately, and
 * the slow part happens later where it has time to.
 *
 * Server-only.
 */
const API = "https://api.resend.com";
const TIMEOUT_MS = 60_000;

export interface InboundAttachmentMeta {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
}

export interface InboundEmail {
  id: string;
  from: string;
  to: string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  created_at?: string;
  attachments?: InboundAttachmentMeta[];
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.RESEND_API_KEY || ""}`,
    "Content-Type": "application/json",
  };
}

async function get(path: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}

/** The full message: headers, body, and the list of attachments. */
export async function fetchInboundEmail(emailId: string): Promise<InboundEmail> {
  const res = await get(`/emails/inbound/${emailId}`);
  return (await res.json()) as InboundEmail;
}

/**
 * An attachment's bytes.
 *
 * Resend hands out a short-lived download URL rather than the content, so this
 * is two hops. The bytes are copied into our own Storage immediately after —
 * a link that expires is no basis for re-running an extraction next month.
 */
export async function downloadInboundAttachment(
  emailId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const res = await get(`/emails/inbound/${emailId}/attachments/${attachmentId}`);
  const meta = (await res.json()) as { download_url?: string; url?: string; content_type?: string };
  const url = meta.download_url ?? meta.url;
  if (!url) throw new Error("ingen nedlastingslenke for vedlegget");

  const file = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!file.ok) throw new Error(`nedlasting feilet: HTTP ${file.status}`);
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: meta.content_type ?? file.headers.get("content-type"),
  };
}

/** Classify an attachment so the extractor knows whether to read it or look at it. */
export function attachmentKind(filename: string, contentType?: string | null): string {
  const name = filename.toLowerCase();
  const type = (contentType ?? "").toLowerCase();
  if (name.endsWith(".pdf") || type.includes("pdf")) return "pdf";
  if (/\.xlsx?$/.test(name) || type.includes("spreadsheet") || type.includes("excel")) return "excel";
  if (name.endsWith(".csv") || type.includes("csv")) return "csv";
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(name) || type.startsWith("image/")) return "image";
  return "other";
}

/** The address part of a `Name <addr@example.com>` header. */
export function parseAddress(raw: string): { address: string; name: string | null } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(raw ?? "");
  if (m) return { address: m[2].trim().toLowerCase(), name: (m[1] || "").trim() || null };
  return { address: (raw ?? "").trim().toLowerCase(), name: null };
}

export interface SupplierRow {
  id: string;
  name: string;
  known_sender_addresses: string[] | null;
}

/**
 * Which supplier sent this, by exact address or by domain.
 *
 * An unknown sender is not an error and not a reason to discard anything: the
 * email is stored with no supplier attached and surfaces in the review queue,
 * because a supplier mailing from a new address is far more likely than a
 * stranger finding this endpoint.
 */
export function matchSupplier(from: string, suppliers: SupplierRow[]): SupplierRow | null {
  const address = from.toLowerCase();
  const domain = address.includes("@") ? `@${address.split("@")[1]}` : "";
  for (const s of suppliers) {
    for (const raw of s.known_sender_addresses ?? []) {
      const pattern = raw.trim().toLowerCase();
      if (!pattern) continue;
      if (pattern.startsWith("@") ? domain === pattern : address === pattern) return s;
    }
  }
  return null;
}
