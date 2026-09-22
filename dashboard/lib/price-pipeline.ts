/**
 * From a received email to comparable prices.
 *
 * Runs well after the webhook that recorded the email, because reading a
 * scanned catalogue takes far longer than Resend is willing to wait for a 200.
 *
 * Every step records what it did, including failing. An email that could not be
 * read becomes a visible `extraction_failed` with the reason attached, never a
 * silent gap — the whole point of the feature is answering "who is cheapest",
 * and a supplier quietly missing from that answer is worse than no answer.
 *
 * Server-only.
 */
import { eq, is, sbInsert, sbSelect, sbUpdate } from "./supabase";
import { uploadObject, sanitizeFilename, SUPPLIER_BUCKET } from "./supabase-storage";
import {
  attachmentKind,
  downloadInboundAttachment,
  fetchInboundEmail,
  type InboundAttachmentMeta,
} from "./resend-inbound";
import {
  extractFromImage,
  extractFromPdf,
  extractFromSpreadsheet,
  extractFromText,
  extractionConfig,
  type ExtractedRow,
  type ExtractionResult,
} from "./price-extraction";
import { matchProduct } from "./product-matching";
import { logError, logInfo, logWarn } from "./eventlog";

export interface SupplierEmailRow {
  id: string;
  resend_email_id: string;
  supplier_id: string | null;
  from_address: string;
  subject: string | null;
  received_at: string;
  status: string;
}

export interface ProcessResult {
  emailId: string;
  status: string;
  rows: number;
  observations: number;
  needsReview: number;
  error?: string;
}

/** Emails waiting to be read, oldest first so nothing starves. */
export async function pendingEmails(limit = 5): Promise<SupplierEmailRow[]> {
  return sbSelect<SupplierEmailRow>("supplier_emails", {
    status: eq("received"),
    order: "received_at.asc",
    limit,
  });
}

/**
 * Take ownership of an email.
 *
 * A conditional update is the lock: it only matches while the row still says
 * `received`, so if two runs overlap exactly one of them gets the row back and
 * the other moves on. Without it, a retry would read and bill the same
 * catalogue twice.
 */
async function claim(emailId: string): Promise<boolean> {
  const rows = await sbUpdate<SupplierEmailRow>(
    "supplier_emails",
    { id: eq(emailId), status: eq("received") },
    { status: "processing" },
  );
  return rows.length > 0;
}

async function finish(emailId: string, status: string, error?: string): Promise<void> {
  await sbUpdate(
    "supplier_emails",
    { id: eq(emailId) },
    {
      status,
      error_message: error ?? null,
      processed_at: new Date().toISOString(),
    },
    { returning: false },
  );
}

/** Store the original alongside the numbers — a disputed price has to be
 *  traceable to the document it came from, months later. */
async function storeAttachment(
  supplierEmailId: string,
  meta: InboundAttachmentMeta,
  bytes: Buffer,
  contentType: string | null,
): Promise<string | null> {
  const kind = attachmentKind(meta.filename, contentType);
  const path = `${supplierEmailId}/${meta.id}_${sanitizeFilename(meta.filename)}`;
  try {
    await uploadObject(SUPPLIER_BUCKET, path, bytes, contentType ?? "application/octet-stream");
  } catch (err) {
    await logWarn("priser", "attachment.uploadFailed", `Kunne ikke lagre vedlegg ${meta.filename}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const inserted = await sbInsert<{ id: string }>(
    "email_attachments",
    {
      supplier_email_id: supplierEmailId,
      resend_attachment_id: meta.id,
      filename: meta.filename,
      content_type: contentType,
      size_bytes: bytes.length,
      storage_bucket: SUPPLIER_BUCKET,
      storage_path: path,
      kind,
      downloaded_at: new Date().toISOString(),
    },
    { returning: true, onConflict: "storage_path", merge: true },
  );
  return inserted[0]?.id ?? null;
}

async function recordExtraction(
  supplierEmailId: string,
  attachmentId: string | null,
  result: ExtractionResult,
): Promise<string> {
  const inserted = await sbInsert<{ id: string }>(
    "price_extractions",
    {
      supplier_email_id: supplierEmailId,
      attachment_id: attachmentId,
      method: result.method,
      model: result.model,
      raw_response: result.raw ?? null,
      extracted_rows: result.rows,
      row_count: result.rows.length,
      confidence: result.confidence,
      status: result.status,
      error_message: result.error,
    },
    { returning: true },
  );
  return inserted[0].id;
}

/**
 * Turn extracted rows into price observations.
 *
 * A row whose product is still unidentified is NOT written as a price: it would
 * be a number attached to nothing, and would either be invisible or, worse,
 * silently averaged into the wrong product later. It stays in the extraction
 * record and its alias sits in the review queue until someone says what it is.
 */
async function recordPrices(
  supplierId: string,
  supplierEmailId: string,
  extractionId: string,
  rows: ExtractedRow[],
): Promise<{ observations: number; needsReview: number }> {
  let observations = 0;
  let needsReview = 0;

  for (const row of rows) {
    const { alias, outcome } = await matchProduct(supplierId, row.raw_name, row.supplier_sku);
    if (!outcome.productId || outcome.needsReview) {
      needsReview++;
      continue;
    }

    await sbInsert("price_observations", {
      supplier_id: supplierId,
      product_id: outcome.productId,
      alias_id: alias.id,
      price_extraction_id: extractionId,
      supplier_email_id: supplierEmailId,
      price: row.price,
      currency: row.currency,
      vat_basis: row.vat_basis,
      vat_basis_assumed: row.vat_basis_assumed,
      unit: row.unit,
      pack_size: row.pack_size,
      valid_from: row.valid_from,
      raw_row: row,
    });
    observations++;
  }

  return { observations, needsReview };
}

/** Read one email end to end. Safe to call again on the same email. */
export async function processEmail(emailId: string): Promise<ProcessResult> {
  if (!(await claim(emailId))) {
    return { emailId, status: "skipped", rows: 0, observations: 0, needsReview: 0 };
  }

  const rows = await sbSelect<SupplierEmailRow>("supplier_emails", { id: eq(emailId), limit: 1 });
  const record = rows[0];
  if (!record) return { emailId, status: "missing", rows: 0, observations: 0, needsReview: 0 };

  try {
    if (!extractionConfig().apiKey) throw new Error("ANTHROPIC_API_KEY mangler");

    const email = await fetchInboundEmail(record.resend_email_id);
    const results: { attachmentId: string | null; result: ExtractionResult }[] = [];

    // Attachments already read on an earlier attempt are skipped, so a retry
    // after a partial failure does not pay for the same pages twice.
    const done = await sbSelect<{ attachment_id: string | null }>("price_extractions", {
      select: "attachment_id",
      supplier_email_id: eq(emailId),
      status: eq("ok"),
    });
    const alreadyRead = new Set(done.map((d) => d.attachment_id).filter(Boolean) as string[]);

    for (const meta of email.attachments ?? []) {
      const { bytes, contentType } = await downloadInboundAttachment(record.resend_email_id, meta.id);
      const attachmentId = await storeAttachment(emailId, meta, bytes, contentType);
      if (attachmentId && alreadyRead.has(attachmentId)) continue;

      const kind = attachmentKind(meta.filename, contentType);
      let result: ExtractionResult;
      if (kind === "pdf") result = await extractFromPdf(bytes);
      else if (kind === "image") result = await extractFromImage(bytes, contentType ?? "image/jpeg");
      else if (kind === "excel") result = await extractFromSpreadsheet(bytes, "excel");
      else if (kind === "csv") result = await extractFromSpreadsheet(bytes, "csv");
      else continue; // nothing readable — a signature image, say

      results.push({ attachmentId, result });
    }

    // No attachment carried prices? The email body may have them typed in.
    const gotRowsFromFiles = results.some((r) => r.result.rows.length > 0);
    if (!gotRowsFromFiles) {
      const body = (email.text ?? email.html ?? "").trim();
      if (body) results.push({ attachmentId: null, result: await extractFromText(body) });
    }

    let totalRows = 0;
    let observations = 0;
    let needsReview = 0;
    let anyOk = false;

    for (const { attachmentId, result } of results) {
      const extractionId = await recordExtraction(emailId, attachmentId, result);
      totalRows += result.rows.length;
      if (result.status !== "failed") anyOk = true;

      if (record.supplier_id && result.rows.length) {
        const counted = await recordPrices(record.supplier_id, emailId, extractionId, result.rows);
        observations += counted.observations;
        needsReview += counted.needsReview;
      } else {
        needsReview += result.rows.length;
      }
    }

    // The status says what a human still has to do, which is the only thing
    // that makes the queue meaningful.
    let status: string;
    if (!results.length) status = "extraction_failed";
    else if (!anyOk) status = "extraction_failed";
    else if (!record.supplier_id || needsReview > 0) status = "awaiting_review";
    else status = "processed";

    await finish(
      emailId,
      status,
      status === "extraction_failed" ? results[0]?.result.error ?? "ingen lesbare vedlegg" : undefined,
    );

    await logInfo("priser", "priser.processed", `Leste e-post fra ${record.from_address}: ${totalRows} rader, ${observations} priser lagret, ${needsReview} til gjennomgang.`, {
      emailId,
      status,
      rows: totalRows,
      observations,
      needsReview,
    });

    return { emailId, status, rows: totalRows, observations, needsReview };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(emailId, "extraction_failed", message);
    await logError("priser", "priser.failed", `Klarte ikke lese e-post fra ${record.from_address}: ${message}`, {
      emailId,
    });
    return { emailId, status: "extraction_failed", rows: 0, observations: 0, needsReview: 0, error: message };
  }
}

/** Put a failed or reviewed email back in the queue. */
export async function retryEmail(emailId: string): Promise<boolean> {
  const rows = await sbUpdate<SupplierEmailRow>(
    "supplier_emails",
    { id: eq(emailId), status: `in.(extraction_failed,awaiting_review,processed)` },
    { status: "received", error_message: null },
  );
  return rows.length > 0;
}

/** Emails a human still has to look at, for the review screen. */
export async function emailsNeedingAttention(limit = 50): Promise<SupplierEmailRow[]> {
  return sbSelect<SupplierEmailRow>("supplier_emails", {
    status: `in.(extraction_failed,awaiting_review)`,
    order: "received_at.desc",
    limit,
  });
}

/** Emails from a sender no supplier claims. */
export async function unknownSenderEmails(limit = 50): Promise<SupplierEmailRow[]> {
  return sbSelect<SupplierEmailRow>("supplier_emails", {
    supplier_id: is(null),
    order: "received_at.desc",
    limit,
  });
}
