-- The storefront wishlist ("Ønskeliste") on nordicengros.com.
--
-- The hearts and the list page live in the theme (shopify-theme/snippets/onskeliste.liquid).
-- A guest's list stays in their browser; a logged-in customer's list is kept here so it
-- follows them across devices and so price-drop / back-in-stock emails can be sent.
--
-- Requests arrive through Shopify's App Proxy (/apps/onskeliste → /api/storefront/wishlist),
-- which signs the logged-in customer's id. That signed id is the only identity used: the
-- storefront never tells us who someone is, and the email is looked up from Shopify.

-- ======================================================== wishlist_customers ======

create table wishlist_customers (
  -- Shopify's numeric customer id, as the proxy sends it ("10157414187200").
  customer_id    text primary key,
  -- Looked up from Shopify, never taken from the browser. Refreshed on opt-in.
  email          text,
  -- Consent to alert emails. Off until the customer ticks the box on the wishlist
  -- page: saving an item is not consent to be emailed about it.
  alerts_opt_in  boolean not null default false,
  opt_in_at      timestamptz,
  opt_out_at     timestamptz,
  -- Unused: a weekly-summary option was planned and dropped (every alert is instant).
  frequency      text not null default 'instant' check (frequency in ('instant', 'weekly')),
  -- When the last alert email went out. Changes that land shortly after one are held
  -- and sent together by the hourly run, so a busy afternoon isn't five emails.
  last_alert_at  timestamptz,
  -- For the unsubscribe link in alert emails, which has to work without a login.
  token          text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index wishlist_customers_opt_in_idx on wishlist_customers (alerts_opt_in) where alerts_opt_in;

alter table wishlist_customers enable row level security;


-- ============================================================ wishlist_items ======

create table wishlist_items (
  customer_id       text not null references wishlist_customers (customer_id) on delete cascade,
  -- The storefront identifies products by handle; ids are resolved from Shopify when
  -- the item is saved, so the alert check can fetch them directly later.
  handle            text not null,
  product_id        text,
  variant_id        text,
  -- What the customer saw when they saved it, in øre. The first price-drop is
  -- measured against this.
  price_at_save     integer,
  available_at_save boolean,
  -- Stock webhooks name an inventory item, not a product; kept so they can be matched
  -- to a saved item without asking Shopify.
  inventory_item_id text,
  -- The price a drop is measured against: the saved price, then the last price we
  -- emailed about. Only moves down, so one drop is never announced twice and a price
  -- that goes up and back down isn't news.
  baseline_price    integer,
  last_price        integer,
  -- Last known stock state. Back-in-stock is the change from false to true.
  last_available    boolean,
  -- When this customer was last EMAILED that it's back; the one-week limit counts from here.
  last_back_in_stock_at timestamptz,
  checked_at        timestamptz,
  added_at          timestamptz not null default now(),
  primary key (customer_id, handle)
);

-- The alert check looks up everyone who saved a given product, or inventory item.
create index wishlist_items_product_idx on wishlist_items (product_id);
create index wishlist_items_inventory_idx on wishlist_items (inventory_item_id);

alter table wishlist_items enable row level security;


-- ========================================================== wishlist_events ======

-- Each detected change for one customer, and what happened to it. Emailed straight
-- away, or with the hourly run if it lands within half an hour of the last alert.
create table wishlist_events (
  id           bigserial primary key,
  customer_id  text not null references wishlist_customers (customer_id) on delete cascade,
  handle       text not null,
  product_id   text,
  kind         text not null check (kind in ('price_drop', 'back_in_stock')),
  old_price    integer,
  new_price    integer,
  detected_at  timestamptz not null default now(),
  -- pending: waiting to be sent · sent · skipped: not sent, see note ·
  -- held: looked like a mistake (e.g. price cut by more than 70 %), needs a human
  status       text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'held')),
  sent_at      timestamptz,
  resend_id    text,
  note         text
);

create index wishlist_events_pending_idx on wishlist_events (customer_id) where status = 'pending';

alter table wishlist_events enable row level security;


-- ================================================================ event_log ======

-- Opt-ins and opt-outs are consent changes and are logged like the contact ones.
alter table event_log drop constraint event_log_source_check;
alter table event_log add constraint event_log_source_check check (source in (
  'sync', 'campaign', 'contacts', 'scheduler', 'config',
  'inbound', 'priser', 'worker', 'auth', 'wishlist'
));
