import { describe, expect, it } from "vitest";
import type { StaffDiningTable } from "./dining-session-client.js";
import { compareTables, tableInTab, tableNeed, tablesFreeingSoon } from "./table-needs.js";
import { tableFactsFromBill, type TableOrderFacts } from "./table-order-facts.js";
import type { TableBill } from "./table-checkout-client.js";
import { listFactsOf } from "./DiningSessionWorkspace.js";
import { setLanguageForTest } from "./i18n/i18n.js";

const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = Date.parse("2026-10-27T19:42:00.000Z");
const table = (n: number, changes: Partial<StaffDiningTable> = {}): StaffDiningTable => ({
  tableReference: id(n),
  stableLabel: String(n),
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  blockReasonCode: null,
  aggregateVersion: 1,
  currentDiningSessionReference: id(100 + n),
  elapsedMinutes: 30,
  qrCodeValidUntil: "2027-01-01T00:00:00.000Z",
  paymentTiming: "PayLater",
  staffRoundsAwaitingPayment: [],
  guestRoundsAwaitingPayment: [],
  roundsAwaitingAcceptance: [],
  session: { phase: "Active", version: 2, orderReference: id(200 + n) },
  staffCall: null,
  ...changes,
});
const facts = (changes: Partial<TableOrderFacts> = {}): TableOrderFacts => ({
  readyToServe: 0,
  inKitchen: false,
  allServed: false,
  bill: null,
  ...changes,
});

it("WP-2423 item 8 ①: names what each table needs, with its one next step", () => {
  const call = tableNeed(
    table(5, {
      staffCall: { callReference: id(9), reason: "Question", calledAt: "2026-10-27T19:40:00.000Z" },
    }),
    facts({ readyToServe: 2 }),
    now,
  );
  // A guest waiting at the table comes before dishes at the pass.
  expect(call).toMatchObject({ tone: "action", step: "Handled", detail: "2 min ago · A question" });
  // Owner 2026-11-03: part by part, the row says what is still to collect.
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      facts({
        bill: {
          totalMinor: "3462",
          partlyPaid: { remainingMinor: "1154", paidParts: 2, partCount: 3 },
          paid: null,
        },
      }),
      now,
    ),
  ).toMatchObject({ detail: "$11.54 to go · 2 of 3 parts paid", step: "TakePayment" });
  // v15 batch 7: guests paying by dish have no number of parts, so never "1 of 1 parts paid".
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      facts({
        bill: {
          totalMinor: "4238",
          partlyPaid: { remainingMinor: "2825", paidParts: 1, partCount: null },
          paid: null,
        },
      }),
      now,
    ),
  ).toMatchObject({ detail: "$28.25 to go · paying by dish, 1 paid", step: "TakePayment" });
  // Owner 2026-11-03: before its bill is read, a table checking out is never said to owe.
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      null,
      now,
    ),
  ).toMatchObject({ words: "Checking the bill", step: null });
  // Owner 2026-11-03: a phone joining never hides a dish waiting to be served.
  expect(
    tableNeed(
      { ...table(12), newPhones: [{ phoneNumber: 1, joinedAt: "2026-10-28T18:58:00.000Z" }] },
      facts({ readyToServe: 2 }),
      now,
    ).words,
  ).toBe("2 dishes ready to serve");
  expect(tableNeed(table(12), facts({ readyToServe: 2 }), now)).toMatchObject({
    tone: "action",
    words: "2 dishes ready to serve",
    step: "ServeAll",
  });
  // Checking out: the bill comes from the system (Payment), never typed into the page.
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      facts({ bill: { totalMinor: "9492", paid: null } }),
      now,
    ),
  ).toMatchObject({ words: "Waiting for payment", detail: "$94.92", step: "TakePayment" });
  // Points or comps took off everything, or a manager wrote it off: nothing to take.
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      facts({ bill: { totalMinor: "0", paid: null } }),
      now,
    ),
  ).toMatchObject({ words: "Nothing to pay · close when the guests leave", step: null });
  expect(
    tableNeed(
      table(8, { session: { phase: "Closing", version: 3, orderReference: id(208) } }),
      facts({ bill: { totalMinor: "9492", paid: { amountMinor: "10752" } } }),
      now,
    ),
  ).toMatchObject({ tone: "done", step: null });
  expect(
    tableNeed(
      table(3, {
        currentDiningSessionReference: null,
        session: null,
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "CLEANING",
      }),
      null,
      now,
    ),
  ).toMatchObject({ tone: "action", words: "Needs cleaning", step: "Cleaned" });
  expect(tableNeed(table(7, { elapsedMinutes: 13 * 60 }), facts(), now)).toMatchObject({
    words: "Open a long time",
  });
  expect(tableNeed(table(2), facts({ inKitchen: true }), now).tone).toBe("progress");
  expect(tableNeed(table(10), facts({ allServed: true }), now).tone).toBe("done");
  expect(
    tableNeed(table(1, { currentDiningSessionReference: null, session: null }), null, now),
  ).toMatchObject({ tone: "idle", words: "Free", step: null });
});

it("WP-2423 item 8 ①: lists the most urgent first and filters by tab", () => {
  const rows = [
    table(10),
    table(3, {
      currentDiningSessionReference: null,
      session: null,
      operationalState: "TemporarilyBlocked",
      blockReasonCode: "CLEANING",
    }),
    table(12),
    table(5, {
      staffCall: { callReference: id(9), reason: "Question", calledAt: "2026-10-27T19:41:00.000Z" },
    }),
  ].map((entry) => {
    const need = tableNeed(
      entry,
      entry.stableLabel === "12" ? facts({ readyToServe: 1 }) : facts(),
      now,
    );
    return { table: entry, need };
  });
  expect(rows.sort(compareTables).map((row) => row.table.stableLabel)).toEqual([
    "5",
    "12",
    "3",
    "10",
  ]);
  const count = (tab: Parameters<typeof tableInTab>[2]) =>
    rows.filter((row) => tableInTab(row.table, row.need, tab)).length;
  expect(count("Needs")).toBe(3);
  expect(count("Seated")).toBe(3);
  expect(count("Cleaning")).toBe(1);
  expect(count("Free")).toBe(0);
  expect(count("All")).toBe(4);
});

it("WP-2423 item 8 ⑤: a round waiting for staff needs action (never times out); a new phone is pointed out", () => {
  const held = tableNeed(
    table(7, {
      heldRounds: [
        {
          orderReference: id(70),
          orderBatchReference: id(71),
          roundNumber: 3,
          reason: "FirstOrder",
          heldAt: "2026-10-27T19:35:00.000Z",
        },
      ],
      newPhones: [{ phoneNumber: 3, joinedAt: "2026-10-27T19:40:00.000Z" }],
    }),
    facts({ readyToServe: 2 }),
    now,
  );
  expect([held.tone, held.words, held.detail, held.urgent]).toEqual([
    "action",
    "Round waiting for your OK",
    "first round from a new phone · 7 min ago",
    true,
  ]);
  const joined = tableNeed(
    table(8, { newPhones: [{ phoneNumber: 3, joinedAt: "2026-10-27T19:40:00.000Z" }] }),
    facts(),
    now,
  );
  expect([joined.tone, joined.words]).toEqual(["action", "Phone 3 just joined"]);
  expect(tableInTab(table(8), joined, "Needs")).toBe(true);
});

describe("DEC-DINING-GUEST-TABLE-START: a table a guest started", () => {
  const closes = (minutes: number) => ({
    closesByItselfAt: new Date(now + minutes * 60_000).toISOString(),
  });
  it("with no order yet says so, and warns only in the last 10 minutes", () => {
    const empty = { orderReference: null, phase: "Active" as const, version: 2 };
    const early = tableNeed(table(1, { session: empty, guestStart: closes(18) }), null, now);
    expect([early.tone, early.words, early.detail]).toEqual([
      "progress",
      "Started by a guest",
      "no order yet",
    ]);
    expect(tableNeed(table(1, { session: empty, guestStart: closes(9) }), null, now).detail).toBe(
      "no order yet · frees itself in 9 min",
    );
  });
  it("all served warns only in the last 10 minutes", () => {
    const served = facts({ allServed: true });
    expect(tableNeed(table(1, { guestStart: closes(80) }), served, now).detail).toBeNull();
    expect(tableNeed(table(1, { guestStart: closes(5) }), served, now).detail).toBe(
      "frees itself in 5 min",
    );
    // Due, and the System hasn't reached it yet: never "in 0 min".
    expect(tableNeed(table(1, { guestStart: closes(-1) }), served, now).detail).toBe(
      "frees itself shortly",
    );
  });
  it("a guest's unpaid round cancels itself: not a job for staff, unlike a payment not confirmed", () => {
    const round = (minutes: number) => ({
      orderReference: id(1),
      orderBatchReference: id(2),
      roundNumber: 1,
      payBy: new Date(now + minutes * 60_000).toISOString(),
    });
    const unpaid = tableNeed(
      table(1, { guestStart: closes(80), guestRoundsAwaitingPayment: [round(12)] }),
      null,
      now,
    );
    expect([unpaid.tone, unpaid.words, unpaid.detail]).toEqual([
      "progress",
      "Round not paid yet",
      "12 min left",
    ]);
    expect(
      tableNeed(
        table(1, { guestStart: closes(80), guestRoundsAwaitingPayment: [round(-30)] }),
        null,
        now,
      ).tone,
    ).toBe("action");
    // A staff-opened table is exactly as it was.
    expect(tableNeed(table(1, { guestRoundsAwaitingPayment: [round(12)] }), null, now).tone).toBe(
      "action",
    );
  });
  it("WP-2423 live minor 14: dishes ready are the guests' to collect, so the row offers no Serve all", () => {
    const need = tableNeed(table(1, { guestStart: closes(80) }), facts({ readyToServe: 2 }), now);
    expect([need.tone, need.step, need.words]).toEqual([
      "progress",
      null,
      "2 dishes ready for the guests to collect",
    ]);
    // A staff-opened table: serving them is staff's job, one tap away.
    expect(tableNeed(table(1), facts({ readyToServe: 2 }), now)).toMatchObject({
      tone: "action",
      step: "ServeAll",
      words: "2 dishes ready to serve",
    });
  });
  it("a dish nobody marked served warns too: the System records it served when it frees the table", () => {
    const ready = facts({ readyToServe: 1 });
    expect(tableNeed(table(1, { guestStart: closes(5) }), ready, now)).toMatchObject({
      tone: "progress",
      words: "1 dish ready for the guest to collect",
      detail: "frees itself in 5 min",
      step: null,
    });
    expect(tableNeed(table(1, { guestStart: closes(80) }), ready, now).detail).toBeNull();
    // Something else still being made: the table isn't going anywhere yet.
    expect(
      tableNeed(
        table(1, { guestStart: closes(5) }),
        facts({ readyToServe: 1, inKitchen: true }),
        now,
      ).detail,
    ).toBeNull();
  });
  it("a table something holds is promised nothing, and stays out of the way", () => {
    const held = { closesByItselfAt: null };
    for (const order of [facts({ readyToServe: 1 }), facts({ allServed: true })]) {
      const need = tableNeed(table(1, { guestStart: held }), order, now);
      expect(need.detail).toBeNull();
      expect(need.tone).not.toBe("action");
    }
  });
  it("long past its time it stops promising and asks a person to look", () => {
    const served = facts({ allServed: true });
    // The System reaches every table within minutes of it being due.
    expect(tableNeed(table(1, { guestStart: closes(-9) }), served, now)).toMatchObject({
      tone: "done",
      detail: "frees itself shortly",
    });
    const stuck = tableNeed(table(1, { guestStart: closes(-10) }), served, now);
    expect(stuck).toMatchObject({
      tone: "action",
      words: "Hasn’t freed itself",
      detail: "open the table",
    });
    expect(tableInTab(table(1), stuck, "Needs")).toBe(true);
    expect(
      tableNeed(table(1, { guestStart: closes(-30) }), facts({ readyToServe: 1 }), now),
    ).toMatchObject({ tone: "action", words: "Hasn’t freed itself" });
    // The kitchen working on it, or a table checking out, is something else.
    expect(
      tableNeed(table(1, { guestStart: closes(-30) }), facts({ inKitchen: true }), now).words,
    ).toBe("Kitchen is making it");
    expect(
      tableNeed(
        table(1, {
          guestStart: closes(-30),
          session: { phase: "Closing", version: 3, orderReference: id(201) },
        }),
        facts({ bill: { totalMinor: "100", paid: null } }),
        now,
      ).words,
    ).toBe("Waiting for payment");
  });
  it("in its last minutes it comes first among the seated", () => {
    const order = facts({ allServed: true });
    const rows = [
      table(2),
      table(3, { guestStart: closes(5) }),
      table(4, { guestStart: closes(70) }),
    ].map((entry) => ({ table: entry, need: tableNeed(entry, order, now) }));
    expect(rows.sort(compareTables).map((row) => row.table.stableLabel)).toEqual(["3", "2", "4"]);
  });
  it("the line at the top of Tables names what frees itself soon, soonest first", () => {
    const empty = { orderReference: null, phase: "Active" as const, version: 2 };
    const soon = tablesFreeingSoon(
      [
        { table: table(1, { guestStart: closes(9) }), order: facts({ allServed: true }) },
        { table: table(2, { session: empty, guestStart: closes(3) }), order: null },
        { table: table(3, { guestStart: closes(-2) }), order: facts({ readyToServe: 1 }) },
        // None of these: not yet, held, still being made, long past due, and any other table.
        { table: table(4, { guestStart: closes(40) }), order: facts({ allServed: true }) },
        { table: table(5, { guestStart: { closesByItselfAt: null } }), order: null },
        { table: table(6, { guestStart: closes(4) }), order: facts({ inKitchen: true }) },
        { table: table(7, { guestStart: closes(-10) }), order: facts({ allServed: true }) },
        { table: table(8), order: facts({ allServed: true }) },
      ],
      now,
    );
    expect(soon.map((row) => [row.table.stableLabel, row.minutes])).toEqual([
      ["3", 0],
      ["2", 3],
      ["1", 9],
    ]);
  });
  it("a table waiting for cleaning says when guests can start it anyway", () => {
    const blocked = (minutes: number) =>
      table(1, {
        currentDiningSessionReference: null,
        elapsedMinutes: null,
        session: null,
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "CLEANING",
        blockedSince: new Date(now - minutes * 60_000).toISOString(),
      });
    expect(tableNeed(blocked(4), null, now).detail).toBeNull();
    expect(tableNeed(blocked(5), null, now).detail).toBe("guests can start it now");
  });
});

it("WP-2423 (M171): an allergy question is named, red at once, and comes before every other call", () => {
  const allergy = tableNeed(
    table(6, {
      staffCall: {
        callReference: id(10),
        reason: "AllergyQuestion",
        calledAt: "2026-10-27T19:41:00.000Z",
      },
    }),
    facts(),
    now,
  );
  expect(allergy).toMatchObject({
    tone: "action",
    urgent: true,
    detail: "1 min ago · Allergy question",
  });
  const question = tableNeed(
    table(5, {
      staffCall: { callReference: id(9), reason: "Question", calledAt: "2026-10-27T19:30:00.000Z" },
    }),
    facts(),
    now,
  );
  expect(allergy.rank).toBeLessThan(question.rank);
});

describe("v15 batch 8: a table checking out the order queue did not bring", () => {
  const closing = table(7, { session: { phase: "Closing", version: 3, orderReference: id(207) } });
  const bill = (changes: Record<string, unknown>) =>
    ({
      owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
      settlement: null,
      split: null,
      ...changes,
    }) as unknown as TableBill;
  const part = (partNumber: number, amountMinor: string, paid: boolean) => ({
    partNumber,
    amountMinor,
    payment: paid ? { totalMinor: amountMinor } : null,
  });
  it("is said from its own bill: paid by dish in full is paid, never 'Checking the bill'", () => {
    const own = tableFactsFromBill(
      bill({
        split: {
          mode: "ByGuests",
          paidInFull: true,
          paidParts: 2,
          remainingMinor: "0",
          parts: [part(1, "1413", true), part(2, "2825", true)],
        },
      }),
    );
    const facts = listFactsOf(closing, new Map(), new Map([[id(207), { facts: own, read: 1 }]]));
    expect(tableNeed(closing, facts, now)).toMatchObject({
      tone: "done",
      words: "Paid · close when the guests leave",
      detail: "$42.38",
    });
    // A table paid whole, and one still owing part of its bill.
    expect(
      tableNeed(
        closing,
        tableFactsFromBill(
          bill({ settlement: { roundsMinor: "2500", totalMinor: "2825" }, split: null }),
        ),
        now,
      ),
    ).toMatchObject({ words: "Paid · close when the guests leave", detail: "$28.25" });
    expect(
      tableNeed(
        closing,
        tableFactsFromBill(
          bill({
            owed: { subtotalMinor: "1250", taxMinor: "163", totalMinor: "1413" },
            split: {
              mode: "ByGuests",
              paidInFull: false,
              paidParts: 1,
              remainingMinor: "1413",
              parts: [part(1, "2825", true)],
            },
          }),
        ),
        now,
      ),
    ).toMatchObject({
      words: "Waiting for payment",
      detail: "$14.13 to go · paying by dish, 1 paid",
    });
  });
  it("the queue's own facts come first, and an open table is never said from its bill", () => {
    const queue = facts({ readyToServe: 1 });
    const own = tableFactsFromBill(bill({ settlement: { roundsMinor: "100", totalMinor: "113" } }));
    expect(
      listFactsOf(
        closing,
        new Map([[id(207), queue]]),
        new Map([[id(207), { facts: own, read: 1 }]]),
        2,
      ),
    ).toBe(queue);
    expect(
      listFactsOf(table(7), new Map(), new Map([[id(207), { facts: own, read: 1 }]])),
    ).toBeNull();
    // Before either is read: still "Checking the bill".
    expect(tableNeed(closing, listFactsOf(closing, new Map(), new Map()), now).words).toBe(
      "Checking the bill",
    );
  });
  it("v15 b12: a table checking out whose bill and queue both failed stays in Needs action with Take payment", () => {
    const facts = listFactsOf(closing, new Map(), new Map());
    // Still on its way: not said as owing, among the seated.
    expect(tableNeed(closing, facts, now, false)).toMatchObject({
      tone: "progress",
      words: "Checking the bill",
      step: null,
    });
    // Its own read failed (503 or no answer): a person has to take the payment.
    const unread = tableNeed(closing, facts, now, true);
    expect(unread).toMatchObject({
      tone: "action",
      words: "Checking out · bill not read",
      detail: "open the table to see what is owed",
      step: "TakePayment",
    });
    expect(tableInTab(closing, unread, "Needs")).toBe(true);
    // Never said as owing an amount, and a bill read later says what it is.
    expect(unread.words).not.toContain("Waiting for payment");
    const own = tableFactsFromBill(
      bill({ settlement: { roundsMinor: "4238", totalMinor: "4238" } }),
    );
    expect(
      tableNeed(
        closing,
        listFactsOf(closing, new Map(), new Map([[id(207), { facts: own, read: 2 }]])),
        now,
        true,
      ).words,
    ).toBe("Paid · close when the guests leave");
    setLanguageForTest("zh-Hans");
    try {
      expect(tableNeed(closing, facts, now, true)).toMatchObject({
        words: "正在结账 · 没读到账单",
        detail: "打开这张桌查看应付金额",
      });
    } finally {
      setLanguageForTest("en");
    }
  });
  it("v15 batch 11: a bill read after a queue read that failed says what the guest paid", () => {
    // The queue's last answer (read 3) still says the table owes $42.38; its next reads fail.
    const queue = facts({
      inKitchen: true,
      bill: { totalMinor: "4238", paid: null },
    });
    // The table's own bill, read later (read 5): the guest paid in full on the phone.
    const own = tableFactsFromBill(
      bill({ settlement: { roundsMinor: "4238", totalMinor: "4238" } }),
    );
    const shown = listFactsOf(
      closing,
      new Map([[id(207), queue]]),
      new Map([[id(207), { facts: own, read: 5 }]]),
      3,
    );
    expect(tableNeed(closing, shown, now)).toMatchObject({
      words: "Paid · close when the guests leave",
      detail: "$42.38",
    });
    // What the kitchen still has stays the queue's.
    expect(shown?.inKitchen).toBe(true);
    // A bill read before the queue's answer does not replace it.
    expect(
      listFactsOf(
        closing,
        new Map([[id(207), queue]]),
        new Map([[id(207), { facts: own, read: 2 }]]),
        3,
      ),
    ).toBe(queue);
  });
});

it("v15 batch 8: a paid round waiting since last week reads in days", () => {
  const need = tableNeed(
    table(1, {
      paymentTiming: "PayFirst",
      roundsAwaitingAcceptance: [
        { roundNumber: 1, paidAt: new Date(now - 9823 * 60_000).toISOString() },
      ],
    }),
    null,
    now,
  );
  expect(need).toMatchObject({ words: "Paid round to accept", detail: "paid 6 days ago" });
  const justPaid = table(1, {
    paymentTiming: "PayFirst",
    roundsAwaitingAcceptance: [{ roundNumber: 1, paidAt: new Date(now - 20_000).toISOString() }],
  });
  expect(tableNeed(justPaid, null, now)).toMatchObject({ detail: "paid just now" });
  setLanguageForTest("zh-Hans");
  try {
    expect(tableNeed(justPaid, null, now)).toMatchObject({ detail: "刚付款" });
    expect(
      tableNeed(
        table(1, {
          paymentTiming: "PayFirst",
          roundsAwaitingAcceptance: [
            { roundNumber: 1, paidAt: new Date(now - 9823 * 60_000).toISOString() },
          ],
        }),
        null,
        now,
      ),
    ).toMatchObject({ detail: "6 天前已付款" });
  } finally {
    setLanguageForTest("en");
  }
});
