/**
 * A PDF the operator attached from their own device, as opposed to a generated
 * drop catalogue.
 *
 * The browser uploads it straight to the `drops` bucket (see
 * /api/campaign/upload), and the campaign remembers it as `dropDir =
 * "upload:<id>"`. Keeping it in storage rather than in the request is what lets
 * a send that is paused or resumed later attach the exact same bytes — the same
 * reason catalogue PDFs are re-read from their drop.
 *
 * Server-only.
 */
import { createSignedUploadUrl, downloadObject, sanitizeFilename } from "./supabase-storage";
import { DROPS_BUCKET } from "./drops";
import type { Attachment } from "./resend";

const MARKER = "upload:";
const ID_RE = /^u[a-z0-9-]{8,64}$/;

/** Resend's limit is 40 MB after base64; 25 MB of PDF is ~33 MB encoded. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function newUploadId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `u${stamp}-${rand}`;
}

export function isValidUploadId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export const uploadMarker = (id: string) => `${MARKER}${id}`;

/** The upload id a campaign's `dropDir` points at, or null for a normal drop. */
export function uploadIdFromDropDir(dropDir: string | null): string | null {
  if (!dropDir?.startsWith(MARKER)) return null;
  const id = dropDir.slice(MARKER.length);
  return isValidUploadId(id) ? id : null;
}

const objectPath = (id: string) => `campaign-uploads/${id}.pdf`;

export function signUpload(id: string): Promise<string> {
  return createSignedUploadUrl(DROPS_BUCKET, objectPath(id));
}

/** A name safe to show and to send: ends in .pdf, no path bits. */
export function uploadFilename(name: string): string {
  const base = sanitizeFilename(name.replace(/\.pdf$/i, "")) || "vedlegg";
  return `${base}.pdf`;
}

export async function readUpload(id: string): Promise<Buffer | null> {
  try {
    return await downloadObject(DROPS_BUCKET, objectPath(id));
  } catch {
    return null;
  }
}

export type UploadLoad = { attachment: Attachment } | { error: string; status: number };

/** Fetch an uploaded PDF and shape it for Resend, or say why it can't be sent. */
export async function loadUploadAttachment(id: unknown, name: unknown): Promise<UploadLoad> {
  if (!isValidUploadId(id)) return { error: "ugyldig vedlegg", status: 400 };
  const pdf = await readUpload(id);
  if (!pdf || pdf.length === 0) {
    return { error: "fant ikke det opplastede vedlegget — last det opp på nytt", status: 400 };
  }
  if (pdf.length > MAX_UPLOAD_BYTES) {
    return { error: "vedlegget er for stort (maks 25 MB)", status: 413 };
  }
  return {
    attachment: {
      filename: uploadFilename(typeof name === "string" ? name : ""),
      content: pdf.toString("base64"),
    },
  };
}
