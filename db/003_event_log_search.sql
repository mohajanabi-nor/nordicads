-- The Logg tab's search box matches against the message, the event name AND the
-- serialised data — that last part is how you find "which campaign was that?"
-- from a detail that only exists inside the payload.
--
-- PostgREST can't express a cast-and-search across those three in one filter, so
-- the concatenation becomes a real column. Keeping the behaviour identical
-- matters more than saving the bytes: a search that quietly stopped looking
-- inside `data` would look like missing log entries.
--
-- Filled by a trigger rather than GENERATED ALWAYS, because a generated column's
-- expression must be provably immutable and a cast out of jsonb is not something
-- to bet a migration on.

alter table event_log add column if not exists search_text text;

create or replace function event_log_fill_search()
returns trigger
language plpgsql
as $$
begin
  new.search_text :=
    coalesce(new.message, '') || ' ' ||
    coalesce(new.event, '') || ' ' ||
    coalesce(new.data::text, '');
  return new;
end;
$$;

drop trigger if exists event_log_search_trigger on event_log;
create trigger event_log_search_trigger
  before insert or update on event_log
  for each row execute function event_log_fill_search();

-- Backfill anything already written.
update event_log
   set search_text = coalesce(message, '') || ' ' || coalesce(event, '') || ' ' ||
                     coalesce(data::text, '')
 where search_text is null;

create index if not exists event_log_search_idx
  on event_log using gin (search_text gin_trgm_ops);
