-- The picker's product list.
--
-- Fetching the catalogue from Shopify takes 20-35 seconds, which is why the
-- route already cached it in memory. On a serverless host that cache dies with
-- the invocation, and the fetch itself cannot run there at all — it is a Python
-- command talking to Shopify's GraphQL API.
--
-- So the runner fetches and writes here, and the picker reads. The page then
-- loads instantly instead of waiting on a cold fetch, with an explicit refresh
-- for the moment you HAVE just edited something in Shopify and want to see it.

create table shopify_products (
  id                   text primary key,
  title                text not null default '',
  vendor               text not null default '',
  price_label          text not null default '',
  image_url            text,
  inventory_quantity   integer not null default 0,
  in_stock             boolean not null default false,
  country_code         text,
  country_name_no      text,
  collections          jsonb not null default '[]'::jsonb,
  created_at           timestamptz,
  updated_at           timestamptz,
  inventory_updated_at timestamptz,
  restock_increase     integer,
  is_offer             boolean not null default false,
  -- When this row was last written by a fetch. The picker shows the age so a
  -- stale list is visible as stale rather than mistaken for the current truth.
  fetched_at           timestamptz not null default now()
);

-- The picker's windows filter on recency, and its search hits title/vendor.
create index shopify_products_updated_idx on shopify_products (updated_at desc nulls last);
create index shopify_products_inventory_idx on shopify_products (inventory_updated_at desc nulls last);
create index shopify_products_search_idx on shopify_products
  using gin ((title || ' ' || vendor) gin_trgm_ops);

alter table shopify_products enable row level security;


-- Replace the whole catalogue in one transaction.
--
-- A fetch is a complete picture, so applying it piecemeal would leave the picker
-- showing half of one catalogue and half of another. Products that have gone
-- from the window are deleted rather than left to linger as items you can still
-- pick but no longer exist.
create or replace function replace_product_cache(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  -- `where true` rather than a bare DELETE: Supabase's safe-update guard
  -- rejects an unqualified delete even inside a function, and silently
  -- wiping a table is exactly the accident it exists to prevent.
  delete from shopify_products where true;

  insert into shopify_products (
    id, title, vendor, price_label, image_url, inventory_quantity, in_stock,
    country_code, country_name_no, collections, created_at, updated_at,
    inventory_updated_at, restock_increase, is_offer, fetched_at
  )
  select
    x.id, coalesce(x.title, ''), coalesce(x.vendor, ''), coalesce(x.price_label, ''),
    x.image_url, coalesce(x.inventory_quantity, 0), coalesce(x.in_stock, false),
    x.country_code, x.country_name_no, coalesce(x.collections, '[]'::jsonb),
    x.created_at, x.updated_at, x.inventory_updated_at, x.restock_increase,
    coalesce(x.is_offer, false), now()
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
    id text, title text, vendor text, price_label text, image_url text,
    inventory_quantity integer, in_stock boolean, country_code text,
    country_name_no text, collections jsonb, created_at timestamptz,
    updated_at timestamptz, inventory_updated_at timestamptz,
    restock_increase integer, is_offer boolean
  )
  on conflict (id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;
