/**
 * Campaign persistence: an immutable manifest plus an append-only send log.
 *
 * The shape matters. `campaign.json` is written once and never touched again, so
 * a resumed send is byte-identical to the original — the same rendered HTML goes
 * to the last recipient as to the first. `recipients.ndjson` is appended one line
 * per attempt, so a crash can lose at most the line in flight, and "did Kari get
 * it?" is answerable by grep months later.
 *
 * Rewriting a single JSON file after each of 500 recipients would be 500 whole-
 * file rewrites with a torn-file window on every one of them; append-only has
 * neither problem.
 *
 * Server-only.
 */
import fs from "node:fs";
import path from "node:path";

import { EMAIL_STATE_DIR } from "./contacts";

const CAMPAIGNS_DIR = path.join(EMAIL_STATE_DIR, "campaigns");

/** Campaign ids appear in URLs and in filesystem paths, so they are restricted
 *  to a shape that cannot escape the campaigns directory. */
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

export function isValidCampaignId(id: string): boolean {
  return ID_RE.test(id);
}

export function campaignDir(id: string): string | null {
  if (!isValidCampaignId(id)) return null;
  return path.join(CAMPAIGNS_DIR, id);
}

/** Readable and sortable: the day it was sent, plus enough randomness that two
 *  campaigns in the same second cannot collide. */
export function newCampaignId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `k${stamp}-${rand}`;
}

export function createCampaign(manifest: CampaignManifest): void {
  const dir = campaignDir(manifest.id);
  if (!dir) throw new Error(`ugyldig kampanje-id: ${manifest.id}`);
  fs.mkdirSync(dir, { recursive: true });
  // 'wx' — never overwrite an existing manifest; that would rewrite history.
  fs.writeFileSync(path.join(dir, "campaign.json"), JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
}

export function readCampaign(id: string): CampaignManifest | null {
  const dir = campaignDir(id);
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "campaign.json"), "utf8"));
  } catch {
    return null;
  }
}

export function appendRecipient(id: string, record: RecipientRecord): void {
  const dir = campaignDir(id);
  if (!dir) return;
  try {
    fs.appendFileSync(path.join(dir, "recipients.ndjson"), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // A failed log write must never abort a send in progress. The Idempotency-Key
    // still protects against a duplicate if this campaign is later resumed.
  }
}

export function readRecipients(id: string): RecipientRecord[] {
  const dir = campaignDir(id);
  if (!dir) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "recipients.ndjson"), "utf8");
  } catch {
    return [];
  }
  const out: RecipientRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written final line after a hard crash — skip it, keep the rest.
    }
  }
  return out;
}

/**
 * Addresses that must NOT be attempted again: anything with a terminal outcome.
 * This is what makes resume idempotent at our layer; Resend's Idempotency-Key is
 * the second layer, covering the case where our log lost the last write.
 */
export function completedEmails(id: string): Set<string> {
  return new Set(readRecipients(id).map((r) => r.email));
}

export function summarize(manifest: CampaignManifest): CampaignSummary {
  const records = readRecipients(manifest.id);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of records) {
    if (r.status === "sent") sent++;
    else if (r.status === "failed") failed++;
    else skipped++;
  }
  const done = new Set(records.map((r) => r.email));
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    subject: manifest.subject,
    headline: manifest.headline,
    total: manifest.recipients.length,
    sent,
    failed,
    skipped,
    remaining: manifest.recipients.filter((e) => !done.has(e)).length,
    dryRun: manifest.dryRun,
    attachmentName: manifest.attachmentName,
  };
}

/** Newest first, for the history list on the e-post page. */
export function listCampaigns(limit = 50): CampaignSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(CAMPAIGNS_DIR);
  } catch {
    return [];
  }
  const out: CampaignSummary[] = [];
  for (const name of names) {
    if (!isValidCampaignId(name)) continue;
    const manifest = readCampaign(name);
    if (manifest) out.push(summarize(manifest));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
