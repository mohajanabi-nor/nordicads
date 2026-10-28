/**
 * READ-ONLY snapshot of the live products behind a supplier spec in .xlsx/.csv form.
 *
 *   node scripts/snapshot-shopify-xlsx.mjs <worker/.env> <file.xlsx> <out.json> [indexColumn] [eanColumns...]
 *
 * Looks products up two ways — by the article number as a tag, and by EAN as a barcode — and
 * writes everything it found plus, per lookup, which products each key hit. Only GraphQL
 * *queries*: there is no mutation in this file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const [envPath, file, outPath, indexCol = "INDEX", ...eanCols0] = process.argv.slice(2);
const eanCols = eanCols0.length ? eanCols0 : ["EAN PCS", "EAN BOX"];
if (!envPath || !file || !outPath) {
  console.error("usage: node scripts/snapshot-shopify-xlsx.mjs <worker/.env> <file> <out.json> [indexColumn] [eanColumns...]");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => /^\s*SHOPIFY_/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
  }),
);
const domain = "nordic-engros.myshopify.com"; // worker/.env carries a placeholder domain
const version = env.SHOPIFY_API_VERSION || "2024-10";
const tok = await (await fetch(`https://${domain}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }),
}).then((r) => r.json())).access_token;

async function gql(query) {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tok },
      body: JSON.stringify({ query }),
    });
    const body = await res.json();
    if (body.errors && JSON.stringify(body.errors).includes("THROTTLED")) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
    return body.data;
  }
  throw new Error("throttled");
}

const wb = XLSX.readFile(file, { raw: false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: "" });
const clean = (v) => String(v ?? "").trim().replace(/^="|"$/g, "");
const indexes = [...new Set(rows.map((r) => clean(r[indexCol])).filter(Boolean))];
const eans = [...new Set(rows.flatMap((r) => eanCols.map((c) => clean(r[c]))).filter((x) => /^\d{6,14}$/.test(x)))];

const FIELDS = `
  id title handle status vendor productType tags createdAt
  featuredImage { url }
  variants(first: 5) { nodes { id sku barcode price inventoryQuantity inventoryItem { id unitCost { amount } } } }
  metafields(first: 10, namespace: "custom") { nodes { namespace key type value } }`;

const byId = new Map();
const hitsByTag = {};
const hitsByEan = {};

async function run(keys, prefix, hits, matchKey) {
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    const q = batch.map((k) => `${prefix}:${k}`).join(" OR ");
    let after = null;
    do {
      const data = await gql(`{ products(first: 100, query: ${JSON.stringify(q)}${after ? `, after: ${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`);
      for (const p of data.products.nodes) {
        byId.set(p.id, p);
        for (const k of matchKey(p, batch)) (hits[k] ??= []).push(p.id);
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);
  }
}

await run(indexes, "tag", hitsByTag, (p, batch) => batch.filter((k) => p.tags.some((t) => t.toLowerCase() === k.toLowerCase())));
await run(eans, "barcode", hitsByEan, (p, batch) => batch.filter((k) => p.variants.nodes.some((v) => v.barcode === k)));

writeFileSync(outPath, JSON.stringify({ takenAt: new Date().toISOString(), shop: domain, indexes, eans, hitsByTag, hitsByEan, products: [...byId.values()] }, null, 1));
console.log(`${indexes.length} article numbers, ${eans.length} EANs → ${byId.size} products. tag hits: ${Object.keys(hitsByTag).length}, ean hits: ${Object.keys(hitsByEan).length}`);
