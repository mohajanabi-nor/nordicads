-- Nordic Engros — initial Postgres schema (Supabase).
--
-- Replaces what used to be local files on one machine:
--   contacts.json          -> contacts
--   campaigns/<id>/…       -> campaigns + campaign_recipients
--   logs/YYYY-MM.ndjson    -> event_log
--   logs/last-seen.json    -> app_state
--   worker/state/*.sqlite3 -> snapshot_runs + snapshot_run_items + latest_inventory
-- and adds the supplier price-comparison feature's own tables.
--
-- Apply by pasting into the Supabase SQL editor, or `psql -f db/001_init.sql`.
--
-- Access model: every table has RLS enabled with NO policies. Both services
-- reach Postgres with the service_role key, which bypasses RLS entirely. The
-- empty-policy state is deliberate defence-in-depth — if the anon key ever ends
-- up in client code by accident, it reads nothing rather than everything.

create extension if not exists pg_trgm;

-- Append-only tables use this instead of relying on application discipline:
-- history that cannot be rewritten is worth more than history we promise not to
-- rewrite. Campaigns in particular MUST be immutable — a resumed send re-reads
-- the manifest, so an edited manifest would silently change what later
-- recipients receive versus earlier ones.
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op;
end;
$$;


-- ============================================================ contacts ======

create table contacts (
  email                   text primary key,
  shopify_id              text unique,
  name                    text not null default '',
  company                 text not null default '',
  city                    text not null default '',
  subscribed              boolean not null default true,
  invalid_email           boolean not null default false,
  missing_in_shopify      boolean not null default false,
  last_seen_in_shopify_at timestamptz,
  failure_count           integer not null default 0,
  added_at                timestamptz not null default now(),
  source                  text not null default 'manual',
  last_sent_at            timestamptz,
  note                    text not null default ''
);

-- The contact list is filtered by these flags on every page load.
create index contacts_subscribed_idx on contacts (subscribed);
create index contacts_flags_idx on contacts (invalid_email, missing_in_shopify);
-- Free-text search across the three fields the UI searches.
create index contacts_search_idx on contacts
  using gin ((email || ' ' || name || ' ' || company) gin_trgm_ops);

alter table contacts enable row level security;


-- =========================================================== campaigns ======

create table campaigns (
  id              text primary key check (id ~ '^[a-z0-9-]{8,64}$'),
  created_at      timestamptz not null default now(),
  subject         text not null,
  headline        text not null,
  -- The exact rendered message, frozen at creation so a resume cannot drift.
  body_html       text not null,
  body_text       text not null,
  -- The recipient list as it was at send time, order preserved.
  recipients      jsonb not null,
  drop_dir        text,
  attachment_name text,
  dry_run         boolean not null default false
);

create index campaigns_created_at_idx on campaigns (created_at desc);

create trigger campaigns_immutable
  before update or delete on campaigns
  for each row execute function forbid_mutation();

alter table campaigns enable row level security;


create table campaign_recipients (
  id          bigserial primary key,
  campaign_id text not null references campaigns (id),
  email       text not null,
  status      text not null check (status in ('sent', 'failed', 'skipped')),
  at          timestamptz not null default now(),
  resend_id   text,
  error       text,
  attempt     integer not null default 1
);

-- Resume asks "which addresses already have a terminal outcome?" on every run.
create index campaign_recipients_lookup_idx on campaign_recipients (campaign_id, email);

create trigger campaign_recipients_immutable
  before update or delete on campaign_recipients
  for each row execute function forbid_mutation();

alter table campaign_recipients enable row level security;


-- =========================================================== event_log ======

create table event_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  level   text not null check (level in ('info', 'warn', 'error')),
  -- Extend this list when a new subsystem starts logging; a CHECK is used rather
  -- than an enum precisely so that is a one-line ALTER.
  source  text not null check (source in (
            'sync', 'campaign', 'contacts', 'scheduler', 'config',
            'inbound', 'priser', 'worker', 'auth'
          )),
  event   text not null,
  message text not null,
  data    jsonb
);

create index event_log_at_idx on event_log (at desc);
create index event_log_level_at_idx on event_log (level, at desc);
create index event_log_source_at_idx on event_log (source, at desc);

alter table event_log enable row level security;


create table app_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_state enable row level security;


-- ==================================================== worker snapshot =======
-- Ported from the worker's local SQLite store. It moves into Postgres because
-- the worker's new host has no persistent disk — local state there does not
-- survive a redeploy, and losing the baseline means every product looks like a
-- restock on the next run.

create table snapshot_runs (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  item_count integer not null
);

create table snapshot_run_items (
  run_id   bigint not null references snapshot_runs (id) on delete cascade,
  sku      text not null,
  quantity integer not null,
  primary key (run_id, sku)
);

create table latest_inventory (
  sku        text primary key,
  quantity   integer not null,
  updated_at timestamptz not null default now()
);

alter table snapshot_runs enable row level security;
alter table snapshot_run_items enable row level security;
alter table latest_inventory enable row level security;


-- =========================================================== suppliers ======

create table suppliers (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  slug                   text not null unique,
  -- Lowercased addresses and/or '@domain' wildcards. Inbound mail is attributed
  -- to a supplier by matching its From: against these.
  known_sender_addresses text[] not null default '{}',
  contact_note           text not null default '',
  archived               boolean not null default false,
  created_at             timestamptz not null default now()
);

alter table suppliers enable row level security;


create table supplier_emails (
  id              uuid primary key default gen_random_uuid(),
  -- Resend's id for the received message. Unique so a redelivered webhook is a
  -- no-op insert rather than a second extraction.
  resend_email_id text not null unique,
  -- Null until attributed; an unrecognised sender is itself a review item.
  supplier_id     uuid references suppliers (id),
  from_address    text not null,
  from_name       text,
  to_address      text not null,
  subject         text,
  received_at     timestamptz not null,
  status          text not null default 'received' check (status in (
                    'received',          -- stored, not yet processed
                    'processing',        -- claimed by a cron run
                    'processed',         -- extracted and matched
                    'awaiting_review',   -- parsed, but a human must confirm something
                    'extraction_failed', -- could not be read; retryable from the UI
                    'ignored'            -- deliberately not a price email
                  )),
  error_message   text,
  webhook_payload jsonb,
  processed_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- The cron poller's hot query: oldest unprocessed first.
create index supplier_emails_status_idx on supplier_emails (status, received_at);
create index supplier_emails_supplier_idx on supplier_emails (supplier_id, received_at desc);

alter table supplier_emails enable row level security;


create table email_attachments (
  id                  uuid primary key default gen_random_uuid(),
  supplier_email_id   uuid not null references supplier_emails (id) on delete cascade,
  resend_attachment_id text,
  filename            text not null,
  content_type        text,
  size_bytes          integer,
  storage_bucket      text not null default 'supplier-emails',
  storage_path        text not null unique,
  kind                text check (kind in (
                        'pdf', 'excel', 'csv', 'image', 'html_body', 'text_body', 'other'
                      )),
  downloaded_at       timestamptz,
  created_at          timestamptz not null default now()
);

create index email_attachments_email_idx on email_attachments (supplier_email_id);

alter table email_attachments enable row level security;


-- Every extraction attempt lands here, successful or not. This is the audit
-- trail that makes "nothing was silently dropped" checkable rather than claimed,
-- and it is what lets a retry skip the attachments that already succeeded.
create table price_extractions (
  id                uuid primary key default gen_random_uuid(),
  supplier_email_id uuid not null references supplier_emails (id) on delete cascade,
  -- Null when the prices came from the email body rather than an attachment.
  attachment_id     uuid references email_attachments (id) on delete cascade,
  method            text not null check (method in (
                      'claude_vision_pdf', 'claude_vision_image',
                      'csv_parse', 'xlsx_parse', 'claude_normalize_text'
                    )),
  model             text,
  raw_response      jsonb,
  extracted_rows    jsonb not null default '[]'::jsonb,
  row_count         integer not null default 0,
  confidence        numeric(3, 2),
  status            text not null check (status in ('ok', 'partial', 'failed')),
  error_message     text,
  created_at        timestamptz not null default now()
);

create index price_extractions_email_idx on price_extractions (supplier_email_id);
create index price_extractions_attachment_idx on price_extractions (attachment_id)
  where attachment_id is not null;

alter table price_extractions enable row level security;


-- ============================================================ products ======

create table products (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,
  normalized_name text not null,
  category        text,
  -- The unit prices are normalised to for ranking ('kg', 'l', 'stk'), when known.
  base_unit       text,
  shopify_product_id text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Candidate lookup for the fuzzy matching pass.
create index products_normalized_trgm_idx on products using gin (normalized_name gin_trgm_ops);

alter table products enable row level security;


-- How one supplier refers to a product. Doubles as the manual-review queue:
-- anything with product_id null or needs_review true is awaiting a human.
create table product_aliases (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references suppliers (id) on delete cascade,
  supplier_sku    text,
  raw_name        text not null,
  normalized_name text not null,
  product_id      uuid references products (id),
  match_method    text check (match_method in (
                    'exact_sku',        -- same supplier reused their own SKU
                    'normalized_name',  -- same supplier reused their own wording
                    'cross_supplier',   -- another supplier's identical wording (suggestion only)
                    'claude_fuzzy',
                    'manual'
                  )),
  confidence      numeric(3, 2) not null default 0,
  needs_review    boolean not null default false,
  ignored         boolean not null default false,
  -- Claude's proposal, kept so review is a one-click confirm, not re-entry.
  suggested_name  text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A supplier's SKU identifies a product; where there is no SKU, their exact
-- wording does. Partial indexes because only one of the two applies per row.
create unique index product_aliases_sku_idx on product_aliases (supplier_id, supplier_sku)
  where supplier_sku is not null;
create unique index product_aliases_name_idx on product_aliases (supplier_id, normalized_name)
  where supplier_sku is null;
create index product_aliases_review_idx on product_aliases (needs_review)
  where needs_review or product_id is null;
create index product_aliases_product_idx on product_aliases (product_id);

alter table product_aliases enable row level security;


-- ================================================== price observations ======
-- Append-only ledger. Never updated: a new price is a new row, which is what
-- makes price history answerable later for free.

create table price_observations (
  id                  uuid primary key default gen_random_uuid(),
  supplier_id         uuid not null references suppliers (id),
  product_id          uuid not null references products (id),
  alias_id            uuid references product_aliases (id),
  price_extraction_id uuid references price_extractions (id),
  supplier_email_id   uuid references supplier_emails (id),

  price               numeric(12, 2) not null,
  currency            text not null default 'NOK',
  -- Whether the figure includes VAT decides whether two prices are comparable at
  -- all. Extracted explicitly; 'unknown' is a real answer, not a failure.
  vat_basis           text not null default 'unknown'
                        check (vat_basis in ('eks_mva', 'inkl_mva', 'unknown')),
  -- True when vat_basis was inferred from convention rather than stated in the
  -- document, so the UI can show it as an assumption instead of a fact.
  vat_basis_assumed   boolean not null default false,

  unit                text,
  pack_size           text,
  -- Populated only when unit/pack_size parsed cleanly into products.base_unit.
  -- Null means "not comparable by unit price" — the UI flags it rather than
  -- ranking on a number derived from a guess.
  base_unit           text,
  price_per_base_unit numeric(14, 4),

  -- When this price takes effect, per the document. Ranking uses this (falling
  -- back to the email's date) rather than insertion order, so a price list that
  -- arrives late cannot override a newer one just by being processed second.
  valid_from          date,
  observed_at         timestamptz not null default now(),
  raw_row             jsonb,
  created_at          timestamptz not null default now()
);

-- The comparison grid picks the current price per (product, supplier).
create index price_observations_current_idx
  on price_observations (product_id, supplier_id, valid_from desc nulls last, observed_at desc);
create index price_observations_supplier_idx on price_observations (supplier_id, observed_at desc);

create trigger price_observations_immutable
  before update or delete on price_observations
  for each row execute function forbid_mutation();

alter table price_observations enable row level security;
