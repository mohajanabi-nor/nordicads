-- Keep alerts_choice in step with every opt-in / opt-out, whoever writes it.
--
-- 008 added alerts_choice while the deployed code still only wrote alerts_opt_in and
-- the timestamps. An unsubscribe made through that code left alerts_choice at 'in',
-- which the next version reads as "wants alerts" — silently undoing the unsubscribe.
-- Deriving the choice here, from the same write that records the opt-in or opt-out,
-- makes the two impossible to disagree, for old code, new code or a manual edit.

create or replace function wishlist_sync_choice()
returns trigger
language plpgsql
as $$
begin
  if new.opt_in_at is distinct from old.opt_in_at
     or new.opt_out_at is distinct from old.opt_out_at then
    new.alerts_choice := case when new.alerts_opt_in then 'in' else 'out' end;
  end if;
  return new;
end;
$$;

create trigger wishlist_customers_sync_choice
  before update on wishlist_customers
  for each row execute function wishlist_sync_choice();

-- Repair anything already written by the older code.
update wishlist_customers
   set alerts_choice = case when alerts_opt_in then 'in' else 'out' end
 where (opt_in_at is not null or opt_out_at is not null)
   and alerts_choice is distinct from (case when alerts_opt_in then 'in' else 'out' end);
