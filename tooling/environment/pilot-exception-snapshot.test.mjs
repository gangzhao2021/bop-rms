import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createInternalExceptionSnapshotTransactions } from "./pilot-exception-snapshot.mjs";
beforeEach(() => vi.stubEnv("NODE_ENV", "development"));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() },
    resources = {
      publicProfile: {
        binding: {
          tenantReference: "tenant",
          brandReference: "brand",
          storeReference: "store",
          validUntil: "2026-09-22T00:00:00.000Z",
        },
      },
      scope: { brandReference: "brand", storeReference: "store" },
      now: () => "2026-09-21T00:00:00.000Z",
      database: { acquire: vi.fn(async () => client) },
    };
  return { client, resources, runner: createInternalExceptionSnapshotTransactions(resources) };
}
it("sets isolation before scoped reads and invalidates escaped transactions", async () => {
  const f = fixture();
  let escaped;
  expect(
    await f.runner.run(async (tx) => {
      escaped = tx;
      await tx.query("SELECT 1", []);
      await tx.query("WITH RECURSIVE nodes AS (SELECT 1) SELECT * FROM nodes", []);
      await tx.query("LOCK TABLE owner.records,owner.policy IN SHARE MODE", []);
      return 1;
    }),
  ).toBe(1);
  expect(f.client.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(f.client.query.mock.calls.at(-1)[0]).toBe("COMMIT");
  await expect(escaped.query("SELECT 1", [])).rejects.toThrow();
  expect(f.client.release).toHaveBeenCalledOnce();
});
it.each([
  "INSERT INTO private_table VALUES (1)",
  "UPDATE private_table SET a=1",
  "SELECT 1; SELECT 2",
  "WITH RECURSIVE removed AS (DELETE FROM owner.records RETURNING *) SELECT * FROM removed",
])("denies mutation or multiple statements: %s", async (sql) => {
  const f = fixture();
  await expect(f.runner.run((tx) => tx.query(sql, []))).rejects.toThrow();
  expect(f.client.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
  expect(f.client.query.mock.calls.some(([query]) => query === sql)).toBe(false);
  expect(f.client.release).toHaveBeenCalledOnce();
});
const failureOf = (error) => error[Symbol.for("bop.database.failure")];
const refusedGrant = () =>
  Object.assign(new Error("permission denied for table reconciliation_case"), { code: "42501" });
it("WP-2423 item 10: a failed read says what failed, and rolls back", async () => {
  const f = fixture();
  f.client.query.mockImplementation(async (sql) => {
    if (sql === "SELECT 1") throw refusedGrant();
    return { rows: [] };
  });
  // Swallowed by the work: still the transaction's failure, with its SQLSTATE and table.
  const swallowed = await f.runner
    .run(async (tx) => {
      await tx.query("SELECT 1", []).catch(() => undefined);
      return "read";
    })
    .catch((error) => error);
  expect(swallowed.code).toBe("TENANT_DATABASE_TRANSACTION_FAILED");
  expect(swallowed.diagnostic).toMatchObject({ sqlState: "42501", table: "reconciliation_case" });
  expect(String(swallowed.message)).not.toContain("permission denied");
  expect(f.client.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
  expect(f.client.release).toHaveBeenCalledOnce();
  // Thrown on: the query's own error says it.
  const thrown = await f.runner.run((tx) => tx.query("SELECT 1", [])).catch((error) => error);
  expect(thrown.code).toBe("TENANT_DATABASE_TRANSACTION_FAILED");
  expect(thrown.diagnostic.sqlState).toBe("42501");
  // Rewritten by the work into a refusal: the refusal carries what failed, so it is not believed.
  const rewritten = await f.runner
    .run(async (tx) => {
      await tx.query("SELECT 1", []).catch(() => {
        throw new Error("MERCHANT_ORDER_EXCEPTION_DENIED");
      });
    })
    .catch((error) => error);
  expect(rewritten.message).toBe("MERCHANT_ORDER_EXCEPTION_DENIED");
  expect(failureOf(rewritten)).toMatchObject({ sqlState: "42501", table: "reconciliation_case" });
  // A lock wait is busy, not a fault.
  const g = fixture();
  g.client.query.mockImplementation(async (sql) => {
    if (sql === "SELECT 1") throw Object.assign(new Error("lock"), { code: "55P03" });
    return { rows: [] };
  });
  const busy = await g.runner.run((tx) => tx.query("SELECT 1", [])).catch((error) => error);
  expect(busy.code).toBe("TENANT_DATABASE_TRANSACTION_CONFLICT");
});
it("WP-2423 item 10: a refusal decided by the work stays that refusal, unmarked", async () => {
  const f = fixture();
  const refused = await f.runner
    .run(async (tx) => {
      await tx.query("SELECT 1", []);
      throw new Error("MERCHANT_ORDER_EXCEPTION_DENIED");
    })
    .catch((error) => error);
  expect(refused.message).toBe("MERCHANT_ORDER_EXCEPTION_DENIED");
  expect(failureOf(refused)).toBeUndefined();
  expect(f.client.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
  expect(f.client.release).toHaveBeenCalledOnce();
});
it("a failed BEGIN or connection says so, and a swallowed guard refusal stays the guard's", async () => {
  const f = fixture();
  f.client.query.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "57P01" }));
  const begin = await f.runner.run(async () => 1).catch((error) => error);
  expect(begin.code).toBe("TENANT_DATABASE_TRANSACTION_FAILED");
  expect(begin.diagnostic.sqlState).toBe("57P01");
  const g = fixture();
  g.resources.database.acquire.mockRejectedValueOnce(new Error("timeout exceeded"));
  const acquire = await g.runner.run(async () => 1).catch((error) => error);
  expect(acquire.code).toBe("TENANT_DATABASE_ACQUIRE_FAILED");
  const h = fixture();
  await expect(
    h.runner.run(async (tx) => {
      await tx.query("DELETE FROM x", []).catch(() => undefined);
    }),
  ).rejects.toThrow("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE");
});
it("denies scope mismatch and expiry before acquiring a connection", async () => {
  const f = fixture();
  f.resources.now = () => "2026-09-23T00:00:00.000Z";
  await expect(f.runner.run(async () => true)).rejects.toThrow();
  expect(f.resources.database.acquire).not.toHaveBeenCalled();
  expect(() =>
    createInternalExceptionSnapshotTransactions({
      ...f.resources,
      scope: { brandReference: "other", storeReference: "store" },
    }),
  ).toThrow();
});
