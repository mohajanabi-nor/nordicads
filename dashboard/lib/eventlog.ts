/**
 * The event log behind the Logg tab.
 *
 * The feature does things while nobody is watching — a sync fires every 24
 * hours, contacts get auto-unsubscribed when Shopify drops them or Resend
 * rejects them. Every one of those is a consent change made without a human
 * deciding it, so each must leave a trace that can be read back later. An
 * automatic action with no record is indistinguishable from a bug.
 *
 * Now in Postgres rather than monthly NDJSON files. The append-only shape is
 * unchanged, but it survives a hosted app having no writable disk, and it is
 * readable from more than one instance at a time.
 *
 * Server-only.
 */
import { eq, gt, ilike, lt, sbDelete, sbInsert, sbSelectPage } from "./supabase";
import { getAppState, setAppState } from "./app-state";

/** Log lines carry email addresses, so they are personal data. Keep a year. */
const RETENTION_MONTHS = 12;

const LAST_SEEN_KEY = "logg.last_seen";

export type LogLevel = "info" | "warn" | "error";
/** Kept in step with the CHECK constraint on event_log.source (db/001). */
export type LogSource =
  | "sync"
  | "campaign"
  | "contacts"
  | "scheduler"
  | "config"
  | "inbound"
  | "priser"
  | "worker"
  | "auth";

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

/**
 * Append one entry. Never rejects: logging must not be able to break the thing
 * it is describing — a failed write here should not abort a campaign mid-send.
 *
 * Callers may await this or not. Awaiting is worth it where the record IS the
 * point (a consent change), because a hosted function can be frozen the moment
 * it returns a response, and an un-awaited write can be lost with it.
 */
export async function logEvent(entry: Omit<LogEntry, "at"> & { at?: string }): Promise<void> {
  try {
    await sbInsert("event_log", {
      at: entry.at ?? new Date().toISOString(),
      level: entry.level,
      source: entry.source,
      event: entry.event,
      message: entry.message,
      data: entry.data ?? null,
    });
    if (Math.random() < 0.02) await prune(); // ~1 in 50 writes; no cron needed
  } catch {
    /* ignore */
  }
}

/** Drop entries past the retention window. */
async function prune(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  try {
    await sbDelete("event_log", { at: lt(cutoff.toISOString()) });
  } catch {
    /* a failed prune is not worth surfacing */
  }
}

/** Convenience wrappers, so call sites read as prose. */
export const logInfo = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "info", source, event, message, data });
export const logWarn = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "warn", source, event, message, data });
export const logError = (source: LogSource, event: string, message: string, data?: Record<string, unknown>) =>
  logEvent({ level: "error", source, event, message, data });

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

interface EventRow {
  at: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  message: string;
  data: Record<string, unknown> | null;
}

/** Newest first, filtered then paginated. */
export async function readEvents(opts: ReadEventsOptions = {}): Promise<EventsPage> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const q = (opts.q ?? "").trim();

  const filters: Record<string, string> = {};
  if (opts.level && opts.level !== "alle") filters.level = eq(opts.level);
  if (opts.source && opts.source !== "alle") filters.source = eq(opts.source);
  // search_text is a stored column (see db/003) precisely so this stays one filter.
  if (q) filters.search_text = ilike(`*${q}*`);

  const { rows, total } = await sbSelectPage<EventRow>(
    "event_log",
    { select: "at,level,source,event,message,data", order: "at.desc,id.desc", ...filters },
    (page - 1) * pageSize,
    pageSize,
  );

  // The error badge counts every error, not just those matching the current
  // filter — the point is "is anything wrong", independent of what you searched.
  const errorCount = await countErrors();

  return {
    entries: rows.map((r) => ({
      at: r.at,
      level: r.level,
      source: r.source,
      event: r.event,
      message: r.message,
      ...(r.data ? { data: r.data } : {}),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    errorCount,
  };
}

async function countErrors(since?: string): Promise<number> {
  const filters: Record<string, string> = { level: eq("error") };
  if (since) filters.at = gt(since);
  const { total } = await sbSelectPage("event_log", { select: "id", ...filters }, 0, 1);
  return total;
}

// ------------------------------------------------- unseen-error badge -------

export async function markLogsSeen(at = new Date().toISOString()): Promise<void> {
  await setAppState(LAST_SEEN_KEY, { at });
}

/**
 * Errors since the tab was last opened — the number on the nav badge. A failure
 * at 03:00 that nobody ever notices is the whole reason this exists.
 */
export async function unseenErrorCount(): Promise<number> {
  try {
    const seen = await getAppState<{ at?: string }>(LAST_SEEN_KEY);
    return await countErrors(seen?.at);
  } catch {
    return 0;
  }
}
