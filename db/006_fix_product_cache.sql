-- Re-create replace_product_cache with a qualified DELETE.
--
-- The first version used a bare `delete from shopify_products`, which Supabase's
-- safe-update guard rejects even inside a function — so every product fetch
-- came back, was handed to the dashboard, and then failed at the last step.

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
