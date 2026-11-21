# Menu, allergen and wording fixes (WP-2423 b9)

Status: accepted under the Owner defaults of 2026-11-06 (decided as commercial choices, not asked).
Source: live findings of batch 9, bundle `menu-allergen-and-wording`.

## Decisions

1. **A dish save is said at the dish.** What a save did ("guests at this Store pay $X from now…")
   shows under that dish's row, where staff were editing, not at the top of a long menu. Only when
   a search or filter hides the dish does it show at the top. A price at this Store only is charged
   from the save on, so staff must see that line where they are looking.
2. **The dish editor never puts back what staff typed.** The first read of a dish fills the form
   once. A later read (the page reading again, a slow read landing after Save) refreshes the
   choice groups only. The menu pages' clients are made once per session token, so the rest of the
   app re-rendering no longer reads the menu and the open dish again.
3. **A save with no answer always goes again as the same operation.** While a save is waiting for
   its answer, Save sends it again unchanged; only with nothing waiting does an unchanged form say
   "nothing to save". Staff then learn what the dropped save did (for example, that the store price
   is live) instead of "nothing changed".
4. **"Adds none" and removing an allergen from a choice reach guests at once, and the save says so.**
   The server reports `allergensShownNow` for an answered-none or removed choice as it already did for
   an added one.
5. **Option recipes reads a Menu-page answer as a declaration.** A choice whose option recipe adds a
   staff-declared stand-in (never stock) reads "Adds no allergens" or "Adds Mustard (declared by
   staff on the Menu page; not a stock item)"; no per-size "1 unit" line is shown for it.
6. **The kitchen ticket's "Modifiers may add allergens" follows the answers.** When staff answered
   every choice on the line since the menu was listed, the line's list (the listed dish's list with
   those answers) names everything those choices add, so the reminder is not shown. A chosen choice
   nobody answered keeps it. "Allergens changed since this menu was listed" is unchanged.
7. **Orders and Home say a hidden dish is off the menu, and count unpaid orders apart.** The order
   row carries the reason its marked lines share (sold out, off the menu, a choice sold out, or
   several). Home counts sold-out orders waiting to be accepted apart from those the guest has not
   paid yet, whose wording asks staff to tell the guest before they pay (nothing is refunded).
8. **A table QR after a pickup visit says nothing about "your earlier cart here".** That note is for
   an ended visit of the same kind at the same Store; the pickup order stays on the phone under its
   own pickup code, as the kept-order note says.
9. **Opening count headings are plain words in the staff's language** ("期初盘点 · 已过账"), without
   the record's English state word or its version number.
