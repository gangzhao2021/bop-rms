# Guest and staff wording (b11)

Status: Accepted (coordinator decisions under the Owner rules of 2026-11-06; WP-2423 pilot track).
Branch `codex/fix-guest-and-staff-wording`, based on integ5 `1d268428` (batches 1–10). Findings:
the v15 live run of the menu-allergen-and-wording bundle
(`.local/integ-tools/b11/guest-and-staff-wording.json`).

## 1. A paid pickup order reads "This order isn't available on this phone" after the guest joins a table

**Cause.** A phone has one current visit (`__Host-bop-guest`). When a guest with a pickup order
scans a table's code at the same Store, the entry starts the table visit and keeps the pickup
visit in `__Host-bop-visits` (M104/M105). The receipt already read a kept visit. The order page
(`/api/v1/orders/:id/status`), its pickup code (`/pickup-code`) and "Remove my contact details"
(`/contact-removal`) read only the current visit. For the table visit the pickup order belongs to
nobody, so the guest who paid was told the order was not theirs. Only a fresh scan of the pickup
QR brought it back.

**Decision.** In a real restaurant a guest who paid for takeaway and then sat down for a drink
must still be able to show their pickup code from the order link. So these three routes answer
for a kept visit in the same way the receipt does.

- The current visit is always tried first. A kept visit is tried only when the current visit does
  not own the order. An outage (503) is answered as an outage and is never retried as another
  visit.
- Stricter than the receipt: a kept visit is used only when the request proved the current visit,
  that is, when its CSRF token is the current Session's own token (compared in constant time). The
  kept visit's CSRF is then derived on the server, and the owner checks of the read or command run
  unchanged under that visit. No credential reaches the page, a URL or the logs.
- The kept visit is read, never renewed. Only scanning its own pickup QR renews it.
- The guest pages are unchanged. The order link now works, and "This order isn't available on
  this phone" stays for an order that really is not this phone's.

## 2. Option recipes: "Cost: approved by You / Food safety: approved by You" under a two-reviewer rule

**Cause.** A choice answered on the Menu page at a Brand with one Store is saved and reviewed by
the person who lists it (WP-2423 item 8 ⑥, `SingleStoreListing`). A Brand owner's listing is
`BrandOwnerListing` (DEC-BRAND-MULTI-STORE segment 9), and a sole operator's review is
`SoleOperator` (Q19). The database records the rule on each review (`review_mode`), but the page
showed only "approved by You". The header stated the two-reviewer rule with no exception. The row
also offered **Change**, which opened the stock-recipe form ("Add an amount of an ingredient per
one chosen"), but this choice is a staff declaration and not stock.

**Decision.**

- Each review the page lists now carries its rule. A review one person gave alone says which rule
  allowed it: "given alone when listing from the Menu page (the Brand has one Store)", "given
  alone by the Brand's owner when listing from the Menu page" or "given alone as sole operator"
  (zh-Hans: 从菜单页上架时单独审核（品牌只有一家门店） / 品牌老板从菜单页上架时单独审核 /
  以唯一操作人身份单独审核). An independent review says nothing extra.
- The header names the same exceptions: such changes are approved by that one person, and their
  reviews say so.
- A row whose change is a Menu-page declaration offers "Change on the Menu page" (在菜单页修改).
  The link goes to `/app/commerce/menus`, where the declaration is answered, and the stock-recipe
  editor is not offered. A stock change keeps its own editor.
- No rule changed. Reviews and their evidence are append-only and are read as recorded.

## 3. 中文 posted opening count at 390 lists values with no column labels

**Cause.** Below 40rem the shared table style hides the header row and labels each cell from its
`data-label`. The opening-count cells had no `data-label`, so staff saw "Chest freezer A, L2410A,
2026-10-20, 8 升, 2.89" with no names. The defect was in both languages and predates b10.

**Decision.** Each value cell (location, lot code, expiry, quantity, unit cost) names its column
in the staff's language. The item name stays the card's heading. Wide screens are unchanged.
