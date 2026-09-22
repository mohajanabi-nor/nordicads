/** Shared client/server types (no Node imports — safe to use in components). */

export interface DropSummary {
  dir: string;
  createdAt: string;
  pdf: string | null;
  reels: string[];
  assetCount: number;
}

export interface BaselineStatus {
  store_domain: string;
  output_dir: string;
  baseline: {
    is_first_run: boolean;
    last_run: { id: number; ts: string; item_count: number } | null;
  };
  config: { new_window_days: number; restock_window_days: number };
}

/** SSE step transition from /api/generate. */
export interface StepEvent {
  key: string;
  label: string;
  status: "active" | "done";
}

/** Payload of any SSE frame from /api/generate, /api/select or a campaign send.
 *  Every field is optional: which ones are set depends on the event name (log /
 *  step / progress / done / error), and the JSON comes off the wire, so nothing
 *  is guaranteed. */
export interface RunEvent {
  line?: string;
  key?: string;
  label?: string;
  status?: StepEvent["status"];
  drop?: string | null;
  assets?: number;
  message?: string;
  // ---- campaign send (event: "progress" / "done") ----
  campaignId?: string;
  sent?: number;
  failed?: number;
  skipped?: number;
  total?: number;
  /** Masked address currently being sent to, e.g. "k***@bedrift.no". */
  current?: string;
  durationMs?: number;
}

/** A store product as served to the picker by /api/products. */
export interface PickerProduct {
  id: string;
  title: string;
  vendor: string;
  price_label: string;
  image_url: string | null;
  inventory_quantity: number;
  in_stock: boolean;
  country_code: string | null;
  /** Norwegian country name for country_code, as the reels print it ("POLEN"). */
  country_name_no?: string | null;
  collections: string[];
  created_at: string | null;
  updated_at: string | null;
  /** Most recent inventory-level change time (restock/adjustment). */
  inventory_updated_at: string | null;
  /** Units added vs the last snapshot baseline (>=0), or null if no baseline. */
  restock_increase: number | null;
  is_offer: boolean;
}

export interface ProductsResponse {
  store_domain: string;
  count: number;
  products: PickerProduct[];
}

// ---------------------------------------------------------------- e-post ----

/** One person in the local contact list (synced from Shopify, or CSV-imported).
 *  `email` is lowercased and is the primary key — see lib/contacts.ts. */
export interface Contact {
  email: string;
  /** Shopify customer GID. Matching on this first is what lets a customer change
   *  their email in Shopify without becoming two contacts here. Null for
   *  manually added or CSV-imported rows that were never matched to Shopify. */
  shopifyId: string | null;
  name: string;
  company: string;
  city: string;
  /** The subscribe checkbox. false = never mail this person. */
  subscribed: boolean;
  /** Address is malformed and can never be sent to. Kept visible rather than
   *  dropped, so a typo in Shopify is something you can see and fix. */
  invalidEmail: boolean;
  /** Not present in the last COMPLETE Shopify sync. */
  missingInShopify: boolean;
  lastSeenInShopifyAt: string | null;
  /** Permanent rejections by Resend — the only bounce signal we get. */
  failureCount: number;
  /** ISO timestamp of when this contact first entered the list. */
  addedAt: string;
  /** Where it came from, e.g. "shopify-2026-09-10" or "manual". */
  source: string;
  /** ISO timestamp of the last campaign this address was sent, if any. */
  lastSentAt: string | null;
  note: string;
}

export type ContactFilter = "alle" | "abonnerer" | "avmeldt" | "ugyldig" | "borte";

export interface ContactStats {
  count: number;
  subscribed: number;
  unsubscribed: number;
  invalid: number;
  missing: number;
  /** Who a campaign would actually reach right now. */
  mailable: number;
}

export interface ContactsResponse extends ContactStats {
  contacts: Contact[];
  page: number;
  pageSize: number;
  /** Rows matching the current search/filter, across all pages. */
  total: number;
  totalPages: number;
  sync: SyncStatus;
}

/** State of the automatic Shopify sync, shown above the contact list. */
export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  lastSyncAt: string | null;
  lastResult: string | null;
  nextDueAt: string | null;
  intervalHours: number;
}

/** A past campaign, as listed on the e-post page. Mirrors the server's
 *  CampaignSummary in lib/campaign-store.ts (kept here so components can import
 *  it without pulling in Node-only code). */
export interface CampaignSummaryView {
  id: string;
  createdAt: string;
  subject: string;
  headline: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  dryRun: boolean;
  attachmentName: string | null;
}

/** Result of a CSV import or a Shopify sync, as shown on the contacts screen.
 *  The counts are meant to RECONCILE against what Shopify returned — that is how
 *  "nothing was skipped silently" becomes arithmetic rather than a claim. */
export interface ImportResult {
  added: number;
  skippedExisting: number;
  /** Malformed addresses — added anyway, flagged, never mailable. */
  flaggedInvalid: number;
  /** Customers Shopify holds with no email at all: nothing to key a contact on,
   *  so they are logged individually instead. */
  noEmail: number;
  /** Which consent column was found, or null when none was present. */
  consentColumn: string | null;
  /** Of the newly added, how many came in as NOT subscribed. */
  addedUnsubscribed: number;
  /** Existing contacts unsubscribed because Shopify no longer consents. */
  unsubscribedByShopify?: number;
  /** Contacts whose address changed in Shopify, matched by shopifyId. */
  emailChanged?: number;
  /** Contacts absent from a COMPLETE sync — flagged and unsubscribed. */
  markedMissing?: number;
  /** Set when the completeness guard refused to flag anything. */
  incomplete?: boolean;
  /** Human-readable Norwegian summary lines for the UI. */
  notes: string[];
}

export interface LogEntryView {
  at: string;
  level: "info" | "warn" | "error";
  source: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogsResponse {
  entries: LogEntryView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  errorCount: number;
}
