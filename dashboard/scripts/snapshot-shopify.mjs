/**
 * READ-ONLY snapshot of the live products behind a supplier spec file, to seed the fake Shopify.
 *
 *   node scripts/snapshot-shopify.mjs <worker/.env> <spec.csv> <out.json>
 *
 * Sends only GraphQL *queries* (products by tag). It cannot change the store: there is not
 * a single mutation in this file, and the app's token has no write scope anyway.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [envPath, csvPath, outPath] = process.argv.slice(2);
if (!envPath || !csvPath || !outPath) {
  console.error("usage: node scripts/snapshot-shopify.mjs <worker/.env> <spec.csv> <out.json>");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*SHOPIFY_/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
// worker/.env carries a placeholder store domain; the real store is the app default.
const domain = /\.myshopify\.com$/.test(env.SHOPIFY_STORE_DOMAIN ?? "") ? env.SHOPIFY_STORE_DOMAIN : "nordic-engros.myshopify.com";
const version = env.SHOPIFY_API_VERSION || "2024-10";

const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
    grant_type: "client_credentials",
  }),
});
const { access_token: token } = await tokenRes.json();
if (!token) throw new Error("no token");

async function gql(query) {
  const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data;
}

// The spec file is cp1250 with ="…" article numbers in the second column.
const text = new TextDecoder("windows-1250").decode(readFileSync(csvPath));
const codes = [
  ...new Set(
    text
      .split(/\r?\n/)
      .slice(1)
      .map((l) => (l.split(";")[1] ?? "").replace(/^="|"$/g, "").trim())
      .filter(Boolean),
  ),
];

const FIELDS = `
  id title handle status vendor productType tags createdAt
  featuredImage { url }
  variants(first: 5) { nodes { id sku barcode price inventoryQuantity inventoryItem { id unitCost { amount } } } }
  metafields(first: 10, namespace: "custom") { nodes { namespace key type value } }`;

const byId = new Map();
for (let i = 0; i < codes.length; i += 30) {
  const batch = codes.slice(i, i + 30);
  const q = batch.map((c) => `tag:${c}`).join(" OR ");
  const data = await gql(`{ products(first: 250, query: ${JSON.stringify(q)}) { nodes { ${FIELDS} } } }`);
  for (const p of data.products.nodes) byId.set(p.id, p);
}

const products = [...byId.values()];
writeFileSync(outPath, JSON.stringify({ takenAt: new Date().toISOString(), shop: domain, products }, null, 1));
console.log(`${codes.length} article numbers → ${products.length} products → ${outPath}`);
