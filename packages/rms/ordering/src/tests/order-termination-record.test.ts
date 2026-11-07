import { describe, expect, it } from "vitest";
import { parseOrderTerminationRecord } from "../index.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const record = () => ({
  terminationReference: id(1),
  operationReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  orderReference: id(5),
  orderBatchReference: id(6),
  expectedOrderVersion: 1,
  terminatedOrderVersion: 2,
  expectedSourceCheckpoint: id(7),
  previousPhase: "Submitted",
  phase: "Rejected",
  actorType: "User",
  actorReference: id(8),
  purposeCode: "OrderTermination",
  permissionCode: "order.reject",
  reasonCode: "SYNTHETIC_TEST",
  workflowVersionReference: id(9),
  transitionReference: id(10),
  sourceDigest: "sha256:" + "a".repeat(64),
  terminatedAt: "2026-09-12T00:00:00.000Z",
});
describe("initial Order termination record", () => {
  it("preserves a closed immutable termination fact", () => {
    const source = record(),
      result = parseOrderTerminationRecord(source);
    source.reasonCode = "CHANGED";
    expect(result.reasonCode).toBe("SYNTHETIC_TEST");
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      parseOrderTerminationRecord({
        ...record(),
        phase: "Cancelled",
        previousPhase: "Accepted",
        expectedOrderVersion: 2,
        terminatedOrderVersion: 3,
      }).phase,
    ).toBe("Cancelled");
    expect(
      parseOrderTerminationRecord({ ...record(), actorType: "System", actorReference: null })
        .actorReference,
    ).toBeNull();
  });
  it.each([
    { previousPhase: "Accepted" },
    { previousPhase: "Fulfilled" },
    { phase: "Closed" },
    { expectedOrderVersion: 0 },
    { expectedOrderVersion: 1.5 },
    { terminatedOrderVersion: 4 },
    { expectedOrderVersion: 2147483647, terminatedOrderVersion: 2147483648 },
    { expectedSourceCheckpoint: "unknown" },
    { actorType: "Guest" },
    { actorType: "System" },
    { actorReference: null },
    { permissionCode: "" },
    { sourceDigest: "unavailable" },
    { terminatedAt: "2026-09-12T00:00:00Z" },
    { refundStatus: "Refunded" },
  ])("rejects invalid or unrelated terminal meaning %j", (patch) => {
    expect(() => parseOrderTerminationRecord({ ...record(), ...patch })).toThrow();
  });
  it("does not execute an accessor", () => {
    const input = record();
    let calls = 0;
    Object.defineProperty(input, "reasonCode", {
      enumerable: true,
      get() {
        calls++;
        return "SECRET";
      },
    });
    expect(() => parseOrderTerminationRecord(input)).toThrow();
    expect(calls).toBe(0);
  });
});
