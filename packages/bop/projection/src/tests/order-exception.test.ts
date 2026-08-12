import { describe, expect, it } from "vitest";
import {
  authorizeOrderExceptionAction,
  buildOrderExceptionProjection,
  OrderExceptionProjectionError,
  type OrderExceptionSource,
} from "../order-exception.js";
const refs = [
  "018f0f58-767a-7f3b-a1d0-000000000001",
  "018f0f58-767a-7f3b-a1d0-000000000002",
  "018f0f58-767a-7f3b-a1d0-000000000003",
  "018f0f58-767a-7f3b-a1d0-000000000004",
  "018f0f58-767a-7f3b-a1d0-000000000005",
  "018f0f58-767a-7f3b-a1d0-000000000006",
  "018f0f58-767a-7f3b-a1d0-000000000007",
  "018f0f58-767a-7f3b-a1d0-000000000008",
  "018f0f58-767a-7f3b-a1d0-000000000009",
  "018f0f58-767a-7f3b-a1d0-000000000010",
  "018f0f58-767a-7f3b-a1d0-000000000011",
  "018f0f58-767a-7f3b-a1d0-000000000012",
] as const;
const source = (): OrderExceptionSource => ({
  sourceReference: refs[0],
  tenantReference: refs[1],
  brandReference: refs[2],
  storeReference: refs[3],
  orderReference: refs[4],
  paymentReference: refs[5],
  diningReference: null,
  kind: "PaidWithoutFulfillableOrder",
  severity: "Critical",
  sourceOwner: "Payment",
  sourceStatus: "Open",
  providerState: "Unknown",
  compensationStatus: "Pending",
  sourceVersion: 2n,
  sourceDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-08-12T16:00:00.000Z",
  updatedAt: "2026-08-12T16:01:00.000Z",
  resolutionEvidenceReference: null,
});
function projection(input = source(), projectedAt = "2026-08-12T16:14:59.000Z") {
  return buildOrderExceptionProjection({
    tenantReference: refs[1],
    brandReference: refs[2],
    storeReference: refs[3],
    businessDate: "2026-08-12",
    checkpointReference: refs[6],
    projectedAt,
    freshnessStatus: "Fresh",
    sources: [input],
    deriveProjectionReference: () => refs[7],
  });
}
function projectedRow() {
  const row = projection().rows[0];
  if (!row) throw new Error("missing synthetic row");
  return row;
}
describe("WP-1809 order exception projection", () => {
  it("projects a critical source within 15 minutes without inventing Provider finality", () => {
    const result = projection();
    expect(result.rows[0]).toMatchObject({
      status: "Open",
      providerState: "Unknown",
      ownerReference: null,
    });
    expect(result.rows[0]?.dueAt).toBe("2026-08-12T16:15:00.000Z");
  });
  it("rejects cross-Store sources and missed critical visibility", () => {
    expect(() => projection({ ...source(), storeReference: refs[8] })).toThrowError(
      new OrderExceptionProjectionError("SCOPE_MISMATCH"),
    );
    expect(() => projection(source(), "2026-08-12T16:15:01.000Z")).toThrowError(
      new OrderExceptionProjectionError("SLA_MISSED"),
    );
  });
  it("routes compensation to the owning Domain with permission and idempotency", () => {
    const row = projectedRow();
    expect(
      authorizeOrderExceptionAction({
        row,
        action: "RequestCompensation",
        actorReference: refs[8],
        actorPermissions: ["operations.order-exception.manage", "payment.compensation.request"],
        expectedSourceVersion: 2n,
        idempotencyReference: refs[9],
      }),
    ).toMatchObject({ owningDomain: "Payment", commandName: "RequestPaymentCompensation" });
  });
  it("cannot resolve before source finality or request write-off without distinct permission", () => {
    const row = projectedRow();
    expect(() =>
      authorizeOrderExceptionAction({
        row,
        action: "Resolve",
        actorReference: refs[8],
        actorPermissions: [
          "operations.order-exception.manage",
          "operations.order-exception.resolve",
        ],
        expectedSourceVersion: 2n,
        idempotencyReference: refs[9],
      }),
    ).toThrowError(new OrderExceptionProjectionError("SOURCE_NOT_FINAL"));
    expect(() =>
      authorizeOrderExceptionAction({
        row,
        action: "RequestWriteOff",
        actorReference: refs[8],
        actorPermissions: ["operations.order-exception.manage"],
        expectedSourceVersion: 2n,
        idempotencyReference: refs[9],
      }),
    ).toThrowError(new OrderExceptionProjectionError("PERMISSION_DENIED"));
  });
});
