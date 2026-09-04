import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createTenantTransactionRunner, type DatabaseTransaction } from "./transaction-runner.js";

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
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain("SET LOCAL lock_timeout = '2s'");
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
  it.each(["SELECT secret", "COMMIT", "SET LOCAL statement_timeout = '5s'", "release"])(
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
