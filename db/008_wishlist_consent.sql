-- Wishlist alerts follow the customer's email-marketing consent unless they choose.
--
-- Nordic Engros decided (2026-09-29) that a customer who is subscribed to its emails is
-- subscribed to wishlist alerts too, and one who isn't, isn't. The customer's own choice
-- on the wishlist page — or "Meld deg av" in an alert — still wins over that.
--
-- So "has the customer chosen?" must be recorded, not guessed from timestamps.
-- alerts_choice is null until they tick or untick the box; while it is null, the
-- marketing consent in `contacts` decides (see lib/wishlist.ts, consentFor).

alter table wishlist_customers
  add column alerts_choice text check (alerts_choice in ('in', 'out'));

-- Anyone who has already ticked or unticked the box made a choice.
update wishlist_customers
   set alerts_choice = case when alerts_opt_in then 'in' else 'out' end
 where opt_in_at is not null or opt_out_at is not null;

comment on column wishlist_customers.alerts_opt_in is
  'The customer''s own choice, when alerts_choice is set. Not the effective consent: see alerts_choice.';
