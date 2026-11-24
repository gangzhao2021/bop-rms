import { describe, expect, it } from "vitest";
import { readTablesOpenTable, tablesOpenTableState } from "./tables-open-table.js";

// Batch 58 (v15 batch 57 live): order entry's refusal links to the table's panel on Tables.
describe("batch 58: the table a link asks Tables to open", () => {
  const table = "01909955-0000-7000-8000-000000000028";

  it("reads back the table the link carries", () => {
    expect(readTablesOpenTable(tablesOpenTableState(table))).toBe(table);
  });

  it("opens nothing for any other history state", () => {
    for (const state of [null, undefined, "x", 1, {}, { bopOpenTable: "T7" }, { other: table }])
      expect(readTablesOpenTable(state)).toBeNull();
  });
});
