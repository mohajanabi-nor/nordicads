/**
 * A `Db` over a real Postgres (PGlite — Postgres compiled to WebAssembly), for tests only.
 *
 * It translates the handful of PostgREST filters the app uses (eq, neq, is, in, gt…lte, ilike,
 * order, limit) into SQL and returns rows the way PostgREST does: numerics as JSON numbers,
 * dates as "YYYY-MM-DD", timestamps as ISO strings. That lets the real migrations and the real
 * service code run together, which the in-memory stand-in cannot prove (types, constraints,
 * arrays, jsonb, upserts on real unique keys).
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import fs from "node:fs";
import path from "node:path";
import type { InsertOptions, QueryParams } from "../../supabase";
import type { Db } from "../db";

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier "${s}"`);
  return `"${s}"`;
};

export async function createPgliteWithMigrations(migrationsDir = path.resolve(__dirname, "../../../../db")): Promise<PGlite> {
  const pg = new PGlite({
    extensions: { pg_trgm },
    parsers: {
      20: (v: string) => Number(v), // int8 (bigserial ids)
      1700: (v: string) => Number(v), // numeric — PostgREST sends JSON numbers
      1082: (v: string) => v, // date stays "YYYY-MM-DD"
      1184: (v: string) => new Date(v).toISOString(), // timestamptz as ISO text
    },
  });
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(fs.readFileSync(path.join(migrationsDir, f), "utf8"));
  }
  return pg;
}

export class PgDb implements Db {
  private types = new Map<string, Map<string, string>>();

  constructor(readonly pg: PGlite) {}

  private async columnTypes(table: string): Promise<Map<string, string>> {
    let t = this.types.get(table);
    if (!t) {
      const r = await this.pg.query<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1",
        [table],
      );
      t = new Map(r.rows.map((c) => [c.column_name, c.data_type]));
      this.types.set(table, t);
    }
    return t;
  }

  /** JS value → what a bind parameter needs for this column's type. */
  private bind(value: unknown, type: string | undefined): unknown {
    if (value === undefined) return null;
    if (value === null) return null;
    if (type === "jsonb" || type === "json") return JSON.stringify(value);
    if (type === "ARRAY" && Array.isArray(value)) return `{${value.map((v) => JSON.stringify(String(v))).join(",")}}`;
    return value;
  }

  private where(params: QueryParams, args: unknown[]): string {
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(params)) {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(key) || raw === undefined || raw === null) continue;
      const spec = String(raw);
      const dot = spec.indexOf(".");
      const op = spec.slice(0, dot);
      const arg = spec.slice(dot + 1);
      const col = ident(key);
      const push = (v: unknown) => {
        args.push(v);
        return `$${args.length}`;
      };
      switch (op) {
        case "eq": parts.push(`${col} = ${push(arg)}`); break;
        case "neq": parts.push(`${col} <> ${push(arg)}`); break;
        case "gt": parts.push(`${col} > ${push(arg)}`); break;
        case "gte": parts.push(`${col} >= ${push(arg)}`); break;
        case "lt": parts.push(`${col} < ${push(arg)}`); break;
        case "lte": parts.push(`${col} <= ${push(arg)}`); break;
        case "ilike": parts.push(`${col} ILIKE ${push(arg)}`); break;
        case "is": parts.push(arg === "null" ? `${col} IS NULL` : arg === "true" ? `${col} IS TRUE` : `${col} IS FALSE`); break;
        case "in": {
          const items = parseList(arg);
          parts.push(items.length ? `${col} IN (${items.map(push).join(",")})` : "FALSE");
          break;
        }
        default: throw new Error(`PgDb: operator "${op}" is not supported`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  async select<T>(table: string, params: QueryParams = {}): Promise<T[]> {
    const args: unknown[] = [];
    const cols = params.select && params.select !== "*" ? String(params.select).split(",").map((c) => ident(c.trim())).join(",") : "*";
    let sql = `SELECT ${cols} FROM ${ident(table)}${this.where(params, args)}`;
    if (params.order) {
      sql += " ORDER BY " + String(params.order).split(",").map((o) => {
        const [c, d] = o.split(".");
        return `${ident(c)} ${d === "desc" ? "DESC" : "ASC"}`;
      }).join(", ");
    }
    if (typeof params.limit === "number") sql += ` LIMIT ${Math.floor(params.limit)}`;
    if (typeof params.offset === "number") sql += ` OFFSET ${Math.floor(params.offset)}`;
    return (await this.pg.query<T>(sql, args)).rows;
  }

  async insert<T>(table: string, rows: object | object[], opts: InsertOptions = {}): Promise<T[]> {
    const list = (Array.isArray(rows) ? rows : [rows]) as Array<Record<string, unknown>>;
    if (!list.length) return [];
    const types = await this.columnTypes(table);
    // PostgREST requires every object in a bulk insert to have the same keys; so does this.
    const keys = Object.keys(list[0]);
    for (const r of list) {
      const k = Object.keys(r);
      if (k.length !== keys.length || !keys.every((x) => k.includes(x))) {
        throw new Error(`bulk insert into ${table}: all objects must have the same keys`);
      }
    }
    const args: unknown[] = [];
    const values = list.map((r) => `(${keys.map((k) => { args.push(this.bind(r[k], types.get(k))); return `$${args.length}`; }).join(",")})`);
    let sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(",")}) VALUES ${values.join(",")}`;
    if (opts.onConflict) {
      const conflict = opts.onConflict.split(",").map(ident).join(",");
      if (opts.ignoreDuplicates) sql += ` ON CONFLICT (${conflict}) DO NOTHING`;
      else if (opts.merge) {
        const upd = keys.filter((k) => !opts.onConflict!.split(",").includes(k));
        sql += upd.length ? ` ON CONFLICT (${conflict}) DO UPDATE SET ${upd.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(",")}` : ` ON CONFLICT (${conflict}) DO NOTHING`;
      }
    }
    sql += " RETURNING *";
    return (await this.pg.query<T>(sql, args)).rows;
  }

  async update<T>(table: string, params: QueryParams, patch: object): Promise<T[]> {
    const types = await this.columnTypes(table);
    const entries = Object.entries(patch as Record<string, unknown>);
    const args: unknown[] = [];
    const set = entries.map(([k, v]) => { args.push(this.bind(v, types.get(k))); return `${ident(k)} = $${args.length}`; }).join(",");
    const sql = `UPDATE ${ident(table)} SET ${set}${this.where(params, args)} RETURNING *`;
    return (await this.pg.query<T>(sql, args)).rows;
  }

  async remove(table: string, params: QueryParams): Promise<void> {
    const args: unknown[] = [];
    await this.pg.query(`DELETE FROM ${ident(table)}${this.where(params, args)}`, args);
  }
}

/** `(a,"b,c",d)` → ["a","b,c","d"] — the inside of PostgREST's in.(…). */
function parseList(arg: string): string[] {
  const inner = arg.replace(/^\(/, "").replace(/\)$/, "");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quoted) {
      if (c === "\\" && inner[i + 1]) cur += inner[++i];
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (inner.length) out.push(cur);
  return out;
}
