import { describe, expect, it } from "vitest";
import {
  decideGuestNewParty,
  decideGuestTableQuietClose,
  decideGuestTableStart,
  type GuestTableCloseFacts,
  type GuestTableStartFacts,
} from "../domain/dining-guest-table-start.js";

const now = "2026-11-05T12:00:00.000Z";
const starts = (table: number) => ({ table, store: table });
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();

describe("DEC-DINING-GUEST-TABLE-START: who may start a table", () => {
  const free: GuestTableStartFacts = {
    switchOn: true,
    storeTiming: "PayFirst",
    lifecycle: "Published",
    qrStatus: "Active",
    operationalState: "Available",
    blockReasonCode: null,
    tableObservedAt: ago(60),
    occupied: false,
  };
  it.each([
    ["a free table", {}, { kind: "MayStart", clearsCleaning: false }],
    ["the switch off", { switchOn: false }, { kind: "No" }],
    ["a pay-later Store", { storeTiming: "PayLater" }, { kind: "No" }],
    ["a table not published", { lifecycle: "Draft" }, { kind: "No" }],
    ["a code not in use", { qrStatus: "Revoked" }, { kind: "No" }],
    ["a table in use", { occupied: true }, { kind: "No" }],
    [
      "a table blocked for another reason",
      { operationalState: "TemporarilyBlocked", blockReasonCode: "REPAIR" },
      { kind: "No" },
    ],
    [
      "cleaning within the grace time",
      {
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "CLEANING",
        tableObservedAt: ago(4),
      },
      { kind: "BeingCleaned" },
    ],
    [
      "cleaning nobody marked for 5 minutes",
      {
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "CLEANING",
        tableObservedAt: ago(5),
      },
      { kind: "MayStart", clearsCleaning: true },
    ],
  ])("%s", (_name, changes, expected) => {
    expect(decideGuestTableStart({ ...free, ...changes } as GuestTableStartFacts, now)).toEqual(
      expected,
    );
  });
});

const quiet = (changes: Partial<GuestTableCloseFacts> = {}): GuestTableCloseFacts => ({
  startedAt: ago(200),
  activity: [null, null, null, null],
  cartHasItems: false,
  cartChangedAt: null,
  openStaffCall: false,
  merged: false,
  scanPaused: false,
  order: null,
  ...changes,
});
const paid = { unfinishedItems: 0, blockers: [], readyItems: 0 };

describe("DEC-DINING-GUEST-TABLE-START: the quiet rule", () => {
  it("frees a table with no order after 20 minutes, not before", () => {
    expect(decideGuestTableQuietClose(quiet({ startedAt: ago(20) }), now).close).toBe(true);
    expect(decideGuestTableQuietClose(quiet({ startedAt: ago(19) }), now)).toEqual({
      close: false,
      hold: "Recent",
      closesAt: new Date(Date.parse(ago(19)) + 20 * 60_000).toISOString(),
    });
  });
  it("gives a party with an order 90 quiet minutes: an hour at the table is normal", () => {
    expect(
      decideGuestTableQuietClose(quiet({ order: paid, activity: [ago(60), null] }), now).close,
    ).toBe(false);
    expect(
      decideGuestTableQuietClose(quiet({ order: paid, activity: [ago(90), null] }), now).close,
    ).toBe(true);
  });
  it("counts the latest of everything that happened", () => {
    expect(
      decideGuestTableQuietClose(
        quiet({ order: paid, activity: [ago(200), ago(100), ago(10), null] }),
        now,
      ).close,
    ).toBe(false);
  });
  it.each([
    ["an open staff call", { openStaffCall: true }, "StaffCall"],
    ["a merged table", { merged: true }, "Merged"],
    ["a cart with something in it", { cartHasItems: true }, "CartInUse"],
    [
      "a cart with something in it, however long since it changed",
      { cartHasItems: true, cartChangedAt: ago(100) },
      "CartInUse",
    ],
    ["a dish not finished", { order: { ...paid, unfinishedItems: 1 } }, "Unfinished"],
    ["a refund pending", { order: { ...paid, blockers: ["REFUND_PENDING"] } }, "Owed"],
    ["an unpaid balance", { order: { ...paid, blockers: ["ORDER_BALANCE_UNPAID"] } }, "Owed"],
  ] as const)("%s holds it, however long it has been quiet", (_name, changes, hold) => {
    expect(decideGuestTableQuietClose(quiet(changes as never), now)).toEqual({
      close: false,
      hold,
      closesAt: null,
    });
  });
  it("a dish the kitchen finished doesn't hold it: it counts as handed over", () => {
    expect(
      decideGuestTableQuietClose(quiet({ order: { ...paid, readyItems: 2 } }), now).close,
    ).toBe(true);
  });
  it("a staff pause is about new phones: the table still frees itself", () => {
    expect(decideGuestTableQuietClose(quiet({ scanPaused: true }), now).close).toBe(true);
  });
});

describe("DEC-DINING-GUEST-TABLE-START: the next party", () => {
  it("is asked only after 5 quiet minutes", () => {
    expect(decideGuestNewParty(quiet({ startedAt: ago(4) }), now, starts(1))).toEqual({
      ask: false,
      hold: "Recent",
    });
    expect(decideGuestNewParty(quiet({ startedAt: ago(5) }), now, starts(1))).toEqual({
      ask: true,
    });
  });
  it.each([
    ["a dish not finished", { order: { ...paid, unfinishedItems: 1 } }, "Unfinished"],
    ["anything owed", { order: { ...paid, blockers: ["REFUND_PENDING"] } }, "Owed"],
    ["a call for staff", { openStaffCall: true }, "StaffCall"],
    ["a merged table", { merged: true }, "Merged"],
    ["a staff pause on scanning", { scanPaused: true }, "Paused"],
    ["a cart nobody has dated", { cartHasItems: true }, "CartInUse"],
    ["a cart changed 19 minutes ago", { cartHasItems: true, cartChangedAt: ago(19) }, "CartInUse"],
  ] as const)("isn't asked with %s", (_name, changes, hold) => {
    expect(decideGuestNewParty(quiet(changes as never), now, starts(0))).toEqual({
      ask: false,
      hold,
    });
  });
  it("a dish left in a cart nobody touched for 20 minutes doesn't stop the next party being asked", () => {
    expect(
      decideGuestNewParty(quiet({ cartHasItems: true, cartChangedAt: ago(20) }), now, starts(0)),
    ).toEqual({ ask: true });
    // An empty cart holds nothing, whenever it changed; its change still counts as activity.
    expect(
      decideGuestNewParty(quiet({ cartChangedAt: ago(1), activity: [ago(1)] }), now, starts(0)),
    ).toEqual({ ask: false, hold: "Recent" });
  });
  it("isn't asked once the table's or the Store's starts are spent", () => {
    const budget = { ask: false, hold: "Budget" };
    expect(decideGuestNewParty(quiet(), now, starts(3))).toEqual(budget);
    expect(decideGuestNewParty(quiet(), now, { table: 0, store: 40 })).toEqual(budget);
    expect(decideGuestNewParty(quiet(), now, { table: 2, store: 39 })).toEqual({ ask: true });
  });
});
