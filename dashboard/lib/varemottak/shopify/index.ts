/**
 * Which Shopify Varemottak talks to.
 *
 *   SHOPIFY_FAKE=1   → the in-memory fake, seeded from a read-only snapshot (local dev)
 *   otherwise        → the live store (reads always; writes only with VAREMOTTAK_LIVE_WRITES=1)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakeShopify } from "./fake";
import { LiveShopify } from "./live";
import type { ShopProduct, ShopifyPort } from "./types";

export * from "./types";
export { FakeShopify } from "./fake";
export { liveWritesEnabled } from "./live";

const STATE_FILE = path.join(process.cwd(), ".data", "fake-shopify.json");
// The whole-catalogue copy when there is one (any supplier's products can be matched against it); the small
// copy of one invoice's products is only the fallback.
const FULL_SNAPSHOT = path.join(process.cwd(), "..", "fwter", "shopify-snapshot-all.json");
const SMALL_SNAPSHOT = path.join(process.cwd(), "..", "fwter", "shopify-snapshot.json");
const SNAPSHOT_FILE = process.env.FAKE_SHOPIFY_SNAPSHOT || (existsSync(FULL_SNAPSHOT) ? FULL_SNAPSHOT : SMALL_SNAPSHOT);

// The fake lives on globalThis: in development Next can load this module once per route, and separate copies
// would each hold (and save) their own state, so a price pushed in one route would be missing in the next.
const shared = globalThis as unknown as { __varemottakFakeShopify?: FakeShopify | null };
let live: LiveShopify | null = null;

export const fakeShopifyEnabled = () => process.env.SHOPIFY_FAKE === "1";

function loadFake(): FakeShopify {
  if (shared.__varemottakFakeShopify) return shared.__varemottakFakeShopify;
  let fake: FakeShopify;
  const save = (state: unknown) => {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  };
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { products: ShopProduct[]; stock: Record<string, number> };
    fake = new FakeShopify(state.products, state.stock).persistTo(save);
  } else if (existsSync(SNAPSHOT_FILE)) {
    // Faithful by default: the real statuses, prices, costs and stock exactly as read from the shop. The
    // synthetic-DRAFT mode (every 5th product turned into a placeholder draft) is for tests only.
    const synthetic = process.env.FAKE_SHOPIFY_SYNTHETIC_DRAFTS === "1";
    fake = FakeShopify.fromSnapshot(JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")), { draftEvery: synthetic ? 5 : 0 }).persistTo(save);
    save(fake.dump());
  } else {
    throw new Error(`SHOPIFY_FAKE=1, men ingen øyeblikksbilde finnes (${SNAPSHOT_FILE}). Kjør scripts/snapshot-shopify.mjs.`);
  }
  shared.__varemottakFakeShopify = fake;
  return fake;
}

/** Forget the fake's state, so the next call re-seeds it from the snapshot. */
export function resetFakeShopify() {
  shared.__varemottakFakeShopify = null;
}

export function getShopify(): ShopifyPort {
  if (fakeShopifyEnabled()) return loadFake();
  return (live ??= new LiveShopify());
}
