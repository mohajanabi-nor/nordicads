/**
 * Supabase (PostgREST) client — plain HTTP, no SDK, matching how lib/resend.ts
 * talks to Resend and how the worker talks to Shopify and Anthropic.
 *
 * `@supabase/supabase-js` exists, but its weight is in auth sessions and
 * realtime subscriptions, neither of which the server side uses: every call from
 * here runs with the service_role key and reads or writes rows. What is left is
 * a query string and a fetch, which is what this file is.
 *
 * PostgREST's filter syntax is exposed rather than hidden — `{ status: eq("received") }`
 * maps to `?status=eq.received`. A thin wrapper you can still read the HTTP of
 * beats a query builder that has to be learned twice.
 *
 * Server-only: reads SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS and must
 * never reach the browser.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export function supabaseConfig() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  };
}

/** Problems the operator can fix, checked before a request fails 40 times. */
export function supabaseConfigProblems(): string[] {
  const cfg = supabaseConfig();
  const problems: string[] = [];
  if (!cfg.url) problems.push("SUPABASE_URL mangler i dashboard/.env.local");
  if (!cfg.serviceRoleKey) problems.push("SUPABASE_SERVICE_ROLE_KEY mangler i dashboard/.env.local");
  return problems;
}

/** A PostgREST error, with the parts of its body that identify what went wrong.
 *  `code` is the Postgres SQLSTATE — '23505' is a unique violation, which some
 *  callers treat as success (the row already existed) rather than an error. */
export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly details: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "SupabaseError";
  }

  /** Unique-constraint violation — an insert that lost a race, usually benign. */
  get isUniqueViolation(): boolean {
    return this.code === "23505";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Quote a value for PostgREST if it contains syntax the parser would otherwise
 * read as structure. Commas separate list items, dots separate operator from
 * value, and parentheses group — so an unquoted company name like
 * "Nordic, AS (avd. Oslo)" silently becomes a malformed query rather than a
 * search term.
 */
function literal(value: string): string {
  if (!/[,.:()"'\\ ]/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** Filter builders. Each returns the `<op>.<value>` half of a query param. */
export const eq = (v: string | number | boolean) => `eq.${literal(String(v))}`;
export const neq = (v: string | number | boolean) => `neq.${literal(String(v))}`;
export const gt = (v: string | number) => `gt.${literal(String(v))}`;
export const gte = (v: string | number) => `gte.${literal(String(v))}`;
export const lt = (v: string | number) => `lt.${literal(String(v))}`;
export const lte = (v: string | number) => `lte.${literal(String(v))}`;
export const like = (v: string) => `like.${literal(v)}`;
export const ilike = (v: string) => `ilike.${literal(v)}`;
export const is = (v: null | boolean) => `is.${v === null ? "null" : String(v)}`;
export const inList = (vs: Array<string | number>) => `in.(${vs.map((v) => literal(String(v))).join(",")})`;

function buildUrl(table: string, params?: QueryParams): string {
  const cfg = supabaseConfig();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return `${cfg.url}/rest/v1/${table}${qs ? `?${qs}` : ""}`;
}

async function request(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  const cfg = supabaseConfig();
  if (!cfg.url || !cfg.serviceRoleKey) {
    throw new SupabaseError(supabaseConfigProblems().join("; ") || "Supabase er ikke konfigurert", 0);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SupabaseError(`nettverksfeil mot Supabase: ${message}`, 0);
  }

  if (!res.ok) {
    const raw = await res.text();
    let body: { message?: string; code?: string; details?: string; hint?: string } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* non-JSON error body — fall back to the raw text */
    }
    throw new SupabaseError(
      body.message || raw.slice(0, 300) || `HTTP ${res.status}`,
      res.status,
      body.code ?? null,
      body.details ?? null,
      body.hint ?? null,
    );
  }

  return res;
}

async function jsonBody<T>(res: Response): Promise<T> {
  const raw = await res.text();
  if (!raw) return [] as unknown as T;
  return JSON.parse(raw) as T;
}

/** Rows matching `params`. Pass PostgREST options as params: `select`, `order`, `limit`. */
export async function sbSelect<T>(table: string, params?: QueryParams): Promise<T[]> {
  const res = await request(buildUrl(table, { select: "*", ...params }), { method: "GET" });
  return jsonBody<T[]>(res);
}

/** The first matching row, or null. */
export async function sbSelectOne<T>(table: string, params?: QueryParams): Promise<T | null> {
  const rows = await sbSelect<T>(table, { ...params, limit: 1 });
  return rows[0] ?? null;
}

/**
 * One page of rows plus the total matching count, for the paginated screens.
 * The count comes back in the Content-Range header ("0-49/2381") because
 * PostgREST reports it there rather than in the body.
 */
export async function sbSelectPage<T>(
  table: string,
  params: QueryParams,
  offset: number,
  limit: number,
): Promise<{ rows: T[]; total: number }> {
  const res = await request(buildUrl(table, { select: "*", ...params }), {
    method: "GET",
    headers: {
      Prefer: "count=exact",
      Range: `${offset}-${offset + limit - 1}`,
      "Range-Unit": "items",
    },
  });
  const rows = await jsonBody<T[]>(res);
  const total = Number.parseInt((res.headers.get("content-range") ?? "").split("/")[1] ?? "", 10);
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

export interface InsertOptions {
  /** Return the inserted rows. Off by default: most inserts don't need the echo. */
  returning?: boolean;
  /** Column(s) the conflict is detected on, e.g. "email". Required for upsert/ignore. */
  onConflict?: string;
  /** On conflict, leave the existing row alone instead of failing or merging.
   *  This is the ON CONFLICT DO NOTHING that makes a redelivered webhook a no-op. */
  ignoreDuplicates?: boolean;
  /** On conflict, overwrite the existing row (upsert). */
  merge?: boolean;
}

export async function sbInsert<T>(
  table: string,
  rows: Record<string, unknown> | Array<Record<string, unknown>>,
  opts: InsertOptions = {},
): Promise<T[]> {
  const prefer: string[] = [opts.returning ? "return=representation" : "return=minimal"];
  if (opts.ignoreDuplicates) prefer.push("resolution=ignore-duplicates");
  else if (opts.merge) prefer.push("resolution=merge-duplicates");

  const res = await request(buildUrl(table, opts.onConflict ? { on_conflict: opts.onConflict } : undefined), {
    method: "POST",
    headers: { Prefer: prefer.join(",") },
    body: JSON.stringify(rows),
  });
  return opts.returning ? jsonBody<T[]>(res) : [];
}

/**
 * Patch matching rows, returning what was actually updated.
 *
 * The returned rows are what makes a conditional update usable as a lock: an
 * UPDATE filtered on the row's current status returns nothing when another
 * worker got there first, which is how two overlapping cron runs avoid both
 * claiming the same email.
 */
export async function sbUpdate<T>(
  table: string,
  params: QueryParams,
  patch: Record<string, unknown>,
  opts: { returning?: boolean } = { returning: true },
): Promise<T[]> {
  const res = await request(buildUrl(table, params), {
    method: "PATCH",
    headers: { Prefer: opts.returning === false ? "return=minimal" : "return=representation" },
    body: JSON.stringify(patch),
  });
  return opts.returning === false ? [] : jsonBody<T[]>(res);
}

export async function sbDelete(table: string, params: QueryParams): Promise<void> {
  await request(buildUrl(table, params), {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

/** Call a Postgres function. Used where several statements must share one
 *  transaction — PostgREST wraps a single request in one, but not several. */
export async function sbRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const cfg = supabaseConfig();
  const res = await request(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  return jsonBody<T>(res);
}
