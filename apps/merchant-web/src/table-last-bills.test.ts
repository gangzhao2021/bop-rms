// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearLastBills,
  LAST_BILLS_KEY,
  lastTableBill,
  loadLastBills,
  saveLastBills,
} from "./table-last-bills.js";
import { parseTableBill } from "./table-checkout-client.js";
import { splitBillFixture } from "./table-split.fixtures.js";
import { TablesOfflineGuide } from "./TablesOfflineGuide.js";

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

// DEC-TAX-WHOLE-RECEIPT: during an outage staff read the same figures as checkout — each round as
// ordered and the bill's tax rounding as one line — never a third set of round amounts.
it("keeps each round as ordered and the bill's tax rounding on its own", () => {
  const value = splitBillFixture();
  const rounds = value.rounds as Record<string, unknown>[];
  rounds[0] = { ...rounds[0], taxMinor: "630", totalMinor: "5480", taxRoundingMinor: "-1" };
  value.owed = { subtotalMinor: "8400", taxMinor: "1091", totalMinor: "9491" };
  const kept = lastTableBill("T8", parseTableBill(value));
  expect(kept.rounds.map((round) => round.totalMinor)).toEqual(["5481", "4011"]);
  expect(kept.taxRoundingMinor).toBe("-1");
  expect(kept.owedMinor).toBe("9491");
  saveLastBills([kept]);
  const html = renderToStaticMarkup(createElement(TablesOfflineGuide));
  expect(html).toContain("<dt>Round 1</dt><dd>$54.81</dd>");
  expect(html).toContain("<dt>Tax rounding</dt><dd>−$0.01</dd>");
  expect(html).toContain("To pay $94.91");
});
