import { describe, expect, it } from "vitest";
import { parseOrderAcceptanceRecord } from "../index.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const record = () => ({
  acceptanceReference: id(1),
  operationReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  orderReference: id(5),
  orderBatchReference: id(6),
  expectedOrderVersion: 1,
  acceptedOrderVersion: 2,
  actorType: "User",
  actorReference: id(7),
  purposeCode: "OrderAcceptance",
  permissionCode: "order.accept",
  reasonCode: "SYNTHETIC_TEST",
  workflowVersionReference: id(8),
  transitionReference: id(9),
  sourceDigest: "sha256:" + "a".repeat(64),
  acceptedAt: "2026-09-12T00:00:00.000Z",
});
describe("general Order acceptance record", () => {
  it("preserves immutable scoped policy provenance independently from terminal authorization", () => {
    const input = record();
    const parsed = parseOrderAcceptanceRecord(input);
    input.reasonCode = "Changed";
    expect(parsed.reasonCode).toBe("SYNTHETIC_TEST");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseOrderAcceptanceRecord({ ...record(), actorType: "System", actorReference: null })
        .actorReference,
    ).toBeNull();
  });
  it.each([
    { expectedOrderVersion: 0 },
    { expectedOrderVersion: 1.5 },
    { acceptedOrderVersion: 3 },
    { expectedOrderVersion: 2147483647, acceptedOrderVersion: 2147483648 },
    { actorType: "System" },
    { actorReference: null },
    { actorType: "Guest" },
    { permissionCode: "" },
    { purposeCode: "unsafe purpose" },
    { reasonCode: "A".repeat(129) },
    { sourceDigest: "sha256:unknown" },
    { acceptedAt: "2026-09-12T00:00:00Z" },
    { paymentStatus: "Succeeded" },
  ])("rejects invalid acceptance history %j", (patch) => {
    expect(() => parseOrderAcceptanceRecord({ ...record(), ...patch })).toThrow(
      expect.objectContaining({ code: "ORDER_ACCEPTANCE_RECORD_INVALID" }),
    );
  });
  it("rejects accessors without executing them", () => {
    const input = record();
    let calls = 0;
    Object.defineProperty(input, "reasonCode", {
      enumerable: true,
      get() {
        calls++;
        return "SECRET";
      },
    });
    expect(() => parseOrderAcceptanceRecord(input)).toThrow();
    expect(calls).toBe(0);
  });
});
