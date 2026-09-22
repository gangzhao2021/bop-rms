import { expect, it } from "vitest";
import { createPilotUpgradeDataPlan } from "./pilot-upgrade-data-plan.mjs";
const row = (count, digest = "a".repeat(32)) => ({ count, digest });
const sourceTables = {
  "platform_core.migration_history": row("195"),
  "rms_store.store": row("2"),
  "platform_core.seed": row("1"),
  "rms_store.empty": row("0"),
};
const canonicalTables = {
  ...sourceTables,
  "platform_core.migration_history": row("196"),
  "rms_store.store": row("0"),
  "rms_store.new_table": row("0"),
};
const archiveList = `; archive
1; 0 1 TABLE DATA platform_core migration_history owner
2; 0 2 TABLE DATA rms_store store owner
3; 0 3 TABLE DATA platform_core seed owner
4; 0 4 TABLE DATA rms_store empty owner
5; 0 0 SEQUENCE SET rms_store store_seq owner
6; 0 0 ACL rms_store store owner
7; 0 0 TRIGGER rms_store store owner
`;
const plan = (patch) =>
  createPilotUpgradeDataPlan({ sourceTables, canonicalTables, archiveList, ...patch });
it("selects all historical business data and sequences but never old history, schema or ACL", () => {
  const result = plan();
  expect(result.restoreList).toBe(
    "2; 0 2 TABLE DATA rms_store store owner\n4; 0 4 TABLE DATA rms_store empty owner\n5; 0 0 SEQUENCE SET rms_store store_seq owner\n",
  );
  expect(result.skippedTables).toEqual(["platform_core.migration_history", "platform_core.seed"]);
  expect(result.expectedBusinessTables).toEqual({
    "rms_store.store": row("2"),
    "platform_core.seed": row("1"),
    "rms_store.empty": row("0"),
    "rms_store.new_table": row("0"),
  });
});
it("rejects conflicting canonical seed contents or newly seeded rows", () => {
  expect(() =>
    plan({
      canonicalTables: { ...canonicalTables, "platform_core.seed": row("1", "b".repeat(32)) },
    }),
  ).toThrow();
  expect(() =>
    plan({ canonicalTables: { ...canonicalTables, "rms_store.new_table": row("1") } }),
  ).toThrow();
});
it("rejects dropped business tables and missing migration inventories", () => {
  const missing = { ...canonicalTables };
  delete missing["rms_store.store"];
  expect(() => plan({ canonicalTables: missing })).toThrow();
  const noHistory = { ...sourceTables };
  delete noHistory["platform_core.migration_history"];
  expect(() => plan({ sourceTables: noHistory })).toThrow();
});
it.each([
  archiveList.replace("4; 0 4 TABLE DATA rms_store empty owner\n", ""),
  archiveList + "8; 0 8 TABLE DATA rms_store store owner\n",
  archiveList + "8; 0 8 TABLE DATA rms_store alien owner\n",
  archiveList + "8; 0 0 SEQUENCE SET rms_store store_seq owner\n",
  archiveList + "7; 0 0 ACL rms_store empty owner\n",
  archiveList.replace("TABLE DATA rms_store store", "TABLE DATA rms_store bad-name"),
])("rejects incomplete or ambiguous archive lists", (list) => {
  expect(() => plan({ archiveList: list })).toThrow();
});
it.each([row("-1"), row("01"), row(1), row("1", "invalid"), null])(
  "rejects malformed inventory rows",
  (entry) => {
    expect(() => plan({ sourceTables: { ...sourceTables, "rms_store.store": entry } })).toThrow();
  },
);
