/**
 * The database behind Varemottak, as a four-method interface in PostgREST's own style
 * (the same params the rest of the app passes to lib/supabase.ts).
 *
 * Two implementations:
 *   supabaseDb  — the real thing.
 *   memoryDb    — a faithful-enough in-memory table store, used by tests and by local
 *                 runs with VAREMOTTAK_STORE=memory|file, so the whole flow can be
 *                 exercised without touching the live database.
 *
 * Business code is written once against `Db`; neither implementation leaks into it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sbDelete, sbInsert, sbSelect, sbUpdate, type InsertOptions, type QueryParams } from "../supabase";

export interface Db {
  select<T>(table: string, params?: QueryParams): Promise<T[]>;
  insert<T>(table: string, rows: object | object[], opts?: InsertOptions): Promise<T[]>;
  update<T>(table: string, params: QueryParams, patch: object): Promise<T[]>;
  remove(table: string, params: QueryParams): Promise<void>;
}

export const supabaseDb: Db = {
  select: (table, params) => sbSelect(table, params),
  // Callers of this interface always want the rows back.
  insert: (table, rows, opts) => sbInsert(table, rows, { returning: true, ...opts }),
  update: (table, params, patch) => sbUpdate(table, params, patch),
  remove: (table, params) => sbDelete(table, params),
};

// ------------------------------------------------------------------ in memory

/** Tables whose `id` is a serial number rather than a uuid. */
const SERIAL = new Set(["vm_invoice_lines", "vm_price_history", "vm_push_log"]);

/** Columns that, with these names, are conflict keys for upserts. */
type Row = Record<string, unknown>;

function matches(row: Row, params: QueryParams): boolean {
  for (const [key, raw] of Object.entries(params)) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key) || raw === undefined || raw === null) continue;
    const spec = String(raw);
    const dot = spec.indexOf(".");
    const op = spec.slice(0, dot);
    const arg = spec.slice(dot + 1);
    const v = row[key];
    const str = v === null || v === undefined ? "null" : String(v);
    switch (op) {
      case "eq":
        if (str !== arg) return false;
        break;
      case "neq":
        if (str === arg) return false;
        break;
      case "is":
        if (str !== arg) return false;
        break;
      case "in": {
        const items = arg.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
        if (!items.includes(str)) return false;
        break;
      }
      case "gt":
        if (!(Number(v) > Number(arg) || (typeof v === "string" && v > arg))) return false;
        break;
      case "gte":
        if (!(Number(v) >= Number(arg) || (typeof v === "string" && v >= arg))) return false;
        break;
      case "lt":
        if (!(Number(v) < Number(arg) || (typeof v === "string" && v < arg))) return false;
        break;
      case "lte":
        if (!(Number(v) <= Number(arg) || (typeof v === "string" && v <= arg))) return false;
        break;
      case "ilike": {
        const re = new RegExp(`^${arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
        if (!re.test(str)) return false;
        break;
      }
      default:
        throw new Error(`memoryDb: operator "${op}" is not supported`);
    }
  }
  return true;
}

export class MemoryDb implements Db {
  private tables = new Map<string, Row[]>();
  private serial = new Map<string, number>();
  /** Conflict keys per table for upserts, set by the code that creates the rows. */
  private persist: (() => void) | null = null;

  constructor(initial?: { tables: Record<string, Row[]>; serial?: Record<string, number> }) {
    if (initial) {
      for (const [t, rows] of Object.entries(initial.tables)) this.tables.set(t, rows);
      for (const [t, n] of Object.entries(initial.serial ?? {})) this.serial.set(t, n);
    }
  }

  /** Synchronous seeding of an empty table (used for the rows migration 011 inserts). */
  seedTable(table: string, rows: Row[]) {
    if (this.rows(table).length) return;
    this.tables.set(table, structuredClone(rows));
  }

  persistTo(save: (state: { tables: Record<string, Row[]>; serial: Record<string, number> }) => void) {
    this.persist = () => save({ tables: Object.fromEntries(this.tables), serial: Object.fromEntries(this.serial) });
    return this;
  }

  private rows(table: string): Row[] {
    let r = this.tables.get(table);
    if (!r) this.tables.set(table, (r = []));
    return r;
  }

  private sort(rows: Row[], order?: string): Row[] {
    if (!order) return rows;
    const specs = order.split(",").map((s) => {
      const [col, dir] = s.split(".");
      return { col, desc: dir === "desc" };
    });
    return [...rows].sort((a, b) => {
      for (const { col, desc } of specs) {
        const x = a[col] as number | string | null;
        const y = b[col] as number | string | null;
        if (x === y) continue;
        if (x === null || x === undefined) return desc ? -1 : 1;
        if (y === null || y === undefined) return desc ? 1 : -1;
        return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }

  async select<T>(table: string, params: QueryParams = {}): Promise<T[]> {
    let out = this.sort(this.rows(table).filter((r) => matches(r, params)), params.order as string | undefined);
    const offset = typeof params.offset === "number" ? params.offset : 0;
    if (offset) out = out.slice(offset);
    if (typeof params.limit === "number") out = out.slice(0, params.limit);
    return structuredClone(out) as T[];
  }

  async insert<T>(table: string, rows: object | object[], opts: InsertOptions = {}): Promise<T[]> {
    const list = (Array.isArray(rows) ? rows : [rows]) as Row[];
    const store = this.rows(table);
    const keys = opts.onConflict ? opts.onConflict.split(",") : null;
    const out: Row[] = [];
    for (const input of list) {
      const row: Row = structuredClone(input);
      const existing = keys ? store.find((r) => keys.every((k) => r[k] === row[k])) : undefined;
      if (existing) {
        if (opts.ignoreDuplicates) continue;
        if (opts.merge) {
          Object.assign(existing, row);
          out.push(existing);
          continue;
        }
        throw Object.assign(new Error(`duplicate key on ${table}`), { code: "23505", isUniqueViolation: true });
      }
      if (row.id === undefined && (SERIAL.has(table) || ["vm_invoice_lines", "vm_push_log"].includes(table))) {
        const n = (this.serial.get(table) ?? 0) + 1;
        this.serial.set(table, n);
        row.id = n;
      } else if (row.id === undefined && !["vm_supplier_links", "vm_product_settings", "vm_supplier_mappings", "vm_gp_categories", "vm_gp_rates"].includes(table)) {
        row.id = crypto.randomUUID();
      }
      const now = new Date().toISOString();
      row.created_at ??= now;
      store.push(row);
      out.push(row);
    }
    this.persist?.();
    return structuredClone(out) as T[];
  }

  async update<T>(table: string, params: QueryParams, patch: object): Promise<T[]> {
    const hits = this.rows(table).filter((r) => matches(r, params));
    for (const r of hits) Object.assign(r, structuredClone(patch));
    this.persist?.();
    return structuredClone(hits) as T[];
  }

  async remove(table: string, params: QueryParams): Promise<void> {
    const keep = this.rows(table).filter((r) => !matches(r, params));
    this.tables.set(table, keep);
    this.persist?.();
  }
}

// ------------------------------------------------------------------ selection

// Held on globalThis, not in a module variable: in development Next can load this module once per route,
// and each copy would then have its own empty store (a shipment created in one route missing in the next).
const shared = globalThis as unknown as { __varemottakMemoryDb?: MemoryDb | null };
const FILE = path.join(process.cwd(), ".data", "varemottak-db.json");

/** VAREMOTTAK_STORE=memory → in memory; =file → in memory, saved under .data/ between restarts. */
export function getDb(): Db {
  const mode = process.env.VAREMOTTAK_STORE;
  if (mode !== "memory" && mode !== "file") return supabaseDb;
  if (shared.__varemottakMemoryDb) return shared.__varemottakMemoryDb;
  if (mode === "file") {
    const save = (state: unknown) => {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(state));
    };
    shared.__varemottakMemoryDb = new MemoryDb(existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined).persistTo(save);
  } else shared.__varemottakMemoryDb = new MemoryDb();
  seedDefaults(shared.__varemottakMemoryDb);
  return shared.__varemottakMemoryDb;
}

export function resetMemoryDb() {
  shared.__varemottakMemoryDb = null;
}

/** What migration 011 inserts, for the in-memory store. */
export function seedDefaults(db: MemoryDb) {
  db.seedTable("vm_gp_categories", [
    { code: "1017", name: "Flasker av plast - drikkevare", unit: "kg", sort: 10, archived: false },
    { code: "2001", name: "Drikkekartong - drikkevare", unit: "pcs", sort: 20, archived: false },
    { code: "4005", name: "Glass drikkevare 0-250 ml", unit: "pcs", sort: 30, archived: false },
    { code: "5020", name: "Aluminium drikkevare 251-500 ml", unit: "pcs", sort: 40, archived: false },
  ]);
  db.seedTable("vm_gp_rates", [
    { code: "1017", valid_from: "2026-01-01", rate: 6 },
    { code: "2001", valid_from: "2026-01-01", rate: 0.18 },
    { code: "4005", valid_from: "2026-01-01", rate: 0.464 },
    { code: "5020", valid_from: "2026-01-01", rate: 0.18 },
  ]);
}
