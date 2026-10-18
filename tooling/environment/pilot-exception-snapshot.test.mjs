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
it("rolls back caught query failures and callback failures", async () => {
  const f = fixture();
  await expect(
    f.runner.run(async (tx) => {
      f.client.query.mockRejectedValueOnce(Error("private"));
      await tx.query("SELECT 1", []).catch(() => undefined);
    }),
  ).rejects.toThrow("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE");
  const g = fixture();
  await expect(
    g.runner.run(() => {
      throw Error("private");
    }),
  ).rejects.toThrow("INTERNAL_EXCEPTION_SNAPSHOT_UNAVAILABLE");
  expect(g.client.release).toHaveBeenCalledOnce();
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
