/**
 * Supabase Storage over plain HTTP, same reasoning as lib/supabase.ts.
 *
 * Two private buckets:
 *   supplier-emails — the original PDF/Excel/image a supplier sent, kept so an
 *                     extraction can be re-run, and so a disputed price can be
 *                     traced back to the document it came from.
 *   drops           — catalogue PDFs and reel MP4s the worker produces, which
 *                     used to live on the worker's local disk.
 *
 * Both are private. Files are handed to the browser as short-lived signed URLs
 * rather than public links: these are business documents, and a public bucket
 * URL is guessable-forever access that outlives any login.
 *
 * Server-only.
 */
import { SupabaseError, supabaseConfig } from "./supabase";

const REQUEST_TIMEOUT_MS = 60_000; // attachments and MP4s are larger than rows

export const SUPPLIER_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "supplier-emails";
export const DROPS_BUCKET = "drops";

/** Default lifetime for a signed URL: long enough to click, short enough that a
 *  copied link is not a lasting grant. */
const SIGNED_URL_TTL_SECONDS = 600;

async function storageFetch(
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  const cfg = supabaseConfig();
  if (!cfg.url || !cfg.serviceRoleKey) {
    throw new SupabaseError("Supabase er ikke konfigurert (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)", 0);
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.url}/storage/v1${path}`, {
      ...init,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SupabaseError(`nettverksfeil mot Supabase Storage: ${message}`, 0);
  }

  if (!res.ok) {
    const raw = await res.text();
    let body: { message?: string; error?: string } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    throw new SupabaseError(body.message || body.error || raw.slice(0, 300) || `HTTP ${res.status}`, res.status);
  }

  return res;
}

/** Each path segment is encoded separately so that slashes stay structural
 *  (they are the bucket's folder separator) while everything else is escaped. */
function encodePath(objectPath: string): string {
  return objectPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Make a filename safe to use as a storage key. Supplier attachments arrive
 * named whatever the sender's system produced — Norwegian characters, spaces,
 * occasionally a path separator — and that string becomes part of a URL.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "vedlegg";
}

export async function uploadObject(
  bucket: string,
  objectPath: string,
  body: ArrayBuffer | Uint8Array | Buffer,
  contentType = "application/octet-stream",
): Promise<{ bucket: string; path: string }> {
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
  await storageFetch(`/object/${bucket}/${encodePath(objectPath)}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      // Re-running an extraction re-uploads the same key; overwrite rather than
      // fail, so a retry is never blocked by its own previous attempt.
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes) as unknown as BodyInit,
  });
  return { bucket, path: objectPath };
}

/** A time-limited URL the browser can fetch directly. */
export async function createSignedUrl(
  bucket: string,
  objectPath: string,
  expiresIn = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const res = await storageFetch(`/object/sign/${bucket}/${encodePath(objectPath)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  const { signedURL } = (await res.json()) as { signedURL: string };
  const cfg = supabaseConfig();
  // The API returns a path relative to /storage/v1, not an absolute URL.
  return `${cfg.url}/storage/v1${signedURL.startsWith("/") ? "" : "/"}${signedURL}`;
}

/** Fetch the bytes server-side — used when the file must be read rather than
 *  handed to the browser, e.g. re-extracting from a stored attachment. */
export async function downloadObject(bucket: string, objectPath: string): Promise<Buffer> {
  const res = await storageFetch(`/object/${bucket}/${encodePath(objectPath)}`, { method: "GET" });
  return Buffer.from(await res.arrayBuffer());
}

export async function removeObject(bucket: string, objectPath: string): Promise<void> {
  await storageFetch(`/object/${bucket}/${encodePath(objectPath)}`, { method: "DELETE" });
}
