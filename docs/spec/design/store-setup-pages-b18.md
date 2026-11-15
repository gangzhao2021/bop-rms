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

| Place (en / zh-Hans)                       | Address                    | What it holds                                                                                                                                                             | When a change takes effect                                                                       | Button                                                                            |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Store details / 门店资料                   | `…/setup`                  | Store name customers see (per language), street address, phone                                                                                                            | Live as soon as it is saved                                                                      | Save and make live / 保存并生效                                                   |
| Receipts and tax numbers / 收据与税号      | `…/setup?section=receipts` | Business name on receipts, GST/HST, QST, PST, privacy notice link                                                                                                         | Live as soon as saved, for receipts issued from then on                                          | Save and make live / 保存并生效                                                   |
| Kitchen setup / 后厨                       | `…/setup?section=kitchen`  | Whether every dish reaches the Kitchen screen; the one-step fix                                                                                                           | Live at once, for orders confirmed from then on                                                  | the action itself                                                                 |
| Permissions and safety / 权限与安全        | `…/setup?section=access`   | Platform support access and its log; sole operator and its history                                                                                                        | Live at once, each change recorded                                                               | the action itself (sole operator still needs a reason and the authenticator code) |
| Settings that need approval / 需审批的设置 | `…/setup?section=changes`  | Four steps: time zone and business day; services and order limits; fees, tax, payment and receipt layout; review and publish (the publication of the Store configuration) | Saved as a draft first; live only after it is submitted, approved and published in the last step | Save as draft / 存为草稿, then Submit for review and Publish in step 4            |

Each place opens with one line saying what it holds and when a change there takes effect, and its
section heading is the place's own name (Receipts and tax numbers, Kitchen setup). Store details
says it once: the selected link and the lead "The name, address and phone customers see. A change is
live as soon as you save it." / “顾客看到的店名、地址和电话，保存后立即生效。”; the section has no
second heading or introduction there (it is labelled for screen readers; a first Store's fold still
shows both, `StoreSetupInPlaceContext`). Only the last place talks about drafts; the old header line
"Saving a draft does not change the live Store" and the page-wide "Refresh saved setup" are gone
from the other four ("Restore the last saved draft" / 恢复上次保存的草稿 sits in the draft place only). No button means two things: "保存并生效" always
means live now; "存为草稿" / "提交审批" always mean a draft that needs approval.

### The opening steps only while a Store is opened (b18 review)

The eight-step wizard (身份/地址和时区/服务方式/营业时间/税务和付款/座位数/联系方式/审核) is an
opening wizard. An open Store's approval place shows only the four steps whose settings need approval
there (step indices 1, 2, 4, 7 of the eight, renumbered 1–4):

- Identity is not a step: it only showed facts that are not changed here; the time-zone step says
  which time zone the Store runs on today.
- Opening hours are not a step: they are changed in Hours & ordering (`/service`, its own hours
  editor and approval, already saving an hours-only Store setup change). The place's lead links
  there, and the Hours & ordering editor says "Opening hours are changed here". One place, one
  save model for hours.
- Address (step 2) and Contacts (step 7) are not asked again. The configuration still carries an
  address and contact record; while the saved setup has none (a Store installed before Store setup
  existed), step 4 shows them under "Still needed", already filled in from Store details (the same
  values the first opening page copies, `StoreSetupReferenceEditor` `suggested`), to check, save and
  choose. Once chosen, nothing asks for them again.
- Order limits (Capacity) are asked with the services (step 2).
- Services stay: they are what the Store's configuration offers (needs approval). Turning pickup off
  for a while or pausing ordering are live switches in Store features and Hours & ordering; step 2
  says so with links, so the two are not the same fact edited twice.

Where-to-set texts follow the layout (`storeSetupWhere`), e.g. "Weekly hours: set it in Hours &
ordering", "Order limits: step 2, Services"; a Store being opened keeps the eight step names.

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

- Platform support: what the place says about the log is read from the whole log on the server
  (`summarizeStoreSupportAccess`: how many records, how many looks and the last one, and every
  Changed/Refused record, newest 50 with their count), never from the records on screen, so a change
  older than the newest page is still listed ("What support changed or tried") and counted. Then
  "Support looked at your Store N times, last …". The access log itself only repeats those looks,
  so it is folded (polish, below): "View all N access records" / “查看全部访问记录（N 条）” opens it,
  then "Show earlier records" reads a page of 50 at a time until the first record
  (`GET /merchant/store/support-access?before=<instant to the microsecond>&skip=<n>`,
  `pageStoreSupportAccess`; the log is append-only so a page once read stays the same); "Hide the
  access records" / 收起访问记录 folds it again.
- Sole operator: the newest five changes, "Show all N changes", then "Show earlier changes" 20 at a
  time down to the first (`GET /merchant/organization/sole-operator?before=<change number>`; the
  setting itself is still the latest). "Showing x of N" while not all are on screen. No change
  numbers on screen.

## Polish (Owner, 2026-11-14, Chinese first)

Nothing here changes a command, permission, step-up, approval or log; each item only says a thing
once, or more plainly.

1. Store details: one line (what it is, live once saved) instead of the lead, a heading and a
   paragraph saying the same; label, help text and field sit close (2px apart, a 36px single-line
   field), so the empty "Unit or suite (optional)" no longer leaves a tall gap. The same field
   spacing applies to Receipts and tax numbers.
2. Platform support: the server offers two grants (`changeAccess` `Limited` 1 hour, `Standing`), so
   there are two actions, each a sentence naming its effect and duration, one per line, the shorter
   first: "Let platform support change my settings for the next hour" /
   “允许平台支持在接下来一小时内帮我改设置” and "Let platform support change my settings until I
   turn it off" / “允许平台支持帮我改设置，直到我关闭”, 8px apart so a grant that wraps on a phone
   still reads as one action. "Turn off now" is unchanged.
3. The support access log starts folded (see Logs); every record is still reachable.
4. Sole operator: one lead ("When it is on and there is no second person, you can approve your own
   refunds, prices, menus and other things that need approval." / “开启后，没有第二个人时你可以自己批准
   退款、价格、菜单等需要批准的事。”), the full list behind "What this covers" / 具体包括哪些, and the
   state as one sentence ("Now: Off. Refunds that need approval are approved by a second owner or
   finance member." / “现在：关闭。需要批准的退款由第二位店主或财务人员批准。”, and the on-state
   equivalents, each a state then a full stop: "Now: On and in effect. You are …", "Now: On, but
   not in effect. Mia also holds …", "Now: On, but it has no effect for you. You don't hold …")
   instead of the label grid.
5. Settings that need approval, step 1: an open Store already runs on a time zone and a business
   day start, so while the saved draft has none and nothing was typed, the draft starts from them:
   the time zone from the Store, the business day start from the live configuration, read on step 1
   itself unless this device holds an unconfirmed configuration request waiting to be recovered
   (then nothing reads the live configuration before the recovery does, and the field fills once
   step 3 or 4 has read it). It says "Filled in with the time zone and business day start the Store
   runs on today; saving the draft keeps them." / “已按门店现在使用的时区和营业日开始时间填好，存为
   草稿后保留。” (the time-zone-only sentence while the business day start is not known); "Not
   configured" / 未配置 is offered only while nothing is set. Prefilled values are not unsaved
   changes (no save prompt, "Discard unsaved changes" stays off). Review lists as missing only what
   the Store has no value for, and lists anything set on the page but not in the saved draft under
   "Filled in, not saved yet" / “已填好，尚未保存”: "Save as draft to keep them. Until then,
   publishing below counts them as not set, because it uses the saved draft." The publication panel
   still checks the saved draft and says so ("the saved setup still has …"), so the two agree. A
   Store being opened is unchanged.
6. "Reload the saved draft" is now "Restore the last saved draft" / 恢复上次保存的草稿, a small text
   action under the step controls, shown while nothing is unsaved (with unsaved changes, "Discard
   unsaved changes" is what restores the saved draft). Before the draft has been read, or when the
   read failed, it stays above as the way to read it again.
7. The step controls are ordinary accent text at every width; only a step that truly cannot move
   ("Previous step" on the first step, "Next step" on the last) is grey. On a phone, Previous and
   Next share one line, the solid "Save as draft" is full width under them, and "Discard unsaved
   changes" (placed by its own class, not by its position) under that.

## Wording

- Name fields: "店名（英文）" / "店名（中文）" (en: "Store name customers see (English)"), never the
  browser's "加拿大英语"; each field's example is in its own language ("Maple Noodle House – King
  Street" for English, "枫叶面馆 国王街店" for Chinese). Step 1 shows the Store language as "英语".
- "修订版 26" is gone, and so are "saved Store setup draft 26" on Hours & ordering and "Version N,
  created from saved setup revision 26" on self-approval.
- 厨房线 / 后厨线 are gone from Chinese: "让所有菜都送到后厨", "本店的菜都送到后厨，开始于".
- Save wording: 保存并生效 (live now) and 存为草稿 / 提交审批 (approval), "放弃未保存的修改",
  "已保存并生效。" success lines; every sentence that named the old "保存设置草稿" button now names
  "存为草稿".

## Links into the places

Approvals' sole-operator line opens Permissions and safety (`?section=access#sole-operator`); the
fee basis on Hours & ordering ("Change them in Settings that need approval") opens
`?section=changes`; Store features' "Add phone number" opens Store details.

## Visual rules

White surfaces, no boxes: the places are accent text links; sections inside a place have no card
border; fields are single bottom lines; buttons are accent text except the one solid accent button
for the step that saves; the support log and sole-operator history use hairlines between rows only;
type 28 (page title) / 20 (section) / 16 (place links, sub-headings) / 14 (text), weights 600/400.
The title row ends with the language switch, as on Orders (AppFrame pages hide the shell's own
header in the workspace, so Store setup draws it in its header); "Restore the last saved draft" sits with
the draft (under the step controls since the polish). Sole operator's change is a reason field, then one action
on one line: "Verify to turn it on/off" until the authenticator code is confirmed, then the one
solid button.
The wizard's step buttons and footer follow the same rules (they were boxed, with a black save
button). Checked at 1440, 1024 and 390 in en and zh-Hans (`e2e/store-setup-places.spec.ts`,
screenshots in `.local/sim-kit/b18-shots/`).

## Kitchen setup and the Kitchen pages

The Owner asked for 后厨 "with the kitchen pages". Section 88 has no kitchen-setup screen, and the
only kitchen page (`KIT-KITCHEN-QUEUE` `/operations/kitchen`) is the cooks' live board, also shown on
the kitchen display; adding setup there would put an Owner's form in front of cooks during service.
So 后厨 is its own place in Store setup, and every page that finds a kitchen problem (Home's
checklist, the menu listing refusal) links straight to it (`#kitchen-setup`). The Kitchen board in
the workspace now has the link "Kitchen setup in Store setup" (`?section=kitchen`) for people whose
menu has Store setup (the Owner; a Store Manager reads it); never on the kitchen display. Whether the
Owner wants the setup itself moved onto a kitchen page is for the Owner to decide (deviation recorded
in WP-2423).

## Continuity

Nothing here changes what staff do when the network, host or a device fails: each section keeps its
own "could not be loaded / try again" state and its retry-safe operation identity; the draft place
keeps its offline note, recovery of an unconfirmed save and conflict handling.

Related fix in the same branch: the staff pages' offline worker (`public/operations/sw.js`, cache
`bop-merchant-offline-v5`) no longer answers a failed navigation with an empty response when the
offline page is not cached: it shows the store system's own answer, or a short built-in page in both
staff languages.
