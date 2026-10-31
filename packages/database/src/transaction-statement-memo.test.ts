import { describe, expect, it } from "vitest";
import { createTransactionStatementMemo } from "./transaction-statement-memo.js";

const brand = "018f3f7a-8b1c-7a11-8d01-000000000041",
  store = "018f3f7a-8b1c-7a11-8d01-000000000042",
  other = "018f3f7a-8b1c-7a11-8d01-000000000043";
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const brandOnlySql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)";
const lockSql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
const tableSql =
  "LOCK TABLE bop_membership.membership,bop_membership.store_assignment IN SHARE MODE";

describe("WP-2423 transaction statement memo", () => {
  it("answers a scope setting only when every setting already holds the written value", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    expect(memo.answer(scopeSql, [brand, store])).toMatchObject({
      rows: [{ set_config: store }],
      rowCount: 1,
    });
    expect(memo.answer(scopeSql, [brand, other])).toBeNull();
    expect(memo.answer(brandOnlySql, [brand])).toBeNull();
    memo.observe(brandOnlySql, [brand]);
    expect(memo.answer(brandOnlySql, [brand])).not.toBeNull();
    expect(memo.answer(scopeSql, [brand, store])).toBeNull();
    // The tenant setting was never written here, so it is never assumed.
    expect(
      memo.answer("SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)", [
        brand,
        brand,
      ]),
    ).toBeNull();
  });
  it("never answers other settings, non-text values or session-wide settings", () => {
    const memo = createTransactionStatementMemo();
    for (const [sql, values] of [
      ["SELECT set_config('statement_timeout',$1,true)", ["5s"]],
      ["SELECT set_config('bop.onboarding_issuer',$1,true)", ["x"]],
      ["SELECT set_config('bop.brand_id',$1,false)", [brand]],
      [scopeSql, [brand, null]],
      ["SELECT set_config('bop.brand_id',$1,true), now()", [brand]],
    ] as const) {
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
  it("keeps what it remembers across a savepoint that is released", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe("SAVEPOINT s", []);
    memo.observe(lockSql, ["a"]);
    memo.observe("RELEASE SAVEPOINT s", []);
    expect(memo.answer(scopeSql, [brand, store])).not.toBeNull();
    expect(memo.answer(lockSql, ["a"])).not.toBeNull();
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
    memo.observe(sql, [brand]);
    expect(memo.answer(scopeSql, [brand, store])).toBeNull();
    expect(memo.answer(lockSql, ["a"])).toBeNull();
  });
  it("forgets everything on request (a failed statement)", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(tableSql, []);
    memo.forget();
    expect(memo.answer(scopeSql, [brand, store])).toBeNull();
    expect(memo.answer(tableSql, [])).toBeNull();
  });
  it("keeps what it remembers across ordinary reads and writes that cannot undo it", () => {
    const memo = createTransactionStatementMemo({ "bop.brand_id": brand, "bop.store_id": store });
    memo.observe(lockSql, ["a"]);
    for (const sql of [
      "SELECT 1",
      "UPDATE rms_ordering.order_line SET status=$1 WHERE id=$2",
      "INSERT INTO x(a) VALUES ($1) ON CONFLICT DO NOTHING",
    ])
      memo.observe(sql, ["v", "w"]);
    expect(memo.answer(scopeSql, [brand, store])).not.toBeNull();
    expect(memo.answer(lockSql, ["a"])).not.toBeNull();
  });
  it("never answers a setting it was not seeded with or did not observe (identity session)", () => {
    const memo = createTransactionStatementMemo({ "bop.identity_session_id": "s" });
    const sessionSql = "SELECT set_config('bop.identity_session_id',$1,true)";
    // Seeding only accepts the scope settings it knows; the session is one of them.
    expect(memo.answer(sessionSql, ["s"])).not.toBeNull();
    expect(memo.answer(sessionSql, ["t"])).toBeNull();
    memo.observe(sessionSql, ["t"]);
    expect(memo.answer(sessionSql, ["s"])).toBeNull();
    expect(
      createTransactionStatementMemo({ "bop.other": "s" }).answer(
        "SELECT set_config('bop.other',$1,true)",
        ["s"],
      ),
    ).toBeNull();
  });
});
