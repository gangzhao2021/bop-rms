import { describe, expect, it } from "vitest";
import {
  createTransactionStatementMemo,
  stableReadMarker,
  stableReadStatement,
} from "./transaction-statement-memo.js";

const brand = "018f3f7a-8b1c-7a11-8d01-000000000041",
  store = "018f3f7a-8b1c-7a11-8d01-000000000042",
  other = "018f3f7a-8b1c-7a11-8d01-000000000043";
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const brandOnlySql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)";
const lockSql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
const tableSql =
  "LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN SHARE MODE";
const readSql = "SELECT table_snapshot FROM rms_dining.dining_table WHERE table_id=$1";
const lockedReadSql = "SELECT * FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE";
const result = (value: string) => ({ command: "SELECT", rowCount: 1, rows: [{ value }] });
/** Records a scope setting as the runner does (deferred until the next statement that runs). */
const write = (
  memo: ReturnType<typeof createTransactionStatementMemo>,
  sql: string,
  values: readonly unknown[],
) => memo.plan(sql, values);
/** The settings the next ordinary statement is sent after (null: none). */
const pending = (memo: ReturnType<typeof createTransactionStatementMemo>) => {
  const planned = memo.plan("SELECT 1", []);
  return planned.kind === "Run" ? planned.settings : "answered";
};

describe("WP-2423 transaction statement memo", () => {
  it("records a scope setting and sends it with the next statement only when it changes one", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    expect(write(memo, scopeSql, [brand, store])).toMatchObject({
      kind: "Answer",
      result: { rows: [{ set_config: store }], rowCount: 1 },
    });
    expect(pending(memo)).toBeNull();
    // M35: a different value is answered too, and goes with the next statement that runs.
    expect(write(memo, scopeSql, [brand, other]).kind).toBe("Answer");
    expect(pending(memo)).toEqual({
      sql: "SELECT set_config('bop.store_id',$1,true)",
      values: [other],
    });
    memo.observe("SELECT set_config('bop.store_id',$1,true)", [other]);
    expect(pending(memo)).toBeNull();
    // Written back before anything ran: nothing is sent at all.
    write(memo, brandOnlySql, [brand]);
    write(memo, scopeSql, [brand, other]);
    expect(pending(memo)).toBeNull();
    // The tenant setting was never written here: it is sent, never assumed.
    write(memo, "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)", [
      brand,
      brand,
    ]);
    expect(pending(memo)).toEqual({
      sql: "SELECT set_config('bop.tenant_id',$1,true)",
      values: [brand],
    });
  });
  it("answers a scope setting without deferring only when the transaction already holds it", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    expect(memo.answer(scopeSql, [brand, store])).not.toBeNull();
    expect(memo.answer(scopeSql, [brand, other])).toBeNull();
    expect(pending(memo)).toBeNull();
    memo.observe(brandOnlySql, [brand]);
    expect(memo.answer(brandOnlySql, [brand])).not.toBeNull();
    expect(memo.answer(scopeSql, [brand, store])).toBeNull();
  });
  it("never records other settings, non-text values or session-wide settings", () => {
    const memo = createTransactionStatementMemo();
    for (const [sql, values] of [
      ["SELECT set_config('statement_timeout',$1,true)", ["5s"]],
      ["SELECT set_config('bop.onboarding_issuer',$1,true)", ["x"]],
      ["SELECT set_config('bop.brand_id',$1,false)", [brand]],
      [scopeSql, [brand, null]],
      ["SELECT set_config('bop.brand_id',$1,true), now()", [brand]],
    ] as const) {
      expect(memo.answer(sql, values)).toBeNull();
      memo.observe(sql, values);
      expect(memo.answer(sql, values)).toBeNull();
    }
  });
  it("answers a lock the transaction already holds, keyed by its exact statement and values", () => {
    const memo = createTransactionStatementMemo();
    expect(memo.answer(lockSql, ["a"])).toBeNull();
    memo.observe(lockSql, ["a"]);
    expect(memo.answer(lockSql, ["a"])).toMatchObject({ rows: [{ pg_advisory_xact_lock: "" }] });
    expect(memo.answer(lockSql, ["b"])).toBeNull();
    expect(memo.answer(tableSql, [])).toBeNull();
    memo.observe(tableSql, []);
    expect(memo.answer(tableSql, [])).toMatchObject({ command: "LOCK", rows: [] });
    expect(
      memo.answer(
        "LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN EXCLUSIVE MODE",
        [],
      ),
    ).toBeNull();
    // A lock whose key is computed by anything other than hashing its values is not answered.
    memo.observe("SELECT pg_advisory_xact_lock(hashtextextended(now()::text,0))", []);
    expect(
      memo.answer("SELECT pg_advisory_xact_lock(hashtextextended(now()::text,0))", []),
    ).toBeNull();
  });
  it("answers a shared advisory lock after a shared or exclusive one, never an upgrade", () => {
    const sharedSql = "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))";
    const memo = createTransactionStatementMemo();
    expect(memo.answer(sharedSql, ["a"])).toBeNull();
    memo.observe(sharedSql, ["a"]);
    expect(memo.answer(sharedSql, ["a"])).toMatchObject({
      rows: [{ pg_advisory_xact_lock_shared: "" }],
    });
    // Shared held, exclusive asked: an upgrade that can wait, so it runs.
    expect(memo.answer(lockSql, ["a"])).toBeNull();
    expect(memo.answer(sharedSql, ["b"])).toBeNull();
    memo.observe(lockSql, ["b"]);
    // Exclusive held: a shared request on the same key returns at once.
    expect(memo.answer(sharedSql, ["b"])).toMatchObject({
      rows: [{ pg_advisory_xact_lock_shared: "" }],
    });
    expect(memo.answer(lockSql, ["b"])).toMatchObject({ rows: [{ pg_advisory_xact_lock: "" }] });
    expect(memo.answer(sharedSql, ["c"])).toBeNull();
    memo.observe("ROLLBACK TO SAVEPOINT s", []);
    expect(memo.answer(sharedSql, ["a"])).toBeNull();
    expect(memo.answer(sharedSql, ["b"])).toBeNull();
  });
  it("keeps what it remembers across a savepoint that is released", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe("SAVEPOINT s", []);
    memo.observe(lockSql, ["a"]);
    memo.observe(readSql, ["t"], result("x"), true);
    memo.observe("RELEASE SAVEPOINT s", []);
    write(memo, scopeSql, [brand, store]);
    expect(pending(memo)).toBeNull();
    expect(memo.answer(lockSql, ["a"])).not.toBeNull();
    expect(memo.answer(readSql, ["t"], true)).toMatchObject({ rows: [{ value: "x" }] });
  });
  it.each([
    "ROLLBACK TO SAVEPOINT s",
    "rollback to s",
    "SET LOCAL ROLE someone",
    "RESET ROLE",
    "SELECT set_config('bop.brand_id',$1,true), 1",
    "SELECT 1; RESET ALL",
    "SELECT 1;\n  reset bop.store_id",
    "SELECT 1; DISCARD ALL",
    "/* note */ SET LOCAL ROLE someone",
    "-- note\nRESET ROLE",
    "SELECT 1 /* a /* b */ c */",
    "DO $$BEGIN PERFORM 1; END$$",
    "CALL some_procedure()",
    "ABORT",
  ])("forgets everything after %s", (sql) => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(lockSql, ["a"]);
    memo.observe(lockedReadSql, [brand], result("b"), true);
    memo.observe(sql, [brand]);
    // What the transaction holds is unknown again: a scope setting written now is sent.
    write(memo, scopeSql, [brand, store]);
    expect(pending(memo)).not.toBeNull();
    expect(memo.answer(lockSql, ["a"])).toBeNull();
    expect(memo.answer(lockedReadSql, [brand], true)).toBeNull();
  });
  it("forgets everything on request (a failed statement)", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(tableSql, []);
    memo.observe(readSql, ["t"], result("x"), true);
    memo.forget();
    write(memo, scopeSql, [brand, store]);
    expect(pending(memo)).not.toBeNull();
    expect(memo.answer(tableSql, [])).toBeNull();
    expect(memo.answer(readSql, ["t"], true)).toBeNull();
  });
  it("keeps settings and locks across ordinary reads and writes that cannot undo them", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(lockSql, ["a"]);
    for (const sql of [
      "SELECT 1",
      "UPDATE rms_ordering.order_line SET status=$1 WHERE id=$2",
      "INSERT INTO x(a) VALUES ($1) ON CONFLICT DO NOTHING",
    ])
      memo.observe(sql, ["v", "w"]);
    write(memo, scopeSql, [brand, store]);
    expect(pending(memo)).toBeNull();
    expect(memo.answer(lockSql, ["a"])).not.toBeNull();
  });
  it("never answers a setting it was not seeded with or did not observe (identity session)", () => {
    const memo = createTransactionStatementMemo({ "bop.identity_session_id": "s" });
    const sessionSql = "SELECT set_config('bop.identity_session_id',$1,true)";
    write(memo, sessionSql, ["s"]);
    expect(pending(memo)).toBeNull();
    write(memo, sessionSql, ["t"]);
    expect(pending(memo)).toEqual({ sql: sessionSql, values: ["t"] });
    const unknown = createTransactionStatementMemo({ "bop.other": "s" });
    expect(unknown.answer("SELECT set_config('bop.other',$1,true)", ["s"])).toBeNull();
  });
  it("lets a joined run set the scope its statements see", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.useScope({ "bop.brand_id": brand, "bop.store_id": "" });
    expect(pending(memo)).toEqual({
      sql: "SELECT set_config('bop.store_id',$1,true)",
      values: [""],
    });
  });
});

describe("WP-2423 M35 stable reads (DEC-STAFF-ROUND-SPEED)", () => {
  const stable = (memo: ReturnType<typeof createTransactionStatementMemo>, sql = readSql) =>
    memo.answer(sql, ["t"], true);
  it("strips the owner's marker and says it was there", () => {
    expect(stableReadStatement(stableReadMarker + readSql)).toEqual({ sql: readSql, stable: true });
    expect(stableReadStatement(readSql)).toEqual({ sql: readSql, stable: false });
  });
  it("answers an identical repeat under the same scope with its own copy of the rows", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    expect(stable(memo)).toBeNull();
    memo.observe(readSql, ["t"], result("x"), true);
    const first = stable(memo) as { rows: { value: string }[] };
    expect(first).toMatchObject({ rows: [{ value: "x" }] });
    for (const row of first.rows) row.value = "changed by the caller";
    expect(stable(memo)).toMatchObject({ rows: [{ value: "x" }] });
    // Other values, another scope, or an unmarked statement: never answered.
    expect(memo.answer(readSql, ["u"], true)).toBeNull();
    expect(memo.answer(readSql, ["t"])).toBeNull();
    write(memo, scopeSql, [brand, other]);
    expect(stable(memo)).toBeNull();
    write(memo, scopeSql, [brand, store]);
    expect(stable(memo)).not.toBeNull();
  });
  it("stays across plain reads; forgets after a write, a new lock, an owner function or a new row lock", () => {
    for (const [sql, kept] of [
      ["SELECT snapshot_json FROM rms_ordering.checkout_session_record WHERE id=$1", true],
      ["SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY') AS observed_at", true],
      ["INSERT INTO platform_audit.audit_record (a) VALUES ($1)", false],
      ["UPDATE rms_dining.dining_table SET x=$1", false],
      ["WITH x AS (DELETE FROM a RETURNING 1) SELECT 1", false],
      [lockSql, false],
      [tableSql, false],
      ["SELECT rms_ordering.append_round($1)", false],
      ["SELECT nextval('rms_ordering.seq')", false],
      ["SELECT * FROM rms_dining.dining_session WHERE id=$1 FOR UPDATE", false],
      ["SELECT 1 INTO TEMP x", false],
    ] as const) {
      const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
      memo.observe(readSql, ["t"], result("x"), true);
      memo.observe(sql, ["v"]);
      expect(stable(memo) !== null, sql).toBe(kept);
    }
  });
  it("keeps a row-locked stable read across writes (its row lock is held), and a first row lock forgets the rest", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(readSql, ["t"], result("x"), true);
    memo.observe(lockedReadSql, ["t"], result("b"), true);
    expect(stable(memo)).toBeNull();
    expect(stable(memo, lockedReadSql)).toMatchObject({ rows: [{ value: "b" }] });
    memo.observe("UPDATE rms_dining.dining_table SET x=$1", ["v"]);
    expect(stable(memo, lockedReadSql)).not.toBeNull();
    // Its repeat (the lock already held) does not forget anything.
    memo.observe(readSql, ["t"], result("y"), true);
    memo.observe(lockedReadSql, ["t"], result("b"), true);
    expect(stable(memo)).toMatchObject({ rows: [{ value: "y" }] });
  });
  it("never answers a read whose values are not plain text or numbers", () => {
    const memo = createTransactionStatementMemo();
    memo.observe(readSql, [{ a: 1 }], result("x"), true);
    expect(memo.answer(readSql, [{ a: 1 }], true)).toBeNull();
  });
});
