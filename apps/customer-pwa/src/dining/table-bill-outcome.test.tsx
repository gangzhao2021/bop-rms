import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { DiningRound, DiningSessionView } from "./dining-session-client.js";
import { tableBillOutcome } from "./table-bill-outcome.js";
import {
  getTableCheckout,
  noteTableCheckingOut,
  noteTableView,
  resetTableCheckout,
} from "./table-checkout-state.js";
import { tableCheckoutText } from "../menu/TableCheckoutNotice.js";
import { LanguageRoot } from "../i18n/i18n.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

// Batch 55 (v15 b54 live, guest-bill-closed-by-staff): the reads v15 sent at TM2 after staff
// recorded "Guests left without paying" (order 59) or "... the rest" (orders 55 and 67), and two
// ordinary paid bills (orders 66 and 63). Menu, dish pages and Cart said "Your table’s bill is
// paid" / 这桌已结清 with "See the receipt" for all of the closed ones, order 59 included, where
// nothing was paid.
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const round = (roundNumber: number, payment: DiningRound["payment"]): DiningRound => ({
  roundNumber,
  orderedBy: roundNumber === 1 ? "You" : "AnotherGuest",
  submittedAt: "2026-11-22T16:06:00.000Z",
  status: "Served",
  payment,
  cancelsAt: null,
  storeCancellationReason: null,
  items: [
    {
      displayName: "Beef noodles (TEST)",
      quantity: 1,
      servedQuantity: 1,
      cancelled: false,
      lineTotal: cad(roundNumber === 1 ? "1413" : "1412"),
    },
  ],
  itemsTotal: cad(roundNumber === 1 ? "1413" : "1412"),
});
function read(
  paid: string,
  rounds: readonly DiningRound[],
  extra: Partial<NonNullable<DiningSessionView["summary"]>> = {},
): DiningSessionView {
  return {
    tableLabel: "L54 GB1 (TEST)",
    orderNumber: "55",
    checkedAt: "2026-11-22T16:09:00.000Z",
    paymentTiming: "PayLater",
    rounds,
    summary: {
      paid: cad(paid),
      refunded: cad("0"),
      refundPending: cad("0"),
      due: cad("0"),
      ...extra,
    },
  };
}
const reads = {
  // Order 59: one round, nobody paid, staff wrote off all of it.
  nothingPaid: read("0", [round(1, "OnTableBill")], { closedByStaff: true }),
  // Order 55: guest A paid their own dish online, staff wrote off the rest.
  byDish: read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
    splitParts: { count: null, paid: 1 },
    closedByStaff: true,
    tableTip: cad("0"),
    cashRounding: cad("0"),
  }),
  // Order 67: staff split evenly in 2, part 1 was paid, staff wrote off the rest.
  split: read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
    splitParts: { count: 2, paid: 1 },
    closedByStaff: true,
    tableTip: cad("0"),
    cashRounding: cad("0"),
  }),
  // Order 66: both guests paid their own dish (no closedByStaff key).
  byDishPaid: read("2825", [round(1, "Paid"), round(2, "Paid")], {
    splitParts: { count: null, paid: 2 },
    tableTip: cad("0"),
    cashRounding: cad("0"),
  }),
  // Order 63: one guest paid the whole table.
  onePayment: read("2825", [round(1, "Paid"), round(2, "Paid")], {
    tableTip: cad("0"),
    cashRounding: cad("0"),
  }),
};

afterEach(() => {
  resetTableCheckout();
  setCustomerCsrfCredential(null);
});

describe("batch 55: one reading of how a table's bill ended", () => {
  it("a bill staff closed is never paid: nothing, by dish, or parts of staff's split", () => {
    expect(tableBillOutcome(reads.nothingPaid)).toEqual({
      kind: "ClosedByStaff",
      paid: { kind: "Nothing" },
    });
    expect(tableBillOutcome(reads.byDish)).toEqual({
      kind: "ClosedByStaff",
      paid: { kind: "ByDish", payments: 1 },
    });
    expect(tableBillOutcome(reads.split)).toEqual({
      kind: "ClosedByStaff",
      paid: { kind: "Parts", paid: 1, count: 2 },
    });
    expect(
      tableBillOutcome(read("1000", [round(1, "OnTableBill")], { closedByStaff: true })),
    ).toEqual({ kind: "ClosedByStaff", paid: { kind: "Some" } });
  });
  it("ordinary bills: paid in full by dish or in one payment, or still owing", () => {
    expect(tableBillOutcome(reads.byDishPaid)).toEqual({ kind: "Paid" });
    expect(tableBillOutcome(reads.onePayment)).toEqual({ kind: "Paid" });
    expect(
      tableBillOutcome({
        ...reads.byDish,
        summary: {
          paid: cad("1413"),
          refunded: cad("0"),
          refundPending: cad("0"),
          due: cad("1412"),
        },
      }),
    ).toEqual({ kind: "Owing" });
    expect(tableBillOutcome({ ...reads.onePayment, rounds: [] })).toEqual({ kind: "Owing" });
  });
});

describe("batch 55: Menu, dish pages and Cart say what Your table says", () => {
  const said = (language: "en" | "zh-Hans", view: DiningSessionView) => {
    setCustomerCsrfCredential("c".repeat(43));
    noteTableView(view);
    // The Store refused the cart read: the table is checking out (or its bill is closed).
    noteTableCheckingOut(true);
    const checkout = getTableCheckout();
    if (checkout === null) throw new Error("the table read was not kept");
    const out: { text?: ReturnType<typeof tableCheckoutText> } = {};
    renderToStaticMarkup(
      <LanguageRoot initial={language}>
        {() => {
          out.text = tableCheckoutText(checkout);
          return null;
        }}
      </LanguageRoot>,
    );
    renderToStaticMarkup(<LanguageRoot initial="en">{() => null}</LanguageRoot>);
    resetTableCheckout();
    if (out.text === undefined) throw new Error("nothing was said");
    return out.text;
  };
  it("order 59, nothing paid: staff closed the bill, nothing was charged, no receipt", () => {
    expect(said("en", reads.nothingPaid)).toEqual({
      heading: "Staff closed your table’s bill",
      line: "Nothing was charged. To order anything else, ask staff.",
      whole:
        "Staff closed your table’s bill; nothing was charged. To order anything else, ask staff.",
      link: "See the bill",
    });
    expect(said("zh-Hans", reads.nothingPaid)).toEqual({
      heading: "店员已关闭本桌账单",
      line: "未收取任何费用。如需再点，请找店员。",
      whole: "店员已关闭本桌账单，未收取任何费用。如需再点，请找店员。",
      link: "查看账单",
    });
  });
  it("orders 55 and 67, part paid: what was paid stays paid, the rest is not charged", () => {
    for (const view of [reads.byDish, reads.split]) {
      expect(said("en", view)).toEqual({
        heading: "Staff closed your table’s bill",
        line: "What was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
        whole:
          "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
        link: "See the bill",
      });
      const zh = said("zh-Hans", view);
      expect(zh.whole).toBe(
        "店员已关闭本桌账单：已付的款项不变，其余不向您收取。如需再点，请找店员。",
      );
      expect(zh.link).toBe("查看账单");
      expect(Object.values(zh).join()).not.toMatch(/结清|付清|收据/u);
    }
  });
  it("ordinary paid bills keep batch 48's words and the receipt link", () => {
    for (const view of [reads.byDishPaid, reads.onePayment]) {
      expect(said("en", view)).toEqual({
        heading: "Your table’s bill is paid",
        line: "To order anything else, ask staff.",
        whole: "Your table’s bill is paid. To order anything else, ask staff.",
        link: "See the receipt",
      });
      expect(said("zh-Hans", view).whole).toBe("这桌已结清。如需再点，请找店员。");
    }
  });
  it("staff closing the bill while the guest reads Menu changes the words at the next read", () => {
    setCustomerCsrfCredential("c".repeat(43));
    // Before staff act: guest A paid their dish, $14.12 still owed (no closedByStaff key).
    noteTableView(
      read("1413", reads.byDish.rounds, { splitParts: { count: null, paid: 1 }, due: cad("1412") }),
    );
    noteTableCheckingOut(true);
    expect(getTableCheckout()).toEqual({ paid: false, payLater: true, closedByStaff: null });
    noteTableView(reads.byDish);
    expect(getTableCheckout()).toEqual({
      paid: true,
      payLater: true,
      closedByStaff: { kind: "ByDish", payments: 1 },
    });
  });
});
