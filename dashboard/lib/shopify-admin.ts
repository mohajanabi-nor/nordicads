/**
 * Shopify, from the dashboard itself.
 *
 * Until the wishlist, only the Python worker talked to Shopify — every catalogue or
 * customer fetch ran on an Actions runner. The wishlist can't wait for a runner: a
 * heart tapped on the storefront arrives through the App Proxy and has to be answered
 * in the same request. So this is the small slice of the worker's client that a
 * request needs, in TypeScript: the same custom app, the same client_credentials
 * grant (see worker/src/nordic_catalogue/shopify_client.py), plain fetch.
 *
 * Server-only: reads SHOPIFY_CLIENT_SECRET.
 */
import crypto from "node:crypto";

const REQUEST_TIMEOUT_MS = 15_000;

export function shopifyConfig() {
  return {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || "nordic-engros.myshopify.com",
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    apiVersion: process.env.SHOPIFY_API_VERSION || "2024-10",
  };
}

export class ShopifyAdminError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "ShopifyAdminError";
  }
}

// ---------------------------------------------------------------- App Proxy ------

/** How old a proxied request may be. Shopify signs each one as it forwards it, so
 *  anything older is a replay, not a slow network. */
const PROXY_TOLERANCE_SECONDS = 5 * 60;

export interface ProxyIdentity {
  /** The logged-in customer's numeric id, or null for a guest. */
  customerId: string | null;
}

/**
 * Check that a request really came through our App Proxy, and read who is logged in.
 *
 * Shopify appends `shop`, `logged_in_customer_id`, `path_prefix`, `timestamp` and
 * `signature` to every request it forwards. The signature is HMAC-SHA256 (hex) over the
 * other query parameters, sorted, each as `key=value` with repeated values joined by
 * commas, concatenated with no separator, keyed on the app's client secret.
 *
 * `logged_in_customer_id` is what makes this safe to leave open: the browser never
 * says who it is, Shopify does, and the browser cannot forge Shopify's signature.
 */
export function verifyAppProxy(url: URL): { ok: true; identity: ProxyIdentity } | { ok: false; reason: string } {
  const cfg = shopifyConfig();
  if (!cfg.clientSecret) return { ok: false, reason: "SHOPIFY_CLIENT_SECRET mangler" };

  const signature = url.searchParams.get("signature") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "mangler signatur" };

  const grouped = new Map<string, string[]>();
  url.searchParams.forEach((value, key) => {
    if (key === "signature") return;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  });
  const message = Array.from(grouped.keys())
    .sort()
    .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
    .join("");
  const expected = crypto.createHmac("sha256", cfg.clientSecret).update(message).digest("hex");

  const a = Buffer.from(signature.toLowerCase());
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signaturen stemmer ikke" };
  }

  if (url.searchParams.get("shop") !== cfg.storeDomain) {
    return { ok: false, reason: "feil butikk" };
  }

  const sent = Number.parseInt(url.searchParams.get("timestamp") ?? "", 10);
  if (!Number.isFinite(sent) || Math.abs(Date.now() / 1000 - sent) > PROXY_TOLERANCE_SECONDS) {
    return { ok: false, reason: "tidsstempel utenfor vinduet (mulig replay)" };
  }

  const customerId = (url.searchParams.get("logged_in_customer_id") ?? "").trim();
  return { ok: true, identity: { customerId: /^\d+$/.test(customerId) ? customerId : null } };
}

// ---------------------------------------------------------------- Admin API ------

// One token per warm instance. Tokens from the client_credentials grant live 24h; a
// cold start simply asks for a new one, which is cheaper than storing it somewhere.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt - 120_000) return cachedToken.value;

  const cfg = shopifyConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new ShopifyAdminError("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET mangler i Vercel");
  }
  const res = await fetch(`https://${cfg.storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new ShopifyAdminError(`Shopify-token feilet (${res.status}): ${body.error ?? "ukjent feil"}`, res.status);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 86_399) * 1000 };
  return body.access_token;
}

/** One Admin GraphQL call, retried on throttling and once on an expired token. */
export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const cfg = shopifyConfig();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://${cfg.storeDomain}/admin/api/${cfg.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken(attempt > 0) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      if (attempt === 0) continue; // token may have expired: the retry forces a new one
      throw new ShopifyAdminError(`Shopify avviste forespørselen (${res.status})`, res.status);
    }
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: unknown } | null;
    if (!res.ok || !body) throw new ShopifyAdminError(`Shopify svarte ${res.status}`, res.status);
    if (body.errors) {
      if (JSON.stringify(body.errors).toUpperCase().includes("THROTTLED")) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new ShopifyAdminError(`GraphQL-feil: ${JSON.stringify(body.errors).slice(0, 300)}`);
    }
    return body.data as T;
  }
  throw new ShopifyAdminError("Shopify: for mange forsøk (throttled)");
}

// ------------------------------------------------------------------ Lookups ------

export interface ShopifyVariantInfo {
  handle: string;
  productId: string;
  variantId: string;
  /** In øre, like the storefront's own prices. */
  price: number;
  available: boolean;
  inventoryItemId: string | null;
}

interface ProductsByHandleData {
  products: {
    nodes: Array<{
      id: string;
      handle: string;
      variants: {
        nodes: Array<{ id: string; price: string; availableForSale: boolean; inventoryItem: { id: string } | null }>;
      };
    }>;
  };
}

const PRODUCTS_BY_HANDLE = `
query($q: String!, $n: Int!) {
  products(first: $n, query: $q) {
    nodes {
      id
      handle
      variants(first: 50) { nodes { id price availableForSale inventoryItem { id } } }
    }
  }
}`;

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

/**
 * Resolve storefront handles to product/variant ids and the current price.
 * `variantIds` picks the saved variant when there is one; otherwise the first
 * variant that can be bought, like the storefront shows. Unknown handles are absent.
 */
export async function lookupHandles(
  wanted: Array<{ handle: string; variantId?: string | null }>,
): Promise<Map<string, ShopifyVariantInfo>> {
  const out = new Map<string, ShopifyVariantInfo>();
  const want = new Map(wanted.map((w) => [w.handle, w.variantId ?? null]));
  const handles = Array.from(want.keys());

  for (let i = 0; i < handles.length; i += 50) {
    const batch = handles.slice(i, i + 50);
    // Handles are [a-z0-9-] in Shopify, but quoting keeps a stray one from breaking the search.
    const q = batch.map((h) => `handle:"${h.replace(/["\\]/g, "")}"`).join(" OR ");
    const data = await shopifyGraphQL<ProductsByHandleData>(PRODUCTS_BY_HANDLE, { q, n: batch.length });
    for (const p of data.products.nodes) {
      if (!want.has(p.handle)) continue;
      const variants = p.variants.nodes;
      const savedId = want.get(p.handle);
      const v =
        variants.find((x) => savedId && numericId(x.id) === String(savedId)) ??
        variants.find((x) => x.availableForSale) ??
        variants[0];
      if (!v) continue;
      out.set(p.handle, {
        handle: p.handle,
        productId: numericId(p.id),
        variantId: numericId(v.id),
        price: Math.round(Number.parseFloat(v.price) * 100),
        available: v.availableForSale,
        inventoryItemId: v.inventoryItem ? numericId(v.inventoryItem.id) : null,
      });
    }
  }
  return out;
}

/** The customer's current email in Shopify, or null. */
export async function customerEmail(customerId: string): Promise<string | null> {
  const data = await shopifyGraphQL<{ customer: { defaultEmailAddress: { emailAddress: string } | null } | null }>(
    `query($id: ID!) { customer(id: $id) { defaultEmailAddress { emailAddress } } }`,
    { id: `gid://shopify/Customer/${customerId}` },
  );
  return data.customer?.defaultEmailAddress?.emailAddress?.toLowerCase() ?? null;
}

export interface ProductNow {
  productId: string;
  handle: string;
  title: string;
  imageUrl: string | null;
  /** Only an ACTIVE product can be bought; anything else counts as unavailable. */
  active: boolean;
  variants: Map<string, { price: number; compareAt: number | null; available: boolean; title: string }>;
  /** Variant ids in Shopify's order, so "the first one that can be bought" is stable. */
  order: string[];
}

interface NodesData {
  nodes: Array<{
    id: string;
    handle: string;
    title: string;
    status: string;
    featuredImage: { url: string } | null;
    variants: {
      nodes: Array<{ id: string; title: string; price: string; compareAtPrice: string | null; availableForSale: boolean }>;
    };
  } | null>;
}

const PRODUCTS_NOW = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id handle title status
      featuredImage { url }
      variants(first: 50) { nodes { id title price compareAtPrice availableForSale } }
    }
  }
}`;

/** Current price and stock for the given products. Deleted products are absent. */
export async function productsNow(productIds: string[]): Promise<Map<string, ProductNow>> {
  const out = new Map<string, ProductNow>();
  const ids = Array.from(new Set(productIds));
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100).map((id) => `gid://shopify/Product/${id}`);
    const data = await shopifyGraphQL<NodesData>(PRODUCTS_NOW, { ids: batch });
    for (const p of data.nodes) {
      if (!p || !p.id) continue;
      const variants = new Map<string, { price: number; compareAt: number | null; available: boolean; title: string }>();
      const order: string[] = [];
      for (const v of p.variants.nodes) {
        const id = numericId(v.id);
        order.push(id);
        variants.set(id, {
          price: Math.round(Number.parseFloat(v.price) * 100),
          compareAt: v.compareAtPrice ? Math.round(Number.parseFloat(v.compareAtPrice) * 100) : null,
          available: v.availableForSale,
          title: v.title,
        });
      }
      out.set(numericId(p.id), {
        productId: numericId(p.id),
        handle: p.handle,
        title: p.title,
        imageUrl: p.featuredImage?.url ?? null,
        active: p.status === "ACTIVE",
        variants,
        order,
      });
    }
  }
  return out;
}
