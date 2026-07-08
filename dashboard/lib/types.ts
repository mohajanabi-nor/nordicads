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
