import { describe, expect, it } from "vitest";
import { initialPayScope, paySelection } from "./table-pay-choice.js";
import { parseTablePaymentView } from "./table-payment-client.js";

// WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): what this phone pays at a table that pays at
// the end — the amounts the server charges, to the cent (the last of a round takes its rounding).

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
// Round 1: dumplings ×3 ($3.39 each, phone A's) and tea ($2.83, phone B's); one cent of tax
// rounding left on round 1. Round 2: noodles ($13.56, phone A's).
const wire = (defaultScope = "WholeTable", split: unknown = null) => ({
  schemaVersion: 1,
  payment: {
    tableLabel: "8",
    checkingOut: true,
    rounds: [],
    owed: { subtotalMinor: "2350", taxMinor: "307", totalMinor: "2657", taxRoundingMinor: "1" },
    consistent: true,
    tips: { enabled: true, tierPercents: [10, 15, 18] },
    state: "NotPaid",
    attempt: null,
    split,
    choices: {
      defaultScope,
      mine: { count: 4, amountMinor: "2373" },
      dishes: [
        {
          orderItemReference: id(11),
          displayName: "Dumplings",
          roundNumber: 1,
          mine: true,
          unitMinor: ["339", "339", "339"],
          unitSubtotalMinor: ["300", "300", "300"],
        },
        {
          orderItemReference: id(12),
          displayName: "Tea",
          roundNumber: 1,
          mine: false,
          unitMinor: ["283"],
          unitSubtotalMinor: ["250"],
        },
        {
          orderItemReference: id(21),
          displayName: "Noodles",
          roundNumber: 2,
          mine: true,
          unitMinor: ["1356"],
          unitSubtotalMinor: ["1200"],
        },
      ],
      rounds: [
        { roundNumber: 1, restMinor: "1301", restSubtotalMinor: "1150" },
        { roundNumber: 2, restMinor: "1356", restSubtotalMinor: "1200" },
      ],
    },
    receipt: null,
  },
});

describe("Which dishes this phone pays", () => {
  it("starts with what the Store chose; the whole table, before anyone paid, is the bill", () => {
    const view = parseTablePaymentView(wire());
    const own = parseTablePaymentView(wire("OwnDishes")).choices;
    if (view.choices === null || own === null) throw new Error("choices expected");
    expect(initialPayScope(view.choices)).toBe("Whole");
    expect(initialPayScope(own)).toBe("Mine");
    expect(paySelection(view, "Whole", new Map())).toEqual({
      amountMinor: "2657",
      subtotalMinor: "2350",
      count: 5,
      choice: null,
    });
  });

  it("only what I added: its own units, a round's rounding only with the round's last dish", () => {
    const view = parseTablePaymentView(wire());
    // The tea (another phone's) stays: round 1 is not finished, so no rounding cent.
    expect(paySelection(view, "Mine", new Map())).toEqual({
      amountMinor: String(339 * 3 + 1356),
      subtotalMinor: String(900 + 1200),
      count: 4,
      choice: { kind: "Mine" },
    });
  });

  it("chosen dishes: how many of each; taking the last of a round pays what is left of it", () => {
    const view = parseTablePaymentView(wire());
    expect(paySelection(view, "Chosen", new Map())).toBeNull();
    expect(paySelection(view, "Chosen", new Map([[id(11), 2]]))).toEqual({
      amountMinor: "678",
      subtotalMinor: "600",
      count: 2,
      choice: { kind: "Chosen", dishes: [{ orderItemReference: id(11), quantity: 2 }] },
    });
    // All of round 1: $13.01, the rounding cent included.
    expect(
      paySelection(
        view,
        "Chosen",
        new Map([
          [id(11), 3],
          [id(12), 1],
        ]),
      )?.amountMinor,
    ).toBe("1301");
    // More than is left counts as what is left.
    expect(paySelection(view, "Chosen", new Map([[id(12), 5]]))?.count).toBe(1);
  });

  it("once others paid some, the whole table is the rest of it", () => {
    const view = parseTablePaymentView(
      wire("WholeTable", {
        mode: "ByGuests",
        paidInFull: false,
        paidParts: 1,
        remainingMinor: "1302",
        parts: [
          {
            partNumber: 2,
            amountMinor: "1355",
            subtotalMinor: "1200",
            dishes: [{ displayName: "Noodles", quantity: 1, shared: false }],
            status: "Paid",
            byYou: true,
          },
        ],
      }),
    );
    expect(view.split?.parts[0]?.byYou).toBe(true);
    expect(paySelection(view, "Whole", new Map())?.choice).toEqual({ kind: "Rest" });
  });
});
