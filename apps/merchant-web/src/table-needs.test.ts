import { expect, it } from "vitest";
import type { StaffDiningTable } from "./dining-session-client.js";
import { compareTables, tableInTab, tableNeed } from "./table-needs.js";
import type { TableOrderFacts } from "./table-order-facts.js";

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
