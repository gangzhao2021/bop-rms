import { describe, it, expect } from "vitest";
import {
  parseDiningItemServiceRecord,
  validateDiningItemServiceAppend,
} from "../domain/dining-item-service-record.js";
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
describe("Dining item service immutable candidate", () => {
  it("retains scoped item, table assignment and partial integer quantity", () => {
    const raw = fixture();
    expect(parseDiningItemServiceRecord(raw)).toEqual(raw);
    expect(Object.isFrozen(parseDiningItemServiceRecord(raw))).toBe(true);
  });
  it.each([
    { quantity: 0 },
    { quantity: 1.5 },
    { quantity: 1000 },
    { expectedItemServiceVersion: -1 },
    { itemServiceVersion: 2 },
    { sessionVersion: 0 },
    { tableAssignmentVersion: 0 },
    { permissionCode: "order.accept" },
    { actorReference: null },
    { servedAt: "2026-09-13T12:00:02.000Z" },
    { privateNote: "not allowed" },
  ])("rejects invalid or unscoped candidate %j", (patch) => {
    expect(() => parseDiningItemServiceRecord({ ...fixture(), ...patch })).toThrow();
  });
});

describe("cumulative Dining service append", () => {
  const next = () => ({
    ...fixture(),
    serviceReference: id(20),
    operationReference: id(21),
    auditReference: id(22),
    expectedItemServiceVersion: 1,
    itemServiceVersion: 2,
  });
  it("allows partial service then exactly the remaining quantity, including a table move", () => {
    const record = { ...next(), tableReference: id(23), tableAssignmentVersion: 4 };
    expect(
      validateDiningItemServiceAppend({
        record,
        history: [fixture()],
        orderedQuantity: 2,
        readyQuantity: 2,
      }),
    ).toMatchObject({ servedQuantity: 2, remainingQuantity: 0 });
  });
  it.each([
    { readyQuantity: 1 },
    { orderedQuantity: 1 },
    { history: [] },
    { history: [{ ...fixture(), orderBatchReference: id(90) }] },
    { history: [{ ...fixture(), itemServiceVersion: 2, expectedItemServiceVersion: 1 }] },
    { record: { ...next(), operationReference: fixture().operationReference } },
    { record: { ...next(), quantity: 2 } },
  ])("rejects over-service, stale versions or unrelated history %j", (patch) => {
    expect(() =>
      validateDiningItemServiceAppend({
        record: next(),
        history: [fixture()],
        orderedQuantity: 2,
        readyQuantity: 2,
        ...patch,
      }),
    ).toThrow();
  });
});
