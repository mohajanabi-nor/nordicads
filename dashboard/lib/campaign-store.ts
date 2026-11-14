/**
 * Campaign persistence: an immutable manifest plus an append-only send log.
 *
 * The shape matters and is unchanged. A campaign row is written once and never
 * touched again, so a resumed send is byte-identical to the original — the same
 * rendered HTML goes to the last recipient as to the first. Recipients are
 * appended one row per attempt, so a crash can lose at most the write in
 * flight, and "did Kari get it?" is answerable months later.
 *
 * What changed is where it lives. This was a directory per campaign with a
 * write-once `campaign.json` and an NDJSON log; it is now Postgres, because a
 * hosted app has no disk to keep those on. The immutability that used to be a
 * filesystem flag (`wx`) is now a trigger that rejects UPDATE and DELETE — the
 * guarantee got stronger in the move, not weaker.
 *
 * Server-only.
 */
import { SupabaseError, eq, sbInsert, sbRpc, sbSelect, sbSelectOne } from "./supabase";

/** Campaign ids appear in URLs, so they are restricted to a known shape. */
const ID_RE = /^[a-z0-9-]{8,64}$/;

export type RecipientStatus = "sent" | "failed" | "skipped";

export interface CampaignManifest {
  id: string;
  createdAt: string;
  subject: string;
  headline: string;
  /** The exact rendered message. Frozen so a resume cannot drift. */
  html: string;
  text: string;
  recipients: string[];
  dropDir: string | null;
  attachmentName: string | null;
  dryRun: boolean;
}

export interface RecipientRecord {
  email: string;
  status: RecipientStatus;
  at: string;
  resendId?: string;
  error?: string;
  attempt: number;
}

export interface CampaignSummary {
  id: string;
  createdAt: string;
  subject: string;
  headline: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  dryRun: boolean;
  attachmentName: string | null;
}

interface CampaignRow {
  id: string;
  created_at: string;
  subject: string;
  headline: string;
  body_html: string;
  body_text: string;
  recipients: string[];
  drop_dir: string | null;
  attachment_name: string | null;
  dry_run: boolean;
}

interface RecipientRow {
  campaign_id: string;
  email: string;
  status: RecipientStatus;
  at: string;
  resend_id: string | null;
  error: string | null;
  attempt: number;
}

export function isValidCampaignId(id: string): boolean {
  return ID_RE.test(id);
}

/** Readable and sortable: the day it was sent, plus enough randomness that two
 *  campaigns in the same second cannot collide. */
export function newCampaignId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `k${stamp}-${rand}`;
}

function toManifest(row: CampaignRow): CampaignManifest {
  return {
    id: row.id,
    createdAt: row.created_at,
    subject: row.subject,
    headline: row.headline,
    html: row.body_html,
    text: row.body_text,
    recipients: row.recipients ?? [],
    dropDir: row.drop_dir,
    attachmentName: row.attachment_name,
    dryRun: row.dry_run,
  };
}

export async function createCampaign(manifest: CampaignManifest): Promise<void> {
  if (!isValidCampaignId(manifest.id)) throw new Error(`ugyldig kampanje-id: ${manifest.id}`);
  try {
    await sbInsert("campaigns", {
      id: manifest.id,
      created_at: manifest.createdAt,
      subject: manifest.subject,
      headline: manifest.headline,
      body_html: manifest.html,
      body_text: manifest.text,
      recipients: manifest.recipients,
      drop_dir: manifest.dropDir,
      attachment_name: manifest.attachmentName,
      dry_run: manifest.dryRun,
    });
  } catch (err) {
    // Same meaning as the old `wx` EEXIST: never rewrite history.
    if (err instanceof SupabaseError && err.isUniqueViolation) {
      throw new Error(`kampanjen finnes allerede: ${manifest.id}`);
    }
    throw err;
  }
}

export async function readCampaign(id: string): Promise<CampaignManifest | null> {
  if (!isValidCampaignId(id)) return null;
  const row = await sbSelectOne<CampaignRow>("campaigns", { id: eq(id) });
  return row ? toManifest(row) : null;
}

export async function appendRecipient(id: string, record: RecipientRecord): Promise<void> {
  if (!isValidCampaignId(id)) return;
  try {
    await sbInsert("campaign_recipients", {
      campaign_id: id,
      email: record.email,
      status: record.status,
      at: record.at,
      resend_id: record.resendId ?? null,
      error: record.error ?? null,
      attempt: record.attempt,
    });
  } catch {
    // A failed log write must never abort a send in progress. The
    // Idempotency-Key still protects against a duplicate if this campaign is
    // later resumed.
  }
}

export async function readRecipients(id: string): Promise<RecipientRecord[]> {
  if (!isValidCampaignId(id)) return [];
  const rows = await sbSelect<RecipientRow>("campaign_recipients", {
    campaign_id: eq(id),
    order: "id.asc",
    limit: 100_000,
  });
  return rows.map((r) => ({
    email: r.email,
    status: r.status,
    at: r.at,
    ...(r.resend_id ? { resendId: r.resend_id } : {}),
    ...(r.error ? { error: r.error } : {}),
    attempt: r.attempt,
  }));
}

/**
 * Addresses that must NOT be attempted again: anything with a terminal outcome.
 * This is what makes resume idempotent at our layer; Resend's Idempotency-Key is
 * the second layer, covering the case where our log lost the last write.
 */
export async function completedEmails(id: string): Promise<Set<string>> {
  if (!isValidCampaignId(id)) return new Set();
  const rows = await sbSelect<{ email: string }>("campaign_recipients", {
    select: "email",
    campaign_id: eq(id),
    limit: 100_000,
  });
  return new Set(rows.map((r) => r.email));
}

export interface CampaignStats {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
}

const NO_STATS: CampaignStats = { total: 0, sent: 0, failed: 0, skipped: 0, remaining: 0 };

/**
 * Progress counts for several campaigns, computed in Postgres (db/012).
 *
 * This used to download every recipient row and count them here. The cron does
 * that every five minutes and the progress stream does it every batch, so the
 * rows were the single biggest source of Supabase egress. The answer is six
 * numbers per campaign.
 */
export async function campaignStats(ids: string[]): Promise<Map<string, CampaignStats>> {
  const valid = ids.filter(isValidCampaignId);
  const out = new Map<string, CampaignStats>();
  if (!valid.length) return out;
  const rows = await sbRpc<Array<{ id: string } & CampaignStats>>("campaign_stats", { p_ids: valid });
  for (const r of rows) {
    out.set(r.id, {
      total: r.total,
      sent: r.sent,
      failed: r.failed,
      skipped: r.skipped,
      remaining: r.remaining,
    });
  }
  return out;
}

export async function summarize(manifest: CampaignManifest): Promise<CampaignSummary> {
  const stats = (await campaignStats([manifest.id])).get(manifest.id) ?? NO_STATS;
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    subject: manifest.subject,
    headline: manifest.headline,
    ...stats,
    dryRun: manifest.dryRun,
    attachmentName: manifest.attachmentName,
  };
}

/** Ids of recent campaigns with recipients still to go, newest first. */
export async function unfinishedCampaignIds(): Promise<string[]> {
  return sbRpc<string[]>("unfinished_campaign_ids");
}

/** Newest first, for the history list on the e-post page. */
export async function listCampaigns(limit = 50): Promise<CampaignSummary[]> {
  // Not the bodies or the recipient lists: those are the bulk of each row and
  // the history list shows neither.
  const rows = await sbSelect<
    Pick<CampaignRow, "id" | "created_at" | "subject" | "headline" | "attachment_name" | "dry_run">
  >("campaigns", {
    select: "id,created_at,subject,headline,attachment_name,dry_run",
    order: "created_at.desc",
    limit,
  });
  if (!rows.length) return [];

  const stats = await campaignStats(rows.map((r) => r.id));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    subject: row.subject,
    headline: row.headline,
    ...(stats.get(row.id) ?? NO_STATS),
    dryRun: row.dry_run,
    attachmentName: row.attachment_name,
  }));
}
