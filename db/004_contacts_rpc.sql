-- Contact operations that cannot be expressed as a single PostgREST request.
--
-- The file-backed version serialised every mutation through one in-process
-- promise chain. That lock stops being a lock the moment the app runs as more
-- than one instance, which is exactly what hosting it does — so the guarantees
-- move into the database instead of being reimplemented in application code.

-- Increment-and-unsubscribe in one statement.
--
-- Resend's synchronous rejection is the only bounce signal available without a
-- webhook, so acting on it is what stops the list rotting and taking the sending
-- domain's reputation with it. Returns the addresses actually unsubscribed —
-- consent changed with no human deciding it, and the caller has to log each one.
-- Two steps rather than one UPDATE..RETURNING, because the caller needs to know
-- who was subscribed BEFORE the update, which the returning clause cannot see.
create or replace function contacts_record_failure(p_emails text[])
returns setof text
language plpgsql
as $$
declare
  unsubbed text[];
begin
  select coalesce(array_agg(email), '{}')
    into unsubbed
    from contacts
   where email = any(p_emails) and subscribed;

  update contacts
     set failure_count = failure_count + 1,
         subscribed = case when subscribed then false else subscribed end
   where email = any(p_emails);

  return query select unnest(unsubbed);
end;
$$;


-- Apply a whole Shopify sync in one transaction.
--
-- The decision logic stays in TypeScript: consent may only ever be tightened,
-- never loosened, and getting that subtly wrong re-subscribes people who opted
-- out by replying to a campaign. It is too important to rewrite in SQL for its
-- own sake. What belongs here is atomicity — a sync that half-applied would
-- leave the list in a state no one reasoned about.
--
-- Renames run first and matter: a customer who changes address in Shopify must
-- be RENAMED, not inserted alongside their old row, which would linger and
-- bounce forever. Email is the primary key, so an upsert alone cannot do it.
create or replace function contacts_apply_sync(p_renames jsonb, p_rows jsonb)
returns void
language plpgsql
as $$
declare
  r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_renames, '[]'::jsonb))
  loop
    -- Drop any row already sitting on the new address, otherwise the rename
    -- collides with a duplicate the sync is about to reconcile anyway.
    delete from contacts
     where email = (r->>'to') and email <> (r->>'from');
    update contacts
       set email = (r->>'to')
     where email = (r->>'from');
  end loop;

  insert into contacts (
    email, shopify_id, name, company, city, subscribed, invalid_email,
    missing_in_shopify, last_seen_in_shopify_at, failure_count, added_at,
    source, last_sent_at, note
  )
  select
    x.email, nullif(x.shopify_id, ''), x.name, x.company, x.city, x.subscribed,
    x.invalid_email, x.missing_in_shopify, x.last_seen_in_shopify_at,
    x.failure_count, x.added_at, x.source, x.last_sent_at, x.note
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
    email text, shopify_id text, name text, company text, city text,
    subscribed boolean, invalid_email boolean, missing_in_shopify boolean,
    last_seen_in_shopify_at timestamptz, failure_count integer,
    added_at timestamptz, source text, last_sent_at timestamptz, note text
  )
  on conflict (email) do update set
    shopify_id              = excluded.shopify_id,
    name                    = excluded.name,
    company                 = excluded.company,
    city                    = excluded.city,
    subscribed              = excluded.subscribed,
    invalid_email           = excluded.invalid_email,
    missing_in_shopify      = excluded.missing_in_shopify,
    last_seen_in_shopify_at = excluded.last_seen_in_shopify_at,
    failure_count           = excluded.failure_count,
    source                  = excluded.source,
    last_sent_at            = excluded.last_sent_at,
    note                    = excluded.note;
end;
$$;


-- A short lease, used so two syncs cannot run at once.
--
-- Advisory locks would be the obvious tool but do not survive between PostgREST
-- requests, which each get their own transaction. A lease row does, and an
-- expiry means a crashed holder frees it without anyone intervening.
create or replace function try_claim_lease(p_key text, p_seconds integer)
returns boolean
language plpgsql
as $$
declare
  claimed boolean;
begin
  insert into app_state (key, value, updated_at)
  values (p_key, jsonb_build_object('until', (now() + make_interval(secs => p_seconds))), now())
  on conflict (key) do update
    set value = jsonb_build_object('until', (now() + make_interval(secs => p_seconds))),
        updated_at = now()
    where (app_state.value->>'until')::timestamptz < now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;


create or replace function release_lease(p_key text)
returns void
language sql
as $$
  update app_state
     set value = jsonb_build_object('until', now()), updated_at = now()
   where key = p_key;
$$;
