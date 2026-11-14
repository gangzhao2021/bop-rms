# Store setup in a few places (b18)

Owner request, 2026-11-14 (after a review of `/app/organization/stores/<store>/setup`):
"先改吧，太多了我记不住". One page held seven unrelated things, said "save" five different ways,
duplicated name and contact, buried the important log lines and opened with the wrong question.
The accepted direction: a few clear places, each doing one thing and each saying plainly whether a
change is live at once or a draft that needs approval.

## What a restaurant owner sees now

The sidebar entry is unchanged (Store setup / 门店设置, Section 88 `STORE-SETUP`,
`/app/organization/stores/{id}/setup`, `organization.manage`, Store Manager reads with
`organization.store.read`). Inside it, an open Store's setup is five places, shown as text links
under the page title (accent colour, the current one marked by weight and a line under it):

| Place (en / zh-Hans)                       | Address                    | What it holds                                                                                                                                                         | When a change takes effect                                                                       | Button                                                                            |
| ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Store details / 门店资料                   | `…/setup`                  | Store name customers see (per language), street address, phone                                                                                                        | Live as soon as it is saved                                                                      | Save and make live / 保存并生效                                                   |
| Receipts and tax numbers / 收据与税号      | `…/setup?section=receipts` | Business name on receipts, GST/HST, QST, PST, privacy notice link                                                                                                     | Live as soon as saved, for receipts issued from then on                                          | Save and make live / 保存并生效                                                   |
| Kitchen setup / 后厨                       | `…/setup?section=kitchen`  | Whether every dish reaches the Kitchen screen; the one-step fix                                                                                                       | Live at once, for orders confirmed from then on                                                  | the action itself                                                                 |
| Permissions and safety / 权限与安全        | `…/setup?section=access`   | Platform support access and its log; sole operator and its history                                                                                                    | Live at once, each change recorded                                                               | the action itself (sole operator still needs a reason and the authenticator code) |
| Settings that need approval / 需审批的设置 | `…/setup?section=changes`  | The eight setup steps (time zone, business day, service, hours, fees, tax/payment, receipt layout, capacity, contacts) and the publication of the Store configuration | Saved as a draft first; live only after it is submitted, approved and published in the last step | Save as draft / 存为草稿, then Submit for review and Publish in step 8            |

Each place opens with one line saying what it holds and when a change there takes effect. Only the
last place talks about drafts; the old header line "Saving a draft does not change the live Store"
and the page-wide "Refresh saved setup" are gone from the other four ("Reload the saved draft" /
重新读取已存的草稿 sits in the draft place only). No button means two things: "保存并生效" always
means live now; "存为草稿" / "提交审批" always mean a draft that needs approval.

A first Store (setup never published) keeps its one opening page (WP-2423 item 14,
DEC-STORE-FIRST-OPENING) with the eight steps and every section folded under "All settings, step
by step". The store-type question "What kind of store is this?" (starter roles) is asked there
only: it is an opening question. An open Store's owner finds the same starter role sets on Roles
(`StarterRoleSetOffer place="Roles"`), so nothing is lost.

## Every moved section

| Section                                                                    | Before                                      | Now                                                                      | Owner, commands, permissions                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name and contact shown to customers (`StorePublicProfilePanel`)            | first section of the one page               | Store details                                                            | unchanged: `/merchant/store/public-profile`, Owner changes, others read-only                                                                           |
| Kitchen (`StoreKitchenSetupPanel`, `#kitchen-setup`)                       | second section                              | Kitchen setup                                                            | unchanged: `/merchant/store/kitchen-setup`                                                                                                             |
| Platform support (`StoreSupportAccessPanel`, `#support-access`)            | third section                               | Permissions and safety                                                   | unchanged: `/merchant/store/support-access`, Owner only                                                                                                |
| Receipts and privacy (`StoreReceiptPrivacyPanel`, `#receipts-and-privacy`) | fourth section                              | Receipts and tax numbers                                                 | unchanged: `/merchant/store/receipt-profile`, tax-number validation unchanged                                                                          |
| Sole operator (`StoreSoleOperatorPanel`)                                   | fifth section, for people who see Approvals | Permissions and safety, same condition                                   | unchanged: `/organization/sole-operator`, reason + authenticator step-up (DEC-SOLE-OPERATOR-APPROVAL)                                                  |
| Eight-step setup wizard and configuration publication                      | always under the sections                   | Settings that need approval (open Store); the opening fold (first Store) | unchanged: store-setup draft, references, payment, fees, receipt template, `StoreConfigurationOrdinaryPanel` approvals and sole-operator self-approval |
| Store type / starter roles (`StoreStarterRolesPanel`)                      | bottom of the page                          | first Store's opening page only; Roles for an open Store                 | unchanged                                                                                                                                              |

Links other pages already use keep working: `#store-public-profile`, `#receipts-and-privacy`,
`#kitchen-setup`, `#support-access` and `#sole-operator` open their place (`storeSetupPlaceOf`), and
on a first Store they still open the fold as before. `?section=` wins over an anchor.

A place none of whose sections this person may see is not offered (each section reports "not for
you" through `onHidden`); a Store Manager, refused the setup read, is not offered the draft place.
An address for a place someone is not offered shows the first place they are. Sections stay
mounted while another place is shown (hidden, not unmounted), so switching places neither re-reads
nor loses an unsaved edit, and the reads are the ones the one page made before.

## Logs

- Platform support: the place leads with "What support changed or tried" (the Changed and Refused
  records), then one line "Support looked at your Store 46 times, last …", then the access log with
  the newest five records and "Show all 49 records" / 显示全部 49 条记录 listing every record the
  read returned. Collapsed on screen only; nothing is removed or filtered out of the record.
- Sole operator: the newest five changes, "Show 5 more" for the rest the read returned, and the
  existing "N earlier changes are kept in the record" for changes beyond it. The "setting change
  36" and "Change 36:" numbers are no longer shown.
- Remaining (not changed in b18, needs a read change): the server returns the latest 10
  sole-operator changes (`historyLimit: 10`) and the latest 100 support log records
  (`listStoreSupportAccess` limit 100); the page says how many more are kept but cannot list them.

## Wording

- Name fields: "店名（英文）" / "店名（中文）" (en: "Store name customers see (English)"), never the
  browser's "加拿大英语"; each field's example is in its own language ("Maple Noodle House – King
  Street" for English, "枫叶面馆 国王街店" for Chinese). Step 1 shows the Store language as "英语".
- "修订版 26" is gone: step 1 says "已存草稿" or "还没有保存草稿".
- 厨房线 / 后厨线 are gone from Chinese: "让所有菜都送到后厨", "本店的菜都送到后厨，开始于".
- Save wording: 保存并生效 (live now) and 存为草稿 / 提交审批 (approval), "放弃未保存的修改",
  "已保存并生效。" success lines; every sentence that named the old "保存设置草稿" button now names
  "存为草稿".

## Visual rules

White surfaces, no boxes: the places are accent text links; sections inside a place have no card
border; fields are single bottom lines; buttons are accent text except the one solid accent button
for the step that saves; the support log and sole-operator history use hairlines between rows only;
type 28 (page title) / 20 (section) / 16 (place links, sub-headings) / 14 (text), weights 600/400.
The wizard's step buttons and footer follow the same rules (they were boxed, with a black save
button). Checked at 1440, 1024 and 390 in en and zh-Hans (`e2e/store-setup-places.spec.ts`,
screenshots in `.local/sim-kit/b18-shots/`).

## Why kitchen setup stays under Store setup

The Owner asked for 后厨 "with the kitchen pages". Section 88 has no kitchen-setup screen, and the
only kitchen page (`KIT-KITCHEN-QUEUE` `/operations/kitchen`) is the cooks' live board, also shown on
the kitchen display; adding setup there would put an Owner's form in front of cooks during service.
So 后厨 is its own place in Store setup, and every page that finds a kitchen problem (Home's
checklist, the menu listing refusal) links straight to it (`#kitchen-setup`). A link from the
Kitchen board for owners is left as a follow-up if the Owner still wants it there.

## Continuity

Nothing here changes what staff do when the network, host or a device fails: each section keeps its
own "could not be loaded / try again" state and its retry-safe operation identity; the draft place
keeps its offline note, recovery of an unconfirmed save and conflict handling.

Related fix in the same branch: the staff pages' offline worker (`public/operations/sw.js`, cache
`bop-merchant-offline-v5`) no longer answers a failed navigation with an empty response when the
offline page is not cached: it shows the store system's own answer, or a short built-in page in both
staff languages.
