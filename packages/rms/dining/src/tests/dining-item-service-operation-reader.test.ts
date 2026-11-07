import { expect, it, vi } from "vitest";
import { createPostgresDiningItemServiceOperationReader } from "../infrastructure/persistence/dining-item-service-store.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  return {
    serviceReference: id(1),
    operationReference: id(2),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    diningSessionReference: id(6),
    tableReference: id(7),
    orderReference: id(8),
    orderBatchReference: id(9),
    orderItemReference: id(10),
    actorReference: id(11),
    sourceCheckpoint: id(12),
    auditReference: id(13),
    sessionVersion: 2,
    tableAssignmentVersion: 3,
    expectedOrderVersion: 5,
    expectedItemServiceVersion: 0,
    itemServiceVersion: 1,
    quantity: 1,
    purposeCode: "ServeDiningOrderItem",
    permissionCode: "dining.item.serve",
    servedAt: "2026-09-13T12:00:00.000Z",
    recordedAt: "2026-09-13T12:00:01.000Z",
    sourceDigest: "a".repeat(64),
  };
}

function setup(records: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT record_json")
      ? records.map((record_json) => ({ record_json }))
      : [],
    rowCount: records.length,
  }));
  const authorize = vi.fn(async () => true);
  const reader = createPostgresDiningItemServiceOperationReader({
    scope: { tenantReference: id(3), brandReference: id(4), storeReference: id(5) },
    authorize,
  });
  return {
    query,
    authorize,
    load: () => reader.load({ transaction: { query }, operationReference: id(2) }),
  };
}
it("loads immutable original operation under the same writer fence", async () => {
  const f = setup([fixture()]);
  expect(await f.load()).toEqual(fixture());
  expect(f.query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
  expect(f.query.mock.calls[2]?.[0]).toContain(
    "tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
  );
});
it("returns missing only after current authorization", async () => {
  expect(await setup([]).load()).toBeNull();
});
it.each(["operationReference", "tenantReference", "brandReference", "storeReference"])(
  "rejects stored %s mismatch",
  async (key) => {
    await expect(setup([{ ...fixture(), [key]: id(99) }]).load()).rejects.toThrow("unavailable");
  },
);
it("rejects ambiguous operation history", async () => {
  await expect(setup([fixture(), fixture()]).load()).rejects.toThrow();
});
it("does not read when denied and rejects revocation even for missing operation", async () => {
  const f = setup([]);
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.load()).rejects.toThrow();
});
