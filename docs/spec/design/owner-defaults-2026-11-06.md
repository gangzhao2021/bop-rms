# DEC-OWNER-DEFAULTS-2026-11-06 — 盘点后的 26 项业务规则与同桌结账

状态：已接受（Owner 2026-11-06）。适用：试点与 InternalTest；真实门店上线前若有变化，以新的 Owner 决定为准。

## 来源

- 2026-11-06 对模拟与角色审核的 228 项问题按当前代码逐项核对后，有 27 项是只能由 Owner 定的业务规则（钱、客人、员工）。每项附推荐默认，交 Owner 决定。
- Owner 原话：“全部按推荐”（26 项）。
- 同桌结账（M38）另行决定，Owner 原话：“不能设一个默认，再加其他选项吗？”与“默认付全桌吧”：结账时可选“付全桌”（默认）、“只付我加的”、“选几道菜帮别人付”；门店可在设置里改默认；每道菜只能付一次，已付的菜从别人的结账里扣除；金额按 DEC-TAX-WHOLE-RECEIPT 逐分计算。

## 决定

问题编号见模拟结果（M 开头）与角色审核。每项的实现以本文件为准；与早期设计文件冲突时，本文件优先（交接包规则：后接受的决定优先）。

1. **M13** — May a store owner start an online refund themselves without turning on 'Sole operator', or must a second person always approve it?
   决定（推荐默认）：Keep the two-person rule. When the owner is alone, the refund page explains how to turn on Sole operator or give someone the Store Manager role. Two people stay the default.
2. **M14** — May a cashier leave a refund request that goes to the manager or owner for approval?
   决定（推荐默认）：Yes. A cashier can request (reason required, recorded) and cannot approve or send. The manager is alerted on Approvals and Home.
3. **M16** — Once a refund is approved, should the system send it to the guest's card at once, or does the approver press Send separately?
   决定（推荐默认）：The system sends it at once after approval, and the order page shows 'sent, waiting on the bank'.
4. **M10** — When part of an order is refunded, should the matching dish always be cancelled in the kitchen too?
   决定（推荐默认）：Not always. Staff are asked 'cancel this dish too?' with Yes preselected when the dish has not been made yet.
5. **M163** — If staff refund too much by mistake, how is the money taken back recorded, and does it need a manager?
   决定（推荐默认）：A new recorded 'money taken back' entry on the same order, on the day it happens, approved by a manager. The original refund is never changed.
6. **M45** — On Today's summary, should net sales and tax subtract partial refunds, or stay gross with refunds shown on a separate line?
   决定（推荐默认）：Show net sales after refunds, with refunds also listed separately, and state the basis on every page.
7. **M44** — When a cancellation or automatic refund is confirmed in full by the payment provider, may it close itself without a staff tick?
   决定（推荐默认）：Yes, recorded as closed by the system. Only failed or mismatched refunds stay as exceptions for staff.
8. **M47** — Should closing up record a cash-drawer count and the card machine's batch total, signed by the person closing?
   决定（推荐默认）：Yes, optional fields on a signed close-of-day record that shows the difference. Closing is not blocked if they are left empty.
9. **M46** — At closing, may a manager mark a ready pickup as not collected before it has waited an hour?
   决定（推荐默认）：Yes, at closing only, recorded with a reason. The guest's page says the store has closed and how to contact it.
10. **M52** — Do walk-up counter orders take cash in this system?
    决定（推荐默认）：Yes. Reuse the table's cash handling (5-cent rounding, change due) so the kitchen still gets the ticket.
11. **M173** — May the kitchen start a pay-at-pickup order before it is paid, and how long is an unpaid order held?
    决定（推荐默认）：No kitchen start before payment. Hold until the promised pickup time plus 10 minutes, and warn staff on screen before release.
12. **M41** — If nobody accepts a paid table round, should it refund automatically after a time limit?
    决定（推荐默认）：No automatic refund for tables. Alert staff at 5 minutes and tell the guest to let staff know.
13. **M58** — Can members use points on pickup and pay-first table orders, not only on pay-at-end table bills?
    决定（推荐默认）：Not for now. Checkout and the member page say clearly where points can be used.
14. **M60** — If an order is refunded after points were earned, should those points be taken back?
    决定（推荐默认）：Yes, in proportion to the refund, recorded on the member's history.
15. **M64** — May an owner or manager add a staff member in person with just a PIN, no email or authenticator app?
    决定（推荐默认）：Yes for staff who cannot move money or change permissions. Email and authenticator remain required for refunds, approvals and settlement.
16. **M76** — Should a new dish start with every allergen unanswered, so staff must answer Yes, May contain or No for each one?
    决定（推荐默认）：Yes, start unanswered and block saving until every row is answered.
17. **M171** — May staff mark the allergens a table must avoid, shown in red on kitchen tickets, and may guests call staff with an 'allergy question'?
    决定（推荐默认）：Yes to both. Allergen ticks only, no free text, cleared when the table closes.
18. **M93** — For stores selling alcohol: record the liquor licence and Smart Serve, a 19+ confirmation at checkout, a 'check ID' note on tickets, and a last-call warning?
    决定（推荐默认）：Yes to all four. Last call 30 minutes before the cutoff.
19. **M85** — Who renews a store's tax setup, BOP support or the merchant, and how early should the owner be warned?
    决定（推荐默认）：BOP support renews it. The owner gets a Home reminder 30 days ahead with a 'Call BOP support' step.
20. **M110** — For an in-store pickup, may a guest order with only a name and no phone or email?
    决定（推荐默认）：Yes for orders collected now. Phone or email is asked only for orders placed ahead for a later time, with the reason shown.
21. **M137** — Should staff be able to merge two pay-first tables (dessert or tea shops) when parties sit together?
    决定（推荐默认）：Yes. Rounds already paid stay with the table that paid them, and the phones follow the party.
22. **M143** — Which roles may comp or discount, and above what amount must a manager approve?
    决定（推荐默认）：Managers freely. Other staff up to $10 or 20% per bill without a manager PIN, and above that a manager PIN. Who did it is always shown.
23. **M144** — At a table staff have seated, should a new phone need the first guest's approval to join?
    决定（推荐默认）：No. Joining stays open, and staff see only unusual joins and can remove a phone.
24. **M145** — May guests at a pay-at-end table start paying by phone themselves?
    决定（推荐默认）：Yes. Staff are warned about dishes not yet served and a guest count that has not been confirmed.
25. **M32** — May the on-duty manager extend or shorten tonight's hours without a second approver?
    决定（推荐默认）：Yes for tonight only, recorded. Permanent hours still need approval.
26. **M165** — If the menu price changes while a guest is inside the 'prices confirmed' window, do we honour the old price or ask the guest to accept the new one?
    决定（推荐默认）：Honour the confirmed price until the hold ends.

## 不改变

- 不允许任何隐藏、删除或改写销售、付款、收据的做法；作废、退款、折扣、免单都必须是有记录、有署名的补偿操作。
- 历史只追加；更正一律用新的记录。
