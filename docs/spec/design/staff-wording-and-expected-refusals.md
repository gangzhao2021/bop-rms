# Staff dish names and expected guest refusals (WP-2423, 2026-11-11)

Two live findings from v15, decided as a restaurant runs, not as the simplest change.

## 1. A guest's cart dish in the staff member's language

**Finding.** In 中文, the Tables cart panel, the staff round (the "guests' dishes still in the cart"
list and its refusal) and the table's order screen named the guests' not-yet-sent dishes in English,
while the kitchen, orders and counter menu named the same dishes in Chinese.

**Cause.** Those three screens name a cart line from Catalog's `listStoreMenuSellableNames`: the
names of the dish on the Store's current menus. It kept one placement per dish (the oldest by
placement id). A Store usually has more than one current menu (dine-in and pickup, or an older
menu); the oldest was published before staff entered the Chinese names (Owner 2026-10-23), so it
carries English only and hid the Chinese name the newer menu has. The screens themselves already
choose the staff member's language (`contentName`, `staffContentLocale`).

**Decision.** Catalog stays the one owner of dish names. A dish on several current menus carries
every language any of them names it in, each taken from the most recently published menu that has
it (generation rebuilt time, then generation, then placement). An older English-only menu adds
nothing over a newer Chinese name; a name only an older menu has is still shown. Another Store's
menu never contributes. Nothing written changes.

**The guest's phone too.** Two guest reads use the same Catalog read, so their names change the
same way (an improvement, not a separate decision): the payer's list of the other guests' waiting
dishes (`apps/api/src/customer-cart-table-pay.ts`) and the "staff took these dishes out" notice
every phone at the table gets (`staffRemovals` in `apps/api/src/local-customer-runtime.ts`). The
guest's phone still picks the language from those names as before.

**Alternatives rejected.** Naming each line from the exact menu version it was chosen from would
need Catalog's selection-display reads (rules, channel, order type) per line on every Tables poll,
for the same names; and still shows English where that version predates the Chinese name.

## 2. Expected refusals are information, with their own code

**Finding.** A guest paying for another round after staff moved the table is refused (nothing placed
or charged; the phone answers 409 `table_moved` and checks out again at the new table). The pilot
logged it as `INTERNAL_ADDITIONAL_PAYMENT_UNAVAILABLE` at error level, so an operator chases an
ordinary moment of service.

**Decision.** One list of the business refusals a guest's round or payment meets in ordinary
service, in `apps/api/src/customer-round-refusal.ts`, matching the payment handler's plain answers:
table moved, items short, menu changed (requote), Store closed, already ordered, tips turned off,
pay-later / pay-first table, and for another card retry limit, retry pending, already paid, payment
window ended. Recognized by error name and code (the pilot composes some owners from sources, so
class identity is not reliable). The pilot's additional-round payment, its current-check during
submission and the first-round payment log these as a level-30 line
`CUSTOMER_ADDITIONAL_ROUND_REFUSED` / `CUSTOMER_ROUND_REFUSED` with `code` (for example
`TABLE_MOVED`), codes only. Everything else (outage, permission, conflict, unknown) keeps its
error line; an outage never reads as a refusal or as no permission.

**Review follow-up (same day).** The first pass logged the additional round's "a dish ran out" and
"the menu changed" as information and then failed it anyway: the additional batch store passed on
only Ordering's stock-short and table-moved refusals, so a checkout refusal raised by the current
check became "unavailable" (an error line and a 503 "try again" for the guest). Now:

- The additional batch store (`additional-dining-batch-store.ts`) passes on, by name and code, the
  refusals its current gates raise in ordinary service: stock short (as Ordering's
  `ORDER_CREATE_STOCK_SHORT`, so the guest is told the items ran out and staff rounds say the dish is
  unavailable), menu changed (`CHECKOUT_REQUOTE_REQUIRED`), a dish off the menu
  (`CHECKOUT_ITEM_UNAVAILABLE`), quote expired (`CHECKOUT_QUOTE_EXPIRED`) and table moved. Anything
  else is still "unavailable".
- The pilot's current check no longer raises a plain `ADDITIONAL_CATALOG_CHANGED`: a menu that moved
  on since checkout, or a checkout window that lapsed while the guest decided, is
  `CHECKOUT_REQUOTE_REQUIRED` (the guest's "the menu changed", the cart prices again). The round's
  time ahead of the server clock, which no moment of service produces, is `ADDITIONAL_CLOCK_AHEAD`
  and stays an error. The current check logs nothing for a refusal; the payment's catch writes the
  one information line for the attempt.
- Also expected, so listed: another guest at the table is paying (`CHECKOUT_IN_PROGRESS`, routine on
  shared tables), a dish came off the menu (`ITEM_UNAVAILABLE`, `CHECKOUT_ITEM_UNAVAILABLE`), and
  the checkout window lapsed (`CHECKOUT_QUOTE_EXPIRED`, `ORDER_CREATE_VALIDATION_EXPIRED`), logged
  as `ITEM_UNAVAILABLE` / `CHECKOUT_EXPIRED` / `CHECKOUT_IN_PROGRESS`.
- Not listed, on purpose: `PAYMENT_INTENT_ORDER_NOT_READY`. Its causes are an unparseable or
  mismatched preparation record, a request time ahead of the server clock, a preparation window that
  is not the fixed 30 minutes, or a missing prior operation; integrity or clock failures, so an
  operator must see them.
- Table moved is recognized however it arrives (`isTableMoved`): Ordering's
  `ORDER_CREATE_TABLE_MOVED`, or Dining's own `DINING_CHECKOUT_STORE_TABLE_MOVED` /
  `DINING_CHECKOUT_TABLE_MOVED` reaching the catch without `refuseRoundOfMovedTable` or the latch.
  The payment handler answers those Dining refusals as table moved (409) too; before, they were a 503. The `code` on the v15 `INTERNAL_ADDITIONAL_PAYMENT_UNAVAILABLE` line was not read (no v15
  access in this change), so every shape is covered rather than assuming one.

**Guest answer.** The table-moved answer was already right for Ordering's refusal. The sweep found Ordering's own
`STORE_CLOSED` checkout refusal answered as a generic conflict; it now answers `store_closed`
(the same plain "the restaurant stopped taking orders" the guest already gets from the Store gate).

**Tests.** `packages/database/test/staff-cart-dish-names-acceptance.test.mjs` (restricted pilot
role; fails on the old DISTINCT ON read), `apps/api/src/customer-payment-intent.test.ts` (every
listed refusal is the handler's plain answer and an information line; others are not),
`tooling/environment/pilot-additional-payment.test.mjs` and `pilot-payment-intent.test.mjs`
(fail before the change). Review follow-up: `packages/rms/ordering/src/tests/additional-dining-batch-store.test.ts`
(each current-gate refusal passed on as itself; 5 fail before),
`tooling/environment/pilot-additional-submission.test.mjs` (menu moved on or window lapsed is
"the menu changed", no error line; 3 fail before) and `apps/api/src/customer-payment-intent.test.ts`
(the added refusals and Dining's table-moved shapes; 9 fail before). The three staff screens choose
the name's language with `contentName` as before; only the read changed, so no new render test.
