import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { createTableCheckoutClient, parseTableBill } from "./table-checkout-client.js";
import {
  byDishUnitAmounts,
  defaultRoundParts,
  splitRoundSender,
  TableSplitControls,
} from "./TableSplit.js";
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

  // b39 review (v15 sweep 38): after H6 was merged into H4, the parts and rounds said only
  // "phone 1" / "phone 3"; staff could not tell which part was which table's.
  it("names each merged round's table and each part's table and rounds", () => {
    const merged = () => {
      const value = splitBillFixture();
      const rounds = value.rounds as Record<string, unknown>[];
      rounds.push(
        { ...rounds[1], roundNumber: 3, orderedBy: null, fromTableLabel: null },
        { ...rounds[1], roundNumber: 4, orderedBy: 1, fromTableLabel: "DEMO-02" },
      );
      const parts = (value.split as { parts: Record<string, unknown>[] }).parts;
      value.split = {
        ...(value.split as object),
        mode: "ByRounds",
        paidParts: 0,
        parts: [
          { ...parts[1], partNumber: 1, roundNumbers: [1, 2, 3] },
          { ...parts[1], partNumber: 2, roundNumbers: [4] },
        ],
      };
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
    const parts = merged();
    expect(parts).toContain("Table 8 · rounds 1, 2, 3");
    expect(parts).toContain("Table DEMO-02 · rounds 4");
    // Before any part is paid the rounds can still be moved; each names its table first.
    expect(parts).toContain("Round 1 · Table 8 · phone 1");
    // b40: DEMO-02's guests used one phone; the table names it, no phone number.
    expect(parts).toContain("Round 4 · Table DEMO-02 · $");
    expect(parts).not.toContain("Table DEMO-02 · phone");
    expect(parts).toContain("Round 3 · Table 8 · entered by staff");
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

describe("b40 who sent each round on a merged bill", () => {
  // v15 b39 live: L39 M3 (one phone, phone 3 on the merged bill) merged into L39 M2.
  const merged = () => {
    const value = splitBillFixture() as { rounds: Record<string, unknown>[] };
    const base = value.rounds[0] as Record<string, unknown>;
    value.rounds = [
      { ...base, roundNumber: 1, orderedBy: 1, fromTableLabel: null },
      { ...base, roundNumber: 2, orderedBy: 3, fromTableLabel: "L39 M3 (TEST)" },
      { ...base, roundNumber: 3, orderedBy: 3, fromTableLabel: "L39 M3 (TEST)" },
      { ...base, roundNumber: 4, orderedBy: 1, fromTableLabel: null },
    ];
    return value;
  };
  it("names a merged table's only phone by the table, never as phone 3", () => {
    const bill = parseTableBill(merged());
    expect(bill.rounds.map((round) => splitRoundSender(bill, round))).toEqual([
      "phone 1",
      null,
      null,
      "phone 1",
    ]);
  });
  it("tells a merged table's several phones apart, and says a staff round", () => {
    const value = merged();
    (value.rounds[2] as Record<string, unknown>).orderedBy = 4;
    (value.rounds[3] as Record<string, unknown>).orderedBy = null;
    const bill = parseTableBill(value);
    expect(bill.rounds.map((round) => splitRoundSender(bill, round))).toEqual([
      "phone 1",
      "phone 3",
      "phone 4",
      "entered by staff",
    ]);
  });
});

// b41 (v15 b40 live, TM2 H40 A with H40 B merged in): Beef noodles $12.50 on rounds 1 and 2, Soy
// milk $3.25 on round 3 at 13 %, round 4 taken off. The bill is $31.92: round 3 carries the bill's
// −$0.01 tax rounding ($3.66). By dish listed Soy milk at $3.67, so the dishes came to $31.93, and
// "Split this way" made Part 1 (Beef noodles + Soy milk) $17.79, not the $17.80 the lines said.
describe("b41: By dish lists each dish as the bill charges it", () => {
  const id = (n: number) => "0190a441-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const dish = (item: number, name: string, subtotal: string, total: string, quantity = 1) => ({
    orderItemReference: id(item),
    quantity,
    displayName: name,
    subtotalMinor: subtotal,
    totalMinor: total,
    reduction: null,
  });
  const round = (
    roundNumber: number,
    items: ReturnType<typeof dish>[],
    sums: [string, string, string, string],
  ) => ({
    roundNumber,
    orderBatchReference: id(100 + roundNumber),
    submissionReference: id(200 + roundNumber),
    items,
    takenOffDishes: [],
    subtotalMinor: sums[0],
    taxMinor: sums[1],
    totalMinor: sums[2],
    taxRoundingMinor: sums[3],
    paid: false,
    orderedBy: roundNumber === 2 || roundNumber === 4 ? null : 1,
    fromTableLabel: roundNumber === 2 || roundNumber === 4 ? "H40 B (TEST)" : null,
  });
  const liveBill = (split: unknown = null) =>
    parseTableBill({
      ...splitBillFixture(),
      tableLabel: "H40 A (TEST)",
      rounds: [
        round(1, [dish(1, "Beef noodles (TEST)", "1250", "1413")], ["1250", "163", "1413", "0"]),
        round(2, [dish(2, "Beef noodles (TEST)", "1250", "1413")], ["1250", "163", "1413", "0"]),
        round(3, [dish(3, "Soy milk", "325", "367")], ["325", "41", "366", "-1"]),
        round(4, [], ["0", "0", "0", "0"]),
      ],
      owed: { subtotalMinor: "2825", taxMinor: "367", totalMinor: "3192" },
      split,
    });
  const key = (item: number, unit = 1) => `${id(item)}:${unit}`;

  it("puts the round's cent on its line, so the lines add up to the bill", () => {
    const amounts = byDishUnitAmounts(liveBill(), () => null, 2);
    expect([key(1), key(2), key(3)].map((k) => amounts.get(k))).toEqual([1413n, 1413n, 366n]);
    expect([...amounts.values()].reduce((sum, value) => sum + value, 0n)).toBe(3192n);
    // Beef noodles and Soy milk to part 1, the merged table's noodles to part 2: part 1's lines are
    // the $17.79 the split makes.
    const parts = new Map([
      [key(1), 1],
      [key(3), 1],
      [key(2), 2],
    ]);
    const chosen = byDishUnitAmounts(liveBill(), (k) => parts.get(k) ?? null, 2);
    expect((chosen.get(key(1)) ?? 0n) + (chosen.get(key(3)) ?? 0n)).toBe(1779n);
  });

  it("splits a line of several evenly, the leftover cent on the first, and the rounding on the part with most tax", () => {
    // 3 × tea $1.00 (+13 % = $3.39) and a $6.25 cucumber ($7.06) on one round whose bill share is
    // $10.44 (−$0.01). Part 1 takes two teas ($0.26 tax), part 2 the cucumber ($0.81 tax): part 2
    // has most of the round's tax, so its line takes the cent.
    const bill = parseTableBill({
      ...splitBillFixture(),
      rounds: [
        round(
          1,
          [dish(11, "Tea", "300", "339", 3), dish(12, "Smashed cucumber", "625", "706")],
          ["925", "119", "1044", "-1"],
        ),
      ],
      owed: { subtotalMinor: "925", taxMinor: "119", totalMinor: "1044" },
      split: null,
    });
    const parts = new Map([
      [key(11, 1), 1],
      [key(11, 2), 1],
      [key(12), 2],
    ]);
    const amounts = byDishUnitAmounts(bill, (k) => parts.get(k) ?? null, 2);
    expect([key(11, 1), key(11, 2), key(11, 3), key(12)].map((k) => amounts.get(k))).toEqual([
      113n,
      113n,
      113n,
      705n,
    ]);
    expect([...amounts.values()].reduce((sum, value) => sum + value, 0n)).toBe(1044n);
    // 2 × $5.01 = $10.01: $5.01 and $5.00, never $5.00 twice.
    const odd = parseTableBill({
      ...splitBillFixture(),
      rounds: [round(1, [dish(13, "Bao", "886", "1001", 2)], ["886", "115", "1001", "0"])],
      owed: { subtotalMinor: "886", taxMinor: "115", totalMinor: "1001" },
      split: null,
    });
    const halves = byDishUnitAmounts(odd, () => null, 2);
    expect([halves.get(key(13, 1)), halves.get(key(13, 2))]).toEqual([501n, 500n]);
  });

  it("lists Soy milk at $3.66 in By dish, as checkout reads round 3", () => {
    const html = renderToStaticMarkup(
      <TableSplitControls
        bill={liveBill({
          mode: "ByItems",
          stale: false,
          dishChoices: [
            { orderItemReference: id(1), unit: 1, partNumber: 1 },
            { orderItemReference: id(3), unit: 1, partNumber: 1 },
            { orderItemReference: id(2), unit: 1, partNumber: 2 },
          ],
          paidParts: 0,
          remainingMinor: "3192",
          parts: [
            {
              partNumber: 1,
              amountMinor: "1779",
              subtotalMinor: "1575",
              taxMinor: "204",
              roundNumbers: [1, 3],
              dishes: [],
              payment: null,
              guestPaying: false,
            },
            {
              partNumber: 2,
              amountMinor: "1413",
              subtotalMinor: "1250",
              taxMinor: "163",
              roundNumbers: [2],
              dishes: [],
              payment: null,
              guestPaying: false,
            },
          ],
        })}
        csrf={"a".repeat(43)}
        client={createTableCheckoutClient()}
        disabled={false}
        selectedPart={null}
        onSelectPart={() => undefined}
        onBill={() => undefined}
        onProblem={() => undefined}
      />,
    );
    expect(html).toContain("Soy milk · $3.66");
    expect(html).not.toContain("$3.67");
  });
});

// Batch 42 (v15 TM2 zh-Hans): after 按菜分 each part read "牛肉面, 豆浆", with an English comma,
// while the Orders rows of the same Store list "1× 牛肉面、1× 豆浆（热）". The en list is unchanged.
describe("batch 42: a by-dish part lists its dishes in the screen's language", () => {
  afterEach(() => setLanguageForTest("en"));
  const byDish = () => {
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
          ? [
              { displayName: "牛肉面", quantity: 1, shared: false },
              { displayName: "豆浆", quantity: 1, shared: false },
            ]
          : [{ displayName: "虾饺", quantity: 2, shared: false }],
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
  it("joins them with 、 in zh-Hans and with a comma in English", () => {
    setLanguageForTest("zh-Hans");
    const zh = byDish();
    expect(zh).toContain("牛肉面、豆浆");
    expect(zh).not.toContain("牛肉面, 豆浆");
    setLanguageForTest("en");
    expect(byDish()).toContain("牛肉面, 豆浆");
  });
});
