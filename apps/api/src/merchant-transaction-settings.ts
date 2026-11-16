/**
 * WP-2423 (tax-config hold round trips): inside one merchant host transaction every owner source
 * re-asserts the transaction-local settings it reads under (Tenant/Brand/Store scope, the Session
 * scope of the Identity selection read, statement and lock limits) and re-takes the advisory locks
 * it needs, one statement and one database round trip each. A Professional Report save made about
 * 1,200 such statements (of about 2,100), so a permitted save could run out of its fixed 5 s Tax
 * authority window on a slow or busy database and answer "unavailable".
 *
 * This tracker belongs to one transaction and is dropped with it; it never carries anything to
 * another transaction. It changes no fact, permission or Session read: every authority source still
 * reads its rows at every hold. It only:
 *
 * - records a pure `set_config(...,true)` of a known setting and sends the settings written since
 *   the last statement as one statement immediately before the next statement that runs (a Scope
 *   setting the transaction already holds with the same value is left out; a statement or lock
 *   limit is always sent, with the last value written, because a database function could have
 *   changed it);
 * - answers a `current_setting(...,true)` read of Scope settings it knows (the value the next
 *   statement runs under);
 * - answers a repeat of an advisory transaction lock this transaction already holds (taking it
 *   again returns at once; an exclusive lock also answers a shared request on the same key).
 *
 * It forgets everything on any statement that could undo or change what it knows (a rollback, any
 * SET/RESET/DO/CALL, any other statement naming `set_config`) and on any failure. Every database
 * trigger that changes a Scope setting restores it before returning (as the database runner's
 * statement memo also relies on).
 */
const scopeSettings: ReadonlySet<string> = new Set([
  "bop.tenant_id",
  "bop.brand_id",
  "bop.store_id",
  "bop.identity_session_id",
  "bop.identity_actor_id",
]);
const limitSettings: ReadonlySet<string> = new Set(["statement_timeout", "lock_timeout"]);
const setConfigCall = String.raw`set_config\(\s*'([a-z_.]+)'\s*,\s*(\$\d+|'[0-9a-z_.:-]*')\s*,\s*true\s*\)`;
const pureSetConfig = new RegExp(
  String.raw`^SELECT\s+` +
    setConfigCall +
    String.raw`(?:\s*,\s*` +
    setConfigCall +
    String.raw`)*\s*;?$`,
  "iu",
);
const setConfigCalls = new RegExp(setConfigCall, "giu");
const currentSettingCall = String.raw`current_setting\(\s*'([a-z_.]+)'\s*,\s*true\s*\)\s+AS\s+([a-z_][a-z0-9_]*)`;
const pureCurrentSetting = new RegExp(
  String.raw`^SELECT\s+` +
    currentSettingCall +
    String.raw`(?:\s*,\s*` +
    currentSettingCall +
    String.raw`)*\s*;?$`,
  "iu",
);
const currentSettingCalls = new RegExp(currentSettingCall, "giu");
const advisoryLock =
  /^SELECT\s+pg_advisory_xact_lock(_shared)?\(\s*hashtextextended\(\s*[^()]*,\s*0\s*\)\s*\)\s*;?$/iu;
const resets =
  /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:ROLLBACK|ABORT|SET|RESET|DISCARD|BEGIN|START|COMMIT|END|PREPARE|DO|CALL|LOAD)\b/iu;
/** Splitting on every semicolon (also inside a literal) can only make it forget more often. */
const mayUndo = (sql: string) =>
  /set_config|\/\*/iu.test(sql) || sql.split(";").some((statement) => resets.test(statement));

export type TransactionSettingsPlan =
  | { readonly kind: "Answer"; readonly result: { readonly rows: readonly object[] } }
  | {
      readonly kind: "Run";
      readonly before: { readonly sql: string; readonly values: readonly string[] } | null;
    };

function settingPairs(sql: string, values: readonly unknown[]) {
  const pairs: [string, string][] = [];
  for (const match of sql.matchAll(setConfigCalls)) {
    const name = (match[1] ?? "").toLowerCase(),
      source = match[2] ?? "";
    const value: unknown = source.startsWith("$")
      ? values[Number(source.slice(1)) - 1]
      : source.slice(1, -1);
    if ((!scopeSettings.has(name) && !limitSettings.has(name)) || typeof value !== "string")
      return null;
    pairs.push([name, value]);
  }
  return pairs.length === 0 ? null : pairs;
}

const answer = (rows: readonly object[]) =>
  Object.freeze({
    kind: "Answer" as const,
    result: Object.freeze({ rows, rowCount: rows.length }),
  });

export function createTransactionSettingsTracker() {
  /** Scope settings this transaction holds on the server, as far as the tracker knows. */
  const held = new Map<string, string>();
  /** Settings written since the last statement that ran (sent with the next one). */
  const wanted = new Map<string, string>();
  const locks = new Set<string>();
  const forget = () => {
    held.clear();
    wanted.clear();
    locks.clear();
  };
  const pending = () => {
    const changed = [...wanted].filter(
      ([name, value]) => limitSettings.has(name) || held.get(name) !== value,
    );
    if (changed.length === 0) return null;
    return Object.freeze({
      sql:
        "SELECT " +
        changed.map(([name], index) => `set_config('${name}',$${index + 1},true)`).join(","),
      values: Object.freeze(changed.map(([, value]) => value)),
    });
  };
  const lockKeys = (sql: string, values: readonly unknown[]) => {
    const text = sql.trim(),
      match = advisoryLock.exec(text);
    if (match === null || !values.every((value) => typeof value === "string")) return null;
    const key = (statement: string) => statement + "\u0000" + JSON.stringify(values);
    return {
      key: key(text),
      column: match[1] === undefined ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared",
      exclusive:
        match[1] === undefined
          ? null
          : key(text.replace(/pg_advisory_xact_lock_shared/iu, "pg_advisory_xact_lock")),
    };
  };
  return Object.freeze({
    /** The plan for one statement; only called while no other statement is in flight. */
    plan(sql: string, values: readonly unknown[]): TransactionSettingsPlan {
      const text = sql.trim();
      if (pureSetConfig.test(text)) {
        const pairs = settingPairs(text, values);
        if (pairs !== null) {
          for (const [name, value] of pairs) wanted.set(name, value);
          return answer([{ set_config: pairs.at(-1)?.[1] ?? null }]);
        }
      }
      if (values.length === 0 && pureCurrentSetting.test(text)) {
        const row: Record<string, string> = {};
        let known = true;
        for (const match of text.matchAll(currentSettingCalls)) {
          const name = (match[1] ?? "").toLowerCase(),
            value = wanted.get(name) ?? held.get(name);
          if (!scopeSettings.has(name) || value === undefined) known = false;
          else row[match[2] ?? ""] = value;
        }
        if (known) return answer([row]);
      }
      const lock = lockKeys(text, values);
      if (
        lock !== null &&
        (locks.has(lock.key) || (lock.exclusive !== null && locks.has(lock.exclusive)))
      )
        return answer([{ [lock.column]: "" }]);
      return { kind: "Run", before: pending() };
    },
    /** Records a statement that ran successfully (a settings statement from `plan` included). */
    observe(sql: string, values: readonly unknown[]) {
      const text = sql.trim();
      const pairs = pureSetConfig.test(text) ? settingPairs(text, values) : null;
      if (pairs !== null) {
        for (const [name, value] of pairs) {
          if (scopeSettings.has(name)) held.set(name, value);
          if (wanted.get(name) === value) wanted.delete(name);
        }
        return;
      }
      if (mayUndo(text)) return forget();
      const lock = lockKeys(text, values);
      if (lock !== null) locks.add(lock.key);
    },
    /** The settings written but not yet sent (null when there are none). */
    pending,
    forget,
  });
}
