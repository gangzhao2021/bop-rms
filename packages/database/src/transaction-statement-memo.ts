/**
 * WP-2423 (v15 latency): a staff command's owner ports each re-assert the transaction's scope
 * settings and re-take the advisory and table locks they need, so a single command repeated the
 * same `set_config`, `pg_advisory_xact_lock` and `LOCK TABLE` statements dozens of times — one
 * database round trip each. Inside one transaction those repeats cannot change anything:
 *
 * - a transaction-local scope setting already holding the value the statement writes stays as
 *   it is (every database trigger that changes a scope setting restores it before returning);
 * - an advisory transaction lock or a table lock the transaction already holds stays held until
 *   it ends, and taking it again returns at once.
 *
 * The memo answers such a repeat without a round trip. It forgets everything on any statement
 * that could undo or change what it remembers (a rollback to a savepoint, SET/RESET, any other
 * statement naming `set_config`) and on any failure, it only remembers statements that
 * succeeded, and it is only consulted while no other statement of the transaction is in flight.
 */
const scopeSettings: ReadonlySet<string> = new Set([
  "bop.tenant_id",
  "bop.brand_id",
  "bop.store_id",
  "bop.identity_session_id",
  "bop.identity_actor_id",
]);
const setConfigCall = String.raw`set_config\(\s*'([a-z_.]+)'\s*,\s*(\$\d+|'[^'\\]*')\s*,\s*true\s*\)`;
const pureSetConfig = new RegExp(
  String.raw`^SELECT\s+` +
    setConfigCall +
    String.raw`(?:\s*,\s*` +
    setConfigCall +
    String.raw`)*\s*;?$`,
  "iu",
);
const setConfigCalls = new RegExp(setConfigCall, "giu");
const advisoryLock =
  /^SELECT\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*[^()]*,\s*0\s*\)\s*\)\s*;?$/iu;
const tableLock =
  /^LOCK\s+TABLE\s+[a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*\s+IN\s+(?:ACCESS\s+SHARE|ROW\s+SHARE|ROW\s+EXCLUSIVE|SHARE\s+UPDATE\s+EXCLUSIVE|SHARE|SHARE\s+ROW\s+EXCLUSIVE|EXCLUSIVE|ACCESS\s+EXCLUSIVE)\s+MODE\s*;?$/iu;
// A rollback (to a savepoint) undoes settings and releases locks taken since; SET/RESET may change
// the role or settings; a DO block or CALL may run any of them. SAVEPOINT and RELEASE keep both, so
// the memo keeps them too. Every statement of a multi-statement query is checked, after any leading
// comment, so `SELECT 1; RESET ALL` or `/* x */ SET ROLE y` cannot slip past it. Splitting on every
// semicolon (also inside a literal) can only make the memo forget more often, never less.
const resets =
  /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:ROLLBACK|ABORT|SET|RESET|DISCARD|BEGIN|START|COMMIT|END|PREPARE|DO|CALL|LOAD)\b/iu;
const mayUndo = (sql: string) =>
  /set_config|\/\*/iu.test(sql) || sql.split(";").some((statement) => resets.test(statement));

type Remembered =
  | { readonly kind: "settings"; readonly pairs: readonly (readonly [string, string])[] }
  | { readonly kind: "lock"; readonly key: string; readonly column: string };

export interface TransactionStatementMemo {
  /** The result to answer instead of running the statement, or null to run it. */
  answer(sql: string, values: readonly unknown[]): object | null;
  /** Records a statement that ran successfully. */
  observe(sql: string, values: readonly unknown[]): void;
  /** Forgets everything (a failed statement, or anything the memo cannot reason about). */
  forget(): void;
}

function settingPairs(
  sql: string,
  values: readonly unknown[],
): readonly (readonly [string, string])[] | null {
  const pairs: [string, string][] = [];
  for (const match of sql.matchAll(setConfigCalls)) {
    const name = (match[1] ?? "").toLowerCase();
    const source = match[2] ?? "";
    let value: unknown;
    if (source.startsWith("$")) value = values[Number(source.slice(1)) - 1];
    else value = source.slice(1, -1);
    if (!scopeSettings.has(name) || typeof value !== "string") return null;
    pairs.push([name, value]);
  }
  return pairs.length === 0 ? null : pairs;
}

function classify(sql: string, values: readonly unknown[]): Remembered | null {
  const text = sql.trim();
  if (pureSetConfig.test(text)) {
    const pairs = settingPairs(text, values);
    return pairs === null ? null : { kind: "settings", pairs };
  }
  if (advisoryLock.test(text) && values.every((value) => typeof value === "string"))
    return {
      kind: "lock",
      key: "advisory\u0000" + text + "\u0000" + JSON.stringify(values),
      column: "pg_advisory_xact_lock",
    };
  if (tableLock.test(text) && values.length === 0)
    return { kind: "lock", key: "table\u0000" + text.replace(/\s+/gu, " "), column: "" };
  return null;
}

const resultOf = (column: string, value: string | null) =>
  Object.freeze({
    command: column === "" ? "LOCK" : "SELECT",
    rowCount: column === "" ? null : 1,
    rows: column === "" ? [] : [{ [column]: value }],
    fields: [],
  });

export function createTransactionStatementMemo(
  initialSettings: Readonly<Record<string, string>> = {},
): TransactionStatementMemo {
  const settings = new Map<string, string>();
  const held = new Set<string>();
  const seed = () => {
    for (const [name, value] of Object.entries(initialSettings))
      if (scopeSettings.has(name) && typeof value === "string") settings.set(name, value);
  };
  seed();
  const forget = () => {
    settings.clear();
    held.clear();
  };
  return Object.freeze({
    answer(sql: string, values: readonly unknown[]) {
      if (typeof sql !== "string" || !Array.isArray(values)) return null;
      const remembered = classify(sql, values);
      if (remembered === null) return null;
      if (remembered.kind === "settings")
        return remembered.pairs.every(([name, value]) => settings.get(name) === value)
          ? resultOf("set_config", remembered.pairs.at(-1)?.[1] ?? null)
          : null;
      return held.has(remembered.key) ? resultOf(remembered.column, "") : null;
    },
    observe(sql: string, values: readonly unknown[]) {
      if (typeof sql !== "string" || !Array.isArray(values)) return forget();
      const remembered = classify(sql, values);
      if (remembered === null) {
        // Anything else that could change a setting or release a lock: forget it all.
        if (mayUndo(sql)) forget();
        return;
      }
      if (remembered.kind === "settings")
        for (const [name, value] of remembered.pairs) settings.set(name, value);
      else held.add(remembered.key);
    },
    forget,
  });
}
