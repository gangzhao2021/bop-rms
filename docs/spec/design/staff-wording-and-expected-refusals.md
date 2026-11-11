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
menu never contributes. Nothing written changes; the guest's own phone is unchanged.

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

**Guest answer.** The table-moved answer was already right. The sweep found Ordering's own
`STORE_CLOSED` checkout refusal answered as a generic conflict; it now answers `store_closed`
(the same plain "the restaurant stopped taking orders" the guest already gets from the Store gate).

**Tests.** `packages/database/test/staff-cart-dish-names-acceptance.test.mjs` (restricted pilot
role; fails on the old DISTINCT ON read), `apps/api/src/customer-payment-intent.test.ts` (every
listed refusal is the handler's plain answer and an information line; others are not),
`tooling/environment/pilot-additional-payment.test.mjs` and `pilot-payment-intent.test.mjs`
(fail before the change).
