import { t, saidTable, listSeparator, contentName } from "./i18n/i18n.js";
import { SlowWaitNotice } from "./slow-wait.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { Link, useSearchParams } from "react-router";
import { createDiningSessionClient } from "./dining-session-client.js";
import { createTableCartClient, type TableCart, type TableCartLine } from "./table-cart-client.js";
import { validSlipReference } from "./CardMachineRefundAction.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { CounterAwaitingPayment } from "./CounterAwaitingPayment.js";
import { CounterCancelAction } from "./CounterCancelAction.js";
import { CashTenderFields, cashTender } from "./CashTenderFields.js";
import { loadOftenOrdered, recordOrdered } from "./counter-often-ordered.js";
import {
  paidAtDayNote,
  paidAtInstant,
  paidAtRefusal,
  payErrorText,
  paidNoteText,
  paymentUrgentMinutes,
  paymentWindowNotice,
} from "./counter-payment.js";
import {
  CounterOrderClientError,
  counterMenuFamilies,
  counterMenuSearch,
  createCounterOrderClient,
  type CounterMenu,
  type CounterMenuItem,
  type CounterMenuRule,
  type CounterTip,
  type PlacedCounterOrder,
  type TableCartItem,
} from "./staff-order-entry.js";

export { paidAtInstant, payErrorText, paymentUrgentMinutes, paymentWindowNotice };

const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

interface Line {
  readonly key: string;
  readonly item: CounterMenuItem;
  readonly quantity: number;
  readonly options: readonly { optionReference: string; name: string; quantity: number }[];
  /** WP-2423 Q7 slice 2 / M53: the guest's note for the kitchen (table rounds and counter). */
  readonly note?: string | null;
}

/**
 * WP-2423 M53: the counter order's lines as sent: a line's kitchen note goes with it, and a line
 * without one sends no note field at all.
 */
export function counterOrderLines(lines: readonly Line[]) {
  return lines.map((line) => {
    const sent = {
      sellableReference: line.item.sellableReference,
      quantity: line.quantity,
      optionSelections: line.options.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
      })),
    };
    const note = line.note ?? null;
    return note === null ? sent : { ...sent, customerNote: note };
  });
}

/** What staff see for an item: about its base price plus chosen options (the order total decides). */
export function estimatedLineMinor(line: Line): bigint | null {
  if (line.item.priceMinor === null) return null;
  let each = BigInt(line.item.priceMinor);
  for (const chosen of line.options) {
    const option = line.item.rules
      .flatMap((rule) => rule.options)
      .find((candidate) => candidate.optionReference === chosen.optionReference);
    if (option?.priceMinor === null || option === undefined) return null;
    each += BigInt(option.priceMinor) * BigInt(chosen.quantity);
  }
  return each * BigInt(line.quantity);
}

/** WP-2423 M165: a ticket line whose price moved when the menu was read again. */
export interface RepricedLine {
  readonly name: string;
  readonly beforeMinor: bigint;
  readonly afterMinor: bigint;
}

/**
 * WP-2423 M165 review: the chosen options of a line its item no longer offers (left the menu, or
 * not offered now). They stay on the line, named, and the ticket cannot be sent until staff
 * choose again, so the kitchen never gets a dish without the guest's instruction.
 */
export function withdrawnOptions(line: Line): readonly string[] {
  const offered = new Map(
    line.item.rules.flatMap((rule) =>
      rule.options.map((option) => [option.optionReference, option] as const),
    ),
  );
  return line.options
    .filter((chosen) => {
      const option = offered.get(chosen.optionReference);
      return option === undefined || option.offeredNow === false;
    })
    .map((chosen) => chosen.name);
}

/**
 * WP-2423 M165: the ticket's lines on the menu just read, so the subtotal staff see is the price
 * the order is charged at. Each line takes its item's current price and options; a chosen option
 * that is no longer offered is kept on the line (see withdrawnOptions), never dropped quietly. A
 * line whose item left the menu keeps its last item, and the send refuses it by name as before.
 */
export function rebindLines<L extends Line>(
  lines: readonly L[],
  menu: CounterMenu,
): { readonly lines: readonly L[]; readonly repriced: readonly RepricedLine[] } {
  const items = new Map(
    menu.sections.flatMap((section) =>
      section.items.map((item) => [item.sellableReference, item] as const),
    ),
  );
  const repriced: RepricedLine[] = [];
  const next = lines.map((line) => {
    const item = items.get(line.item.sellableReference);
    if (item === undefined) return line;
    const rebound = { ...line, item };
    const before = estimatedLineMinor(line),
      after = estimatedLineMinor(rebound);
    if (before !== null && after !== null && before !== after)
      repriced.push({ name: item.name, beforeMinor: before, afterMinor: after });
    return rebound;
  });
  return { lines: next, repriced };
}

/** How many of each option chosen by default (a choice guests can repeat, such as double pearls). */
function defaultCounts(item: CounterMenuItem) {
  return Object.fromEntries(
    item.rules.flatMap((rule) =>
      rule.options.map((option) => [option.optionReference, option.defaultQuantity || 1]),
    ),
  ) as Record<string, number>;
}

/** Defaults pre-chosen per option group; a group of one choice is a single pick. */
function defaultChoices(item: CounterMenuItem) {
  return Object.fromEntries(
    item.rules.map((rule) => [
      rule.bindingReference,
      rule.options
        .filter((option) => option.selectedByDefault)
        .slice(0, Math.max(rule.maximumSelections, 0))
        .map((option) => option.optionReference),
    ]),
  ) as Record<string, string[]>;
}

/** The group's limit counts each repeat of a choice (two of pearls is two of "at most 3"). */
const chosenInRule = (choices: readonly string[], counts: Readonly<Record<string, number>>) =>
  choices.reduce((sum, reference) => sum + (counts[reference] ?? 1), 0);
/** The group's rule in the words guests see: "Required", "Optional · up to 3", "Choose 1 to 2". */
export function staffChoiceText(
  rule: Pick<CounterMenuRule, "minimumSelections" | "maximumSelections">,
) {
  const { minimumSelections: min, maximumSelections: max } = rule;
  if (min === max) return max === 1 ? t("Required") : t("Required · choose {max}", { max });
  if (min === 0) return max === 1 ? t("Optional") : t("Optional · up to {max}", { max });
  return t("Choose {min} to {max}", { min, max });
}
/**
 * WP-2423 item 3b: how many of one chosen option staff may enter — its own limit, or what the
 * group's total leaves after the other choices, whichever is lower (never below one).
 */
export function repeatLimit(
  rule: CounterMenuRule,
  optionReference: string,
  choices: readonly string[],
  counts: Readonly<Record<string, number>>,
) {
  const option = rule.options.find((candidate) => candidate.optionReference === optionReference);
  if (option === undefined) return 1;
  const others = chosenInRule(
    choices.filter((reference) => reference !== optionReference),
    counts,
  );
  return Math.max(1, Math.min(option.maximumQuantity, rule.maximumSelections - others));
}
export function choicesComplete(
  item: CounterMenuItem,
  choices: Record<string, string[]>,
  counts: Readonly<Record<string, number>> = {},
) {
  return item.rules.every((rule) => {
    const chosen = choices[rule.bindingReference] ?? [];
    const picked = chosenInRule(chosen, counts);
    return (
      picked >= rule.minimumSelections &&
      picked <= rule.maximumSelections &&
      chosen.every((reference) => {
        const option = rule.options.find((candidate) => candidate.optionReference === reference);
        const count = counts[reference] ?? 1;
        return (
          option !== undefined &&
          Number.isSafeInteger(count) &&
          count >= 1 &&
          count <= option.maximumQuantity
        );
      })
    );
  });
}

const menuError: Record<string, [string, string]> = {
  PermissionDenied: [noAccessHeading, pageAccessDeniedText],
  TableUnavailable: [
    t("This table can't take an order now"),
    t("It may be marked unavailable or its session may be closing. Check it on the Tables page."),
  ],
  TableHasNoQr: [
    t("This table has no table QR code yet"),
    t(
      "Orders for a table use its code. Ask a manager to create one on the Table QR codes page, then take the order.",
    ),
  ],
  TableUnknown: [t("Table not found"), t("Open the table from the Tables page to take its order.")],
  Unavailable: [
    t("The menu could not be loaded"),
    t(
      "Try again. If the system stays down, take the order on paper and record it here afterwards.",
    ),
  ],
};

/** WP-2423 (staff-round-soldout): the guests' items staff may take off (can't be served now). */
export function tableCartUnsellable(items: readonly TableCartItem[]): readonly TableCartItem[] {
  return items.filter(
    (item) => item.standing === "Unavailable" || item.standing === "OptionsChanged",
  );
}
/** The items' menu names as staff read them ("Plum juice, Noodles" / "酸梅汤、面"). */
export function tableCartNames(items: readonly TableCartItem[]): string {
  return items.map((item) => item.name).join(listSeparator());
}
/** WP-2423 M06: what staff tell the guests after their unavailable dishes left the round. */
export function tableCartRemovedNote(items: readonly TableCartItem[]): string | null {
  if (items.length === 0) return null;
  const names = tableCartNames(items);
  return items.length === 1
    ? t("Tell the guests: {names} isn't available now, so it was taken off their order.", { names })
    : t("Tell the guests: {names} aren't available now, so they were taken off their order.", {
        names,
      });
}
/** WP-2423 (staff-round-soldout): what a guest's item is marked with, or null when it can be sent. */
export function tableCartMark(item: TableCartItem): string | null {
  if (item.standing === "Unavailable") return t("Sold out or off the menu now");
  if (item.standing === "OptionsChanged") return t("Choices changed on the menu");
  if (item.standing === "Short")
    return (item.available ?? 0) > 0
      ? t("Only {count} left", { count: item.available ?? 0 })
      : t("None left");
  return null;
}

/**
 * WP-2423 M35 (shared-table-cart-staff-round): one of the guests' unsent lines as the staff round
 * screen shows it: named and priced from the menu staff hold (the dish's own name when it is on no
 * current menu), whether it can be sent now, and which phone added it.
 */
export interface GuestCartLine {
  readonly cartItemReference: string;
  readonly name: string;
  readonly options: string;
  readonly quantity: number;
  /** About the line's price before tax from the menu; null when the menu can't say. */
  readonly estimateMinor: bigint | null;
  /** Sold out, off the menu, or one of its choices no longer offered: it can't be sent. */
  readonly unsellable: boolean;
  readonly phoneNumber: number | null;
  readonly phoneLeft: boolean;
}
export type GuestLineDecision = "Send" | "Remove";

export function guestCartLines(
  cart: TableCart | null,
  menu: CounterMenu | null,
): readonly GuestCartLine[] {
  if (cart === null) return [];
  const items = new Map(
    (menu?.sections ?? []).flatMap((section) =>
      section.items.map((item) => [item.sellableReference, item] as const),
    ),
  );
  return cart.lines.map((line: TableCartLine) => {
    const item = items.get(line.sellableReference);
    const offered = item?.rules.flatMap((rule) => rule.options) ?? [];
    const options = line.optionSelections.map((selection) => ({
      selection,
      option: offered.find((option) => option.optionReference === selection.optionReference),
    }));
    const unsellable =
      item === undefined ||
      !item.available ||
      options.some(({ option }) => option === undefined || option.offeredNow === false);
    return Object.freeze({
      cartItemReference: line.cartItemReference,
      name: item?.name ?? contentName(line.names) ?? t("A dish no longer on the menu"),
      options: options
        .map(({ option, selection }) =>
          option === undefined
            ? ""
            : selection.quantity > 1
              ? `${option.name} × ${selection.quantity}`
              : option.name,
        )
        .filter((name) => name !== "")
        .join(", "),
      quantity: line.quantity,
      estimateMinor:
        item === undefined || unsellable
          ? null
          : estimatedLineMinor({
              key: line.cartItemReference,
              item,
              quantity: line.quantity,
              options: options.map(({ option, selection }) => ({
                optionReference: selection.optionReference,
                name: option?.name ?? "",
                quantity: selection.quantity,
              })),
            }),
      unsellable,
      phoneNumber: line.phoneNumber,
      phoneLeft: line.phoneLeft,
    });
  });
}

/** Why a line staff take out leaves (recorded with the removal; no extra tap). */
export function guestRemovalReason(line: GuestCartLine): "CantMake" | "GuestLeft" | "GuestAsked" {
  return line.unsellable ? "CantMake" : line.phoneLeft ? "GuestLeft" : "GuestAsked";
}

/** What staff tell the guests about the lines they took out with the round sent. */
export function guestRemovedNote(removed: readonly GuestCartLine[]): string | null {
  const cantMake = removed.filter((line) => line.unsellable);
  const asked = removed.filter((line) => !line.unsellable);
  const notes = [
    cantMake.length === 0
      ? null
      : tableCartRemovedNote(
          cantMake.map((line) => ({
            cartItemReference: line.cartItemReference,
            name: line.name,
            quantity: line.quantity,
            standing: "Unavailable" as const,
            available: null,
          })),
        ),
    asked.length === 0
      ? null
      : t("Removed from the guests' cart: {names}.", {
          names: asked.map((line) => line.name).join(listSeparator()),
        }),
  ].filter((note): note is string => note !== null);
  return notes.length === 0 ? null : notes.join(" ");
}

/** Who added a guest line, as staff say it ("Phone 2", "Phone 2 has left", "Staff"). */
export function guestLineAdder(line: GuestCartLine): string {
  if (line.phoneNumber === null) return t("Staff");
  return line.phoneLeft
    ? t("Phone {number} has left", { number: String(line.phoneNumber) })
    : t("Phone {number}", { number: String(line.phoneNumber) });
}

export function placeErrorText(
  error: CounterOrderClientError,
  lines: readonly Line[],
  table: string | null = null,
  canCreateTableCode = false,
) {
  switch (error.code) {
    case "TableCartHasItems": {
      const value =
        error.pendingItems.length > 0
          ? ` (${error.pendingItems.map((item) => `${item.quantity} × ${item.name}`).join(", ")})`
          : "";
      // WP-2423 (staff-round-soldout): too few left of a guest's item: only the guests change it
      // (or, with none left, staff mark it sold out, and can then remove it).
      const short = error.pendingItems.find((item) => item.standing === "Short");
      if (error.tableCart !== null && short !== undefined)
        return (short.available ?? 0) > 0
          ? t(
              "{name} has only {count} left. Ask the guests to lower it on their phone, then send again. Nothing was sent or charged.",
              { name: short.name, count: short.available ?? 0 },
            )
          : t(
              "{name} has none left. Ask the guests to remove it on their phone, or mark it sold out, then send again. Nothing was sent or charged.",
              { name: short.name },
            );
      // WP-2423 (staff-round-soldout): a guest's item can't be served now; staff remove it.
      const unsellable = tableCartUnsellable(error.pendingItems);
      if (error.tableCart !== null && unsellable.length > 0) {
        const names = tableCartNames(unsellable);
        if (unsellable.length === 1)
          return error.tableCart.guestsCanSend
            ? t(
                "Guests at this table have items in their shared cart that haven't been sent. {names} can't be served now. Remove it from their order, or ask the guests to change their order on their phone.",
                { names },
              )
            : t(
                "Guests at this table have items in their shared cart that haven't been sent. {names} can't be served now, and guests can no longer send after last orders. Remove it from their order to send this round.",
                { names },
              );
        return error.tableCart.guestsCanSend
          ? t(
              "Guests at this table have items in their shared cart that haven't been sent. {names} can't be served now. Remove them from their order, or ask the guests to change their order on their phone.",
              { names },
            )
          : t(
              "Guests at this table have items in their shared cart that haven't been sent. {names} can't be served now, and guests can no longer send after last orders. Remove them from their order to send this round.",
              { names },
            );
      }
      // WP-2423 item 8 ⑦ (v15 finding t): staff add them to this round; asking the guests only
      // while they can still send (not after last orders).
      if (error.tableCart !== null)
        return error.tableCart.guestsCanSend
          ? t(
              "Guests at this table have items in their shared cart that haven't been sent{value}. Add them to this round, or ask the guests to send or remove them on their phone.",
              { value },
            )
          : t(
              "Guests at this table have items in their shared cart that haven't been sent{value}, and guests can no longer send them after last orders. Add them to this round to order them.",
              { value },
            );
      return t(
        "Guests at this table have items in their shared cart that haven't been sent{value}. Ask them to send or remove those items on their phone, then send this order again.",
        { value },
      );
    }
    case "TableCheckoutInProgress":
      return t(
        "A guest at this table is ordering or paying on their phone. Wait a minute, then send again.",
      );
    case "TableUnavailable":
      return t(
        "{value} can't take an order now (marked unavailable, or its session is closing). Check the table on the Tables page.",
        { value: table ?? "This table" },
      );
    case "TableHasNoQr":
      return t(
        "{value} has no table QR code, so orders can't be taken for it yet. Nothing was sent or charged. {value2}",
        {
          value: table ?? "This table",
          value2: canCreateTableCode
            ? "Create one on Table QR codes (it can be printed later), then send the order again."
            : "Ask a manager to create one on the Table QR codes page, then send the order again.",
        },
      );
    case "ItemUnavailable": {
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      // WP-2423 (staff-round-soldout): the dish is sold, the choices made for it no longer fit.
      if (line && error.optionsChanged)
        return t(
          "{name}'s choices changed on the menu. Remove it, add it again with the new choices, then send. Nothing was sent or charged.",
          { name: line.item.name },
        );
      // WP-2423: each item could be made on its own, but not together (they share an ingredient).
      if (line && error.sharedStock)
        return t(
          "There isn't enough left to make {name} with the rest of this order (other items use the same ingredients). Remove {name2} or change the other items, then send again. Nothing was sent or charged.",
          { name: line.item.name, name2: line.item.name },
        );
      return line
        ? t(
            "{name} can't be sold right now (sold out or off the menu). Remove it and send again. Nothing was sent or charged.",
            { name: line.item.name },
          )
        : t(
            "An item can't be sold right now (it may have just sold out). Check the order and send again. Nothing was sent or charged.",
          );
    }
    case "ItemShort": {
      // v15 run: name the short item and how many are left; the order stays as entered.
      const line = error.lineIndex === null ? undefined : lines[error.lineIndex];
      const left = error.available ?? 0;
      if (line === undefined)
        return t(
          "An item has only {left} left. Remove it and add {left2} back, then send again. Nothing was sent or charged.",
          { left: left, left2: left },
        );
      // WP-2423: short only because other items in the order use the same ingredients.
      if (error.sharedStock)
        return t(
          "Only {left} {name} can be made with the rest of this order (other items use the same ingredients). Lower {name2} to {left2} or change the other items, then send again. Nothing was sent or charged.",
          { left: left, name: line.item.name, name2: line.item.name, left2: left },
        );
      const options = (entry: Line) =>
        JSON.stringify(
          entry.options.map((option) => [option.optionReference, option.quantity]).sort(),
        );
      const ordered = lines
        .filter(
          (other) =>
            other.item.sellableReference === line.item.sellableReference &&
            options(other) === options(line),
        )
        .reduce((sum, other) => sum + other.quantity, 0);
      return t(
        "Only {left} {name} left, {ordered} in this order. Remove {name2} and add {left2} back, then send again. Nothing was sent or charged.",
        { left: left, name: line.item.name, ordered: ordered, name2: line.item.name, left2: left },
      );
    }
    case "StoreNotTakingOrders":
      return table !== null
        ? t(
            "The store is closed, so no new table orders can be taken now. A paper order taken earlier can still be entered under Paper order.",
          )
        : t(
            "Pickup hours are over, so the counter can't take a new order now. A paper order taken earlier can still be entered under Paper order.",
          );
    case "TipsOff":
      return t(
        "Tips are turned off for this store, so nothing was sent or charged. Send it again with no tip.",
      );
    case "TipChoicesChanged":
      return t(
        "The store's tip choices just changed, so nothing was sent or charged. Choose the tip again and send.",
      );
    // WP-2423 item 13 ② (Owner 2026-11-05): only new guests stop; what is open carries on.
    case "NewGuestsPaused":
      return table !== null
        ? t(
            "New guests are paused for this restaurant by the platform, so no new table can be opened. Tables already seated carry on as usual: serve, take payment and refund. Ask the owner about it.",
          )
        : t(
            "New guests are paused for this restaurant by the platform, so the counter can't take a new order. Nothing was sent or charged. Orders already placed carry on as usual: prepare, hand over and refund them. Ask the owner about it.",
          );
    case "CounterOrderingOff":
      return t(
        "Counter ordering is turned off for this store, so nothing was sent or charged. The owner can turn it back on in Store features.",
      );
    case "NotPriced":
      return t("This order could not be priced. Check the items and options and send again.");
    case "NotFinished":
      return t("This order didn't go through and nothing was charged. Send it again.");
    case "InProgress":
      return t("This order is still being sent. Wait a moment, then send again to see it.");
    case "PermissionDenied":
      return t("Your session can't take counter orders. Sign in again or ask a manager.");
    case "OutcomeUnknown":
      return t("No answer from the system. Send again — the same order is never created twice.");
    case "NoPickupTimes":
      return t(
        "Pickup times have run out in the system, so no pickup order can be entered right now. Nothing was sent or charged. Take this order on paper and charge it on the card machine, then enter it under Paper order once pickup times are back. Tell a manager — Home shows the alert.",
      );
    // WP-2423 M03: these dishes went into an order already; never charge them a second time.
    case "AlreadyOrdered":
      return error.placedOrderNumber !== null
        ? t("Already ordered as order {number}. Nothing new was charged. Open it in Orders.", {
            number: error.placedOrderNumber,
          })
        : t("These items are already in an order. Nothing new was charged. Open it in Orders.");
    case "SystemProblem":
      return table !== null
        ? t(
            "The system couldn't send this round for {table} (a problem on our side, not with the order). Nothing was sent to the kitchen or charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
            { table: table },
          )
        : t(
            "The system couldn't place this order (a problem on our side, not with the order). Nothing was charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
          );
    default:
      // WP-2423: e.g. no order can be priced right now; Home shows the alert and what to do.
      return t(
        "The order could not be sent. Check the order and try again. If it keeps failing, check Home for an alert and take the order on paper.",
      );
  }
}

/** v15 run: how often the counter menu re-reads what the store can sell while staff build an order. */
export const MENU_REFRESH_MS = 30_000;
/** WP-2423 M35: how often the table's unsent guest lines are read while staff build a round. */
export const GUEST_CART_REFRESH_MS = 5_000;

/**
 * WP-2423 Q7 (OPS-ORDER-ENTRY, DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the
 * counter for a customer without a phone, or enter a paper order taken while the system was down.
 * The order uses the same menu, sold-out state, prices and tax as the customer app; the store's
 * own card machine takes the payment (no cash) and staff record it here.
 */
/**
 * WP-2423 (staff-round-soldout): the guests' unsent items, each marked when it can't be sent, and
 * what staff can do with them: add them to this round, or first take off the ones that can't be
 * served (the server removes only those, and only while they still can't be sold). An item with
 * too few left is the guests' to change, so it offers nothing.
 */
export function TableCartOfferActions({
  offer,
  disabled,
  onSend,
}: {
  readonly offer: { readonly items: readonly TableCartItem[] };
  readonly disabled: boolean;
  readonly onSend: (removeUnavailable: readonly TableCartItem[]) => void;
}) {
  const unsellable = tableCartUnsellable(offer.items);
  const short = offer.items.some((item) => item.standing === "Short");
  const names = tableCartNames(unsellable);
  return (
    <>
      {offer.items.length > 0 ? (
        <ul className="counter-order__table-cart" aria-label={t("Guests' items not sent yet")}>
          {offer.items.map((item) => {
            const mark = tableCartMark(item);
            return (
              <li key={item.cartItemReference}>
                <span>
                  {t("{quantity} × {name}", { quantity: item.quantity, name: item.name })}
                </span>
                {mark !== null ? (
                  <span className="order-accept-by" data-tier="warning">
                    {mark}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {short ? null : (
        <p>
          <button
            type="button"
            className="counter-order__primary counter-order__table-cart-action"
            disabled={disabled}
            onClick={() => onSend(unsellable)}
          >
            {unsellable.length === 0
              ? t("Add them to this round")
              : unsellable.length === offer.items.length
                ? t("Remove {names} and send this round", { names })
                : t("Remove {names} and add the rest to this round", { names })}
          </button>
        </p>
      )}
    </>
  );
}

export function StaffOrderEntryPage({
  storeLabel,
  storeReference = storeLabel,
  csrf,
  timeZone,
  tableQrHref,
  fetcher,
}: {
  readonly storeLabel: string;
  /** Which Store this tablet's often-ordered dishes belong to. */
  readonly storeReference?: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  /** Where staff who can create table QR codes do so (same rule as the Tables page), if allowed. */
  readonly tableQrHref?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createCounterOrderClient(csrf, fetcher), [csrf, fetcher]);
  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): opened from the Tables page for one table.
  const [searchParams] = useSearchParams();
  const requestedTable = searchParams.get("table");
  const tableReference =
    requestedTable !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestedTable)
      ? requestedTable
      : null;
  const tableMode = requestedTable !== null;
  const [tableLabel, setTableLabel] = useState<string | null>(null);
  // DEC-DINE-IN-PAY-LATER: the table pays once at the end — no tip and no charge per round.
  const [tablePaysLater, setTablePaysLater] = useState(false);
  const [menu, setMenu] = useState<
    { kind: "Loading" } | { kind: "Error"; code: string } | { kind: "Ready"; menu: CounterMenu }
  >({ kind: "Loading" });
  const [reload, setReload] = useState(0);
  const [lines, setLines] = useState<readonly Line[]>([]);
  /** WP-2423 M165: ticket lines whose price changed on the last menu read (until the next edit). */
  const [repriced, setRepriced] = useState<readonly RepricedLine[]>([]);
  const linesNow = useRef(lines);
  linesNow.current = lines;
  const [choosing, setChoosing] = useState<{
    item: CounterMenuItem;
    choices: Record<string, string[]>;
    /** How many of each chosen option, where guests can take more than one of the same choice. */
    counts: Record<string, number>;
    quantity: number;
    note: string;
    /** The order line being changed; null for a new line. */
    editing: string | null;
  } | null>(null);
  const [search, setSearch] = useState("");
  // Read once per visit, so the dishes staff reach for stay where they are while they work.
  const [oftenOrdered] = useState(() => loadOftenOrdered(storeReference));
  const [activeSection, setActiveSection] = useState<string | null>(null);
  // "0": no tip; a percentage the Store offers, as text; or an amount typed in.
  const [tip, setTip] = useState<string>("0");
  const [customTip, setCustomTip] = useState("");
  const [paper, setPaper] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const [slip, setSlip] = useState("");
  // WP-2423 M52 (DEC-COUNTER-CASH): how the counter guest pays, and the cash they handed over.
  const [tender, setTender] = useState<"CardMachine" | "Cash">("CardMachine");
  const [received, setReceived] = useState("");
  const [changeDue, setChangeDue] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedCounterOrder | null>(null);
  const [phase, setPhase] = useState<
    "Building" | "Sending" | "Charge" | "Recording" | "Paid" | "Accepted" | "Sent"
  >("Building");
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const [problem, setProblem] = useState<string | null>(null);
  const [problemNeedsTableCode, setProblemNeedsTableCode] = useState(false);
  // WP-2423 item 8 ⑦: the guests' unsent items the server named, to add to this round.
  const [tableCartOffer, setTableCartOffer] = useState<{
    readonly cartVersion: number;
    readonly items: readonly TableCartItem[];
  } | null>(null);
  // WP-2423 (staff-round-soldout): the guests' items taken off with the round sent, to tell them.
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  // WP-2423 M35: the table's dining session (from the Tables list), the guests' unsent lines read
  // from it before staff send, and what staff decided for each (Send unless it can't be sent).
  const [tableSession, setTableSession] = useState<string | null>(null);
  const [guestCart, setGuestCart] = useState<TableCart | null>(null);
  const [guestCartFailed, setGuestCartFailed] = useState(false);
  const [guestDecisions, setGuestDecisions] = useState<Readonly<Record<string, GuestLineDecision>>>(
    {},
  );
  const tableCartClient = useMemo(() => createTableCartClient(fetcher), [fetcher]);
  const guestRead = useRef<AbortController | null>(null);
  const [paidNote, setPaidNote] = useState<string | null>(null);
  // WP-2423 (v15 751dd768): re-read the sent, unpaid counter orders after a send or a payment.
  const [awaitingKey, setAwaitingKey] = useState(0);
  // WP-2423 M127: the order being charged may be cancelled by this staff member (from Orders' read).
  const [placedCancellable, setPlacedCancellable] = useState(false);
  const placeOperation = useRef<string | null>(null);
  // One operation per payment as staff entered it (as at table checkout): a retry after no answer
  // with the same details is the same command (never counted twice); a corrected paid-at or slip is
  // a new one, not a conflict with the first.
  const payOperation = useRef<{ key: string; reference: string } | null>(null);
  // WP-2423 (v15 fabf0261): the server refused the paid-at itself; staff correct it in the charge
  // step, where it is shown, and record again.
  const [paidAtRefused, setPaidAtRefused] = useState(false);
  const [focusPaidAt, setFocusPaidAt] = useState(0);
  const chargePaidAt = useRef<HTMLInputElement>(null);
  const chargeHeading = useRef<HTMLHeadingElement>(null);
  const ticketHeading = useRef<HTMLHeadingElement>(null);
  const chooseHeading = useRef<HTMLHeadingElement>(null);
  const chooseDialog = useRef<HTMLDialogElement>(null);
  // WP-2423 item 5: the clock behind the payment-time warning, ticking while payment is due.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "Charge" && phase !== "Recording") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const controller = new AbortController();
    setMenu({ kind: "Loading" });
    if (tableMode && tableReference === null) {
      setMenu({ kind: "Error", code: "TableUnknown" });
      return () => controller.abort();
    }
    const loadTable = async () => {
      if (tableReference === null) return;
      // The table's name as staff know it, from the Tables list (paged, at most 500 tables).
      const tables = createDiningSessionClient(fetcher);
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await tables.tables(csrf, after, controller.signal);
        const found = result.items.find((table) => table.tableReference === tableReference);
        if (found !== undefined) {
          if (found.lifecycle !== "Published" || found.operationalState !== "Available")
            throw new CounterOrderClientError("TableUnavailable");
          if (found.qrCodeValidUntil === null) throw new CounterOrderClientError("TableHasNoQr");
          setTableLabel(found.stableLabel);
          setTablePaysLater(found.paymentTiming === "PayLater");
          setTableSession(found.currentDiningSessionReference);
          return;
        }
        if (result.next === null) break;
        after = result.next;
      }
      throw new CounterOrderClientError("TableUnavailable");
    };
    Promise.all([client.loadMenu(controller.signal, tableMode ? "DineIn" : "Pickup"), loadTable()])
      .then(([value]) => {
        if (!controller.signal.aborted) setMenu({ kind: "Ready", menu: value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMenu({
          kind: "Error",
          code:
            error instanceof CounterOrderClientError &&
            (error.code === "PermissionDenied" ||
              error.code === "TableUnavailable" ||
              error.code === "TableHasNoQr")
              ? error.code
              : "Unavailable",
        });
      });
    return () => controller.abort();
  }, [client, reload, csrf, fetcher, tableMode, tableReference]);
  useEffect(() => {
    if (phase === "Charge" || phase === "Sent") chargeHeading.current?.focus();
  }, [phase]);
  // After the charge heading takes focus on returning to Charge: a refused paid-at takes it instead.
  useEffect(() => {
    if (focusPaidAt === 0) return;
    chargePaidAt.current?.focus();
    chargePaidAt.current?.select?.();
  }, [focusPaidAt]);
  // The item's options open over the menu (a sheet on a phone), so the order stays where it is.
  const choosingItem = choosing?.item.sellableReference ?? null;
  useEffect(() => {
    if (choosingItem === null) return;
    const dialog = chooseDialog.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    chooseHeading.current?.focus();
  }, [choosingItem]);
  // The category bar follows the menu as it scrolls.
  const sectionKeys =
    menu.kind === "Ready"
      ? menu.menu.sections.map((section) => section.sectionReference).join()
      : "";
  useEffect(() => {
    if (sectionKeys === "" || search !== "" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen = entries.find((entry) => entry.isIntersecting);
        if (seen) setActiveSection(seen.target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const key of sectionKeys.split(",")) {
      const section = document.getElementById("counter-section-" + key);
      if (section !== null) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [sectionKeys, search]);

  // v15 run: what the store can sell changes with every order (stock used, items sold out), so
  // the menu is re-read quietly after each send or payment, every 30 s while staff build an
  // order, and when the screen comes back into view. A failed re-read keeps the last menu (the
  // server still refuses an item that ran out, naming it); it never blanks the order in progress.
  const menuRefresh = useRef<AbortController | null>(null);
  const refreshMenu = useCallback(() => {
    menuRefresh.current?.abort();
    const controller = new AbortController();
    menuRefresh.current = controller;
    client
      .loadMenu(controller.signal, tableMode ? "DineIn" : "Pickup")
      .then((value) => {
        if (controller.signal.aborted) return;
        setMenu((current) => (current.kind === "Ready" ? { kind: "Ready", menu: value } : current));
        // WP-2423 M165: the ticket follows the menu just read; staff see what changed before
        // anything is sent, and a changed ticket is a new order intent.
        const rebound = rebindLines(linesNow.current, value);
        if (rebound.repriced.length > 0 && phaseNow.current === "Building") {
          placeOperation.current = null;
          setLines(rebound.lines);
          setRepriced(rebound.repriced);
        } else if (phaseNow.current === "Building") setLines(rebound.lines);
      })
      .catch(() => undefined);
  }, [client, tableMode]);
  useEffect(() => () => menuRefresh.current?.abort(), []);
  const menuReady = menu.kind === "Ready";
  // v15 cbff9d6f: no menu re-reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!menuReady || !live || phase !== "Building") return;
    const timer = setInterval(refreshMenu, MENU_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshMenu();
    };
    window.addEventListener("focus", refreshMenu);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshMenu);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, menuReady, phase, refreshMenu]);

  // WP-2423 M35: the guests' unsent lines are on screen before staff send: read as soon as the
  // table is known, every 5 s while the screen is in view, and once more when it comes back. A
  // failed read keeps the last list and says so (the send is still checked by the server).
  // A table that was free when this screen opened may have been seated since.
  const findTableSession = useCallback(async () => {
    if (tableReference === null) return;
    try {
      const tables = createDiningSessionClient(fetcher);
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await tables.tables(csrf, after);
        const found = result.items.find((table) => table.tableReference === tableReference);
        if (found !== undefined) {
          setTableSession(found.currentDiningSessionReference);
          return;
        }
        if (result.next === null) return;
        after = result.next;
      }
    } catch {
      // Read again with the next send; the server still checks the cart.
    }
  }, [csrf, fetcher, tableReference]);
  const readGuestCart = useCallback(() => {
    if (tableSession === null) return;
    guestRead.current?.abort();
    const controller = new AbortController();
    guestRead.current = controller;
    tableCartClient
      .read(csrf, tableSession, controller.signal)
      .then((cart) => {
        if (controller.signal.aborted) return;
        setGuestCart(cart);
        setGuestCartFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGuestCartFailed(true);
      });
  }, [csrf, tableCartClient, tableSession]);
  useEffect(() => () => guestRead.current?.abort(), []);
  useEffect(() => {
    if (!tableMode || tableSession === null || !live || phase !== "Building") return;
    readGuestCart();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") readGuestCart();
    }, GUEST_CART_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") readGuestCart();
    };
    window.addEventListener("focus", readGuestCart);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", readGuestCart);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, phase, readGuestCart, tableMode, tableSession]);
  const guestLines = useMemo(
    () => guestCartLines(guestCart, menu.kind === "Ready" ? menu.menu : null),
    [guestCart, menu],
  );
  // A line that can't be sent is taken out unless staff choose otherwise (they can't send it);
  // every other line goes with the round unless staff take it out.
  const decisionOf = (line: GuestCartLine): GuestLineDecision =>
    line.unsellable ? "Remove" : (guestDecisions[line.cartItemReference] ?? "Send");
  const guestSent = guestLines.filter((line) => decisionOf(line) === "Send");
  const guestRemoved = guestLines.filter((line) => decisionOf(line) === "Remove");
  const decide = (line: GuestCartLine, decision: GuestLineDecision) => {
    placeOperation.current = null;
    setProblem(null);
    setGuestDecisions((current) => ({ ...current, [line.cartItemReference]: decision }));
  };

  // Any change to what is ordered is a new order intent.
  const changeLines = (next: readonly Line[]) => {
    placeOperation.current = null;
    setRepriced([]);
    setProblem(null);
    setProblemNeedsTableCode(false);
    setLines(next);
  };
  const itemPrice = (item: CounterMenuItem) =>
    item.available
      ? item.priceMinor === null
        ? t("Price at checkout")
        : cad(item.priceMinor)
      : t("Sold out");
  const canAdd = (item: CounterMenuItem) => item.available && ordering && item.priceMinor !== null;
  // An item with nothing to choose goes straight onto the order (one more of the same line); one
  // with options opens its choices first, the usual ones already picked. A kitchen note is added
  // with Change on the order line (WP-2423 M53: at the counter too).
  const add = (item: CounterMenuItem) => {
    if (item.rules.length > 0) {
      setChoosing({
        item,
        choices: defaultChoices(item),
        counts: defaultCounts(item),
        quantity: 1,
        note: "",
        editing: null,
      });
      return;
    }
    const same = lines.find(
      (line) =>
        line.item.sellableReference === item.sellableReference &&
        line.options.length === 0 &&
        (line.note ?? null) === null,
    );
    changeLines(
      same
        ? lines.map((line) =>
            line.key === same.key ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [
            ...lines,
            { key: serviceOperationReference(), item, quantity: 1, options: [], note: null },
          ],
    );
  };
  // WP-2423 item 8 ⑦ (Owner decision 11): the Store's own percentages; with tips off, no tip.
  const tips = menu.kind === "Ready" ? menu.menu.tips : null;
  const tipOptions = tips === null || !tips.enabled ? [] : ["0", ...tips.tierPercents.map(String)];
  useEffect(() => {
    if (tip !== "Custom" && tip !== "0" && tips !== null && !tipOptions.includes(tip)) setTip("0");
  }, [tip, tips, tipOptions]);
  const tipChoice = (): CounterTip | null => {
    if (tip === "0" || tablePaysLater || tips?.enabled === false) return { kind: "None" };
    if (tip !== "Custom") return { kind: "Percent", percent: Number(tip) };
    const match = /^(0|[1-9][0-9]{0,4})(?:\.([0-9]{1,2}))?$/u.exec(customTip.trim());
    if (!match) return null;
    return {
      kind: "Amount",
      amountMinor: String(Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"))),
    };
  };
  const paperInstant = paper ? paidAtInstant(paidAt, Date.now(), timeZone) : null;
  const estimate = lines.reduce<bigint | null>((sum, line) => {
    const value = estimatedLineMinor(line);
    return sum === null || value === null ? null : sum + value;
  }, 0n);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  // WP-2423 M165 review: chosen options the menu just read no longer offers, by dish.
  const withdrawn = lines.flatMap((line) => {
    const options = withdrawnOptions(line);
    return options.length > 0 ? [{ dish: line.item.name, options }] : [];
  });
  // WP-2423 M35: the guests' lines sent with the round, about their price from the menu.
  const guestEstimate = guestSent.reduce<bigint | null>(
    (sum, line) => (sum === null || line.estimateMinor === null ? null : sum + line.estimateMinor),
    0n,
  );
  const roundEstimate =
    estimate === null || guestEstimate === null ? null : estimate + guestEstimate;
  const roundCount = itemCount + guestSent.reduce((sum, line) => sum + line.quantity, 0);
  const canSend =
    phase === "Building" &&
    (lines.length > 0 || (tableMode && guestSent.length > 0)) &&
    withdrawn.length === 0 &&
    !(guestCart?.guestPaying === true && guestLines.length > 0) &&
    tipChoice() !== null &&
    (!paper || tablePaysLater || paperInstant !== null);

  const send = async (
    includeTableCart: {
      readonly expectedCartVersion: number;
      readonly removeUnavailable: readonly TableCartItem[];
    } | null = null,
  ) => {
    const chosenTip = tipChoice();
    if (!canSend || chosenTip === null) return;
    // WP-2423 M35: every guest line on screen goes with a decision, against the cart version read.
    const decided =
      includeTableCart === null &&
      tableReference !== null &&
      guestCart !== null &&
      guestCart.lines.length > 0
        ? {
            expectedCartVersion: guestCart.cartVersion,
            lines: guestLines.map((line) =>
              decisionOf(line) === "Send"
                ? { cartItemReference: line.cartItemReference, decision: "Send" as const }
                : {
                    cartItemReference: line.cartItemReference,
                    decision: "Remove" as const,
                    reason: guestRemovalReason(line),
                  },
            ),
          }
        : null;
    const removedAtSend = guestRemoved;
    placeOperation.current ??= serviceOperationReference();
    setPhase("Sending");
    setProblem(null);
    setProblemNeedsTableCode(false);
    setTableCartOffer(null);
    setRemovedNote(null);
    try {
      const chosen = lines.map((line) => ({
        sellableReference: line.item.sellableReference,
        quantity: line.quantity,
        optionSelections: line.options.map((option) => ({
          optionReference: option.optionReference,
          quantity: option.quantity,
        })),
      }));
      const order =
        tableReference !== null
          ? await client.placeTableRound({
              operationReference: placeOperation.current,
              tableReference,
              lines: chosen.map((line, index) => ({ ...line, note: lines[index]?.note ?? null })),
              tip: chosenTip,
              recordedAfterOutage: paper,
              ...(decided !== null
                ? { includeTableCart: decided }
                : includeTableCart === null
                  ? {}
                  : {
                      includeTableCart: {
                        expectedCartVersion: includeTableCart.expectedCartVersion,
                        ...(includeTableCart.removeUnavailable.length === 0
                          ? {}
                          : {
                              removeUnavailable: includeTableCart.removeUnavailable.map(
                                (item) => item.cartItemReference,
                              ),
                            }),
                      },
                    }),
            })
          : await client.placeOrder({
              operationReference: placeOperation.current,
              lines: counterOrderLines(lines),
              tip: chosenTip,
              recordedAfterOutage: paper,
            });
      setPlaced(order);
      if (decided !== null) setRemovedNote(guestRemovedNote(removedAtSend));
      else if (includeTableCart !== null && includeTableCart.removeUnavailable.length > 0)
        setRemovedNote(tableCartRemovedNote(includeTableCart.removeUnavailable));
      setGuestDecisions({});
      recordOrdered(
        storeReference,
        lines.map((line) => [line.item.sellableReference, line.quantity]),
      );
      payOperation.current = null;
      setPhase(order.payLater ? "Sent" : "Charge");
      setAwaitingKey((value) => value + 1);
      refreshMenu();
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      // An unknown or still-running outcome keeps the same operation (a retry returns the same
      // order); anything else starts over as a new order.
      if (failure.code !== "OutcomeUnknown" && failure.code !== "InProgress")
        placeOperation.current = null;
      setProblem(
        placeErrorText(
          failure,
          lines,
          tableLabel === null
            ? null
            : t("Table {tableLabel}", { tableLabel: saidTable(tableLabel) }),
          tableQrHref !== undefined,
        ),
      );
      setProblemNeedsTableCode(failure.code === "TableHasNoQr");
      // WP-2423 M35: with the guests' lines on screen, a cart that changed is read again and
      // staff decide on it as it is now; the server's own list only when it can't be read here.
      const liveList =
        failure.code === "TableCartHasItems" && (decided !== null || guestCart !== null);
      if (failure.code === "TableCartHasItems") {
        if (tableSession === null) void findTableSession();
        else readGuestCart();
      }
      if (liveList)
        setProblem(
          t(
            "Guests changed their cart just now. Check the list again, then send. Nothing was sent or charged.",
          ),
        );
      setTableCartOffer(
        failure.code === "TableCartHasItems" && failure.tableCart !== null && !liveList
          ? { cartVersion: failure.tableCart.cartVersion, items: failure.pendingItems }
          : null,
      );
      if (
        failure.code === "ItemUnavailable" ||
        failure.code === "ItemShort" ||
        failure.code === "TipsOff" ||
        failure.code === "TipChoicesChanged"
      )
        refreshMenu();
      setPhase("Building");
    }
  };

  const recordPayment = async (expectedTotalMinor: string) => {
    if (placed === null || phase !== "Charge") return;
    const inCash = tender === "Cash" && !tableMode;
    const cash = inCash ? cashTender(BigInt(expectedTotalMinor), received) : null;
    if (cash !== null ? !cash.ready : !validSlipReference(slip.trim())) return;
    if (placed.recordedAfterOutage && paperInstant === null) return;
    const takenAt = placed.recordedAfterOutage ? paperInstant : null;
    const tenderedMinor = cash?.receivedMinor?.toString() ?? null;
    const intent = JSON.stringify([
      placed.orderBatchReference,
      expectedTotalMinor,
      inCash ? "" : slip.trim(),
      takenAt,
      tenderedMinor,
    ]);
    if (payOperation.current?.key !== intent)
      payOperation.current = { key: intent, reference: serviceOperationReference() };
    setPhase("Recording");
    setProblem(null);
    setProblemNeedsTableCode(false);
    setPaidAtRefused(false);
    let recorded;
    try {
      recorded = await client.recordPayment({
        operationReference: payOperation.current.reference,
        orderReference: placed.orderReference,
        orderBatchReference: placed.orderBatchReference,
        expectedTotalMinor,
        slipReference: inCash || slip.trim() === "" ? null : slip.trim(),
        takenAt,
        ...(tenderedMinor === null ? {} : { tenderedMinor }),
      });
    } catch (error) {
      const failure =
        error instanceof CounterOrderClientError
          ? error
          : new CounterOrderClientError("Unavailable");
      if (failure.code !== "OutcomeUnknown") payOperation.current = null;
      if (failure.code === "AmountChanged" && failure.totalMinor !== null)
        setPlaced({ ...placed, totalMinor: failure.totalMinor });
      setProblem(payErrorText(failure));
      setPhase("Charge");
      if (placed.recordedAfterOutage && paidAtRefusal(failure)) {
        setPaidAtRefused(true);
        setFocusPaidAt((value) => value + 1);
      }
      return;
    }
    refreshMenu();
    setAwaitingKey((value) => value + 1);
    // WP-2423 D1: the server accepts the paid order or round with the payment record (at the
    // Order's current version), so it reaches the kitchen even if this page is closed now.
    setPhase(recorded.acceptance === "Accepted" ? "Accepted" : "Paid");
    setChangeDue(recorded.cash?.changeMinor ?? null);
    setPaidNote(
      paidNoteText({
        tableMode,
        recordedAfterOutage: placed.recordedAfterOutage,
        acceptance: recorded.acceptance,
        cash: recorded.cash,
      }),
    );
  };

  // WP-2423 M127: "Back to edit": the unpaid order was cancelled (entered by mistake); the same
  // lines, notes and tip stay here to change and send again as a new order.
  const backToEdit = () => {
    setPlaced(null);
    setPaidAt("");
    setSlip("");
    setReceived("");
    setChangeDue(null);
    setProblem(null);
    setPaidNote(null);
    setRemovedNote(null);
    setPaidAtRefused(false);
    placeOperation.current = null;
    payOperation.current = null;
    setPlacedCancellable(false);
    setAwaitingKey((value) => value + 1);
    setPhase("Building");
  };
  const startOver = () => {
    setLines([]);
    setPlaced(null);
    setTip("0");
    setCustomTip("");
    setPaper(false);
    setPaidAt("");
    setSlip("");
    setTender("CardMachine");
    setReceived("");
    setChangeDue(null);
    setProblem(null);
    setProblemNeedsTableCode(false);
    setPaidNote(null);
    setRemovedNote(null);
    setPaidAtRefused(false);
    placeOperation.current = null;
    payOperation.current = null;
    setPhase("Building");
  };

  /** WP-2423 M52: this counter order is being paid in cash (tables pay cash at checkout). */
  const counterCash = tender === "Cash" && !tableMode;
  const pageTitle = tableMode
    ? tableLabel === null
      ? t("Table order")
      : t("Table {tableLabel} order", { tableLabel: saidTable(tableLabel) })
    : t("Counter order");
  if (menu.kind === "Loading")
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading={t("Loading the menu")} status>
          <p>{t("Loading what the store sells now…")}</p>
        </StatePanel>
      </WorkspacePage>
    );
  if (menu.kind === "Error") {
    const [heading, text] = menuError[menu.code] ?? (menuError.Unavailable as [string, string]);
    const createCode = menu.code === "TableHasNoQr" ? tableQrHref : undefined;
    return (
      <WorkspacePage title={pageTitle} meta={storeLabel}>
        <StatePanel heading={heading} tone="error" status>
          {createCode ? (
            // Same rule as the Tables page: staff who can create codes get the link.
            <p>
              {t("Orders for a table use its code. Create one on")}{" "}
              <Link to={createCode}>{t("Table QR codes")}</Link>{" "}
              {t("(it can be printed later), then take the order.")}
            </p>
          ) : (
            <p>{text}</p>
          )}
          {menu.code === "Unavailable" ? (
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              {t("Try again")}
            </button>
          ) : tableMode ? (
            <Link to="/operations/dining">{t("Back to Tables")}</Link>
          ) : (
            <Link to="/app">{t("Back to home")}</Link>
          )}
        </StatePanel>
      </WorkspacePage>
    );
  }

  const ordering = phase === "Building" || phase === "Sending";
  const found = counterMenuSearch(menu.menu.sections, search);
  const often = oftenOrdered.flatMap((reference) =>
    menu.menu.sections
      .flatMap((section) => section.items)
      .filter((item) => item.sellableReference === reference)
      .slice(0, 1),
  );
  const inOrder = (item: CounterMenuItem) =>
    lines
      .filter((line) => line.item.sellableReference === item.sellableReference)
      .reduce((sum, line) => sum + line.quantity, 0);
  const jumpTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  };
  const itemRow = (item: CounterMenuItem) => (
    <li key={item.sellableReference} data-available={item.available}>
      <button
        type="button"
        className="counter-order__item"
        disabled={!canAdd(item)}
        aria-label={t("Add {name}", { name: item.name })}
        onClick={() => add(item)}
      >
        <span className="counter-order__item-name">
          {inOrder(item) > 0 ? (
            <span className="counter-order__in-order">{inOrder(item)} × </span>
          ) : null}
          {item.name}
        </span>
        <span className="counter-order__item-price">{itemPrice(item)}</span>
      </button>
    </li>
  );
  const choosingLine: Line | null =
    choosing === null
      ? null
      : {
          key: choosing.editing ?? serviceOperationReference(),
          item: choosing.item,
          quantity: choosing.quantity,
          options: choosing.item.rules.flatMap((rule) =>
            (choosing.choices[rule.bindingReference] ?? []).map((reference) => {
              const option = rule.options.find(
                (candidate) => candidate.optionReference === reference,
              );
              return {
                optionReference: reference,
                name: option?.name ?? "",
                quantity: choosing.counts[reference] ?? option?.defaultQuantity ?? 1,
              };
            }),
          ),
          // WP-2423 M53: a counter line takes the guest's kitchen note too, as a table round does.
          note: choosing.note.trim() !== "" ? choosing.note.trim() : null,
        };
  const choosingMinor = choosingLine === null ? null : estimatedLineMinor(choosingLine);
  return (
    <WorkspacePage
      title={pageTitle}
      meta={
        tableMode
          ? tablePaysLater
            ? t("{store} · Dine-in · added to the table's bill · the table pays at the end", {
                store: storeLabel,
              })
            : t(
                "{store} · Dine-in · added to the table's order · paid on the store's card machine",
                {
                  store: storeLabel,
                },
              )
          : t("{store} · Pickup · paid on the store's card machine", { store: storeLabel })
      }
      className="counter-order"
    >
      {/* WP-2423 (v15 751dd768): sent counter orders not paid yet, from the server. */}
      {tableMode ? null : (
        <CounterAwaitingPayment
          csrf={csrf}
          timeZone={timeZone}
          fetcher={fetcher}
          refreshKey={awaitingKey}
          excludeOrderReference={
            placed !== null && (phase === "Charge" || phase === "Recording")
              ? placed.orderReference
              : null
          }
          onExcludedCancellable={setPlacedCancellable}
        />
      )}
      <div className="counter-order__layout">
        <section className="counter-order__menu" aria-labelledby="counter-menu-heading">
          <h2 id="counter-menu-heading" className="counter-order__hidden-heading">
            {t("Menu")}
          </h2>
          <div className="counter-order__menu-bar">
            <label className="counter-order__search">
              <span className="counter-order__hidden-heading">
                {t("Search dishes (Chinese or English)")}
              </span>
              <input
                type="search"
                value={search}
                placeholder={t("Search dishes (Chinese or English)")}
                autoComplete="off"
                onChange={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // A keyboard at the counter: Enter adds the one dish left on the list.
                  if (event.key !== "Enter") return;
                  const only = found.flatMap((section) => section.items);
                  if (only.length === 1 && only[0] && canAdd(only[0])) {
                    add(only[0]);
                    setSearch("");
                  }
                }}
              />
            </label>
            {search === "" && menu.menu.sections.length + (often.length > 0 ? 1 : 0) > 1 ? (
              <nav className="counter-order__categories" aria-label={t("Menu categories")}>
                {often.length > 0 ? (
                  <button
                    type="button"
                    aria-current={activeSection === "counter-section-often" ? "true" : undefined}
                    onClick={() => jumpTo("counter-section-often")}
                  >
                    {t("Often ordered")}
                  </button>
                ) : null}
                {menu.menu.sections.map((section) => (
                  <button
                    key={section.sectionReference}
                    type="button"
                    aria-current={
                      activeSection === "counter-section-" + section.sectionReference
                        ? "true"
                        : undefined
                    }
                    onClick={() => jumpTo("counter-section-" + section.sectionReference)}
                  >
                    {section.name}
                  </button>
                ))}
              </nav>
            ) : null}
          </div>
          {menu.menu.sections.length === 0 ? (
            <p className="counter-order__menu-empty">
              {t(
                "Nothing is on the menu right now. Check the menu's hours and items on the Menus page.",
              )}
            </p>
          ) : null}
          {search !== "" && found.length === 0 ? (
            <p className="counter-order__menu-empty" role="status">
              {t("No dish matches “{query}”.", { query: search.trim() })}
            </p>
          ) : null}
          {search === "" && often.length > 0 ? (
            <section
              id="counter-section-often"
              className="counter-order__section"
              aria-label={t("Often ordered")}
            >
              <h3>{t("Often ordered")}</h3>
              <ul className="counter-order__items">{often.map((item) => itemRow(item))}</ul>
            </section>
          ) : null}
          {found.map((section) => (
            <section
              key={section.sectionReference}
              id={`counter-section-${section.sectionReference}`}
              className="counter-order__section"
              aria-label={section.name}
            >
              <h3>{section.name}</h3>
              <ul className="counter-order__items">
                {counterMenuFamilies(section.items).map((family) => {
                  const single = family.sizes.length === 1 ? family.sizes[0]?.item : undefined;
                  if (single !== undefined) return itemRow(single);
                  // Owner 2026-10-26: one row per drink; a tap on a size adds that size.
                  return (
                    <li
                      key={family.key}
                      className="counter-order__family"
                      data-available={family.sizes.some((size) => size.item.available)}
                    >
                      <span className="counter-order__item-name">{family.name}</span>
                      <span className="counter-order__sizes" role="group" aria-label={family.name}>
                        {family.sizes.map((size) => (
                          <button
                            key={size.item.sellableReference}
                            type="button"
                            disabled={!canAdd(size.item)}
                            aria-label={t("Add {name}", { name: size.item.name })}
                            data-available={size.item.available}
                            onClick={() => add(size.item)}
                          >
                            <span>
                              {inOrder(size.item) > 0 ? (
                                <span className="counter-order__in-order">
                                  {inOrder(size.item)} ×{" "}
                                </span>
                              ) : null}
                              {size.label}
                            </span>
                            <span className="counter-order__item-price">
                              {itemPrice(size.item)}
                            </span>
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>

        <section
          id="counter-order-ticket"
          className="counter-order__ticket store-card"
          aria-labelledby="counter-ticket"
        >
          <header className="counter-order__ticket-header">
            <h2 id="counter-ticket" ref={ticketHeading} tabIndex={-1}>
              {t("Order")}
            </h2>
            {itemCount > 0 ? (
              <span className="counter-order__count">
                {itemCount === 1 ? t("1 item") : t("{itemCount} items", { itemCount: itemCount })}
              </span>
            ) : null}
          </header>
          {lines.length === 0 && guestLines.length > 0 ? null : lines.length === 0 ? (
            <div className="counter-order__empty">
              <p className="counter-order__empty-title">{t("No items yet")}</p>
              <p className="bop-muted">{t("Add items from the menu.")}</p>
            </div>
          ) : (
            <ul className="counter-order__lines" aria-label={t("Items in this order")}>
              {lines.map((line) => {
                const each = estimatedLineMinor(line);
                const setQuantity = (quantity: number) =>
                  changeLines(
                    lines.map((other) => (other.key === line.key ? { ...other, quantity } : other)),
                  );
                return (
                  <li key={line.key}>
                    <span className="counter-order__line-name">
                      {line.quantity} × {line.item.name}
                      {line.options.length > 0 ? (
                        <span className="bop-muted">
                          {" "}
                          ·{" "}
                          {line.options
                            .map((option) =>
                              option.quantity > 1
                                ? `${option.name} × ${option.quantity}`
                                : option.name,
                            )
                            .join(", ")}
                        </span>
                      ) : null}
                      {line.note ? (
                        <span className="bop-muted">
                          {" "}
                          {t("· Note: {note}", { note: line.note })}
                        </span>
                      ) : null}
                    </span>
                    <span className="counter-order__line-price">
                      {each === null ? "" : cad(each.toString())}
                    </span>
                    {/* WP-2423 D5: once sent, an item is changed by cancelling it on the order. */}
                    {ordering ? (
                      <span className="counter-order__line-actions">
                        <button
                          type="button"
                          className="counter-order__step"
                          disabled={phase !== "Building" || line.quantity <= 1}
                          aria-label={t("One less {name}", { name: line.item.name })}
                          onClick={() => setQuantity(line.quantity - 1)}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="counter-order__step"
                          disabled={phase !== "Building" || line.quantity >= 99}
                          aria-label={t("One more {name}", { name: line.item.name })}
                          onClick={() => setQuantity(line.quantity + 1)}
                        >
                          +
                        </button>
                        {/* WP-2423 M53: Change also adds a note for the kitchen, at the counter too; it
                            also re-chooses a withdrawn choice. */}
                        <button
                          type="button"
                          className="counter-order__change"
                          disabled={phase !== "Building"}
                          aria-label={t("Change {name}", { name: line.item.name })}
                          onClick={() =>
                            setChoosing({
                              item: line.item,
                              choices: Object.fromEntries(
                                line.item.rules.map((rule) => [
                                  rule.bindingReference,
                                  line.options
                                    .map((option) => option.optionReference)
                                    .filter((reference) =>
                                      rule.options.some(
                                        (option) => option.optionReference === reference,
                                      ),
                                    ),
                                ]),
                              ),
                              counts: {
                                ...defaultCounts(line.item),
                                ...Object.fromEntries(
                                  line.options.map((option) => [
                                    option.optionReference,
                                    option.quantity,
                                  ]),
                                ),
                              },
                              quantity: line.quantity,
                              note: line.note ?? "",
                              editing: line.key,
                            })
                          }
                        >
                          {t("Change")}
                        </button>
                        <button
                          type="button"
                          className="counter-order__remove"
                          disabled={phase !== "Building"}
                          aria-label={t("Remove {name}", { name: line.item.name })}
                          onClick={() =>
                            changeLines(lines.filter((other) => other.key !== line.key))
                          }
                        >
                          {t("Remove")}
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {tableMode && ordering && (guestLines.length > 0 || guestCartFailed) ? (
            <section
              className="counter-order__guest-lines"
              aria-labelledby="counter-guest-lines-heading"
            >
              <h3 id="counter-guest-lines-heading">
                {t("From the guests' phones (not sent yet)")}
              </h3>
              {guestCartFailed ? (
                <p className="order-accept-by" data-tier="warning" role="status">
                  {t(
                    "The guests' cart couldn't be read just now. Sending still checks it, and nothing is sent twice.",
                  )}
                </p>
              ) : null}
              {guestCart?.guestPaying === true && guestLines.length > 0 ? (
                <p className="order-accept-by" data-tier="warning" role="status">
                  {t(
                    "A guest is paying for these dishes on their phone now. Send when they finish, or ask them.",
                  )}
                </p>
              ) : null}
              <ul className="counter-order__lines" aria-labelledby="counter-guest-lines-heading">
                {guestLines.map((line) => {
                  const decision = decisionOf(line);
                  return (
                    <li key={line.cartItemReference} data-decision={decision}>
                      <span className="counter-order__line-name">
                        <span className="counter-order__guest-dish">
                          {t("{quantity} × {name}", { quantity: line.quantity, name: line.name })}
                          {line.options !== "" ? (
                            <span className="bop-muted"> · {line.options}</span>
                          ) : null}
                        </span>
                        <span className="bop-muted"> · {guestLineAdder(line)}</span>
                      </span>
                      <span className="counter-order__line-price">
                        {decision === "Send" && line.estimateMinor !== null
                          ? cad(line.estimateMinor.toString())
                          : ""}
                      </span>
                      <span className="counter-order__line-actions counter-order__guest-choice">
                        {line.unsellable ? (
                          <span className="order-accept-by" data-tier="warning">
                            {t("Sold out or off the menu now. It is taken out.")}
                          </span>
                        ) : decision === "Send" ? (
                          <button
                            type="button"
                            disabled={phase !== "Building"}
                            aria-label={t("Take {name} out of this round", { name: line.name })}
                            onClick={() => decide(line, "Remove")}
                          >
                            {t("Take out")}
                          </button>
                        ) : (
                          <>
                            <span className="bop-muted">{t("Taken out")}</span>
                            <button
                              type="button"
                              disabled={phase !== "Building"}
                              aria-label={t("Send {name} with this round", { name: line.name })}
                              onClick={() => decide(line, "Send")}
                            >
                              {t("Send with this round")}
                            </button>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          <div className="counter-order__ticket-foot">
            {withdrawn.length > 0 && phase === "Building" ? (
              <p className="order-accept-by" data-tier="warning" role="alert">
                {t("No longer offered: {changes}. Tap Change to choose again, or Remove.", {
                  changes: withdrawn
                    .map((line) =>
                      t("{dish} ({options})", {
                        dish: line.dish,
                        options: line.options.join(listSeparator()),
                      }),
                    )
                    .join(listSeparator()),
                })}
              </p>
            ) : null}
            {repriced.length > 0 &&
            estimate !== null &&
            lines.length > 0 &&
            phase === "Building" ? (
              <p className="order-accept-by" data-tier="warning" role="alert">
                {t("Prices updated: {changes}. Subtotal now {subtotal}.", {
                  changes: repriced
                    .map((line) =>
                      t("{dish} {old} → {new}", {
                        dish: line.name,
                        old: cad(line.beforeMinor.toString()),
                        new: cad(line.afterMinor.toString()),
                      }),
                    )
                    .join(listSeparator()),
                  subtotal: cad(estimate.toString()),
                })}
              </p>
            ) : null}
            {tableMode && ordering && guestSent.length > 0 && roundEstimate !== null ? (
              <div className="counter-order__totals">
                {lines.length > 0 && estimate !== null ? (
                  <p className="counter-order__part">
                    <span>{t("Your items")}</span>
                    <span>{cad(estimate.toString())}</span>
                  </p>
                ) : null}
                <p className="counter-order__part">
                  <span>{t("From the guests' phones")}</span>
                  <span>{cad((guestEstimate ?? 0n).toString())}</span>
                </p>
                <p className="counter-order__subtotal">
                  <span>{t("Estimated subtotal")}</span>
                  <span>{cad(roundEstimate.toString())}</span>
                </p>
                <p className="counter-order__estimate">
                  {tablePaysLater
                    ? t(
                        "About {value} before tax. It goes on the table's bill; the table pays once at the end.",
                        { value: cad(roundEstimate.toString()) },
                      )
                    : t(
                        "About {value} before tax and tip. The final total comes when you send the order.",
                        { value: cad(roundEstimate.toString()) },
                      )}
                </p>
              </div>
            ) : (estimate !== null && lines.length > 0) || (placed !== null && !ordering) ? (
              <div className="counter-order__totals">
                {estimate !== null && lines.length > 0 ? (
                  <p className="counter-order__subtotal">
                    <span>{t("Subtotal")}</span>
                    <span>{cad(estimate.toString())}</span>
                  </p>
                ) : null}
                <p className="counter-order__estimate">
                  {placed !== null && !ordering
                    ? placed.payLater
                      ? t("Sent to the kitchen. {totalMinor} with tax goes on the table's bill.", {
                          totalMinor: cad(placed.totalMinor),
                        })
                      : phase === "Paid" || phase === "Accepted"
                        ? t("Sent and paid: {totalMinor} with tax and tip.", {
                            totalMinor: cad(placed.totalMinor),
                          })
                        : placed.recordedAfterOutage
                          ? t(
                              "Sent. This paper order was paid during the outage: don't charge again, record it below.",
                            )
                          : t("Sent. Charge {totalMinor} with tax and tip on the card machine.", {
                              totalMinor: cad(placed.totalMinor),
                            })
                    : tablePaysLater
                      ? t(
                          "About {value} before tax. It goes on the table's bill; the table pays once at the end.",
                          { value: cad((estimate ?? 0n).toString()) },
                        )
                      : t(
                          "About {value} before tax and tip. The final total comes when you send the order.",
                          { value: cad((estimate ?? 0n).toString()) },
                        )}
                </p>
              </div>
            ) : null}
            {tablePaysLater || tipOptions.length === 0 ? null : (
              <fieldset className="counter-order__tip" disabled={!ordering}>
                <legend>{t("Tip")}</legend>
                {tipOptions.map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="counter-tip"
                      checked={tip === value}
                      onChange={() => {
                        placeOperation.current = null;
                        setTip(value);
                      }}
                    />
                    {value === "0" ? t("No tip") : `${value}%`}
                  </label>
                ))}
                <label>
                  <input
                    type="radio"
                    name="counter-tip"
                    checked={tip === "Custom"}
                    onChange={() => {
                      placeOperation.current = null;
                      setTip("Custom");
                    }}
                  />
                  {t("Other amount")}
                </label>
                {tip === "Custom" ? (
                  <label className="counter-order__custom-tip">
                    {t("Tip amount ($)")}
                    <input
                      inputMode="decimal"
                      value={customTip}
                      aria-invalid={tipChoice() === null}
                      onChange={(event) => {
                        placeOperation.current = null;
                        setCustomTip(event.currentTarget.value);
                      }}
                    />
                  </label>
                ) : null}
              </fieldset>
            )}
            <fieldset className="counter-order__paper" disabled={!ordering}>
              <legend className="counter-order__hidden-heading">{t("Paper order")}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={paper}
                  onChange={(event) => {
                    placeOperation.current = null;
                    setPaper(event.currentTarget.checked);
                  }}
                />
                {t("Recorded after an outage (taken on paper)")}
              </label>
              {/* Once sent, the paid-at is shown and corrected in the charge step below. */}
              {paper && !tablePaysLater && ordering ? (
                <label>
                  {t("Paid at (store time, from the paper order)")}
                  <input
                    type="datetime-local"
                    value={paidAt}
                    aria-invalid={paperInstant === null}
                    aria-describedby="counter-paper-hint"
                    onChange={(event) => {
                      placeOperation.current = null;
                      setPaidAt(event.currentTarget.value);
                    }}
                  />
                </label>
              ) : null}
              {paper && !tablePaysLater && ordering ? (
                <p id="counter-paper-hint" className="field-hint">
                  {t(
                    "Within the last 3 days. The order is marked “Recorded after outage” and its payment counts on the day it was paid.",
                  )}
                </p>
              ) : null}
              {paper &&
              !tablePaysLater &&
              ordering &&
              paidAtDayNote(paperInstant, Date.now(), timeZone) ? (
                <p className="order-accept-by" data-tier="warning" role="note">
                  {paidAtDayNote(paperInstant, Date.now(), timeZone)}
                </p>
              ) : null}
            </fieldset>
            {tableMode && ordering ? (
              <p className="field-hint">
                {t(
                  "Sending gives this order its own join code, so a join code you handed out that hasn't been used yet stops working. Guests already at the table stay joined.",
                )}
              </p>
            ) : null}
            {problem !== null && ordering ? <p role="alert">{problem}</p> : null}
            {problem !== null && ordering && tableCartOffer !== null ? (
              <TableCartOfferActions
                offer={tableCartOffer}
                disabled={!canSend}
                onSend={(removeUnavailable) =>
                  void send({ expectedCartVersion: tableCartOffer.cartVersion, removeUnavailable })
                }
              />
            ) : null}
            {problem !== null && ordering && problemNeedsTableCode && tableQrHref !== undefined ? (
              <p>
                <Link to={tableQrHref}>{t("Table QR codes")}</Link>
              </p>
            ) : null}
            {ordering ? (
              <div className="card-actions counter-order__send">
                <button
                  type="button"
                  className="counter-order__primary"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  {phase === "Sending" ? t("Sending…") : t("Send order")}
                </button>
                <SlowWaitNotice busy={phase === "Sending"} />
              </div>
            ) : null}
          </div>
        </section>

        {ordering && (lines.length > 0 || guestSent.length > 0) ? (
          // Phone layout only (CSS): the ticket sits below the menu, so a bottom bar keeps the
          // order's count and estimate in view and takes staff to it to send (with the guests'
          // lines it takes in, WP-2423 M35).
          <div className="counter-order__summary-bar">
            <span className="counter-order__summary-text">
              <span>
                {roundCount === 1 ? t("1 item") : t("{itemCount} items", { itemCount: roundCount })}
              </span>
              {roundEstimate !== null ? <strong>{cad(roundEstimate.toString())}</strong> : null}
            </span>
            <button
              type="button"
              className="counter-order__primary"
              onClick={() => {
                document
                  .getElementById("counter-order-ticket")
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
                ticketHeading.current?.focus({ preventScroll: true });
              }}
            >
              {t("View order")}
            </button>
          </div>
        ) : null}

        {placed !== null && !ordering && placed.payLater ? (
          <section
            className="counter-order__charge store-card"
            aria-labelledby="counter-charge"
            data-phase={phase}
          >
            <h2 id="counter-charge" ref={chargeHeading} tabIndex={-1}>
              {t("Table {value} round sent to the kitchen", {
                value: saidTable(placed.tableLabel ?? tableLabel ?? ""),
              })}
            </h2>
            {removedNote !== null ? (
              <p className="order-accept-by" data-tier="warning" role="note">
                {removedNote}
              </p>
            ) : null}
            <dl>
              <div>
                <dt>{t("Order")}</dt>
                <dd>{placed.orderNumber}</dd>
              </div>
              <div>
                <dt>{t("Round total incl. tax")}</dt>
                <dd>
                  <strong>{cad(placed.orderMinor)}</strong>
                </dd>
              </div>
            </dl>
            <p role="status">
              {t(
                "Nothing to charge now. The round is on the table's bill; the table pays once at the end, tip included.",
              )}
            </p>
            {paper ? (
              <p role="note">
                {t(
                  "It also shows in the kitchen, marked as from a paper slip. If it was already made, the kitchen marks it done and you mark it served.",
                )}
              </p>
            ) : null}
            <div className="card-actions">
              <button type="button" onClick={startOver}>
                {t("Another order for this table")}
              </button>
              <Link to="/operations/dining">{t("Back to Tables")}</Link>
              <Link to="/operations/orders">{t("Open Orders")}</Link>
            </div>
          </section>
        ) : placed !== null && !ordering ? (
          <section
            className="counter-order__charge store-card"
            aria-labelledby="counter-charge"
            data-phase={phase}
          >
            <h2 id="counter-charge" ref={chargeHeading} tabIndex={-1}>
              {phase === "Paid" || phase === "Accepted"
                ? tableMode
                  ? t("Table {value} order paid", {
                      value: saidTable(placed.tableLabel ?? tableLabel ?? ""),
                    })
                  : t("Order {orderNumber} paid", { orderNumber: placed.orderNumber })
                : placed.recordedAfterOutage
                  ? t("Paper order {orderNumber}: record the payment taken during the outage", {
                      orderNumber: placed.orderNumber,
                    })
                  : counterCash
                    ? t("Take {amount} in cash", {
                        amount: cad(
                          cashTender(BigInt(placed.totalMinor), "").cashDueMinor.toString(),
                        ),
                      })
                    : t("Charge {totalMinor} on the card machine", {
                        totalMinor: cad(placed.totalMinor),
                      })}
            </h2>
            {removedNote !== null ? (
              <p className="order-accept-by" data-tier="warning" role="note">
                {removedNote}
              </p>
            ) : null}
            <dl>
              <div>
                <dt>{t("Order")}</dt>
                <dd>{placed.orderNumber}</dd>
              </div>
              <div>
                <dt>{t("Order total incl. tax")}</dt>
                <dd>{cad(placed.orderMinor)}</dd>
              </div>
              <div>
                <dt>{t("Tip")}</dt>
                <dd>{cad(placed.tipMinor)}</dd>
              </div>
              <div>
                <dt>{t("To charge")}</dt>
                <dd>
                  <strong>{cad(placed.totalMinor)}</strong>
                </dd>
              </div>
              {changeDue !== null && (phase === "Paid" || phase === "Accepted") ? (
                <div>
                  <dt>{t("Change to give")}</dt>
                  <dd>
                    <strong>{cad(changeDue)}</strong>
                  </dd>
                </div>
              ) : null}
            </dl>
            {phase === "Charge" || phase === "Recording" ? (
              <>
                {(() => {
                  const notice = paymentWindowNotice({
                    payBy: placed.payBy ?? "",
                    now,
                    tableMode,
                    timeZone,
                  });
                  return (
                    <p
                      className="order-accept-by"
                      data-tier={notice.tier}
                      role={notice.tier === "urgent" ? "alert" : "note"}
                    >
                      {notice.text}
                    </p>
                  );
                })()}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void recordPayment(placed.totalMinor);
                  }}
                >
                  {tableMode ? null : (
                    // WP-2423 M52 (DEC-COUNTER-CASH): a counter guest pays on the card machine or
                    // in cash, by the table's cash rules.
                    <fieldset className="counter-order__tender" disabled={phase === "Recording"}>
                      <legend>{t("How the guest pays")}</legend>
                      <label>
                        <input
                          type="radio"
                          name="counter-tender"
                          checked={tender === "CardMachine"}
                          onChange={() => {
                            setTender("CardMachine");
                            setProblem(null);
                          }}
                        />
                        {t("Card machine")}
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="counter-tender"
                          checked={tender === "Cash"}
                          onChange={() => {
                            setTender("Cash");
                            setProblem(null);
                          }}
                        />
                        {t("Cash")}
                      </label>
                    </fieldset>
                  )}
                  {counterCash ? (
                    <CashTenderFields
                      idPrefix="counter-cash"
                      dueMinor={BigInt(placed.totalMinor)}
                      received={received}
                      onReceived={(value) => {
                        setReceived(value);
                        setProblem(null);
                      }}
                      disabled={phase === "Recording"}
                    />
                  ) : (
                    <>
                      <label>
                        {t("Slip reference (optional)")}
                        <input
                          value={slip}
                          maxLength={40}
                          autoComplete="off"
                          aria-invalid={!validSlipReference(slip.trim())}
                          aria-describedby="counter-slip-hint"
                          onChange={(event) => setSlip(event.currentTarget.value)}
                        />
                      </label>
                      <p id="counter-slip-hint" className="field-hint">
                        {t(
                          "The approval or reference code on the card machine slip, to match the machine's day total. Never the card number.",
                        )}
                      </p>
                    </>
                  )}
                  {placed.recordedAfterOutage ? (
                    <>
                      <label>
                        {t("Paid at (store time, from the paper order)")}
                        <input
                          ref={chargePaidAt}
                          type="datetime-local"
                          value={paidAt}
                          disabled={phase === "Recording"}
                          aria-invalid={paperInstant === null || paidAtRefused}
                          aria-describedby={
                            paidAtRefused
                              ? "counter-charge-paid-at-refused counter-charge-paid-at-hint"
                              : "counter-charge-paid-at-hint"
                          }
                          onChange={(event) => {
                            setPaidAt(event.currentTarget.value);
                            if (paidAtRefused) {
                              setPaidAtRefused(false);
                              setProblem(null);
                            }
                          }}
                        />
                      </label>
                      {paidAtRefused && problem !== null ? (
                        <p id="counter-charge-paid-at-refused" role="alert">
                          {problem}
                        </p>
                      ) : null}
                      <p id="counter-charge-paid-at-hint" className="field-hint">
                        {t(
                          "Within the last 3 days. If the time was wrong, correct it here and record again.",
                        )}
                      </p>
                      {paidAtDayNote(paperInstant, now, timeZone) !== null ? (
                        <p className="order-accept-by" data-tier="warning" role="note">
                          {paidAtDayNote(paperInstant, now, timeZone)}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {problem !== null && !paidAtRefused ? <p role="alert">{problem}</p> : null}
                  <div className="card-actions">
                    <button
                      type="submit"
                      className="counter-order__primary"
                      disabled={
                        phase === "Recording" ||
                        (counterCash
                          ? !cashTender(BigInt(placed.totalMinor), received).ready
                          : !validSlipReference(slip.trim())) ||
                        (placed.recordedAfterOutage && paperInstant === null)
                      }
                    >
                      {phase === "Recording"
                        ? t("Recording…")
                        : counterCash
                          ? t("Cash received · {amount}", {
                              amount: cad(
                                cashTender(BigInt(placed.totalMinor), "").cashDueMinor.toString(),
                              ),
                            })
                          : t("Paid on card machine · {totalMinor}", {
                              totalMinor: cad(placed.totalMinor),
                            })}
                    </button>
                  </div>
                </form>
                <p className="bop-muted">
                  {tableMode
                    ? t(
                        "Card declined? Try another card. Nothing goes to the kitchen until this is recorded; after {payBy} it can no longer be paid here and must be sent again.",
                        { payBy: storeTime(placed.payBy ?? "", timeZone) },
                      )
                    : counterCash
                      ? t(
                          "Count the cash before you record it. Once recorded, only a manager can give it back.",
                        )
                      : placedCancellable
                        ? t(
                            "Card declined? Try another card. Guest not paying? Cancel the order so its items go back to stock.",
                          )
                        : t(
                            "Card declined? Try another card. Guest not paying? Ask a manager to cancel it; otherwise it is released at {payBy}.",
                            { payBy: storeTime(placed.payBy ?? "", timeZone) },
                          )}
                </p>
                {!tableMode && placedCancellable && !placed.recordedAfterOutage ? (
                  <div className="card-actions">
                    <CounterCancelAction
                      orderReference={placed.orderReference}
                      orderBatchReference={placed.orderBatchReference}
                      orderNumber={placed.orderNumber}
                      expectedOrderVersion={placed.orderVersion}
                      csrf={csrf}
                      {...(fetcher === undefined ? {} : { fetcher })}
                      onCancelled={startOver}
                    />
                    <CounterCancelAction
                      label={t("Back to edit")}
                      defaultReason="COUNTER_ENTERED_WRONG"
                      orderReference={placed.orderReference}
                      orderBatchReference={placed.orderBatchReference}
                      orderNumber={placed.orderNumber}
                      expectedOrderVersion={placed.orderVersion}
                      csrf={csrf}
                      {...(fetcher === undefined ? {} : { fetcher })}
                      onCancelled={backToEdit}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <p role="status">
                  {paidNote ??
                    (changeDue !== null ? t("Paid in cash.") : t("Paid on the card machine."))}
                </p>
                <div className="card-actions">
                  <button type="button" onClick={startOver}>
                    {tableMode ? t("Another order for this table") : t("New counter order")}
                  </button>
                  {tableMode ? <Link to="/operations/dining">{t("Back to Tables")}</Link> : null}
                  <Link to="/operations/orders">{t("Open Orders")}</Link>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
      {choosing !== null && choosingLine !== null ? (
        <dialog
          ref={chooseDialog}
          className="counter-order__choose"
          onCancel={() => setChoosing(null)}
          onClick={(event) => {
            if (event.target === chooseDialog.current) setChoosing(null);
          }}
        >
          <form
            aria-label={t("Choose {name}", { name: choosing.item.name })}
            onSubmit={(event) => {
              event.preventDefault();
              if (!choicesComplete(choosing.item, choosing.choices, choosing.counts)) return;
              changeLines(
                choosing.editing === null
                  ? [...lines, choosingLine]
                  : lines.map((line) => (line.key === choosing.editing ? choosingLine : line)),
              );
              setChoosing(null);
            }}
          >
            <h3 ref={chooseHeading} tabIndex={-1}>
              {choosing.item.name}
            </h3>
            {choosing.item.rules.map((rule) => {
              const single = rule.maximumSelections === 1;
              const picked = choosing.choices[rule.bindingReference] ?? [];
              const total = chosenInRule(picked, choosing.counts);
              return (
                <fieldset key={rule.bindingReference}>
                  <legend>
                    {rule.name}
                    {` · ${staffChoiceText(rule)}`}
                  </legend>
                  {total > rule.maximumSelections ? (
                    <p role="status">
                      {t("{name} allows at most {max}. Choose fewer.", {
                        name: rule.name,
                        max: rule.maximumSelections,
                      })}
                    </p>
                  ) : null}
                  {rule.options.map((option) => (
                    <label key={option.optionReference}>
                      <input
                        type={single ? "radio" : "checkbox"}
                        name={rule.bindingReference}
                        checked={picked.includes(option.optionReference)}
                        disabled={
                          (option.offeredNow === false &&
                            !picked.includes(option.optionReference)) ||
                          (!single &&
                            !picked.includes(option.optionReference) &&
                            total >= rule.maximumSelections)
                        }
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setChoosing({
                            ...choosing,
                            choices: {
                              ...choosing.choices,
                              [rule.bindingReference]: single
                                ? [option.optionReference]
                                : checked
                                  ? [...picked, option.optionReference]
                                  : picked.filter((value) => value !== option.optionReference),
                            },
                          });
                        }}
                      />
                      <span>{option.name}</span>
                      {option.offeredNow === false ? (
                        <span className="counter-order__option-price">
                          {option.soldOut === true ? t("Sold out today") : t("Not available now")}
                        </span>
                      ) : option.priceMinor !== null && option.priceMinor !== "0" ? (
                        <span className="counter-order__option-price">
                          +{cad(option.priceMinor)}
                        </span>
                      ) : null}
                    </label>
                  ))}
                  {/* WP-2423 item 3b: a choice guests can repeat (double pearls) at the table too. */}
                  {rule.options
                    .filter(
                      (option) =>
                        option.maximumQuantity > 1 && picked.includes(option.optionReference),
                    )
                    .map((option) => (
                      <label key={option.optionReference} className="counter-order__quantity">
                        {t("How many {name}", { name: option.name })}
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={repeatLimit(rule, option.optionReference, picked, choosing.counts)}
                          value={choosing.counts[option.optionReference] ?? 1}
                          onChange={(event) =>
                            setChoosing({
                              ...choosing,
                              counts: {
                                ...choosing.counts,
                                [option.optionReference]: Math.min(
                                  repeatLimit(
                                    rule,
                                    option.optionReference,
                                    picked,
                                    choosing.counts,
                                  ),
                                  Math.max(1, Number(event.currentTarget.value) || 1),
                                ),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                </fieldset>
              );
            })}
            <label className="counter-order__quantity">
              {t("Quantity")}
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                value={choosing.quantity}
                onChange={(event) =>
                  setChoosing({
                    ...choosing,
                    quantity: Math.min(99, Math.max(1, Number(event.currentTarget.value) || 1)),
                  })
                }
              />
            </label>
            {/* WP-2423 M53: the counter takes the guest's note for the kitchen too. */}
            <label className="counter-order__note">
              {t("Note for the kitchen (optional)")}
              <input
                value={choosing.note}
                maxLength={140}
                autoComplete="off"
                onChange={(event) => setChoosing({ ...choosing, note: event.currentTarget.value })}
              />
            </label>
            <div className="counter-order__choose-actions">
              <button
                type="submit"
                className="counter-order__primary"
                disabled={!choicesComplete(choosing.item, choosing.choices, choosing.counts)}
              >
                {choosing.editing === null ? t("Add to order") : t("Save change")}
                {choosingMinor === null ? "" : ` · ${cad(choosingMinor.toString())}`}
              </button>
              <button type="button" onClick={() => setChoosing(null)}>
                {t("Cancel")}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </WorkspacePage>
  );
}
