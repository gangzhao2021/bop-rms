# Orders and wording (v15 b12)

Status: built 2026-11-13 on `codex/fix-orders-and-wording` (from `295bdd4b`). It covers the
`orders-and-wording` live findings of batch 12. It builds on
[menu-review-roles-orders-wording-b10.md](menu-review-roles-orders-wording-b10.md) and the b11
guest-and-staff wording bundle. All data in tests is synthetic and TEST-only.

## 1. "What goes live" never shows the menu from before a save

Cause: the review is drawn from the menu on screen. After Save, the menu is read again (four reads,
seconds under load), and "List it" stayed enabled while the save was still on its way and while that
read ran. A tap in that window reviewed the menu as it was before the save.

Decision: "List it" waits. It is disabled, with the reason under it, while:

- a dish or combo save (or "Use on other dishes") is on its way: "Saving… List it once the menu
  shows what you saved.";
- the menu read after a save, a section added, a new dish order or a price rebase has not reached the
  screen yet: "Reading the menu again to show what you saved. List it once it shows.";
- that read failed: "List it once the menu is read again and shows what you saved." (with the
  existing Read again).

The review's own List it uses the same rule. We chose this over re-reading inside the review because
an owner who has just saved expects to see that save. A second read path inside the review would
show two versions of the same menu. Polling during a listing and sold-out changes do not hold List
it, because they do not change what the review shows.

## 2. Listing time

Real listings took 10–13 s at v15 load about 4, and 42–82 s when the system was busy. The banner said
"usually takes one to two minutes", which overstates the usual wait. It now says "This usually takes
under a minute, up to two when the system is busy" (zh: 通常不到一分钟，系统忙时最多两分钟). Past two
minutes it still says "Taking longer than usual. Nothing needs doing…". That line also shows after a
reload while the listing marker is between 120 and 180 s old, which is now covered by a unit test.

The listing was not made faster. It is one request that runs each publication step (combos, price
book publish and assign, choice prices, offers, menu list) under the menu-listing-cost budget.
Shortening it means changing the publication workflow's cost, which is out of this bundle's scope.
The wording matches what was measured.

## 3. A paper order entered again (DEC-PAPER-ORDER-NEVER-RELEASED)

The badge and summary already said "Paid on paper · entered again". Three places still read it as an
unpaid or cancelled sale:

| Where               | Before                    | Now                                                                               |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Row money column    | "— No payment recorded"   | "— Paid on paper · its sale is on order 85" (纸单已付款 · 这笔销售记在订单 85 上) |
| Record section      | "Cancelled — You · 01:12" | "Closed · entered again as order 85 — You · 01:12" (已关闭 · 已重新录入为订单 85) |
| Order status filter | listed under Cancelled    | its own choice "Paid on paper · entered again"; never under Cancelled             |

Its money is never shown on the old order. The sale and its payment are on the new order, and
counting it twice would overstate the day. The record keeps who closed it and when. Only the word
changes: it is the same append-only closing.

## 4. Why a pickup contact was removed

The staff order detail gave one reason for every removal: "(contacts are kept only for a limited
time)". It now reads the reason from the removal evidence row's `policy_code`. That column already
exists (2000_049, 2000_450), and the pilot api already holds SELECT on the table:

- `CUSTOMER_REQUEST`: "The customer removed their contact on {date}, from their order page."
- `STAFF_ON_CUSTOMER_REQUEST`: "Staff removed the customer's contact on {date}, at the customer's
  request."
- `CHECKOUT_CONTACT_RETENTION`: unchanged, with the limited-time reason.

The value itself is never read or shown. The detail answer adds `because` (Retention, GuestAsked or
StaffOnGuestRequest). The browser refuses a Removed contact that has no reason. API and web ship in
one image.

## 5. Option recipes: "the Brand had one Store then"

A review given alone under SingleStoreListing was correct when it was given. The present tense
"(the Brand has one Store)" became false once the Brand opened more Stores. The suffix now says it as
at the review: "(the Brand had one Store then)" / （当时品牌只有一家门店）. The header still states the
rule in the present tense, because the rule itself has not changed.

## 6. A sign-in that ended mid-page

When the screen's sign-in ends (pushed out by the concurrent-session limit, or timed out), the fetch
gate sends nothing and rejects the request. Pages read that rejection as a dropped connection and
said "Check the Wi-Fi", and Try again sent nothing. Now:

- The gate marks its rejection (`isStaffSignInEndedRefusal`).
- Option recipes maps a marked rejection to `SignedOut`. It also treats a 403 refusal while the
  screen is signed out as `SignedOut`, never as no access.
- `PageDidNotLoad` (every back-office page that uses it) says "Your sign-in on this screen has ended, so this page wasn't read.
  Sign in again to keep working. Nothing you saved is affected." whenever the screen is signed out.
  It shows the Sign in again link and reads again by itself once the sign-in works again (Check
  again on the cover).

A real outage still reads as an outage. Only a sign-in the session guard confirmed ended (401
`session_ended`) changes the wording.

## 7. Cookies and CSRF in logs

Every log path was checked:

- the api request completion log (`http_request_completed` in `api.log`, about 122k lines on v15);
- the guest failure line;
- `MERCHANT_REQUEST_UNEXPECTED` and the other pilot unexpected-failure lines;
- the payment webhook rejection line;
- the front's fixed lines.

Each writes only fixed fields: codes, route templates, statuses and durations. None writes headers,
cookies, bodies or message text. A read-only grep of every v15 log found 0 occurrences of
`__Host-bop-guest`, `__Host-bop-visits`, `cookie` and `csrf`. No code change was needed. Tests now
send real visit cookies and a CSRF value through each path and assert that none of them appears.

## 8. Store features: the real phone refusal

The browser path was proved against a simulated 409. The route now has a test that a real
`STORE_FEATURES_PHONE_REQUIRED` failure answers `409 {"error":"store_features_phone_required"}`. That
is exactly what the page's PhoneRequired reads. The live check uses a TEST store without a phone.
