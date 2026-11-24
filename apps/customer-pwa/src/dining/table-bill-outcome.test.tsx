import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { EndedTableCard } from "./EndedTable.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DiningRound, DiningSessionView } from "./dining-session-client.js";
import { openBillParts, tableBillOutcome } from "./table-bill-outcome.js";
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

describe("batch 56: staff's equal parts on a bill still open", () => {
  it("order 80: 1 of 2 parts paid while open; none once staff closed it, by dish or none paid", () => {
    const open = read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
      due: cad("1412"),
      splitParts: { count: 2, paid: 1 },
    });
    expect(openBillParts(open)).toEqual({ paid: 1, count: 2 });
    expect(openBillParts(reads.split)).toBeNull();
    expect(openBillParts(reads.byDish)).toBeNull();
    expect(
      openBillParts(
        read("0", [round(1, "OnTableBill")], {
          due: cad("2825"),
          splitParts: { count: 2, paid: 0 },
        }),
      ),
    ).toBeNull();
  });
});

// Batch 59 (v15 b58 live, TM2 L58R B order 23 and L58R A order 16): staff split evenly in 2,
// phone A paid part 1 ($14.13), staff closed the rest, then a manager gave all of part 1 back
// to the card (the read: paidAfterRefunds 0, splitParts refunded 1) or $8.00 of it
// (paidAfterRefunds 613, no part given back in full). Every page still said 1 of 2 parts paid and
// "what was paid stays paid".
describe("batch 59: a part given back in full is not paid", () => {
  const refundedSplit = read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
    splitParts: { count: 2, paid: 1, refunded: 1 },
    paidAfterRefunds: cad("0"),
    closedByStaff: true,
    tableTip: cad("0"),
    cashRounding: cad("0"),
  });
  const partlySplit = read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
    splitParts: { count: 2, paid: 1 },
    paidAfterRefunds: cad("613"),
    closedByStaff: true,
    tableTip: cad("0"),
    cashRounding: cad("0"),
  });
  it("all of it back: Refunded, with the parts; part of it back: still 1 of 2 paid", () => {
    expect(tableBillOutcome(refundedSplit)).toEqual({
      kind: "ClosedByStaff",
      paid: { kind: "Refunded", parts: { refunded: 1, count: 2 } },
    });
    expect(tableBillOutcome(partlySplit)).toEqual({
      kind: "ClosedByStaff",
      paid: { kind: "Parts", paid: 1, count: 2 },
    });
    // By dish (order 52's shape), all of the one payment back.
    expect(
      tableBillOutcome(
        read("1413", reads.byDish.rounds, {
          splitParts: { count: null, paid: 1, refunded: 1 },
          paidAfterRefunds: cad("0"),
          closedByStaff: true,
        }),
      ),
    ).toEqual({ kind: "ClosedByStaff", paid: { kind: "Refunded", parts: null } });
    // 3 parts, 2 paid, one of them given back in full: 1 of 3 paid, 1 given back.
    expect(
      tableBillOutcome(
        read("1884", [round(1, "OnTableBill"), round(2, "OnTableBill")], {
          splitParts: { count: 3, paid: 2, refunded: 1 },
          paidAfterRefunds: cad("942"),
          closedByStaff: true,
        }),
      ),
    ).toEqual({ kind: "ClosedByStaff", paid: { kind: "Parts", paid: 1, count: 3, refunded: 1 } });
  });
  it("while the bill is open, a part given back is not counted paid", () => {
    expect(
      openBillParts(
        read("1413", [round(1, "Paid"), round(2, "OnTableBill")], {
          due: cad("1412"),
          splitParts: { count: 2, paid: 1, refunded: 1 },
          paidAfterRefunds: cad("0"),
        }),
      ),
    ).toEqual({ paid: 0, count: 2, refunded: 1 });
  });
  it("Menu, dish pages and Cart never say what all went back stays paid (en, zh-Hans)", () => {
    const saidIn = (language: "en" | "zh-Hans", view: DiningSessionView) => {
      setCustomerCsrfCredential("c".repeat(43));
      noteTableView(view);
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
    const en = saidIn("en", refundedSplit);
    expect(en.whole).toBe(
      "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you. To order anything else, ask staff.",
    );
    expect(en.line).toBe(
      "What was paid went back in full; nothing is charged to you. To order anything else, ask staff.",
    );
    const zh = saidIn("zh-Hans", refundedSplit);
    expect(zh.whole).toBe(
      "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。如需再点，请找店员。",
    );
    for (const said of [en, zh]) expect(Object.values(said).join()).not.toMatch(/stays paid|不变/u);
    expect(saidIn("en", partlySplit).whole).toContain("what was paid stays paid");
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

// Batch 55 review (v15 b54, order 59): once staff also closed the table, Menu, dish pages and Cart
// showed the settled card, "Thank you for dining with us … See the receipt", for a bill that has
// no receipt. They say how the bill ended, in the words they used while the table was open.
describe("the ended table's card after staff closed the bill", () => {
  const card = (paid: "Nothing" | "Some" | "Refunded", initial: "en" | "zh-Hans" = "en") => {
    const html = renderToStaticMarkup(
      <LanguageRoot initial={initial}>
        {() => (
          <MemoryRouter>
            <EndedTableCard
              ended={{ kind: "ClosedByStaff", tableLabel: "L54 GB2 (TEST)", paid, store: null }}
            />
          </MemoryRouter>
        )}
      </LanguageRoot>,
    );
    renderToStaticMarkup(<LanguageRoot initial="en">{() => null}</LanguageRoot>);
    return html;
  };
  it("says nothing was charged, or that what was paid stays paid; never a receipt", () => {
    expect(card("Nothing")).toContain("Staff closed your table’s bill; nothing was charged.");
    expect(card("Some")).toContain(
      "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
    );
    expect(card("Nothing", "zh-Hans")).toContain("店员已关闭本桌账单，未收取任何费用。");
    expect(card("Some", "zh-Hans")).toContain(
      "店员已关闭本桌账单：已付的款项不变，其余不向您收取。",
    );
    for (const html of [card("Nothing"), card("Some"), card("Some", "zh-Hans")]) {
      expect(html).not.toMatch(/receipt|Thank you for dining|<a |收据|谢谢光临|已结清/iu);
    }
  });
  // Batch 59 (v15 b58 live, L58R B): all that was paid went back; before, "stays paid".
  it("batch 59: all that was paid went back: says so, never that it stays paid", () => {
    expect(card("Refunded")).toContain(
      "Staff closed your table’s bill: what was paid went back in full; nothing is charged to you.",
    );
    expect(card("Refunded", "zh-Hans")).toContain(
      "店员已关闭本桌账单：已付的款项已全部退回，不向您收取。",
    );
    for (const html of [card("Refunded"), card("Refunded", "zh-Hans")])
      expect(html).not.toMatch(/stays paid|不变|receipt|收据|<a /iu);
  });
});
