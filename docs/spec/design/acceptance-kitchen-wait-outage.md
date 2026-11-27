# Acceptance, kitchen wait and outage screens (v15 batch-5 live findings)

Status: decided 2026-11-11 under the Owner's standing rules (commercial fidelity, warn before
timeouts, operating continuity). Branch `codex/fix-acceptance-kitchen-wait-outage`.

## 1. Refusing a paid order is a choice beside Accept, not a step before it

Since v15 2026-11-01 every paid order waiting for acceptance is refusable ("Refuse and refund") by
whoever may cancel orders, which is every manager and owner. The Orders list treated "can be
cancelled" as "needs a decision first" and took the row's Accept and **Accept all** away, so at an
outage recovery a manager had to open every order. Decision: the row's Accept and Accept all ignore
the refusal option. Refusing stays in the order's panel. What still keeps an order off the row
(an outage hold, unpaid counter or staff rounds, a card-machine refund owed, ended stock) is
unchanged: each needs its own step first.

## 2. A ticket's wait counts from when the order was placed

The server has sent `placedAt` (when the round was sent) since M120, but the board's reader dropped
it, and dropped the alcohol `checkId` mark too. The reader now passes both through. A ticket's
timer counts from placement. After a slow acceptance the cook sees how long the guest has really
waited.

## 3. The shared tablet's staff list shows every paid order waiting

Elsewhere the refund warning starts 5 minutes before the automatic refund, because staff signed in
there also see the order on Orders and hear the new-order sound. Nobody is signed in on a shared
tablet's staff list, so a paid order stayed invisible there for 25 of its 30 minutes. Decision: the
staff list shows each paid order waiting from the start, quietly ("Order 29 is paid and waiting to
be accepted. It will be refunded automatically in 25 min unless someone accepts it." with "Sign in
to accept it."). It is announced once and does not chime. In the last 5 minutes it becomes the
usual countdown, which chimes at 2 minutes and at 30 seconds. Other screens are unchanged. The
staff list's "Last checked at" uses the Store's time zone from the staff list, not UTC.

## 4. A one-tap add that is still waiting says so

The menu's `+` uses the menu's message line. After 3 s still waiting it reads "Still adding; the
restaurant's system is busy. No need to tap again.", the same text as the dish page. The `+` stays
off, and "Added to your cart." follows.

## 5. The reconnecting page and the offline reload

- The reconnecting page is a page of its own: the title row ends with the language switch, the
  page's margins apply, and **Try now** is a real 44 px button.
- A staff page reloaded with no network comes from the copy kept by the merchant service worker.
  The copy now says **This device is offline / 这台设备没有联网** when nothing answers, and
  "Can't reach the system" when the network works but the system answers 503. It follows the app's
  language choice: the device's own choice, else Chinese only on a Chinese device. Home and the
  other `/app` pages now have the same copy, through `/merchant-app-sw.js` (scope `/app`), which
  runs the same worker code.
- The live check saw the browser's error page because its browser opened the pilot past a
  certificate warning. Chromium never installs a service worker for such a page (reproduced
  locally: "An SSL certificate error occurred when fetching the script"). A device must trust the
  pilot certificate. The runbook says so.

Not changed: the once-seen unstyled reconnecting page (not reproduced). A staff page that can load
still always comes from the network (IDR-0039), so the app's own styles are not kept offline.
