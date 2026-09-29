-- One-click unsubscribe for campaign emails.
--
-- Campaigns used to carry a mailto: "Meld deg av", which landed in post@nordicengros.no
-- and waited for someone to unsubscribe the customer by hand — a customer who asked to
-- stop kept getting campaigns (and, since 008, wishlist alerts) until then. Each contact
-- now has a random token for a personal https link (/api/storefront/unsubscribe?t=…)
-- that unsubscribes them on the spot. Random rather than derived from the address, so a
-- link can't be guessed or edited into someone else's.

alter table contacts
  add column unsubscribe_token text not null default replace(gen_random_uuid()::text, '-', '');

create unique index contacts_unsubscribe_token_idx on contacts (unsubscribe_token);
