-- Cut Supabase egress: do the counting in Postgres instead of downloading rows.
--
-- Before this, the 5-minute campaign cron downloaded every recipient row of the
-- 20 newest campaigns just to count them, and every contacts-page load
-- downloaded the whole contact table to show 50 rows. Both now ask the
-- database for the answer, which is a few hundred bytes.
--
-- Run once in the Supabase SQL editor BEFORE deploying the matching code.


-- ---------------------------------------------------------------- contacts ---

-- "Can a campaign reach this person?" as a stored column, so the list can be
-- sorted and filtered by it in SQL. Same rule as isMailable() in lib/contacts.ts.
alter table contacts
  add column if not exists mailable boolean
  generated always as (subscribed and not invalid_email and not missing_in_shopify) stored;

create index if not exists contacts_mailable_added_idx
  on contacts (mailable desc, added_at desc);

-- The header numbers on the contacts page, in one round trip.
create or replace function contacts_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'count',      count(*),
    'subscribed', count(*) filter (where subscribed),
    'invalid',    count(*) filter (where invalid_email),
    'missing',    count(*) filter (where missing_in_shopify),
    'mailable',   count(*) filter (where mailable)
  )
  from contacts;
$$;


-- --------------------------------------------------------------- campaigns ---

-- Progress for a set of campaigns: the counts the app used to compute by
-- downloading every recipient row. `remaining` is recipients in the frozen list
-- that have no outcome yet — the same rule as campaignProgress() in TypeScript.
create or replace function campaign_stats(p_ids text[])
returns table (
  id        text,
  total     integer,
  sent      integer,
  failed    integer,
  skipped   integer,
  remaining integer
)
language sql
stable
as $$
  select
    c.id,
    jsonb_array_length(c.recipients)::integer,
    coalesce(s.n_sent, 0)::integer,
    coalesce(s.n_failed, 0)::integer,
    coalesce(s.n_skipped, 0)::integer,
    (
      select count(*)::integer
        from jsonb_array_elements_text(c.recipients) as e(email)
       where not exists (
         select 1 from campaign_recipients r
          where r.campaign_id = c.id and r.email = e.email
       )
    )
  from campaigns c
  left join lateral (
    select
      count(*) filter (where r.status = 'sent')                     as n_sent,
      count(*) filter (where r.status = 'failed')                   as n_failed,
      count(*) filter (where r.status not in ('sent', 'failed'))    as n_skipped
    from campaign_recipients r
    where r.campaign_id = c.id
  ) s on true
  where c.id = any(p_ids);
$$;


-- Which of the 20 newest campaigns still have recipients to go, newest first.
-- The cron used to find this out by reading all of them every five minutes;
-- with nothing in flight it now costs one empty response.
create or replace function unfinished_campaign_ids()
returns setof text
language sql
stable
as $$
  select c.id
    from (select id, recipients, created_at
            from campaigns
           order by created_at desc
           limit 20) c
   where exists (
     select 1
       from jsonb_array_elements_text(c.recipients) as e(email)
      where not exists (
        select 1 from campaign_recipients r
         where r.campaign_id = c.id and r.email = e.email
      )
   )
   order by c.created_at desc;
$$;
