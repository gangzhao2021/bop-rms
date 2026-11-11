import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTableCheckoutClient, parseTableBill } from "./table-checkout-client.js";
import { defaultRoundParts, TableSplitControls } from "./TableSplit.js";
import { splitBillFixture } from "./table-split.fixtures.js";

describe("WP-2423 item 8 ④ split bill at the Tables checkout", () => {
  it("reads the parts, what paid each and who is paying, and refuses a malformed split", () => {
    const bill = parseTableBill(splitBillFixture());
    expect(bill.split?.parts.map((part) => [part.partNumber, part.amountMinor])).toEqual([
      [1, "3164"],
      [2, "3164"],
      [3, "3164"],
    ]);
    expect(bill.split?.parts[0]?.payment?.totalMinor).toBe("3584");
    expect(bill.split?.parts[2]?.guestPaying).toBe(true);
    expect(bill.rounds.map((round) => round.orderedBy)).toEqual([1, 2]);
    const broken = splitBillFixture();
    (broken.split as { parts: unknown[] }).parts.pop();
    (broken.split as { parts: unknown[] }).parts.pop();
    expect(() => parseTableBill(broken)).toThrow();
  });

  it("gives each phone its own part by default and staff rounds the first part", () => {
    const value = splitBillFixture();
    const rounds = value.rounds as Record<string, unknown>[];
    rounds.push({ ...rounds[1], roundNumber: 3, orderedBy: null });
    expect([...defaultRoundParts(parseTableBill(value))]).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
  });

  it("v15 2026-10-30 (item 8 ⑨): a merged bill gives each table one part, its staff rounds with it", () => {
    const value = splitBillFixture();
    const rounds = value.rounds as Record<string, unknown>[];
    rounds.push(
      // Staff entered this table's tea; the merged table's phone and its tea came from DEMO-02.
      { ...rounds[1], roundNumber: 3, orderedBy: null, fromTableLabel: null },
      { ...rounds[1], roundNumber: 4, orderedBy: 3, fromTableLabel: "DEMO-02" },
      { ...rounds[1], roundNumber: 5, orderedBy: null, fromTableLabel: "DEMO-02" },
    );
    expect([...defaultRoundParts(parseTableBill(value))]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
    ]);
  });

  it("offers each paying for their own rounds only when different phones sent them", () => {
    const render = (orderedBy: readonly (number | null)[]) => {
      const value = splitBillFixture();
      value.split = null;
      const rounds = value.rounds as Record<string, unknown>[];
      orderedBy.forEach((phone, index) => {
        rounds[index] = { ...rounds[0], roundNumber: index + 1, orderedBy: phone };
      });
      rounds.length = orderedBy.length;
      return renderToStaticMarkup(
        <TableSplitControls
          bill={parseTableBill(value)}
          csrf={"a".repeat(43)}
          client={createTableCheckoutClient()}
          disabled={false}
          selectedPart={null}
          onSelectPart={() => undefined}
          onBill={() => undefined}
          onProblem={() => undefined}
        />,
      );
    };
    expect(render([1])).not.toContain("Each pays own rounds");
    expect(render([1, 1])).not.toContain("Each pays own rounds");
    expect(render([1, null])).not.toContain("Each pays own rounds");
    expect(render([1])).toContain("Split evenly");
    expect(render([1, 2])).toContain("Each pays own rounds");
  });

  it("asks for no second step once split evenly, except when the bill has changed", () => {
    const render = (stale: boolean) => {
      const value = splitBillFixture();
      const split = value.split as Record<string, unknown>;
      split.stale = stale;
      split.paidParts = 0;
      split.parts = (split.parts as Record<string, unknown>[]).map((part) => ({
        ...part,
        payment: null,
        guestPaying: false,
      }));
      return renderToStaticMarkup(
        <TableSplitControls
          bill={parseTableBill(value)}
          csrf={"a".repeat(43)}
          client={createTableCheckoutClient()}
          disabled={false}
          selectedPart={null}
          onSelectPart={() => undefined}
          onBill={() => undefined}
          onProblem={() => undefined}
        />,
      );
    };
    expect(render(false)).not.toContain("Split again");
    expect(render(false)).not.toContain("Split in ");
    expect(render(true)).toContain("Split again");
  });

  it("by dish: says what each part pays for and offers the dishes to assign", () => {
    const value = splitBillFixture();
    const split = value.split as Record<string, unknown>;
    split.mode = "ByItems";
    split.paidParts = 0;
    split.parts = (split.parts as Record<string, unknown>[]).map((part, index) => ({
      ...part,
      payment: null,
      guestPaying: false,
      dishes:
        index === 0
          ? [{ displayName: "Mapo tofu (TEST)", quantity: 2, shared: false }]
          : [{ displayName: "Har gow (TEST)", quantity: 1, shared: true }],
    }));
    const rounds = value.rounds as { items: Record<string, unknown>[] }[];
    (rounds[0]?.items[0] as Record<string, unknown>).quantity = 2;
    const html = renderToStaticMarkup(
      <TableSplitControls
        bill={parseTableBill(value)}
        csrf={"a".repeat(43)}
        client={createTableCheckoutClient()}
        disabled={false}
        selectedPart={null}
        onSelectPart={() => undefined}
        onBill={() => undefined}
        onProblem={() => undefined}
      />,
    );
    expect(html).toContain("By dish");
    expect(html).toContain("2 × Mapo tofu (TEST)");
    expect(html).toContain("Har gow (TEST) (shared)");
    // One row per unit, so one of two dishes can go to another part.
    expect(html).toContain("Mapo tofu (TEST) (1/2)");
    expect(html).toContain("Mapo tofu (TEST) (2/2)");
    expect(html).toContain("Everyone shares");
  });

  it("lists each part with its status, collects only an open part, and locks the split once paid", () => {
    const html = renderToStaticMarkup(
      <TableSplitControls
        bill={parseTableBill(splitBillFixture())}
        csrf={"a".repeat(43)}
        client={createTableCheckoutClient()}
        disabled={false}
        selectedPart={null}
        onSelectPart={() => undefined}
        onBill={() => undefined}
        onProblem={() => undefined}
      />,
    );
    expect(html).toContain("Paid $35.84 · card machine");
    expect(html).toContain("A guest is paying on their phone");
    expect(html).toContain("To collect");
    expect(html.match(/Collect this part/gu)).toHaveLength(1);
    expect(html).toContain("1 of 3 parts paid · $63.28 to go");
    // A part is paid: the way of splitting can't change.
    expect(html).not.toContain("Split in ");
    expect(html).toContain("Split evenly · 3 parts");
  });
});

describe("WP-2423 同桌结账: guests paying by dish, staff take the rest", () => {
  const byGuests = (paidInFull: boolean) => {
    const value = splitBillFixture();
    const split = value.split as Record<string, unknown>;
    const [first, , third] = split.parts as Record<string, unknown>[];
    // Part 1 failed on a phone and was withdrawn (left out); 2 paid online, 3 being paid.
    split.mode = "ByGuests";
    split.paidInFull = paidInFull;
    split.restMinor = paidInFull ? null : "1301";
    split.restSubtotalMinor = paidInFull ? null : "1150";
    split.parts = [
      {
        ...first,
        partNumber: 2,
        choice: "Chosen",
        dishes: [{ displayName: "Beef noodle soup", quantity: 1, shared: false }],
      },
      {
        ...third,
        partNumber: 3,
        choice: "Mine",
        dishes: [{ displayName: "Pork dumplings", quantity: 3, shared: false }],
      },
    ];
    split.paidParts = 1;
    return value;
  };
  const render = (value: Record<string, unknown>) =>
    renderToStaticMarkup(
      <TableSplitControls
        bill={parseTableBill(value)}
        csrf={"a".repeat(43)}
        client={createTableCheckoutClient()}
        disabled={false}
        selectedPart={null}
        onSelectPart={() => undefined}
        onBill={() => undefined}
        onProblem={() => undefined}
      />,
    );

  it("reads parts whose numbers skip a withdrawn one, and what is left to take", () => {
    const bill = parseTableBill(byGuests(false));
    expect(bill.split?.parts.map((part) => part.partNumber)).toEqual([2, 3]);
    expect([bill.split?.paidInFull, bill.split?.restMinor]).toEqual([false, "1301"]);
    const backwards = byGuests(false);
    (backwards.split as { parts: unknown[] }).parts.reverse();
    expect(() => parseTableBill(backwards)).toThrow();
  });

  it("lists what each guest paid or is paying by dish, and the rest for the counter", () => {
    const html = render(byGuests(false));
    expect(html).toContain("Guests paying by dish");
    expect(html).toContain("Beef noodle soup");
    expect(html).toContain("3 × Pork dumplings");
    expect(html).toContain("A guest is paying on their phone");
    expect(html).toContain("Not chosen yet · $13.01. Take it at the counter below.");
    // No split controls once guests started paying by dish.
    expect(html).not.toContain("Split evenly");
    expect(render(byGuests(true))).toContain("Every dish is paid.");
  });

  it("says the rest couldn't be worked out, never that every dish is chosen", () => {
    const value = byGuests(false);
    const split = value.split as Record<string, unknown>;
    split.restMinor = null;
    split.restSubtotalMinor = null;
    split.restUnavailable = true;
    expect(parseTableBill(value).split?.restUnavailable).toBe(true);
    const html = render(value);
    expect(html).toContain(
      "We couldn&#x27;t work out what is left to pay just now. Refresh the bill and try again.",
    );
    expect(html).not.toContain("Every dish is chosen");
  });
});
