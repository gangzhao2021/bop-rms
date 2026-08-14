import { describe, expect, it } from "vitest";
import {
  createAmendmentChange,
  createOrderAmendment,
  initialAmendmentStatus,
  parseAmendmentCode,
  parseAmendmentDigest,
  parseAmendmentReference,
  transitionOrderAmendment,
} from "../index.js";

const raw = (n: number) => `018f9a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseAmendmentReference(raw(n));
const at = "2026-08-13T20:00:00.000Z";
const change = (kind: "AddItem" | "ReduceItem" | "ReplaceItemConfiguration" = "AddItem") =>
  createAmendmentChange({
    kind,
    targetOrderItemReference: kind === "AddItem" ? null : id(8),
    replacementSnapshotDigest:
      kind === "AddItem" || kind === "ReplaceItemConfiguration"
        ? parseAmendmentDigest(`sha256:${"a".repeat(64)}`)
        : null,
    quantityDelta: kind === "AddItem" ? 1 : kind === "ReduceItem" ? -1 : 0,
    noteCode: null,
  });
function amendment(status: "PendingKitchen" | "PendingApproval" = "PendingKitchen") {
  return createOrderAmendment({
    amendmentReference: id(1),
    orderReference: id(2),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    requestedByActorReference: id(6),
    reasonCode: parseAmendmentCode("GUEST_REQUEST"),
    change: change("ReduceItem"),
    expectedOrderVersion: 4,
    quoteReference: id(9),
    quoteVersion: 2,
    quoteInputDigest: parseAmendmentDigest(`sha256:${"b".repeat(64)}`),
    currencyCode: "CAD",
    originalTotalMinor: "1000",
    revisedTotalMinor: "800",
    deltaMinor: "-200",
    kitchenStatus: "InProgress",
    fulfillmentStatus: "NotStarted",
    approvalRequired: true,
    customerNoticeCode: parseAmendmentCode("NOTICE_REQUIRED"),
    status,
    aggregateVersion: 1,
    decidedByActorReference: null,
    requestedAt: at,
    decidedAt: null,
  });
}
describe("Order Amendment domain", () => {
  it("accepts only the five structured change forms and exact integer money", () => {
    expect(change("AddItem").quantityDelta).toBe(1);
    expect(() => createAmendmentChange({ ...change("AddItem"), quantityDelta: 1.5 })).toThrowError(
      expect.objectContaining({ code: "ORDER_AMENDMENT_INPUT_INVALID" }),
    );
    expect(() => createOrderAmendment({ ...amendment(), revisedTotalMinor: "900" })).toThrowError(
      expect.objectContaining({ code: "ORDER_AMENDMENT_INPUT_INVALID" }),
    );
  });
  it("holds destructive Kitchen work and enforces distinct approval", () => {
    expect(
      initialAmendmentStatus({
        kind: "ReduceItem",
        kitchenStatus: "InProgress",
        approvalRequired: true,
      }),
    ).toBe("PendingKitchen");
    const waiting = transitionOrderAmendment(
      amendment(),
      "ConfirmKitchen",
      id(7),
      "2026-08-13T20:01:00.000Z",
    );
    expect(waiting.status).toBe("PendingApproval");
    expect(() =>
      transitionOrderAmendment(waiting, "Approve", id(6), "2026-08-13T20:02:00.000Z"),
    ).toThrowError(expect.objectContaining({ code: "ORDER_AMENDMENT_SEPARATION_REQUIRED" }));
    expect(
      transitionOrderAmendment(waiting, "Approve", id(10), "2026-08-13T20:02:00.000Z").status,
    ).toBe("Applied");
  });
  it("rejects destructive changes after Kitchen completion", () => {
    expect(() =>
      initialAmendmentStatus({
        kind: "ReplaceItemConfiguration",
        kitchenStatus: "Completed",
        approvalRequired: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "ORDER_AMENDMENT_KITCHEN_REJECTED" }));
  });
});
