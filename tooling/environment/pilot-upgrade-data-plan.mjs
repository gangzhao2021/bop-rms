const historyTable = "platform_core.migration_history";
const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const invalid = () => {
  throw Error("PILOT_UPGRADE_DATA_PLAN_INVALID");
};
function inventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  for (const [name, entry] of Object.entries(value)) {
    const parts = name.split(".");
    if (
      parts.length !== 2 ||
      parts.some((part) => !identifier.test(part)) ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "count,digest" ||
      typeof entry.count !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(entry.count) ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{32}$/u.test(entry.digest)
    )
      invalid();
  }
  if (!value[historyTable] || value[historyTable].count === "0") invalid();
}
// Used only between fresh canonical pre-data/data and post-data restoration.
// The caller must verify migration history on the fresh template and final target.
export function createPilotUpgradeDataPlan({ sourceTables, canonicalTables, archiveList }) {
  inventory(sourceTables);
  inventory(canonicalTables);
  if (typeof archiveList !== "string" || archiveList.length > 16_000_000) invalid();
  const skipped = new Set([historyTable]),
    expectedBusinessTables = {};
  for (const [table, entry] of Object.entries(sourceTables)) {
    if (!Object.hasOwn(canonicalTables, table)) invalid();
    if (table !== historyTable) expectedBusinessTables[table] = { ...entry };
  }
  for (const [table, entry] of Object.entries(canonicalTables)) {
    if (table === historyTable) continue;
    const source = sourceTables[table];
    if (entry.count !== "0") {
      if (!source || source.count !== entry.count || source.digest !== entry.digest) invalid();
      skipped.add(table);
    } else if (!source) expectedBusinessTables[table] = { ...entry };
  }
  const selected = [],
    seenTables = new Set(),
    sequenceNames = new Set(),
    ids = new Set();
  for (const line of archiveList.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith(";")) continue;
    const id = /^(\d+); /u.exec(line)?.[1];
    if (!id || ids.has(id)) invalid();
    ids.add(id);
    const match = /^\d+; \d+ \d+ (TABLE DATA|SEQUENCE SET) (\S+) (\S+) \S+$/u.exec(line);
    if (!match) {
      if (/\b(?:TABLE DATA|SEQUENCE SET)\b/u.test(line)) invalid();
      continue;
    }
    const [, kind, schema, name] = match;
    if (!identifier.test(schema) || !identifier.test(name)) invalid();
    const key = schema + "." + name;
    if (kind === "TABLE DATA") {
      if (!Object.hasOwn(sourceTables, key) || seenTables.has(key)) invalid();
      seenTables.add(key);
      if (!skipped.has(key)) selected.push(line);
    } else {
      if (sequenceNames.has(key)) invalid();
      sequenceNames.add(key);
      selected.push(line);
    }
  }
  for (const table of Object.keys(sourceTables)) if (!seenTables.has(table)) invalid();
  return {
    restoreList: selected.join("\n") + "\n",
    expectedBusinessTables,
    skippedTables: [...skipped].sort(),
    sequenceNames: [...sequenceNames].sort(),
  };
}
