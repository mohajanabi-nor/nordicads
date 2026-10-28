/**
 * READ-ONLY copy of the whole Shopify catalogue, for the fake store.
 *
 *   node scripts/snapshot-shopify-all.mjs <worker/.env> <out.json>
 *
 * Pages through products with a plain `products` query. There is no mutation in this file.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [envPath, outPath] = process.argv.slice(2);
if (!envPath || !outPath) {
  console.error("usage: node scripts/snapshot-shopify-all.mjs <worker/.env> <out.json>");
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => /^\s*SHOPIFY_/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
  }),
);
const domain = "nordic-engros.myshopify.com";
const version = env.SHOPIFY_API_VERSION || "2024-10";
const tok = await (await fetch(`https://${domain}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }),
}).then((r) => r.json())).access_token;

const FIELDS = `
  id title handle status vendor productType tags createdAt
  featuredImage { url }
  variants(first: 5) { nodes { id sku barcode price inventoryQuantity inventoryItem { id unitCost { amount } } } }
  metafields(first: 10, namespace: "custom") { nodes { namespace key type value } }`;

const products = [];
let after = null;
let page = 0;
do {
  const query = `{ products(first: 60${after ? `, after: "${after}"` : ""}) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;
  let body;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tok },
      body: JSON.stringify({ query }),
    });
    body = await res.json();
    if (body.errors && JSON.stringify(body.errors).includes("THROTTLED")) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    break;
  }
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  products.push(...body.data.products.nodes);
  after = body.data.products.pageInfo.hasNextPage ? body.data.products.pageInfo.endCursor : null;
  if (++page % 10 === 0) console.log(`  page ${page}: ${products.length} products`);
  // stay well under the cost bucket
  const cost = body.extensions?.cost;
  if (cost && cost.throttleStatus.currentlyAvailable < 600) await new Promise((r) => setTimeout(r, 1500));
} while (after);

writeFileSync(outPath, JSON.stringify({ takenAt: new Date().toISOString(), shop: domain, products }));
const byStatus = products.reduce((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {});
console.log(`${products.length} products`, byStatus, "→", outPath);
