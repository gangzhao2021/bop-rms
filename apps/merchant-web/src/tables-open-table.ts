/**
 * Batch 58 (v15 batch 57 live): a link to the Tables page that opens one table's panel there. The
 * table travels in the page's history state, never in the address, so no reference is written to
 * a URL, a bookmark or the server's logs.
 */
const key = "bopOpenTable";
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function tablesOpenTableState(tableReference: string): Readonly<Record<string, string>> {
  return { [key]: tableReference };
}

/** The table a link asked Tables to open, or null for anything else in the history state. */
export function readTablesOpenTable(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const value = (state as Record<string, unknown>)[key];
  return typeof value === "string" && reference.test(value) ? value : null;
}
