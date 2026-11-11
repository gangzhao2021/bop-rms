import { describe, expect, it } from "vitest";
import { tableCartChange } from "./table-cart-change.js";
import type { CartItemView, CartView } from "./types.js";
import {
  cartText,
  tableCartAddedDishes,
  tableCartChangedDishes,
  checkoutText,
} from "../journey/messages.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const line = (n: number, displayName: string, quantity = 1): CartItemView =>
  ({
    cartItemReference: id(n),
    sellableReference: id(100 + n),
    displayName,
    quantity,
    configuration: [],
    customerNote: null,
    lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
    warnings: [],
  }) as CartItemView;
const view = (
  version: number,
  items: readonly CartItemView[],
  recentRounds?: CartView["cart"]["recentRounds"],
): CartView =>
  ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic", storeName: "Synthetic" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-11-06T20:00:00.000Z",
        absoluteExpiresAt: "2026-11-07T16:00:00.000Z",
      },
      items,
      quote: null,
      warnings: [],
      ...(recentRounds === undefined ? {} : { recentRounds }),
    },
  }) as CartView;

describe("WP-2423 same-table-ordering: what happened at the table while this phone checks out", () => {
  const mine = line(10, "Dumplings", 2);
  it("nothing, while the cart's version stands", () => {
    expect(tableCartChange(view(3, [mine]), view(3, [mine]))).toEqual({ kind: "unchanged" });
  });
  it("names the dishes someone added, and the extra of a dish already there", () => {
    const change = tableCartChange(
      view(3, [mine]),
      view(5, [line(10, "Dumplings", 3), line(11, "Sesame soup")], []),
    );
    expect(change).toEqual({
      kind: "changed",
      added: [
        { displayName: "Dumplings", quantity: 1 },
        { displayName: "Sesame soup", quantity: 1 },
      ],
      removed: [],
      reduced: [],
    });
    if (change.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(change))).toBe(
      "Someone at your table changed the cart: added Dumplings ×1, Sesame soup ×1.",
    );
    expect(checkoutText.tableCartChangedBy("")).toBe("Someone at your table changed the cart.");
  });
  it("names a removed dish and a smaller quantity, and does not repeat an increase (M37)", () => {
    const change = tableCartChange(
      view(3, [mine, line(11, "Tea", 2), line(12, "Rice", 3), line(13, "Soup")]),
      view(6, [line(10, "Dumplings", 4), line(12, "Rice", 1), line(13, "Soup")], []),
    );
    expect(change).toEqual({
      kind: "changed",
      added: [{ displayName: "Dumplings", quantity: 2 }],
      removed: [{ displayName: "Tea", quantity: 2 }],
      reduced: [{ displayName: "Rice", quantity: 1 }],
    });
    if (change.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(change))).toBe(
      "Someone at your table changed the cart: added Dumplings ×2; removed Tea ×2; Rice now ×1.",
    );
    const removedOnly = tableCartChange(view(3, [mine, line(11, "Tea")]), view(4, [mine], []));
    if (removedOnly.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(removedOnly))).toBe(
      "Someone at your table changed the cart: removed Tea ×1.",
    );
  });
  it("says another phone's round took these dishes, even after more dishes were added", () => {
    // Review: the round was followed by an add, so the cart is two versions on.
    const current = view(
      6,
      [line(12, "Tea")],
      [
        {
          roundNumber: 2,
          sentAt: "2026-11-06T16:00:00.000Z",
          sentByThisPhone: false,
          cartItemReferences: [id(10), id(13)],
          paymentState: "Paid",
        },
      ],
    );
    expect(tableCartChange(view(3, [mine]), current)).toEqual({
      kind: "sent",
      roundNumber: 2,
      byThisPhone: false,
      paymentState: "Paid",
      cartHasDishes: true,
    });
    expect(checkoutText.tableCartSent(2, false, false)).toBe(
      "These dishes were paid and sent by someone at your table (round 2).",
    );
    expect(checkoutText.tableCartSent(2, false, true)).toBe(
      "These dishes were sent to the kitchen by someone at your table (round 2).",
    );
  });
  it("never claims a round took dishes it didn't, nor when the rounds can't be read", () => {
    const rounds = [
      {
        roundNumber: 1,
        sentAt: "2026-11-06T16:00:00.000Z",
        sentByThisPhone: false,
        cartItemReferences: [id(99)],
        paymentState: null,
      },
    ];
    expect(tableCartChange(view(3, [mine]), view(4, [], rounds)).kind).toBe("changed");
    expect(tableCartChange(view(3, [mine]), view(4, [])).kind).toBe("changed");
    expect(tableCartChange(view(3, [mine]), null).kind).toBe("changed");
  });
  it("M38: a round still being paid, or closed unpaid, is never called paid and sent", () => {
    const awaiting = view(
      6,
      [],
      [
        {
          roundNumber: 1,
          sentAt: "2026-11-06T16:00:00.000Z",
          sentByThisPhone: false,
          cartItemReferences: [id(10)],
          paymentState: "AwaitingPayment",
        },
      ],
    );
    const change = tableCartChange(view(3, [mine]), awaiting);
    expect(change).toMatchObject({ kind: "sent", paymentState: "AwaitingPayment" });
    expect(checkoutText.tableCartSent(1, false, false, "AwaitingPayment")).toBe(
      "Someone at your table is paying for round 1 now. Your dishes are in it.",
    );
    expect(checkoutText.tableCartSent(1, true, false, "AwaitingPayment")).toBe(
      "You’re paying for round 1. It goes to the kitchen once it’s paid.",
    );
    // Closed unpaid (deadline or staff): the dishes did not come back, so nothing says they did.
    const cancelled = checkoutText.tableCartSent(1, false, false, "Cancelled");
    expect(cancelled).toBe(
      "Round 1 wasn’t paid, so it wasn’t sent to the kitchen. Add the dishes again to order them.",
    );
    expect(cancelled).not.toMatch(/back in the cart/u);
    expect(cartText.line.roundSentByTable(1, "AwaitingPayment")).toBe(
      "Someone at your table is paying for round 1 now. Your dishes are in it.",
    );
    expect(cartText.line.roundSentByTable(1, "Paid")).toBe(
      "Round 1 was sent by someone at your table.",
    );
  });
  it("M38: at a table that pays at the end nobody is told a round is being paid now", () => {
    for (const byThisPhone of [false, true]) {
      for (const state of ["AwaitingPayment", "WaitingForStaff", "Cancelled"] as const) {
        const text = checkoutText.tableCartSent(2, byThisPhone, true, state);
        expect(text).not.toMatch(/pay|paid/iu);
      }
    }
    // A round held for staff says so, to the sender and to the table.
    expect(checkoutText.tableCartSent(2, true, true, "WaitingForStaff")).toBe(
      "Round 2 is waiting for staff to send it to the kitchen.",
    );
    expect(cartText.line.roundSentByTable(2, "WaitingForStaff", true)).toBe(
      "Round 2 from someone at your table is waiting for staff to send it to the kitchen. Your dishes are in it.",
    );
    // A send whose answer did not come back is not placed yet, never "paying".
    expect(cartText.line.roundSentByTable(2, "AwaitingPayment", true)).toBe(
      "Someone at your table is still placing round 2. Your dishes are in it.",
    );
    expect(checkoutText.tableCartSent(2, true, true, "AwaitingPayment")).toBe(
      "Round 2 isn’t placed yet. If it still isn’t in a minute, ask staff to check it.",
    );
    // Staff declined a held round: it was not unpaid.
    expect(cartText.line.roundSentByTable(2, "StaffDeclined", true)).toBe(
      "Staff didn’t send round 2 to the kitchen. Add the dishes again to order them, or ask staff.",
    );
  });
  it("M38: staff are named only when staff cancelled the round", () => {
    // Closed by the payment window at a pay-later table (an unconfirmed send the sweep
    // cancelled): nobody on staff touched it, so staff are not blamed.
    for (const byThisPhone of [false, true]) {
      const closed = checkoutText.tableCartSent(3, byThisPhone, true, "Cancelled");
      expect(closed).toBe("Round 3 wasn’t placed. Add the dishes again to order them.");
      expect(closed).not.toMatch(/staff/iu);
    }
    expect(cartText.line.roundSentByTable(3, "Cancelled", true)).toBe(
      "Round 3 wasn’t placed. Add the dishes again to order them.",
    );
    // A pay-first round staff cancelled unpaid: staff, not "wasn't paid".
    expect(checkoutText.tableCartSent(3, true, false, "StaffDeclined")).toBe(
      "Staff didn’t send round 3 to the kitchen. Add the dishes again to order them, or ask staff.",
    );
    // A round staff cancelled after it was sent is never "sent" or "didn't send".
    for (const payLater of [false, true])
      expect(cartText.line.roundSentByTable(3, "StaffCancelled", payLater)).toBe(
        "Staff cancelled round 3. Ask staff if you still want these dishes.",
      );
  });
  it("a round paid but with nothing it could make is never 'wasn't paid': its payment is refunded", () => {
    expect(checkoutText.tableCartSent(3, true, false, "PaidNotMade")).toBe(
      "Round 3 was paid but couldn’t be made, so your payment is being refunded to your original payment method. Ask staff if you have questions.",
    );
    expect(cartText.line.roundSentByTable(3, "PaidNotMade", false)).toBe(
      "Round 3 from someone at your table was paid but couldn’t be made. Their payment is being refunded.",
    );
    expect(cartText.line.roundSentByThisPhone(3, "PaidNotMade", false)).not.toMatch(/wasn’t paid/u);
  });
});

describe("v15 batch 7 table-pay-by-dish: staff take a dish out while this phone chose what it pays", () => {
  const tea = line(10, "Lemon tea");
  const cucumber = line(20, "Smashed cucumber");
  const payer = (thisPhone: boolean) =>
    ({
      defaultChoice: "WholeTable",
      payer: {
        thisPhone,
        choice: "Mine",
        expiresAt: "2026-11-10T20:05:00.000Z",
        reserved: true,
      },
      waiting: [],
      returnable: false,
    }) as const;
  const removedByStaff = {
    removedAt: "2026-11-10T20:01:00.000Z",
    quantity: 1,
    names: { "en-CA": "Lemon tea" },
  };
  const withPay = (cart: CartView, tablePay: CartView["cart"]["tablePay"], staff = false) =>
    ({
      ...cart,
      cart: {
        ...cart.cart,
        ...(tablePay === undefined ? {} : { tablePay }),
        ...(staff ? { staffRemoved: [removedByStaff] } : {}),
      },
    }) as CartView;
  const noPayer = {
    defaultChoice: "WholeTable",
    payer: null,
    waiting: [],
    returnable: true,
  } as const;

  it("ends this phone's choice and names staff, never 'someone added' the dishes that came back", () => {
    const change = tableCartChange(
      withPay(view(5, [tea]), payer(true)),
      withPay(view(7, [cucumber]), noPayer, true),
    );
    expect(change).toEqual({
      kind: "choiceEnded",
      byStaff: [{ displayName: "Lemon tea", quantity: 1 }],
    });
    if (change.kind !== "choiceEnded") throw new Error("expected choiceEnded");
    const said = checkoutText.tableChoiceEnded(tableCartAddedDishes(change.byStaff));
    expect(said).toContain("Staff removed Lemon tea ×1");
    expect(said).toContain("Nothing was charged. Choose again what you pay for.");
    expect(said).not.toContain("Someone at your table");
    expect(said).not.toContain("added");
  });

  it("ends this phone's choice when another phone chose before this one read again", () => {
    // Phone B chose what it pays before phone A's next read: A's choice ended all the same, and
    // A is never told someone added the dishes that came back or offered a checkout the server
    // refuses while B's choice holds.
    const change = tableCartChange(
      withPay(view(5, [tea]), payer(true)),
      withPay(view(7, [cucumber]), payer(false), true),
    );
    expect(change).toEqual({
      kind: "choiceEnded",
      byStaff: [{ displayName: "Lemon tea", quantity: 1 }],
    });
  });

  it("ends the choice without blaming staff when the others' dishes came back on their own", () => {
    expect(
      tableCartChange(
        withPay(view(5, [tea]), payer(true)),
        withPay(view(6, [tea, cucumber]), noPayer),
      ),
    ).toEqual({ kind: "choiceEnded", byStaff: [] });
    expect(checkoutText.tableChoiceEnded("")).toContain("The cart changed");
  });

  it("another phone's checkout says staff removed the dish, not someone at the table", () => {
    const change = tableCartChange(
      withPay(view(5, [tea, cucumber]), noPayer),
      withPay(view(6, [cucumber]), noPayer, true),
    );
    expect(change).toEqual({
      kind: "changed",
      added: [],
      removed: [],
      reduced: [],
      byStaff: [{ displayName: "Lemon tea", quantity: 1 }],
    });
    expect(
      checkoutText.tableCartStaffRemoved(
        tableCartAddedDishes([{ displayName: "Lemon tea", quantity: 1 }]),
      ),
    ).toBe("Staff removed Lemon tea ×1 from the cart.");
  });
});
