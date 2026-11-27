// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  clearStaffRoundDraft,
  keepStaffRoundDraft,
  loadStaffRoundDraft,
  STAFF_ROUND_DRAFT_KEEP_MS,
  staffRoundBackOf,
  staffRoundIsForParty,
  startingStaffRound,
} from "./staff-round-draft.js";

// Batch 65 (v15 b64 live): a table's unsent staff round is kept on this device per Store and
// table, without its kitchen notes, and read back only while it is recent.
const store = "store-1";
const table = "table-1";
const line = (key: string, note?: string) => ({
  key,
  item: { sellableReference: "s-" + key, name: "Gyoza", rules: [] },
  quantity: 1,
  options: [{ optionReference: "o-1", name: "Extra", quantity: 1 }],
  ...(note === undefined ? {} : { note }),
});
const draft = {
  savedAt: 1_000_000,
  businessDate: "2026-10-15",
  party: { session: "session-1" },
  lines: [line("a", "No peanuts"), line("b")],
  tip: "15",
  customTip: "",
};
afterEach(() => globalThis.localStorage.clear());

it("keeps the round per Store and table, never a kitchen note, and counts the notes left out", () => {
  keepStaffRoundDraft(store, table, draft);
  expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain("No peanuts");
  const back = loadStaffRoundDraft(store, table, 1_000_000 + 60_000);
  expect(back?.lines.map((l) => l.key)).toEqual(["a", "b"]);
  expect(back?.noteKeysLeftOut).toEqual(["a"]);
  expect(back?.party).toEqual({ session: "session-1" });
  expect(back?.tip).toBe("15");
  expect(loadStaffRoundDraft(store, "table-2", 1_000_000)).toBeNull();
  expect(loadStaffRoundDraft("store-2", table, 1_000_000)).toBeNull();
});

it("forgets a round that is too old, unreadable, or cleared", () => {
  keepStaffRoundDraft(store, table, draft);
  expect(loadStaffRoundDraft(store, table, 1_000_000 + STAFF_ROUND_DRAFT_KEEP_MS + 1)).toBeNull();
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
  keepStaffRoundDraft(store, table, draft);
  clearStaffRoundDraft(store, table);
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
  globalThis.localStorage.setItem("bop.merchant.staffRoundDraft.v1.store-1.table-1", "{");
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
  // A line carrying a note was written by something else: not trusted.
  globalThis.localStorage.setItem(
    "bop.merchant.staffRoundDraft.v1.store-1.table-1",
    JSON.stringify({ ...draft, lines: [line("a", "x")], noteKeysLeftOut: [] }),
  );
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
});

it("counts a lost note once: not again when it is added back, nor once its line is removed", () => {
  // Brought back with line a's note left out; staff add the note again and the page reloads.
  keepStaffRoundDraft(store, table, {
    ...draft,
    lines: [line("a", "No peanuts"), line("b")],
    noteKeysLeftOut: ["a"],
  });
  expect(loadStaffRoundDraft(store, table, 1_000_000)?.noteKeysLeftOut).toEqual(["a"]);
  // Staff remove line a, which had lost its note: no note is left to add.
  keepStaffRoundDraft(store, table, { ...draft, lines: [line("b")], noteKeysLeftOut: ["a"] });
  expect(loadStaffRoundDraft(store, table, 1_000_000)?.noteKeysLeftOut).toEqual([]);
  // Still missing and still there: it is still counted.
  keepStaffRoundDraft(store, table, {
    ...draft,
    lines: [line("a"), line("b")],
    noteKeysLeftOut: ["a"],
  });
  expect(loadStaffRoundDraft(store, table, 1_000_000)?.noteKeysLeftOut).toEqual(["a"]);
  // A count naming a line that is not in the round was written by something else: not trusted.
  globalThis.localStorage.setItem(
    "bop.merchant.staffRoundDraft.v1.store-1.table-1",
    JSON.stringify({ ...draft, lines: [line("b")], noteKeysLeftOut: ["a"] }),
  );
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
});

// Batch 66 (v15 b65 live, TM2 K65 A): what the language switch kept was not checked against the
// table's party, and it dropped the brought-back round's notes reminder.
it("starts from either kept round with its party, day and notes reminder", () => {
  keepStaffRoundDraft(store, table, { ...draft, noteKeysLeftOut: [] });
  const onDevice = loadStaffRoundDraft(store, table, 1_000_000);
  const fromDevice = startingStaffRound(null, onDevice);
  expect(fromDevice?.party).toEqual({ session: "session-1" });
  expect(fromDevice?.businessDate).toBe("2026-10-15");
  expect(fromDevice?.roundBack).toEqual({ noteKeysLeftOut: ["a"] });
  // The language switch's entry is used first, and carries what it was given.
  const switched = {
    lines: [line("a"), line("b")],
    tip: "0",
    customTip: "",
    party: { session: "session-1" },
    businessDate: "2026-10-15",
    roundBack: { noteKeysLeftOut: ["a"] },
  };
  expect(startingStaffRound(switched, onDevice)).toEqual(switched);
  // A switch while staff only took the order: nothing was brought back, so no note.
  const plain = { lines: [line("a")], tip: "0", customTip: "", party: { session: "session-1" } };
  expect(startingStaffRound(plain, null)).toEqual({
    ...plain,
    businessDate: null,
    roundBack: null,
  });
  expect(startingStaffRound(null, null)).toBeNull();
});

it("holds a kept round only for the party seated at the table now", () => {
  expect(staffRoundIsForParty({ session: "session-1" }, "session-1")).toBe(true);
  // Closed and seated again, or closed and free now: another party's round.
  expect(staffRoundIsForParty({ session: "session-1" }, "session-2")).toBe(false);
  expect(staffRoundIsForParty({ session: "session-1" }, null)).toBe(false);
  // Taken while the table was free: still this table's while it is free, not once seated.
  expect(staffRoundIsForParty({ session: null }, null)).toBe(true);
  expect(staffRoundIsForParty(null, undefined)).toBe(true);
  expect(staffRoundIsForParty({ session: null }, "session-2")).toBe(false);
});

it("reads a switch-kept notes reminder only for lines in the round", () => {
  const lines = [{ key: "a" }, { key: "b" }];
  expect(staffRoundBackOf(undefined, lines)).toBeUndefined();
  expect(staffRoundBackOf(null, lines)).toBeNull();
  expect(staffRoundBackOf({ noteKeysLeftOut: ["a", "a"] }, lines)).toEqual({
    noteKeysLeftOut: ["a"],
  });
  expect(staffRoundBackOf({ noteKeysLeftOut: ["c"] }, lines)).toBeNull();
  expect(staffRoundBackOf({ noteKeysLeftOut: "a" }, lines)).toBeNull();
});
