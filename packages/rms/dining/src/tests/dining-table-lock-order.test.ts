import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WP-2423 M68 (c) DEC-DATABASE-RESILIENCE: one lock order for a Dining table. Whatever locks the
 * table row takes the table's advisory key `DiningTable:<table>` first (step 3, then step 4), so a
 * holder of the row never waits for that key and a guest's or staff member's transaction cannot
 * form a cycle with a table command (40P01). Nothing share-locks the table row: the guest's own
 * table check reads the committed row. This guard reads every Dining persistence source, so a new
 * row lock without the key, or a row-then-advisory read, fails here before it reaches a table.
 */
const directory = new URL("../infrastructure/persistence/", import.meta.url);
const sources = readdirSync(directory)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(new URL(name, directory), "utf8") }));

/** SQL literals (quoted or template) that read the table row itself, not its operation tables. */
const tableRead =
  /"((?:SELECT|WITH)[^"\n]*)"|'((?:SELECT|WITH)[^'\n]*)'|`((?:SELECT|WITH)[^`]*)`/gu;
const tableRow = /rms_dining\.dining_table(?![_a-z])/u;
const rowLock = /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u;
const tableKey = /`DiningTable:\$\{/u;
/** How far before a row lock its table key must have been taken (one statement or two). */
const window = 12;

function lineOf(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}
function before(text: string, line: number) {
  return text
    .split("\n")
    .slice(Math.max(0, line - 1 - window), line - 1)
    .join("\n");
}

describe("WP-2423 M68 one Dining table lock order", () => {
  const locks = sources.flatMap(({ name, text }) =>
    [...text.matchAll(tableRead)]
      .map((match) => ({
        name,
        text,
        sql: match[1] ?? match[2] ?? match[3] ?? "",
        line: lineOf(text, match.index ?? 0),
      }))
      .filter(
        (lock) =>
          tableRow.test(lock.sql) && (rowLock.test(lock.sql) || /\$\{lock \?/u.test(lock.sql)),
      ),
  );

  it("finds the table row locks it guards", () => {
    // The guard must see the known lockers; if a refactor hides them from it, say so here.
    expect(locks.length).toBeGreaterThanOrEqual(15);
  });

  it("never share-locks the table row", () => {
    expect(
      locks
        .filter((lock) => /\bFOR (?:SHARE|KEY SHARE)\b/u.test(lock.sql))
        .map((lock) => `${lock.name}:${lock.line}`),
    ).toEqual([]);
  });

  it("takes DiningTable:<table> before every lock on the table row", () => {
    const missing: string[] = [];
    for (const lock of locks) {
      if (/\$\{lock \?/u.test(lock.sql)) {
        // dining-table-store's load(tx, table, lock): each locking call needs the key first.
        for (const call of lock.text.matchAll(/await load\([^)]*,\s*true\)/gu)) {
          const line = lineOf(lock.text, call.index ?? 0);
          if (!tableKey.test(before(lock.text, line))) missing.push(`${lock.name}:${line}`);
        }
      } else if (!tableKey.test(before(lock.text, lock.line))) {
        missing.push(`${lock.name}:${lock.line}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
