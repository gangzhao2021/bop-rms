import { describe, expect, it } from "vitest";
import { snapshotReadStatement } from "./snapshot-read.js";

describe("WP-2423 snapshot read statements", () => {
  it.each([
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    "  SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0));",
    "SELECT pg_advisory_xact_lock(hashtextextended('bop.feature-control:' || $1,0))",
    "LOCK TABLE rms_ordering.order_header IN SHARE ROW EXCLUSIVE MODE",
  ])("answers %s without running it", (sql) => {
    expect(snapshotReadStatement(sql).kind).toBe("Answer");
  });
  it.each([
    ["SELECT a FROM t WHERE id=$1 FOR UPDATE", "SELECT a FROM t WHERE id=$1"],
    ["SELECT a FROM t FOR NO KEY UPDATE SKIP LOCKED", "SELECT a FROM t"],
    ["SELECT a FROM t JOIN u ON true FOR SHARE OF t, u NOWAIT;", "SELECT a FROM t JOIN u ON true"],
    ["WITH x AS (SELECT 1) SELECT * FROM x FOR KEY SHARE", "WITH x AS (SELECT 1) SELECT * FROM x"],
    ["SELECT a FROM t\n  FOR UPDATE\n", "SELECT a FROM t"],
  ])("reads %s from the snapshot without the row lock", (sql, read) => {
    expect(snapshotReadStatement(sql)).toEqual({ kind: "Run", sql: read });
  });
  it.each([
    "SELECT a FROM t WHERE note='FOR UPDATE'",
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a=1",
    "SELECT 1; SELECT a FROM t FOR UPDATE",
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))",
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0)), pg_sleep(1)",
    "SELECT a FROM t WHERE id IN (SELECT id FROM u FOR UPDATE) ORDER BY a",
  ])(
    "runs %s as written (a write or an unremovable lock fails the read-only transaction)",
    (sql) => {
      const planned = snapshotReadStatement(sql);
      expect(planned.kind).toBe("Run");
      if (planned.kind === "Run") expect(planned.sql).toBe(sql);
    },
  );
});
