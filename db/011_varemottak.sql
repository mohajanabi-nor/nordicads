-- Varemottak: pricing a supplier shipment (import → cost → price → push to Shopify).
--
-- Additive: new tables only, plus one new value for event_log.source. Everything is
-- prefixed vm_ so it cannot be confused with the price-comparison tables (suppliers
-- is shared on purpose; products / product_aliases are NOT reused — they belong to the
-- price-comparison review queue and invoice matches would pollute it).
--
-- RLS is on with no policies, like every other table: only the service role reads or
-- writes, and the browser never talks to the database directly.

-- ============================================================ event_log ======

alter table event_log drop constraint event_log_source_check;
alter table event_log add constraint event_log_source_check check (source in (
  'sync', 'campaign', 'contacts', 'scheduler', 'config',
  'inbound', 'priser', 'worker', 'auth', 'wishlist', 'varemottak'
));

-- ============================================================ shipments ======

create table vm_shipments (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  supplier_id         uuid references suppliers(id),
  supplier_name       text not null,
  -- When the goods arrived. Drives Grønt Punkt (the report period) and purchase history.
  arrival_date        date,
  status              text not null default 'draft'
                        check (status in ('draft', 'review', 'pushed', 'archived')),
  -- NOK per one unit of each invoice currency in this shipment: {"PLN": 2.498, "EUR": 11}.
  rates               jsonb not null default '{}',
  freight_amount      numeric(14, 2),
  freight_currency    text not null default 'NOK',
  -- "markup": price = cost × (1 + value).  "margin": price = cost ÷ (1 − value).
  markup_mode         text not null default 'markup' check (markup_mode in ('markup', 'margin')),
  markup_value        numeric(6, 4) not null default 0.30,
  margin_threshold    numeric(6, 4) not null default 0.23,
  drink_packaging_nok numeric(8, 2) not null default 2,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index vm_shipments_created_idx on vm_shipments (created_at desc);
alter table vm_shipments enable row level security;

create table vm_invoices (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references vm_shipments(id) on delete cascade,
  invoice_no    text not null,
  invoice_date  date,
  currency      text not null,
  -- Storage paths (bucket "varemottak"). The spec file and the paper invoice.
  spec_file     text,
  pdf_file      text,
  -- What the paper invoice says, for invoice control.
  net_total     numeric(14, 2),
  vat_total     numeric(14, 2),
  gross_total   numeric(14, 2),
  net_weight_kg numeric(12, 3),
  -- Lines on the paper invoice that are costs, not goods: [{no,name,qty,unit,value}].
  extra_lines   jsonb not null default '[]',
  -- The result of invoice control: [{code,severity,text}].
  control       jsonb not null default '[]',
  warnings      jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  unique (shipment_id, invoice_no)
);
alter table vm_invoices enable row level security;

-- Every line as read from the file, before merging — the trail back to the source.
create table vm_invoice_lines (
  id              bigserial primary key,
  invoice_id      uuid not null references vm_invoices(id) on delete cascade,
  line_no         integer not null,
  idx             text not null,
  name            text not null default '',
  qty             numeric(14, 3) not null,
  unit            text not null check (unit in ('pcs', 'kilo')),
  cartons         numeric(14, 3),
  country         text not null default '',
  hs              text,
  net_weight_kg   numeric(14, 3),
  gross_weight_kg numeric(14, 3),
  line_value      numeric(16, 4),
  -- EANs from the file (one piece / the carton), digits only.
  ean             text,
  ean_box         text
);
create index vm_invoice_lines_invoice_idx on vm_invoice_lines (invoice_id);
alter table vm_invoice_lines enable row level security;

-- One row per product in the shipment (merged on article number) — the review screen's rows.
create table vm_lines (
  id                 uuid primary key default gen_random_uuid(),
  shipment_id        uuid not null references vm_shipments(id) on delete cascade,
  invoice_id         uuid references vm_invoices(id) on delete set null,
  position           integer not null default 0,
  currency           text not null,

  -- From the invoice
  idx                text not null,
  name               text not null default '',
  unit               text not null check (unit in ('pcs', 'kilo')),
  qty                numeric(14, 3) not null,
  cartons            numeric(14, 3),
  country            text not null default '',
  hs                 text,
  hs_fixed           boolean not null default false,
  net_weight_kg      numeric(14, 3),
  line_value         numeric(16, 4),
  ean                text,
  ean_box            text,
  unit_price         numeric(16, 4),
  -- Set when the same article number came at different prices: [{unitPrice,qty,lines}].
  price_conflict     jsonb,
  source_lines       integer[] not null default '{}',
  issues             jsonb not null default '[]',

  -- Match to Shopify
  match_status       text not null default 'unmatched'
                       check (match_status in ('matched', 'doubtful', 'unmatched')),
  match_via          text not null default 'none' check (match_via in ('link', 'tag', 'ean', 'none')),
  match_reason       text not null default '',
  match_candidates   jsonb not null default '[]',
  shopify_product_id text,
  -- The product as it was at import: status, title, vendor, productType, price, cost,
  -- image, tags. Frozen so "new vs restocked" cannot change after the goods are priced.
  shopify            jsonb,
  -- Existed as DRAFT before this shipment (new) rather than ACTIVE (restocked).
  is_new             boolean not null default false,
  mva25              boolean not null default false,
  -- VAT set by hand for this line (0.15 or 0.25); null = automatic.
  vat_rate           numeric(4, 3) check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 0.5)),
  -- Purchase history compared at import: {previous: {...}, change: {...}}. Frozen like shopify.
  history            jsonb,

  -- What the operator edits
  duty_per_kg        numeric(12, 4),
  -- Duty as a share of the goods value (0.19 = 19 %) for goods charged by value; used instead of duty_per_kg when set.
  duty_pct           numeric(6, 4) check (duty_pct is null or (duty_pct >= 0 and duty_pct <= 1)),
  -- Packaging per unit typed or declared for this row; null = automatic (the drink fee).
  packaging_nok      numeric(10, 4) check (packaging_nok is null or packaging_nok >= 0),
  duty_source        text,
  duty_source_kind   text check (duty_source_kind in ('declaration', 'cn8', 'product', 'hs6', 'estimate')),
  pcs_per_carton     integer,
  pcs_source         text,
  sales_unit_kg      numeric(10, 3),
  price_override     numeric(12, 2),
  -- When the article came at two prices, the one the operator picked.
  chosen_unit_price  numeric(16, 4),
  done               boolean not null default false,

  -- Push state
  pushed_at          timestamptz,
  pushed             jsonb,
  push_errors        jsonb,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Per invoice, so the same article on two invoices (even in two currencies) stays two rows.
  unique (shipment_id, invoice_id, idx)
);
create index vm_lines_shipment_idx on vm_lines (shipment_id, position);
create index vm_lines_product_idx on vm_lines (shipment_id, shopify_product_id);
alter table vm_lines enable row level security;

-- ====================================================== product memory ======

-- A pick the operator made in the match screen, so the next shipment is automatic.
create table vm_supplier_links (
  supplier           text not null,
  idx                text not null,
  shopify_product_id text not null,
  title              text not null default '',
  created_at         timestamptz not null default now(),
  primary key (supplier, idx)
);
alter table vm_supplier_links enable row level security;

-- Things set once per Shopify product and remembered.
create table vm_product_settings (
  shopify_product_id text primary key,
  -- Kg products sold per box: the box size in kg.
  sales_unit_kg      numeric(10, 3),
  -- Grønt Punkt: the packaging code, and for plastic bottles the packaging weight per bottle.
  gp_code            text,
  gp_packaging_kg    numeric(10, 5),
  updated_at         timestamptz not null default now()
);
alter table vm_product_settings enable row level security;

-- Which column of a supplier's file is which, chosen once in the import screen and reused.
create table vm_supplier_mappings (
  supplier   text primary key,
  mapping    jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table vm_supplier_mappings enable row level security;

-- ========================================================= registers ======

-- Customs register: duty NOK per kg, so the same rate is never typed twice. Lookup order
-- (never guessed from a name): declaration CN8 → same product earlier → declaration HS6.
create table vm_customs_rates (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('cn8', 'product', 'hs6')),
  cn8         text,
  hs6         text,
  supplier    text,
  idx         text,
  title_key   text,
  duty_per_kg numeric(12, 4) not null,
  -- A product rate charged on the goods value instead (0.19 = 19 %); duty_per_kg is then 0 and not used.
  duty_pct    numeric(6, 4) check (duty_pct is null or (duty_pct >= 0 and duty_pct <= 1)),
  -- A declaration always overrides an estimate.
  source_kind text not null check (source_kind in ('declaration', 'estimate')),
  -- Declaration number, or "typed by us, estimate".
  source_ref  text not null,
  source_date date not null default current_date,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index vm_customs_cn8_idx on vm_customs_rates (cn8) where scope = 'cn8';
create index vm_customs_product_idx on vm_customs_rates (supplier, idx) where scope = 'product';
create index vm_customs_hs6_idx on vm_customs_rates (hs6) where scope = 'hs6';
alter table vm_customs_rates enable row level security;

create table vm_declarations (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  declared_at date,
  file        text,
  -- A draft declaration is replaced when the final one is uploaded.
  status      text not null default 'final' check (status in ('draft', 'final')),
  -- [{cn8, dutyNok, netWeightKg, dutyPerKg}]
  items       jsonb not null default '[]',
  created_by  text,
  created_at  timestamptz not null default now()
);
alter table vm_declarations enable row level security;

-- Purchase price history: per supplier + article number, per shipment.
create table vm_price_history (
  id            bigserial primary key,
  supplier      text not null,
  idx           text not null,
  currency      text not null,
  unit_price    numeric(16, 4) not null,
  cost_incl_vat numeric(14, 4),
  -- Our price per unit (productType) when this shipment was priced, so the next shipment
  -- can tell whether a supplier increase came with an unchanged shop price.
  our_price     numeric(12, 2),
  invoice_no    text,
  occurred_on   date not null,
  shipment_id   uuid references vm_shipments(id) on delete cascade,
  created_at    timestamptz not null default now()
);
alter table vm_price_history add constraint vm_price_history_unique unique (shipment_id, supplier, idx);
create index vm_price_history_lookup_idx on vm_price_history (supplier, idx, occurred_on desc);
alter table vm_price_history enable row level security;

-- ======================================================== push log ======

create table vm_push_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  shipment_id uuid references vm_shipments(id) on delete set null,
  line_id     uuid,
  product_id  text,
  -- The signed-in account (a shared login, so this is the account, not the person).
  by_user     text,
  mode        text not null check (mode in ('dry-run', 'fake', 'live')),
  -- What was sent, what it replaced (for a manual rollback), and what came back.
  request     jsonb,
  previous    jsonb,
  result      jsonb
);
create index vm_push_log_at_idx on vm_push_log (at desc);
create index vm_push_log_shipment_idx on vm_push_log (shipment_id, at desc);
alter table vm_push_log enable row level security;

-- ============================================================ Grønt Punkt ======

-- Packaging categories the client reports. Editable in the app: a new category needs no code change.
create table vm_gp_categories (
  code     text primary key,
  name     text not null,
  unit     text not null check (unit in ('kg', 'pcs')),
  sort     integer not null default 0,
  archived boolean not null default false
);
alter table vm_gp_categories enable row level security;

-- Rates change ("gjeldende priser"), so they carry a valid-from date.
create table vm_gp_rates (
  code       text not null references vm_gp_categories(code) on delete cascade,
  valid_from date not null,
  rate       numeric(10, 4) not null,
  primary key (code, valid_from)
);
alter table vm_gp_rates enable row level security;

insert into vm_gp_categories (code, name, unit, sort) values
  ('1017', 'Flasker av plast - drikkevare', 'kg', 10),
  ('2001', 'Drikkekartong - drikkevare', 'pcs', 20),
  ('4005', 'Glass drikkevare 0-250 ml', 'pcs', 30),
  ('5020', 'Aluminium drikkevare 251-500 ml', 'pcs', 40);

insert into vm_gp_rates (code, valid_from, rate) values
  ('1017', '2026-01-01', 6.0000),
  ('2001', '2026-01-01', 0.1800),
  ('4005', '2026-01-01', 0.4640),
  ('5020', '2026-01-01', 0.1800);
