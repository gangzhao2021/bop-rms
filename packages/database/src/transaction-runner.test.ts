import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createTenantTransactionRunner,
  isRetryableTransactionConflict,
  type DatabaseTransaction,
} from "./transaction-runner.js";

const scope = { brandId: "018f3f7a-8b1c-7a11-8d01-000000000041" };
function fixture(failure?: string) {
  const query = vi.fn(async (sql: string) => {
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
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain(
      "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; " +
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    );
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
  it.each([
    "SELECT secret",
    "COMMIT",
    "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; " +
      "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    "release",
  ])("bounds %s failure without retry", async (failure) => {
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
    const ran = () =>
      f.query.mock.calls.filter(([sql]) => sql === scopeSql || sql === lockSql).length;
    await f.runner.run(async (transaction) => {
      // The runner installed the brand and an empty Store before the callback.
      await transaction.query(scopeSql, [scope.brandId, ""]);
      expect(ran()).toBe(0);
      await transaction.query(scopeSql, [scope.brandId, store]);
      await transaction.query(scopeSql, [scope.brandId, store]);
      await transaction.query(lockSql, ["k"]);
      await transaction.query(lockSql, ["k"]);
      expect(ran()).toBe(2);
      await transaction.query("ROLLBACK TO SAVEPOINT s", []);
      await transaction.query(lockSql, ["k"]);
      await transaction.query(scopeSql, [scope.brandId, store]);
      expect(ran()).toBe(4);
    });
    await f.runner.run(async (transaction) => {
      await transaction.query(lockSql, ["k"]);
    });
    expect(ran()).toBe(5);
  });
});
