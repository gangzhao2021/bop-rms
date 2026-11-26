// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  clearStaffRoundDraft,
  keepStaffRoundDraft,
  loadStaffRoundDraft,
  STAFF_ROUND_DRAFT_KEEP_MS,
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
  expect(back?.notesLeftOut).toBe(1);
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
    JSON.stringify({ ...draft, lines: [line("a", "x")], notesLeftOut: 0 }),
  );
  expect(loadStaffRoundDraft(store, table, 1_000_000)).toBeNull();
});
