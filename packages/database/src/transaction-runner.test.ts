import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createTenantTransactionRunner,
  isRetryableTransactionConflict,
  runTogether,
  type DatabaseTransaction,
} from "./transaction-runner.js";
import { currentRequestChecks, withVerifiedChecks } from "./request-check-memo.js";
import {
  remainingRequestAcquireBudgetMs,
  runWithRequestAcquireBudget,
} from "./connection-acquire.js";

const scope = { brandId: "018f3f7a-8b1c-7a11-8d01-000000000041" };
// WP-2423 item 4 and M35: BEGIN, the three limits and the (validated) scope in one round trip.
const setup =
  "BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; " +
  "SET LOCAL idle_in_transaction_session_timeout = '5s'; " +
  `SELECT set_config('bop.brand_id', '${scope.brandId}', true), set_config('bop.store_id', '', true)`;
function fixture(failure?: string) {
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    void values;
    if (sql === failure) throw new Error("private SQL/bind failure");
    return { rows: [] };
  });
  const release = vi.fn((destroy?: boolean) => {
    if (failure === "release") throw new Error(String(destroy));
  });
  const connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  const pool: Parameters<typeof createTenantTransactionRunner>[0] = {
    connect,
    options: { connectionTimeoutMillis: 2000, query_timeout: 5000 },
  };
  return { query, release, connect, pool, runner: createTenantTransactionRunner(pool, scope) };
}
describe("WP-2212 pooled transaction runner", () => {
  it("sets finite local limits, commits before return and expires escaped handles", async () => {
    const f = fixture();
    let escaped: DatabaseTransaction | undefined;
    expect(
      await f.runner.run(async (transaction) => {
        escaped = transaction;
        await transaction.query("SELECT $1", ["synthetic"]);
        expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
        return 42;
      }),
    ).toBe(42);
    // WP-2423 item 4 and M35: BEGIN, the three limits and the scope in one round trip.
    expect(f.query.mock.calls.slice(0, 2).map(([sql]) => sql)).toEqual([setup, "SELECT $1"]);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(f.release).toHaveBeenCalledWith(false);
    await expect(escaped?.query("SELECT 1", [])).rejects.toMatchObject({
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
    });
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it.each([undefined, 0, -1, 1.5, 10001])("rejects unbounded timeout %s", (timeout) => {
    const f = fixture();
    expect(() =>
      createTenantTransactionRunner(
        {
          ...f.pool,
          options: {
            connectionTimeoutMillis: timeout,
            query_timeout: 5000,
          },
        },
        scope,
      ),
    ).toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["SELECT secret", "COMMIT", setup, "release"])(
    "bounds %s failure without retry",
    async (failure) => {
      const f = fixture(failure);
      const error = await f.runner
        .run(async (t) => {
          await t.query("SELECT secret", []);
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_FAILED" });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private");
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      if (failure !== "release") expect(f.release).toHaveBeenCalledWith(true);
    },
  );
  it.each([
    ["COMMIT", "Connection terminated unexpectedly", "08006"],
    [setup, "Client has encountered a connection error and is not queryable", "08006"],
    ["COMMIT", "private SQL/bind failure", null],
  ])(
    "WP-2423 (v15 2026-10-17): %s failing with %j keeps SQLSTATE %s for retry decisions",
    async (failure, message, sqlState) => {
      const f = fixture();
      f.query.mockImplementation(async (sql: string) => {
        if (sql === failure) throw new Error(message);
        return { rows: [] };
      });
      const error = await f.runner.run(async () => undefined).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "TENANT_DATABASE_TRANSACTION_FAILED",
        diagnostic: { sqlState, constraint: null, table: null, closed: false },
      });
      expect(JSON.stringify(error)).not.toContain(message);
    },
  );
  it("WP-2423: a swallowed query failure keeps that query's SQLSTATE", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT lost") throw new Error("Connection terminated unexpectedly");
      return { rows: [] };
    });
    await expect(
      f.runner.run(async (t) => {
        await t.query("SELECT lost", []).catch(() => undefined);
      }),
    ).rejects.toMatchObject({
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
      diagnostic: { sqlState: "08006" },
    });
  });
  it("does not commit a caught query failure", async () => {
    const f = fixture("SELECT secret");
    await expect(
      f.runner.run(async (t) => {
        await t.query("SELECT secret", []).catch(() => undefined);
        return "not-success";
      }),
    ).rejects.toThrow();
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it.each(["55P03", "40001", "40P01"])(
    "reports a %s conflict as retryable even when the action rewraps it",
    async (code) => {
      const f = fixture();
      f.query.mockImplementation(async (sql: string) => {
        if (sql === "LOCK TABLE x") throw Object.assign(new Error("private"), { code });
        return { rows: [] };
      });
      const failure = await f.runner
        .run(async (t) => {
          try {
            await t.query("LOCK TABLE x", []);
          } catch {
            throw new Error("domain wrapper");
          }
        })
        .catch((error: unknown) => error);
      expect(isRetryableTransactionConflict(failure)).toBe(true);
      expect(String((failure as Error).message)).not.toContain("private");
      expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    },
  );
  it("names only safe identifiers of a failed statement (SQLSTATE, constraint, table)", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "INSERT x")
        throw Object.assign(new Error("private value 'secret'"), {
          code: "23505",
          constraint: "order_revision_pk",
          table: "order_revision",
          detail: "Key (id)=(secret) already exists.",
        });
      return { rows: [] };
    });
    let seen: unknown;
    let escaped: DatabaseTransaction | undefined;
    await f.runner
      .run(async (t) => {
        escaped = t;
        await t.query("INSERT x", []).catch((error: unknown) => {
          seen = error;
          throw error;
        });
      })
      .catch(() => undefined);
    expect(seen).toMatchObject({
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
      diagnostic: {
        sqlState: "23505",
        constraint: "order_revision_pk",
        table: "order_revision",
        closed: false,
      },
    });
    expect(JSON.stringify(seen)).not.toContain("secret");
    await expect(escaped?.query("SELECT 1", [])).rejects.toMatchObject({
      diagnostic: { sqlState: null, constraint: null, table: null, closed: true },
    });
  });
  it("keeps the caller's own error after a failed query, with the SQLSTATE riding along", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT denied")
        throw Object.assign(new Error("permission denied for table secret_table"), {
          code: "42501",
        });
      return { rows: [] };
    });
    class DomainError extends Error {
      readonly code = "ORDER_STATUS_DEPENDENCY_UNAVAILABLE";
    }
    const thrown = await f.runner
      .run(async (t) => {
        await t.query("SELECT denied", []).catch(() => {
          throw new DomainError();
        });
      })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DomainError);
    expect(
      Object.getOwnPropertyDescriptor(thrown, Symbol.for("bop.database.failure"))?.value,
    ).toMatchObject({ sqlState: "42501" });
    // Not enumerable: never serialized into a payload or log by accident.
    expect(Object.keys(thrown as object)).not.toContain("sqlState");
    expect(JSON.stringify(thrown)).not.toContain("42501");
  });
  it("refuses a second query while one is in flight and rolls the transaction back", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT slow")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { rows: [] };
    });
    let second: unknown;
    const failure = await f.runner
      .run(async (t) => {
        const first = t.query("SELECT slow", []);
        second = await t.query("SELECT other", []).catch((error: unknown) => error);
        release?.();
        await first;
      })
      .catch((error: unknown) => error);
    expect(second).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY" });
    expect(failure).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY" });
    expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("SELECT other");
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
  it("allows the same queries one after another", async () => {
    const f = fixture();
    expect(
      await f.runner.run(async (t) => {
        await t.query("SELECT 1", []);
        await t.query("SELECT 2", []);
        return "done";
      }),
    ).toBe("done");
  });
  it("keeps other failures non-retryable", async () => {
    const f = fixture("SELECT secret");
    const failure = await f.runner
      .run((t) => t.query("SELECT secret", []))
      .catch((error: unknown) => error);
    expect(isRetryableTransactionConflict(failure)).toBe(false);
  });
  it("does not invoke scope accessors", async () => {
    const f = fixture();
    const getter = vi.fn(() => scope.brandId);
    const input = Object.defineProperty({}, "brandId", { enumerable: true, get: getter });
    await expect(
      createTenantTransactionRunner(f.pool, input as typeof scope).run(async () => undefined),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("rejects a callback that leaves a query pending instead of committing", async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    f.query.mockImplementation(async (sql) => {
      if (sql === "pending")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { rows: [] };
    });
    await expect(
      f.runner.run(async (transaction) => {
        void transaction.query("pending", []).catch(() => undefined);
      }),
    ).rejects.toThrow();
    finish();
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledWith(true);
  });
});
describe("WP-2423 repeated scope settings and held locks", () => {
  it("answers repeats inside one transaction without a round trip, never across transactions", async () => {
    const f = fixture();
    const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
    const lockSql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
    const store = "018f3f7a-8b1c-7a11-8d01-000000000042";
    const sent = () => f.query.mock.calls.map(([sql]) => sql).filter((sql) => sql !== setup);
    await f.runner.run(async (transaction) => {
      // The runner installed the brand and an empty Store before the callback.
      await transaction.query(scopeSql, [scope.brandId, ""]);
      // M35: a scope setting goes with the next statement that runs, once.
      await transaction.query(scopeSql, [scope.brandId, store]);
      await transaction.query(scopeSql, [scope.brandId, store]);
      expect(sent()).toEqual([]);
      await transaction.query(lockSql, ["k"]);
      await transaction.query(lockSql, ["k"]);
      expect(sent()).toEqual(["SELECT set_config('bop.store_id',$1,true)", lockSql]);
      expect(f.query.mock.calls.at(-2)?.[1]).toEqual([store]);
      await transaction.query("ROLLBACK TO SAVEPOINT s", []);
      await transaction.query(lockSql, ["k"]);
      // Written last, with nothing after it: not sent yet (the ROLLBACK TO forgot what is held).
      await transaction.query(scopeSql, [scope.brandId, store]);
      expect(sent()).toHaveLength(4);
    });
    // v15 2026-11-12: sent before COMMIT, so deferred triggers run under the scope written last.
    expect(sent().slice(4, 6)).toEqual([
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      "COMMIT",
    ]);
    await f.runner.run(async (transaction) => {
      await transaction.query(lockSql, ["k"]);
    });
    expect(sent().filter((sql) => sql === lockSql)).toHaveLength(3);
  });
  it("M35: answers an owner's repeated stable read inside one transaction, never across, and never sends the marker", async () => {
    const f = fixture();
    const read = "SELECT table_snapshot FROM rms_dining.dining_table WHERE table_id=$1";
    f.query.mockImplementation(async (sql: string) =>
      sql === read ? { rows: [{ table_snapshot: { v: 1 } }] } : { rows: [] },
    );
    const reads = () => f.query.mock.calls.filter(([sql]) => sql === read).length;
    await f.runner.run(async (transaction) => {
      const first = await transaction.query("-- bop:stable-read\n" + read, ["t"]);
      const again = await transaction.query("-- bop:stable-read\n" + read, ["t"]);
      expect(again).toMatchObject({ rows: [{ table_snapshot: { v: 1 } }] });
      expect(again).not.toBe(first);
      expect(reads()).toBe(1);
      await transaction.query("UPDATE rms_dining.dining_table SET x=$1", ["v"]);
      await transaction.query("-- bop:stable-read\n" + read, ["t"]);
      expect(reads()).toBe(2);
      // Unmarked: always sent.
      await transaction.query(read, ["t"]);
      expect(reads()).toBe(3);
    });
    await f.runner.run(async (transaction) => {
      await transaction.query("-- bop:stable-read\n" + read, ["t"]);
    });
    expect(reads()).toBe(4);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("bop:stable-read"))).toBe(false);
  });
});

describe("v15 2026-11-12 scope restored last before COMMIT (unbound batch cancellation revision)", () => {
  const store = "018f3f7a-8b1c-7a11-8d01-000000000042";
  const storeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
  const calls = (f: ReturnType<typeof fixture>) =>
    f.query.mock.calls.map(([sql, values]) => [sql, values ?? null]);
  it("sends a Store scope restored after a Brand-level read before COMMIT, never after it", async () => {
    const f = fixture();
    const storeRunner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    await storeRunner.run(async (transaction) => {
      await transaction.query("INSERT INTO rms_ordering.order_revision VALUES ($1)", ["r"]);
      // An owner reads Brand-level facts, then restores the Store scope as its last statement.
      await transaction.query(storeSql, [scope.brandId, ""]);
      await transaction.query("SELECT release FROM bop_publishing.x", []);
      await transaction.query(storeSql, [scope.brandId, store]);
    });
    expect(calls(f).slice(1)).toEqual([
      ["INSERT INTO rms_ordering.order_revision VALUES ($1)", ["r"]],
      ["SELECT set_config('bop.store_id',$1,true)", [""]],
      ["SELECT release FROM bop_publishing.x", []],
      ["SELECT set_config('bop.store_id',$1,true)", [store]],
      ["COMMIT", null],
    ]);
  });
  it("sends nothing more when the scope written last is the one held, or for a snapshot read", async () => {
    const f = fixture();
    await f.runner.run(async (transaction) => {
      await transaction.query(storeSql, [scope.brandId, store]);
      await transaction.query("SELECT a", []);
      await transaction.query(storeSql, [scope.brandId, store]);
    });
    await f.runner.runSnapshot(async (transaction) => {
      await transaction.query(storeSql, [scope.brandId, store]);
    });
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("SELECT set_config"))).toHaveLength(
      1,
    );
  });
  it("a failed scope restore before COMMIT rolls back and keeps its SQLSTATE", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT set_config('bop.store_id',$1,true)")
        throw Object.assign(new Error("private"), { code: "57014" });
      return { rows: [] };
    });
    const storeRunner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    await expect(
      storeRunner.run(async (transaction) => {
        await transaction.query(storeSql, [scope.brandId, ""]);
        return "never";
      }),
    ).rejects.toMatchObject({
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
      diagnostic: { sqlState: "57014" },
    });
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  });
  it("runTogether sends the scope the work wrote last before its one COMMIT", async () => {
    const f = fixture();
    await runTogether(async () => {
      await f.runner.run((t) => t.query("SELECT a", []));
      await f.runner.run((t) => t.query(storeSql, [scope.brandId, store]));
    });
    expect(calls(f).slice(-2)).toEqual([
      ["SELECT set_config('bop.store_id',$1,true)", [store]],
      ["COMMIT", null],
    ]);
  });
});

describe("WP-2423 M35 runTogether (DEC-STAFF-ROUND-SPEED)", () => {
  const store = "018f3f7a-8b1c-7a11-8d01-000000000042";
  it("joins the runs of one call on one pool into one transaction, each under its own scope", async () => {
    const f = fixture();
    const storeRunner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const value = await runTogether(async () => {
      await f.runner.run((t) => t.query("SELECT a", []));
      await storeRunner.run((t) => t.query("SELECT b", []));
      await f.runner.run((t) => t.query("SELECT c", []));
      // Nothing commits before the work ends.
      expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
      return "checked";
    });
    expect(value).toBe("checked");
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.map(([sql, values]) => [sql, values ?? null])).toEqual([
      [setup, null],
      ["SELECT a", []],
      ["SELECT set_config('bop.store_id',$1,true)", [store]],
      ["SELECT b", []],
      ["SELECT set_config('bop.store_id',$1,true)", [""]],
      ["SELECT c", []],
      ["COMMIT", null],
    ]);
    // Outside a call every run is its own transaction again.
    await f.runner.run((t) => t.query("SELECT d", []));
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
  it("rolls everything back when the work fails, and reports the work's own error", async () => {
    const f = fixture();
    const failure = new Error("not current");
    await expect(
      runTogether(async () => {
        await f.runner.run((t) => t.query("SELECT a", []));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("a failed statement fails the joined run and every later one; nothing is committed", async () => {
    const f = fixture("SELECT broken");
    const error = await runTogether(async () => {
      await f.runner.run((t) => t.query("SELECT broken", [])).catch(() => undefined);
      await f.runner.run(async () => "fine");
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_FAILED" });
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
  it("leaves snapshot reads, other pools and work without a run as they were", async () => {
    const f = fixture();
    const g = fixture();
    await runTogether(async () => {
      await f.runner.runSnapshot((t) => t.query("SELECT a", []));
      await f.runner.run((t) => t.query("SELECT b", []));
      await g.runner.run((t) => t.query("SELECT c", []));
    });
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(g.connect).toHaveBeenCalledTimes(1);
    const h = fixture();
    expect(await runTogether(async () => 1)).toBe(1);
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe("v15 hotfix review: runTogether's one COMMIT holds the scope of the run that wrote", () => {
  const storeA = "018f3f7a-8b1c-7a11-8d01-000000000042";
  const storeB = "018f3f7a-8b1c-7a11-8d01-000000000043";
  const sent = (f: ReturnType<typeof fixture>) =>
    f.query.mock.calls.map(([sql, values]) => [sql, values ?? null]);
  it("restores the writer's Store scope before COMMIT after a later run read under another", async () => {
    const f = fixture();
    const a = createTenantTransactionRunner(f.pool, { ...scope, storeId: storeA });
    const b = createTenantTransactionRunner(f.pool, { ...scope, storeId: storeB });
    await runTogether(async () => {
      await a.run((t) => t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["r"]));
      await b.run((t) => t.query("SELECT b", []));
    });
    // Before: COMMIT ran the deferred checks of A's row under Store B.
    expect(sent(f).slice(-2)).toEqual([
      ["SELECT set_config('bop.store_id',$1,true)", [storeA]],
      ["COMMIT", null],
    ]);
  });
  it("refuses a write under another runner's scope once one wrote, and commits nothing", async () => {
    const f = fixture();
    const a = createTenantTransactionRunner(f.pool, { ...scope, storeId: storeA });
    const b = createTenantTransactionRunner(f.pool, { ...scope, storeId: storeB });
    const error = await runTogether(async () => {
      await a.run((t) => t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["r"]));
      await b.run((t) => t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["s"]));
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_FAILED" });
    const statements = f.query.mock.calls.map(([sql]) => sql);
    expect(statements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
    expect(statements).not.toContain("COMMIT");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });
  it("lets the same scope write again in a later run", async () => {
    const f = fixture();
    const a = createTenantTransactionRunner(f.pool, { ...scope, storeId: storeA });
    await runTogether(async () => {
      await a.run((t) => t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["r"]));
      await f.runner.run((t) => t.query("SELECT b", []));
      await a.run((t) => t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["s"]));
    });
    expect(sent(f).at(-1)).toEqual(["COMMIT", null]);
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(2);
  });
});

describe("WP-2423 M35 third step: one request's verified checks (request-check-memo)", () => {
  const store = "018f3f7a-8b1c-7a11-8d01-000000000042";
  const check = "-- bop:stable-read\nSELECT * FROM rms_dining.dining_table WHERE table_id=$1";
  const identity = "-- bop:stable-read\nSELECT * FROM bop_identity.guest_session WHERE id=$1";
  function rowsFixture() {
    const f = fixture();
    const rows = new Map<string, unknown[]>();
    f.query.mockImplementation(async (sql: string) => ({ rows: rows.get(sql) ?? [] }));
    return { ...f, rows };
  }
  const read = (t: DatabaseTransaction, sql = check) => t.query(sql, ["t1"]);
  const statements = (f: ReturnType<typeof fixture>) => f.query.mock.calls.map(([sql]) => sql);
  it("answers a check this request already made, and a run answered in full takes no connection", async () => {
    const f = rowsFixture();
    f.rows.set(check.slice(19), [{ table: 1 }]);
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const answers = await withVerifiedChecks(async () => [
      await runner.run(read),
      await runner.run(read),
    ]);
    expect(answers.map((a) => (a as { rows: unknown[] }).rows)).toEqual([
      [{ table: 1 }],
      [{ table: 1 }],
    ]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(statements(f).filter((sql) => sql.includes("dining_table"))).toHaveLength(1);
    // Never across requests, and never outside one.
    await withVerifiedChecks(() => runner.run(read));
    await runner.run(read);
    expect(f.connect).toHaveBeenCalledTimes(3);
  });
  it("sends every borrowed read again before the first write; a change reruns it once on what is current", async () => {
    const f = rowsFixture();
    const plainCheck = check.slice(19);
    f.rows.set(plainCheck, [{ version: 1 }]);
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    let attempts = 0;
    const write = async (t: DatabaseTransaction) => {
      attempts += 1;
      const seen = await read(t);
      await t.query("INSERT INTO rms_ordering.order_batch VALUES ($1)", ["b"]);
      return seen;
    };
    await withVerifiedChecks(async () => {
      await runner.run(read);
      // Someone changed the table (another phone joined) since this request checked it.
      f.rows.set(plainCheck, [{ version: 2 }]);
      const before = f.connect.mock.calls.length;
      // Review of the third step: the staff member is not refused. The first attempt wrote
      // nothing and is rolled back; the transaction runs again as an ordinary one, deciding on
      // what is current under its own transaction.
      const again = (await runner.run(write)) as { rows: unknown[] };
      expect(again.rows).toEqual([{ version: 2 }]);
      expect(attempts).toBe(2);
      expect(f.connect.mock.calls.length - before).toBe(2);
    });
    const sent = statements(f);
    expect(sent.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
    const rollback = sent.lastIndexOf("ROLLBACK");
    expect(rollback).toBeGreaterThan(-1);
    expect(sent.slice(0, rollback).some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(sent.slice(-3)).toEqual([
      plainCheck,
      "INSERT INTO rms_ordering.order_batch VALUES ($1)",
      "COMMIT",
    ]);
  });
  it("keeps the retryable conflict when the request wrote since the transaction began", async () => {
    const f = rowsFixture();
    const plainCheck = check.slice(19);
    f.rows.set(plainCheck, [{ version: 1 }]);
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const other = fixture();
    const otherRunner = createTenantTransactionRunner(other.pool, { ...scope, storeId: store });
    await withVerifiedChecks(async () => {
      await runner.run(read);
      f.rows.set(plainCheck, [{ version: 2 }]);
      const error = await runner
        .run(async (t) => {
          await read(t);
          // Another transaction of this request wrote meanwhile: rerunning could do it twice.
          await otherRunner.run((u) => u.query("INSERT INTO rms_ordering.x VALUES ($1)", ["x"]));
          await t.query("INSERT INTO rms_ordering.order_batch VALUES ($1)", ["b"]);
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
      expect(isRetryableTransactionConflict(error)).toBe(true);
    });
    expect(statements(f)).not.toContain("INSERT INTO rms_ordering.order_batch VALUES ($1)");
  });
  it("reruns a runTogether call whose one transaction met a changed check before it wrote", async () => {
    const f = rowsFixture();
    const plainCheck = check.slice(19);
    f.rows.set(plainCheck, [{ version: 1 }]);
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    let attempts = 0;
    await withVerifiedChecks(async () => {
      await runner.run(read);
      f.rows.set(plainCheck, [{ version: 2 }]);
      const seen = await runTogether(async () => {
        attempts += 1;
        const first = (await runner.run(read)) as { rows: unknown[] };
        await runner.run((t) => t.query("INSERT INTO rms_ordering.order_batch VALUES ($1)", ["b"]));
        return first.rows;
      });
      expect(seen).toEqual([{ version: 2 }]);
    });
    expect(attempts).toBe(2);
    expect(statements(f).filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
    expect(statements(f).at(-1)).toBe("COMMIT");
  });
  it("a stable row-locking read sent for real is a fence: row locks are taken in the code's order", async () => {
    const f = rowsFixture();
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const lockA = "-- bop:stable-read\nSELECT * FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE";
    const lockB =
      "-- bop:stable-read\nSELECT * FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2 FOR SHARE";
    await withVerifiedChecks(async () => {
      await runner.run((t) => t.query(lockA, ["b"]));
      await runner.run(async (t) => {
        await t.query(lockA, ["b"]); // borrowed: its lock waits for the fence
        await t.query(lockB, ["b", "s"]); // not borrowed: sent now, so A is sent again first
      });
    });
    const sent = statements(f).filter((sql) => sql.includes("FOR SHARE"));
    expect(sent).toEqual([lockA.slice(19), lockA.slice(19), lockB.slice(19)]);
  });
  it("lists a check a read-only transaction answered from earlier when a write follows before it is read again", async () => {
    const f = rowsFixture();
    f.rows.set(check.slice(19), [{ table: 1 }]);
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const write = (t: DatabaseTransaction) =>
      t.query("INSERT INTO rms_ordering.order_batch VALUES ($1)", ["b"]);
    await withVerifiedChecks(async () => {
      const checks = currentRequestChecks();
      await runner.run(read);
      await runner.run(read); // answered in full, read-only
      // A later writing transaction reads it again (here under a row lock) before its write.
      await runner.run(async (t) => {
        await t.query(check.slice(19) + " FOR UPDATE", ["t1"]);
        await write(t);
      });
      expect(checks?.unverifiedChecks()).toEqual([]);
      await runner.run(read); // answered again, read-only
      await runner.run(write); // a write that never read it again
      expect(checks?.unverifiedChecks()).toEqual([
        "SELECT * FROM rms_dining.dining_table WHERE table_id=$1",
      ]);
    });
  });

  it("a lock is a fence too: the borrowed read is sent again before it, under its own scope", async () => {
    const f = rowsFixture();
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const storeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
    await withVerifiedChecks(async () => {
      await runner.run(read);
      await runner.run(async (t) => {
        await read(t);
        await t.query(storeSql, [scope.brandId, ""]);
        await t.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["k"]);
      });
    });
    const calls = f.query.mock.calls.map(([sql, values]) => [sql, values ?? null]);
    expect(calls.slice(-5)).toEqual([
      [setup.replace("'', true)", `'${store}', true)`), null],
      [check.slice(19), ["t1"]],
      ["SELECT set_config('bop.store_id',$1,true)", [""]],
      ["SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["k"]],
      ["COMMIT", null],
    ]);
  });
  it("forgets what this request wrote: the schemas a write names, everything when it names none", async () => {
    const f = rowsFixture();
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    const sentOf = (sql: string) => statements(f).filter((s) => s === sql.slice(19)).length;
    await withVerifiedChecks(async () => {
      await runner.run(async (t) => {
        await read(t, check);
        await read(t, identity);
      });
      await runner.run((t) => t.query("UPDATE rms_dining.dining_table SET v=v+1", []));
      await runner.run(async (t) => {
        await read(t, check);
        await read(t, identity);
      });
      expect([sentOf(check), sentOf(identity)]).toEqual([2, 1]);
      await runner.run((t) => t.query("UPDATE something SET v=1", []));
      await runner.run((t) => read(t, identity));
      expect(sentOf(identity)).toBe(2);
    });
  });
  it("never answers a snapshot read, or a read after the transaction's own write", async () => {
    const f = rowsFixture();
    const runner = createTenantTransactionRunner(f.pool, { ...scope, storeId: store });
    await withVerifiedChecks(async () => {
      await runner.run(read);
      await runner.runSnapshot(read);
      await runner.run(async (t) => {
        await t.query("INSERT INTO rms_ordering.x VALUES ($1)", ["x"]);
        await read(t);
      });
    });
    expect(statements(f).filter((sql) => sql === check.slice(19))).toHaveLength(3);
  });
  it("a run that could not begin fails with the runner's own error, whatever the action made of it", async () => {
    const f = fixture();
    const acquire = Object.assign(new Error("busy"), { code: "ECONNREFUSED" });
    f.connect.mockRejectedValue(acquire);
    const error = await withVerifiedChecks(() =>
      f.runner.run(async (t) => {
        await t.query("SELECT 1", []).catch(() => undefined);
        return "swallowed";
      }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TENANT_DATABASE_ACQUIRE_FAILED" });
  });
});

describe("WP-2423 snapshot reads (v15 2026-10-18, 55P03)", () => {
  it("begins one REPEATABLE READ, READ ONLY transaction, answers fences locally and reads rows without locking them", async () => {
    const f = fixture();
    const results: unknown[] = [];
    await f.runner.runSnapshot(async (transaction) => {
      results.push(
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "OrderingOrderDisposition:a:b:c",
        ]),
      );
      await transaction.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", ["k"]);
      await transaction.query("LOCK TABLE rms_ordering.order_header IN SHARE MODE", []);
      await transaction.query(
        "SELECT order_id FROM rms_ordering.order_header WHERE order_id=$1 FOR UPDATE",
        ["x"],
      );
      await transaction.query("SELECT fulfillment_id FROM f WHERE id=$1 FOR SHARE OF f NOWAIT", [
        "y",
      ]);
    });
    const sent = f.query.mock.calls.map(([sql]) => sql);
    expect(sent[0]).toMatch(/^BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET LOCAL /u);
    expect(sent.some((sql) => /advisory|LOCK TABLE|FOR (UPDATE|SHARE)/u.test(sql))).toBe(false);
    expect(sent).toContain("SELECT order_id FROM rms_ordering.order_header WHERE order_id=$1");
    expect(sent).toContain("SELECT fulfillment_id FROM f WHERE id=$1");
    expect(results[0]).toMatchObject({ rowCount: 1, rows: [{ pg_advisory_xact_lock: "" }] });
    expect(sent.at(-1)).toBe("COMMIT");
  });
  it("leaves ordinary transactions' fences and row locks as written", async () => {
    const f = fixture();
    await f.runner.run(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["k"]);
      await transaction.query("SELECT id FROM t WHERE id=$1 FOR UPDATE", ["x"]);
    });
    const sent = f.query.mock.calls.map(([sql]) => sql);
    expect(sent[0]).toMatch(/^BEGIN; SET LOCAL /u);
    expect(sent).toContain("SELECT pg_advisory_xact_lock(hashtextextended($1,0))");
    expect(sent).toContain("SELECT id FROM t WHERE id=$1 FOR UPDATE");
  });
});

describe("WP-2423 guest-table-open-and-busy-reads: a read's statements end with its answer time", () => {
  it("narrows the statement limit to what is left and sends nothing once the time is spent", async () => {
    vi.useFakeTimers();
    try {
      const { runWithRequestAcquireBudget } = await import("./connection-acquire.js");
      const f = fixture();
      const outcome = runWithRequestAcquireBudget(
        10_000,
        () =>
          f.runner.run(async (t) => {
            await t.query("SELECT 'first'", []);
            vi.advanceTimersByTime(9_000);
            await t.query("SELECT 'second'", []);
            vi.advanceTimersByTime(3_500);
            await t.query("SELECT 'third'", []);
          }),
        { answerWithinMs: 12_000 },
      );
      const error = await outcome.catch((e: unknown) => e);
      // Busy (the read answers 503 + Retry-After), and the third statement was never sent.
      expect(error).toMatchObject({
        code: "TENANT_DATABASE_TRANSACTION_FAILED",
        diagnostic: { sqlState: "57014" },
      });
      const sent = f.query.mock.calls.map(([sql, values]) => [sql, values]);
      expect(sent.slice(1, 4)).toEqual([
        ["SELECT 'first'", []],
        ["SELECT set_config('statement_timeout',$1,true)", ["3000ms"]],
        ["SELECT 'second'", []],
      ]);
      expect(sent.some(([sql]) => sql === "SELECT 'third'")).toBe(false);
      expect(sent.at(-1)?.[0]).toBe("ROLLBACK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a command's statements their 5 s limit however long it runs", async () => {
    vi.useFakeTimers();
    try {
      const { runWithRequestAcquireBudget } = await import("./connection-acquire.js");
      const f = fixture();
      await runWithRequestAcquireBudget(10_000, () =>
        f.runner.run(async (t) => {
          await t.query("SELECT 'first'", []);
          vi.advanceTimersByTime(13_000);
          await t.query("SELECT 'second'", []);
        }),
      );
      const sent = f.query.mock.calls.map(([sql]) => sql);
      expect(sent).toContain("SELECT 'second'");
      expect(sent.at(-1)).toBe("COMMIT");
      expect(sent.some((sql) => sql.includes("set_config('statement_timeout'"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WP-2423 (rush-reads-and-orders-changes review): a real refusal stays a fault after the rush", () => {
  it("marks the request faulted on a refusal that is not the rush, never on a conflict or a cut", async () => {
    const { runWithRequestAcquireBudget, noteRequestShed } =
      await import("./request-acquire-budget.js");
    const budget = () =>
      (globalThis as Record<symbol, { getStore(): { shed?: boolean; faulted?: boolean } }>)[
        Symbol.for("bop.database.request-acquire-budget")
      ]?.getStore();
    const outcome = async (code: string) => {
      const f = fixture();
      f.query.mockImplementation(async (sql: string) => {
        if (sql === "SELECT a") throw Object.assign(new Error("private"), { code });
        return { rows: [] };
      });
      return runWithRequestAcquireBudget(1_000, async () => {
        // An earlier step of the same request was turned away by the rush.
        noteRequestShed();
        await f.runner.run((t) => t.query("SELECT a", [])).catch(() => undefined);
        return budget()?.faulted === true;
      });
    };
    // A missing pilot grant, a constraint: faults, logged as such (level 50), not as a wait.
    expect(await outcome("42501")).toBe(true);
    expect(await outcome("23505")).toBe(true);
    // A conflict to run again, too many connections and a statement cut: not faults.
    for (const code of ["40001", "40P01", "55P03", "53300", "57014"])
      expect(await outcome(code), code).toBe(false);
  });
});

describe("WP-2423 (rush-connection-hold)", () => {
  it("a transaction opened inside another of the same pool never waits in a full pool's queue", async () => {
    const f = fixture();
    const full = {
      ...f.pool,
      options: { ...f.pool.options, max: 1 },
      waitingCount: 3,
      idleCount: 0,
      totalCount: 1,
    } as Parameters<typeof createTenantTransactionRunner>[0];
    const runner = createTenantTransactionRunner(full, scope, { acquireBudgetMs: 10_000 });
    const started = Date.now();
    const inner = await runner
      .run(async (outer) => {
        await outer.query("SELECT 1", []);
        return runner.run(async (nested) => nested.query("SELECT 2", [])).catch((e: unknown) => e);
      })
      .catch((e: unknown) => e);
    expect(inner).toMatchObject({ code: "TENANT_DATABASE_ACQUIRE_FAILED" });
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
    // Once the outer transaction gave its connection back, the next one waits as any request.
    await runner.run(async (t) => t.query("SELECT 3", []));
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("a transaction that only locked rows does not mark the request as written; one that wrote does", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT pg_current_xact_id_if_assigned()")
        ? { rows: [{ wrote: true }] }
        : { rows: [] },
    );
    const probes = () =>
      f.query.mock.calls.filter(([sql]) =>
        sql.startsWith("SELECT pg_current_xact_id_if_assigned()"),
      ).length;
    await runWithRequestAcquireBudget(10_000, async () => {
      // A row lock takes a transaction id too: the database's answer alone read it as a write.
      await f.runner.run(async (t) => t.query("SELECT * FROM s.t WHERE id=$1 FOR SHARE", ["x"]));
      expect(remainingRequestAcquireBudgetMs()).toBeDefined();
      expect(probes()).toBe(0);
      await f.runner.run(async (t) => t.query("INSERT INTO s.t (id) VALUES ($1)", ["x"]));
      expect(probes()).toBe(1);
      expect(remainingRequestAcquireBudgetMs()).toBeUndefined();
    });
  });
});
