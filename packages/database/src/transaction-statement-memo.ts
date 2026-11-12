/**
 * WP-2423 (v15 latency): a staff command's owner ports each re-assert the transaction's scope
 * settings and re-take the advisory and table locks they need, so a single command repeated the
 * same `set_config`, `pg_advisory_xact_lock` and `LOCK TABLE` statements dozens of times — one
 * database round trip each. Inside one transaction those repeats cannot change anything:
 *
 * - a transaction-local scope setting already holding the value the statement writes stays as
 *   it is (every database trigger that changes a scope setting restores it before returning);
 * - an advisory transaction lock or a table lock the transaction already holds stays held until
 *   it ends, and taking it again returns at once. An exclusive advisory lock also answers a shared
 *   request on the same key; a shared one never answers an exclusive request (that is an upgrade,
 *   which can wait).
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
  /^SELECT\s+pg_advisory_xact_lock(_shared)?\(\s*hashtextextended\(\s*[^()]*,\s*0\s*\)\s*\)\s*;?$/iu;
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

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED, staff round speed): an owner store marks a read whose answer
 * can only change when data changes by starting its SQL with this line. Such a read is a plain
 * SELECT with no side effect (a trailing row-locking clause is allowed); its owner keeps it so.
 * The marker is an ordinary SQL comment, so the statement means the same everywhere else.
 */
export const stableReadMarker = "-- bop:stable-read\n";

/** The statement without its stable-read marker, and whether it had one. */
export function stableReadStatement(sql: string): {
  readonly sql: string;
  readonly stable: boolean;
} {
  return typeof sql === "string" && sql.startsWith(stableReadMarker)
    ? { sql: sql.slice(stableReadMarker.length), stable: true }
    : { sql, stable: false };
}

type Remembered =
  | { readonly kind: "settings"; readonly pairs: readonly (readonly [string, string])[] }
  | {
      readonly kind: "lock";
      readonly key: string;
      readonly column: string;
      /** A shared advisory lock: answered too by the exclusive one on the same key. */
      readonly exclusiveKey: string | null;
    };

/** What the transaction does with one statement. */
export type TransactionStatementPlan =
  /** Answer it without a round trip. */
  | { readonly kind: "Answer"; readonly result: object }
  /** Send it, after `settings` (when not null) brings the scope settings to what was written. */
  | {
      readonly kind: "Run";
      readonly settings: { readonly sql: string; readonly values: readonly string[] } | null;
    };

export interface TransactionStatementMemo {
  /**
   * The plan for one statement while no other statement of the transaction is in flight. A scope
   * setting is only recorded here and sent before the next statement that runs (when it differs
   * from what the transaction holds); a repeat of a lock already held, or of a stable read with
   * nothing since that could change its answer, is answered.
   */
  plan(sql: string, values: readonly unknown[], stable?: boolean): TransactionStatementPlan;
  /**
   * The result to answer instead of running the statement, or null to run it. Unlike `plan`, a
   * scope setting is only answered when the transaction already holds it (nothing is deferred),
   * for callers that send every statement they are not answered themselves.
   */
  answer(sql: string, values: readonly unknown[], stable?: boolean): object | null;
  /** Records a statement that ran successfully (with its result, for a stable read). */
  observe(sql: string, values: readonly unknown[], result?: unknown, stable?: boolean): void;
  /** The scope settings the next statements run under (sent with the next one that runs). */
  useScope(scope: Readonly<Record<string, string>>): void;
  /**
   * The scope settings written but not yet sent (null when the transaction holds them all). The
   * runner sends them before COMMIT: deferred constraint triggers run at COMMIT under the scope
   * the transaction then holds, which must be the one its caller wrote last.
   */
  pending(): { readonly sql: string; readonly values: readonly string[] } | null;
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
  const advisory = advisoryLock.exec(text);
  if (advisory !== null && values.every((value) => typeof value === "string")) {
    const shared = advisory[1] !== undefined;
    const exclusiveText = text.replace(/pg_advisory_xact_lock_shared/iu, "pg_advisory_xact_lock");
    const key = (statement: string) =>
      "advisory\u0000" + statement + "\u0000" + JSON.stringify(values);
    return {
      kind: "lock",
      key: key(text),
      column: shared ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock",
      exclusiveKey: shared ? key(exclusiveText) : null,
    };
  }
  if (tableLock.test(text) && values.length === 0)
    return {
      kind: "lock",
      key: "table\u0000" + text.replace(/\s+/gu, " "),
      column: "",
      exclusiveKey: null,
    };
  return null;
}

const resultOf = (column: string, value: string | null) =>
  Object.freeze({
    command: column === "" ? "LOCK" : "SELECT",
    rowCount: column === "" ? null : 1,
    rows: column === "" ? [] : [{ [column]: value }],
    fields: [],
  });

// A stable read with a trailing row-locking clause: once it ran, this transaction holds the row
// lock, so no other transaction can change the row until this one ends. This transaction itself
// still can, so any statement that may write forgets row-locked reads too.
const rowLockingClause =
  /\s+FOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)(?:\s+OF\s+[a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/iu;
const leadingComments = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
/**
 * True unless the statement is one plain read that cannot change data, take a lock or change a
 * setting: a SELECT without a row-locking clause, a schema-qualified (owner) function call, INTO,
 * or a built-in that locks, writes or changes state. Anything else makes the memo forget the
 * stable reads it holds without a row lock; erring towards "may change" only costs a round trip.
 */
function mayChange(sql: string): boolean {
  const text = sql.replace(leadingComments, "").replace(/;\s*$/u, "");
  // A savepoint taken or released changes no data, setting or lock.
  if (/^(?:SAVEPOINT|RELEASE)\s+(?:SAVEPOINT\s+)?[a-z_][a-z0-9_]*$/iu.test(text)) return false;
  return (
    !/^SELECT\b/iu.test(text) ||
    text.includes(";") ||
    /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/iu.test(text) ||
    /\bINTO\b/iu.test(text) ||
    /\b[a-z_][a-z0-9_]*\s*\.\s*"?[a-z_][a-z0-9_]*"?\s*\(/iu.test(text) ||
    /\b(?:pg_advisory\w*|pg_try_advisory\w*|nextval|setval|set_config|pg_notify|lo_\w+|dblink\w*|pg_sleep\w*|txid_current\w*|pg_current_xact_id\w*)\s*\(/iu.test(
      text,
    )
  );
}
const plainValue = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
// Each answer is its own copy of the rows, so a caller changing one never changes a later answer.
const copyResult = (result: unknown): object => {
  const value = result as { rows?: unknown };
  return Object.freeze({
    ...(result as object),
    rows: Array.isArray(value.rows)
      ? value.rows.map((row: unknown) =>
          row !== null && typeof row === "object" ? { ...(row as object) } : row,
        )
      : value.rows,
  });
};

export function createTransactionStatementMemo(
  initialSettings: Readonly<Record<string, string>> = {},
): TransactionStatementMemo {
  /** The scope settings the transaction holds on the server, as far as the memo knows. */
  const settings = new Map<string, string>();
  /** The scope settings the caller wrote last; sent before the next statement that runs. */
  const wanted = new Map<string, string>();
  const held = new Set<string>();
  /** Stable reads answered from here: key → result, and whether this transaction holds its row lock. */
  const reads = new Map<string, { readonly result: object; readonly locked: boolean }>();
  for (const [name, value] of Object.entries(initialSettings))
    if (scopeSettings.has(name) && typeof value === "string") {
      settings.set(name, value);
      wanted.set(name, value);
    }
  const forget = () => {
    settings.clear();
    wanted.clear();
    held.clear();
    reads.clear();
  };
  const forgetUnlockedReads = () => {
    for (const [key, read] of reads) if (!read.locked) reads.delete(key);
  };
  // The scope settings a stable read runs under (once the pending ones are sent), in fixed order.
  const readKey = (sql: string, values: readonly unknown[]) =>
    values.every(plainValue)
      ? JSON.stringify([
          [...scopeSettings].map((name) => wanted.get(name) ?? settings.get(name) ?? null),
          sql.trim(),
          values,
        ])
      : null;
  const pendingSettings = () => {
    const changed = [...wanted].filter(([name, value]) => settings.get(name) !== value);
    if (changed.length === 0) return null;
    return Object.freeze({
      sql:
        "SELECT " +
        changed.map(([name], index) => `set_config('${name}',$${index + 1},true)`).join(","),
      values: Object.freeze(changed.map(([, value]) => value)),
    });
  };
  const plan = (
    sql: string,
    values: readonly unknown[],
    stable = false,
    defer = true,
  ): TransactionStatementPlan => {
    if (typeof sql !== "string" || !Array.isArray(values))
      return { kind: "Run", settings: pendingSettings() };
    const remembered = classify(sql, values);
    if (remembered?.kind === "settings") {
      // Without deferral (`answer`): only a repeat of what the transaction holds and was written.
      if (
        !defer &&
        !remembered.pairs.every(
          ([name, value]) => settings.get(name) === value && (wanted.get(name) ?? value) === value,
        )
      )
        return { kind: "Run", settings: pendingSettings() };
      for (const [name, value] of remembered.pairs) wanted.set(name, value);
      return {
        kind: "Answer",
        result: resultOf("set_config", remembered.pairs.at(-1)?.[1] ?? null),
      };
    }
    if (
      remembered?.kind === "lock" &&
      (held.has(remembered.key) ||
        (remembered.exclusiveKey !== null && held.has(remembered.exclusiveKey)))
    )
      return { kind: "Answer", result: resultOf(remembered.column, "") };
    if (stable && remembered === null) {
      const key = readKey(sql, values);
      const read = key === null ? undefined : reads.get(key);
      if (read !== undefined) return { kind: "Answer", result: copyResult(read.result) };
    }
    return { kind: "Run", settings: pendingSettings() };
  };
  return Object.freeze({
    plan,
    answer(sql: string, values: readonly unknown[], stable = false) {
      const planned = plan(sql, values, stable, false);
      return planned.kind === "Answer" ? planned.result : null;
    },
    observe(sql: string, values: readonly unknown[], result?: unknown, stable = false) {
      if (typeof sql !== "string" || !Array.isArray(values)) return forget();
      const remembered = classify(sql, values);
      if (remembered === null) {
        // Anything else that could change a setting or release a lock: forget it all.
        if (mayUndo(sql)) return forget();
        const text = sql.trim();
        if (stable && !mayChange(text.replace(rowLockingClause, ""))) {
          const key = readKey(text, values);
          const locked = rowLockingClause.test(text);
          // A first row lock may order this transaction after another: earlier reads are stale.
          if (locked && (key === null || !reads.has(key))) forgetUnlockedReads();
          if (key !== null && result !== null && typeof result === "object")
            reads.set(key, { result: copyResult(result), locked });
          return;
        }
        // A statement that may write (anything but a plain read, with or without a row lock) may
        // change a row this transaction itself holds locked, and its own later read sees that
        // change: forget every stable read. A plain row-locking read or a new lock writes nothing,
        // so only reads taken without a row lock (now possibly older than the lock) are forgotten.
        if (mayChange(text.replace(rowLockingClause, ""))) reads.clear();
        else if (mayChange(text)) forgetUnlockedReads();
        return;
      }
      if (remembered.kind === "settings")
        for (const [name, value] of remembered.pairs) {
          settings.set(name, value);
          wanted.set(name, value);
        }
      else {
        // A lock taken for the first time may order this transaction after another one.
        if (!held.has(remembered.key)) forgetUnlockedReads();
        held.add(remembered.key);
      }
    },
    useScope(scope: Readonly<Record<string, string>>) {
      for (const [name, value] of Object.entries(scope))
        if (scopeSettings.has(name) && typeof value === "string") wanted.set(name, value);
    },
    pending: pendingSettings,
    forget,
  });
}
