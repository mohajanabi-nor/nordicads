/**
 * Logged-in customers' wishlists, and their consent to alert emails.
 *
 * Every function takes the customer id the App Proxy signed (see verifyAppProxy);
 * nothing here accepts an identity from the storefront.
 *
 * Server-only.
 */
import { eq, inList, sbDelete, sbInsert, sbSelect, sbSelectOne, sbUpdate } from "./supabase";
import { customerEmail, lookupHandles } from "./shopify-admin";
import { logInfo } from "./eventlog";
import { maskEmail } from "./resend";

/** A list longer than this is someone scripting the endpoint, not shopping. */
export const MAX_ITEMS = 300;

/** Shopify handles are lowercase letters, digits and dashes; allow a little slack. */
const HANDLE_RE = /^[a-z0-9][a-z0-9\-_.]{0,254}$/i;

export function validHandle(h: unknown): h is string {
  return typeof h === "string" && HANDLE_RE.test(h);
}

interface CustomerRow {
  customer_id: string;
  email: string | null;
  alerts_opt_in: boolean;
}

interface ItemRow {
  handle: string;
  variant_id: string | null;
  added_at: string;
}

export interface WishlistState {
  items: Array<{ handle: string; variantId: string | null; addedAt: string }>;
  alerts: { optIn: boolean };
}

/** Make sure the customer has a row; the email is filled in from Shopify on first sight. */
async function ensureCustomer(customerId: string): Promise<CustomerRow> {
  const existing = await sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) });
  if (existing) return existing;
  const email = await customerEmail(customerId).catch(() => null);
  await sbInsert("wishlist_customers", { customer_id: customerId, email }, { onConflict: "customer_id", ignoreDuplicates: true });
  return (await sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) }))!;
}

export async function getState(customerId: string): Promise<WishlistState> {
  const [customer, items] = await Promise.all([
    sbSelectOne<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) }),
    sbSelect<ItemRow>("wishlist_items", {
      customer_id: eq(customerId),
      select: "handle,variant_id,added_at",
      order: "added_at.desc",
      limit: MAX_ITEMS,
    }),
  ]);
  return {
    items: items.map((i) => ({ handle: i.handle, variantId: i.variant_id, addedAt: i.added_at })),
    alerts: { optIn: customer?.alerts_opt_in ?? false },
  };
}

/**
 * Save items. Existing ones are left untouched, so re-saving never resets the
 * price a product was saved at (which is what a later price drop is measured from).
 * Handles Shopify doesn't know are skipped.
 */
export async function addItems(
  customerId: string,
  wanted: Array<{ handle: string; variantId?: string | null; addedAt?: string | null }>,
): Promise<void> {
  if (!wanted.length) return;
  await ensureCustomer(customerId);

  const current = await sbSelect<{ handle: string }>("wishlist_items", {
    customer_id: eq(customerId),
    select: "handle",
  });
  const have = new Set(current.map((c) => c.handle));
  const fresh = wanted.filter((w) => !have.has(w.handle)).slice(0, Math.max(0, MAX_ITEMS - have.size));
  if (!fresh.length) return;

  const info = await lookupHandles(fresh);
  const rows = fresh
    .filter((w) => info.has(w.handle))
    .map((w) => {
      const i = info.get(w.handle)!;
      const added = w.addedAt && !Number.isNaN(Date.parse(w.addedAt)) ? new Date(w.addedAt) : new Date();
      return {
        customer_id: customerId,
        handle: w.handle,
        product_id: i.productId,
        variant_id: i.variantId,
        price_at_save: i.price,
        available_at_save: i.available,
        inventory_item_id: i.inventoryItemId,
        // The alert check starts from what the customer saw when saving.
        baseline_price: i.price,
        last_price: i.price,
        last_available: i.available,
        checked_at: new Date().toISOString(),
        // A date from the browser is only kept if it's plausible; never in the future.
        added_at: (added.getTime() > Date.now() ? new Date() : added).toISOString(),
      };
    });
  if (rows.length) {
    await sbInsert("wishlist_items", rows, { onConflict: "customer_id,handle", ignoreDuplicates: true });
  }
}

export async function removeItems(customerId: string, handles: string[]): Promise<void> {
  if (!handles.length) return;
  await sbDelete("wishlist_items", { customer_id: eq(customerId), handle: inList(handles) });
}

/**
 * Turn alert emails on or off.
 *
 * Opting in refreshes the email from Shopify, since that is the address the
 * customer is consenting for. Both directions are logged: a consent change with
 * no record can't be shown later to have been the customer's own choice.
 */
export async function setAlerts(
  customerId: string,
  change: { optIn: boolean },
): Promise<WishlistState["alerts"]> {
  const before = await ensureCustomer(customerId);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { updated_at: now };

  let email = before.email;
  if (change.optIn === true && !before.alerts_opt_in) {
    email = (await customerEmail(customerId)) ?? before.email;
    if (!email) throw new Error("Fant ingen e-postadresse på kontoen");
    Object.assign(patch, { alerts_opt_in: true, opt_in_at: now, email });
  } else if (change.optIn === false && before.alerts_opt_in) {
    Object.assign(patch, { alerts_opt_in: false, opt_out_at: now });
  }

  const [after] = await sbUpdate<CustomerRow>("wishlist_customers", { customer_id: eq(customerId) }, patch);

  if (after && after.alerts_opt_in !== before.alerts_opt_in) {
    await logInfo(
      "wishlist",
      after.alerts_opt_in ? "wishlist.optIn" : "wishlist.optOut",
      after.alerts_opt_in
        ? `${maskEmail(email ?? "")} slo på varsler for ønskelisten.`
        : `${maskEmail(email ?? "")} slo av varsler for ønskelisten.`,
      { customerId, source: "storefront" },
    );
  }
  return { optIn: after?.alerts_opt_in ?? before.alerts_opt_in };
}
