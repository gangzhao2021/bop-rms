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
