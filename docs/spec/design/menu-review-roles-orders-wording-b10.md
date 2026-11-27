# b10 menu review, roles and Orders wording

Status: accepted by the coordinator under the Owner's standing instructions (commercial fidelity,
decide technical choices, owner defaults 2026-11-06). Source: v15 live findings 2026-11-11
(`.local/integ-tools/b10/menu-review-roles-orders-wording.json`). Branch
`codex/fix-menu-review-roles-orders-wording` from `10124d70`.

## What goes live names names and allergens (M72)

- The owner's review before "List it" now has a "Names and allergens" part whenever the menu was
  listed before. Each dish whose name guests will read differently is listed: in the reader's own
  language as "Renamed: old → new"; in the other language as "Dish: Chinese name old → new" (added
  and taken-off names are said as such). Sizes of one dish share its name and are said once.
- Each dish whose allergens changed since the listed version (a staff declaration, a recipe bound
  or ended: `sellable_allergen_change` after that version's review) is listed with its allergens
  as the dish row says them.
- The renames are worked out by the server against the listed menu's own review snapshot, inside a
  savepoint. If that read fails the review says "Name changes could not be checked just now. The
  names go live as they are on this page." and never "No name or allergen changes".
- The commands' own menu reads (save dish, list) skip this comparison, so listing is not slowed.

## Listing time is said truthfully

A busy v15 took 42–82 s. The page no longer promises "up to a minute". It says listing usually
takes one to two minutes, longer when the system is busy, and past two minutes adds that it is
taking longer and nothing needs doing. The listing is not made faster in this bundle: its cost is
in the publication workflow (`menu-listing-cost`), which is unchanged.

## Starter roles

- "Also remove the roles this kind of shop doesn't use" starts unticked. Removing presets in use is
  the owner's own choice; sending the starter roles again never takes roles away by default.
- When every starter role for the chosen kind of shop was removed, Store setup no longer says the
  roles are set up. It names the removed roles, says no role for this kind of shop is in use, and
  offers the kind-of-shop choice again.

## Guest checkout after a dish change

- A greyed "Continue to payment" says, directly under it, to tick the changes box above.
- A rename notice says which language's name changed, from what to what, so an English reader sees
  a Chinese-only rename.

## Orders

- A paper order paid during an outage and linked to its re-entry reads "Paid on paper · entered
  again" with "Its sale is on order N; don't charge again", never "Cancelled" or "Not paid".
- An order with refunds ends with "Total after refunds" (only when every refund amount is known,
  never negative), so a table whose paid rounds were all cancelled and refunded reads $0.00 after
  refunds instead of a Total staff could take for money owed. The Total stays what was ordered
  (DEC-TAX-WHOLE-RECEIPT).

## Store features

A Save answer (including the refusal for pickup without a phone, with its "Add phone number" link)
is scrolled fully into view under the tapped Save.

## Orders missing a freshly paid pickup (open, capture only)

Investigated with read-only v15 data for orders 37 and 40 of 2026-11-11: each Order header existed
before its payment, `PaymentSucceeded` and the payment status projection followed within 1 s, and
every API request in 14:23–14:25Z completed in under 1 s (two 503s at 14:24:36Z and 14:24:45Z,
whose route the completion log does not name). The Orders list read lists every Order header of the
Store. No product cause was found, and b10 showed a new paid pickup 2.5 s after payment. Nothing is
changed. Next time it is seen, record the `/merchant/orders` replies and the page state (an outage
panel or the Today filter) along with the time.
