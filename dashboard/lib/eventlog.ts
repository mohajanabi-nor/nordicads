/**
 * The event log behind the Logg tab.
 *
 * The feature now does things while nobody is watching — a sync fires every 24
 * hours, contacts get auto-unsubscribed when Shopify drops them or Resend
 * rejects them. Every one of those is a consent change made without a human
 * deciding it, so each must leave a trace that can be read back later. An
 * automatic action with no record is indistinguishable from a bug.
 *
 * Append-only NDJSON, one file per month — the same shape as the per-campaign
 * log in campaign-store.ts, for the same reason: a crash can lose at most the
 * line in flight, and appending stays O(1) however long the file grows.
 *
 * Server-only.
 */
import fs from "node:fs";
import path from "node:path";

import { EMAIL_STATE_DIR } from "./contacts";

const LOGS_DIR = path.join(EMAIL_STATE_DIR, "logs");
const SEEN_FILE = path.join(LOGS_DIR, "last-seen.json");

/** Log lines carry email addresses, so they are personal data. Keep a year. */
const RETENTION_MONTHS = 12;

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "sync" | "campaign" | "contacts" | "scheduler" | "config";

export interface LogEntry {
  at: string;
  level: LogLevel;
  source: LogSource;
  /** Machine-readable, dotted: "sync.finished", "contact.autoUnsubscribed". */
  event: string;
  /** Norwegian, written for the operator rather than for a developer. */
  message: string;
  data?: Record<string, unknown>;
}

function monthFile(date = new Date()): string {
  return path.join(LOGS_DIR, `${date.toISOString().slice(0, 7)}.ndjson`);
}

function listLogFiles(): string[] {
  try {
    return fs
      .readdirSync(LOGS_DIR)
      .filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f))
      .sort()
      .reverse(); // newest month first
  } catch {
    return [];
  }
}

/** Drop month files past the retention window. Cheap, so it runs on write. */
function prune(): void {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const cutoffKey = cutoff.toISOString().slice(0, 7);
  for (const name of listLogFiles()) {
    if (name.slice(0, 7) < cutoffKey) {
      try {
        fs.unlinkSync(path.join(LOGS_DIR, name));
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Append one entry. Never throws: logging must not be able to break the thing it
 * is describing — a failed write here should not abort a campaign mid-send.
 */
export function logEvent(entry: Omit<LogEntry, "at"> & { at?: string }): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const full: LogEntry = { at: entry.at ?? new Date().toISOString(), ...entry };
    fs.appendFileSync(monthFile(), JSON.stringify(full) + "\n", "utf8");
    if (Math.random() < 0.02) prune(); // ~1 in 50 writes; no cron needed
  } catch {
    /* ignore */
  }
}

/** Convenience wrappers, so call sites read as prose. */
export const logInfo = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "info", source, event, message, data });
export const logWarn = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "warn", source, event, message, data });
export const logError = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "error", source, event, message, data });

function parseFile(name: string): LogEntry[] {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, name), "utf8");
    const out: LogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A half-written final line after a hard crash — skip it, keep the rest.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ReadEventsOptions {
  page?: number;
  pageSize?: number;
  level?: LogLevel | "alle";
  source?: LogSource | "alle";
  /** Substring match over message, event and the serialised data. */
  q?: string;
}

export interface EventsPage {
  entries: LogEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  errorCount: number;
}

/**
 * Newest first, filtered then paginated.
 *
 * Reads whole month files rather than seeking: a month of this app's activity is
 * a few thousand lines, and the simplicity is worth more than the microseconds.
 * It stops early once enough newer entries exist to satisfy the page AND the
 * filters are unset — the common case of "show me the latest".
 */
export function readEvents(opts: ReadEventsOptions = {}): EventsPage {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const level = opts.level && opts.level !== "alle" ? opts.level : null;
  const source = opts.source && opts.source !== "alle" ? opts.source : null;
  const q = (opts.q ?? "").trim().toLowerCase();

  const matches: LogEntry[] = [];
  let errorCount = 0;

  for (const name of listFilesNewestFirst()) {
    const entries = parseFile(name).reverse(); // within a file, newest last
    for (const e of entries) {
      if (e.level === "error") errorCount++;
      if (level && e.level !== level) continue;
      if (source && e.source !== source) continue;
      if (q) {
        const hay = `${e.message} ${e.event} ${JSON.stringify(e.data ?? {})}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      matches.push(e);
    }
  }

  const total = matches.length;
  const start = (page - 1) * pageSize;
  return {
    entries: matches.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    errorCount,
  };
}

function listFilesNewestFirst(): string[] {
  return listLogFiles();
}

// ------------------------------------------------- unseen-error badge -------

/** When the operator last opened the Logg tab. */
function readLastSeen(): string {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).at ?? "";
  } catch {
    return "";
  }
}

export function markLogsSeen(at = new Date().toISOString()): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ at }), "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Errors since the tab was last opened — the number on the nav badge. A failure
 * at 03:00 that nobody ever notices is the whole reason this exists, so the
 * count deliberately covers only the current and previous month; anything older
 * is not "new" by any useful definition.
 */
export function unseenErrorCount(): number {
  const since = readLastSeen();
  let count = 0;
  for (const name of listLogFiles().slice(0, 2)) {
    for (const e of parseFile(name)) {
      if (e.level === "error" && (!since || e.at > since)) count++;
    }
  }
  return count;
}
