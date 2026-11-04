// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  clearLastBills,
  LAST_BILLS_KEY,
  loadLastBills,
  saveLastBills,
} from "./table-last-bills.js";

const table = {
  label: "T2",
  owedMinor: "2685",
  settled: false,
  rounds: [
    { number: 1, totalMinor: "2685", items: [{ name: "Mapo tofu", subtotalMinor: "1588" }] },
  ],
};
beforeEach(() => localStorage.clear());

it("keeps each table's last bill on this device, as of when it was read", () => {
  saveLastBills([table], new Date("2026-11-03T22:00:00.000Z"));
  const read = loadLastBills(Date.parse("2026-11-03T22:30:00.000Z"));
  expect(read?.savedAt).toBe("2026-11-03T22:00:00.000Z");
  expect(read?.tables).toEqual([table]);
});

it("never shows last night's bills as tonight's", () => {
  saveLastBills([table], new Date("2026-11-03T02:00:00.000Z"));
  expect(loadLastBills(Date.parse("2026-11-03T22:30:00.000Z"))).toBeNull();
});

it("holds nothing when no table is open or after signing out", () => {
  saveLastBills([table]);
  saveLastBills([]);
  expect(localStorage.getItem(LAST_BILLS_KEY)).toBeNull();
  saveLastBills([table]);
  clearLastBills();
  expect(loadLastBills()).toBeNull();
});

it("reads nothing from a damaged value", () => {
  localStorage.setItem(LAST_BILLS_KEY, "{not json");
  expect(loadLastBills()).toBeNull();
});
