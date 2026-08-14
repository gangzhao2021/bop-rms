import { describe, expect, it, vi } from "vitest";
import { executePurchaseOrder } from "../application/purchase-order-service.js";
import type { PurchaseOrderPorts } from "../application/ports/purchase-order-ports.js";
import type { PurchaseOrderCommand } from "../contracts/purchase-order.js";
import {
  cancelPurchaseOrderLineRemainder,
  closePurchaseOrder,
  createPurchaseOrder,
  recordSupplierPurchaseOrderResponse,
  revisePurchaseOrder,
  transitionPurchaseOrder,
  type PurchaseOrder,
  type PurchaseOrderLineSnapshot,
  type PurchaseOrderReference,
} from "../domain/aggregates/purchase-order.js";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as PurchaseOrderReference;
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const line = (quantity = "10", unitCost = "12.50", discount = "0", total = "125") =>
  ({
    lineReference: id(20),
    inventoryItemReference: id(21),
    offeringReference: id(22),
    offeringVersionReference: id(23),
    priceRecordReference: id(24),
    priceVersionReference: id(25),
    requisitionAllocationReferences: [id(26)],
    inventoryItemName: "Synthetic Tomatoes",
    supplierItemCode: "SUP-TOM-01",
    supplierItemName: "Synthetic Tomato Case",
    purchaseUnit: "CASE",
    packQuantity: "1",
    baseUnit: "EA",
    baseQuantity: "24",
    orderedQuantity: quantity,
    unitCost,
    currency: "CAD",
    discount,
    lineTotal: total,
    expectedDeliveryUtc: at(20),
    commercialTermsReference: id(27),
  }) satisfies PurchaseOrderLineSnapshot;
function draft() {
  return createPurchaseOrder({
    purchaseOrderReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    supplierReference: id(3),
    buyerLegalEntityReference: id(4),
    shipToStockSiteReference: id(5),
    shipToAddressSnapshotReference: id(6),
    currency: "CAD",
    revisionReference: id(11),
    lines: [line()],
    actorReference: id(7),
    occurredAt: at(1),
  });
}
function issued() {
  let value = transitionPurchaseOrder(draft(), {
    expectedVersion: 1,
    action: "Submit",
    actorReference: id(7),
    occurredAt: at(2),
    approvalReference: null,
    buyerAuthorityDecisionReference: null,
    issueReference: null,
    reasonCode: null,
  });
  value = transitionPurchaseOrder(value, {
    expectedVersion: 2,
    action: "Approve",
    actorReference: id(8),
    occurredAt: at(3),
    approvalReference: id(30),
    buyerAuthorityDecisionReference: null,
    issueReference: null,
    reasonCode: null,
  });
  return transitionPurchaseOrder(value, {
    expectedVersion: 3,
    action: "Issue",
    actorReference: id(9),
    occurredAt: at(4),
    approvalReference: id(30),
    buyerAuthorityDecisionReference: id(31),
    issueReference: id(32),
    reasonCode: null,
  });
}
function access() {
  return {
    authorized: true,
    mayManage: true,
    mayApprove: true,
    mayIssue: true,
    mayRecordResponse: true,
    mayCancel: true,
    mayClose: true,
    mayViewCost: true,
    mayViewSupplierResponse: true,
    mayViewReceipt: true,
    mayViewDiscrepancy: true,
    mayViewHistory: true,
  };
}
function command(
  action: PurchaseOrderCommand["action"],
  existing = issued(),
): PurchaseOrderCommand {
  const permission =
    action === "Approve"
      ? "procurement.purchase_order.approve"
      : action === "Issue"
        ? "procurement.purchase_order.issue"
        : ["RecordAcknowledgement", "RecordDecline"].includes(action)
          ? "procurement.purchase_order.response"
          : ["Cancel", "CancelRemainder"].includes(action)
            ? "procurement.purchase_order.cancel"
            : action === "Close"
              ? "procurement.purchase_order.close"
              : "procurement.purchase_order.manage";
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(9),
    purpose: "PurchaseOrderManagement",
    permission,
    operationReference: id(70),
    occurredAt: at(10),
    action,
    payload:
      action === "Issue"
        ? {
            purchaseOrderReference: id(10),
            expectedVersion: existing.aggregateVersion,
            approvalReference: id(30),
            reasonCode: null,
          }
        : action === "CancelRemainder"
          ? {
              purchaseOrderReference: id(10),
              expectedVersion: existing.aggregateVersion,
              lineReference: id(20),
              quantity: "10",
              reasonCode: "REMAINDER_CANCELLED",
              approvalReference: id(30),
            }
          : { purchaseOrderReference: id(10), expectedVersion: existing.aggregateVersion },
  };
}
function ports(existing: PurchaseOrder = issued()): PurchaseOrderPorts {
  return {
    authorization: { authorize: vi.fn(async () => access()) },
    projection: { query: vi.fn() },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => existing),
      commit: vi.fn(async (record) => record),
    },
    composition: { resolve: vi.fn() },
    approval: {
      validate: vi.fn(async ({ command: input, purchaseOrder, lineReference, quantity }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        purchaseOrderReference: id(10),
        purchaseOrderVersion: purchaseOrder.aggregateVersion,
        revisionNumber:
          lineReference === null
            ? (purchaseOrder.pendingRevisionNumber ?? 1)
            : (purchaseOrder.effectiveRevisionNumber ?? 1),
        lineReference,
        quantity,
        approvalReference: input.payload.approvalReference as PurchaseOrderReference,
        approved: true,
        approvedAt: at(9),
      })),
    },
    issuePolicy: {
      validate: vi.fn(async ({ command: input, purchaseOrder }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        purchaseOrderReference: id(10),
        purchaseOrderVersion: purchaseOrder.aggregateVersion,
        revisionNumber: purchaseOrder.pendingRevisionNumber ?? 1,
        supplierReference: id(3),
        supplierActive: true,
        buyerLegalEntityReference: id(4),
        buyerAuthorityDecisionReference: id(31),
        buyerAuthorityEffectiveAt: at(9),
        shipToStockSiteReference: id(5),
        shipToAddressSnapshotReference: id(6),
        currency: "CAD",
        approvalReference: input.payload.approvalReference as PurchaseOrderReference,
        valid: true,
        blockers: [],
      })),
    },
    fulfillment: {
      resolveForClose: vi.fn(async ({ purchaseOrder }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        purchaseOrderReference: id(10),
        purchaseOrderVersion: purchaseOrder.aggregateVersion,
        snapshot: {
          snapshotReference: id(60),
          sourceAsOfUtc: at(9),
          openDiscrepancyCount: 0,
          lineReceivedQuantities: [{ lineReference: id(20), receivedQuantity: "10" }],
        },
      })),
    },
    audit: { create: vi.fn(async () => ({ auditReference: id(99) })) },
    references: {
      generate: vi.fn((kind) =>
        kind === "Issue" ? id(32) : kind === "Cancellation" ? id(40) : id(50),
      ),
      hashIntent: vi.fn(() => "hash"),
      equals: vi.fn((left, right) => left === right),
    },
  };
}
describe("Purchase Order Aggregate", () => {
  it("uses exact decimal arithmetic and rejects a mismatched line total", () => {
    expect(() =>
      createPurchaseOrder({
        purchaseOrderReference: id(10),
        tenantReference: id(1),
        brandReference: id(2),
        supplierReference: id(3),
        buyerLegalEntityReference: id(4),
        shipToStockSiteReference: id(5),
        shipToAddressSnapshotReference: id(6),
        currency: "CAD",
        revisionReference: id(11),
        lines: [line("1", "1", "0.50", "0.49")],
        actorReference: id(7),
        occurredAt: at(1),
      }),
    ).toThrowError("PURCHASE_ORDER_AMOUNT_MISMATCH");
    expect(
      createPurchaseOrder({
        purchaseOrderReference: id(10),
        tenantReference: id(1),
        brandReference: id(2),
        supplierReference: id(3),
        buyerLegalEntityReference: id(4),
        shipToStockSiteReference: id(5),
        shipToAddressSnapshotReference: id(6),
        currency: "CAD",
        revisionReference: id(11),
        lines: [line("1", "1", "0.50", "0.50")],
        actorReference: id(7),
        occurredAt: at(1),
      }).currency,
    ).toBe("CAD");
  });
  it("keeps approval separate from explicit Issue and pins authority evidence", () => {
    const value = issued();
    expect(value).toMatchObject({
      workflow: "Issued",
      effectiveRevisionNumber: 1,
      pendingRevisionNumber: null,
    });
    expect(value.revisions[0]).toMatchObject({
      lifecycle: "Issued",
      approvalReference: id(30),
      buyerAuthorityDecisionReference: id(31),
      issueReference: id(32),
    });
  });
  it("appends a post-Issue Draft Revision without overwriting the issued snapshot", () => {
    const value = revisePurchaseOrder(issued(), {
      expectedVersion: 4,
      revisionReference: id(12),
      reasonCode: "QUANTITY_CHANGE",
      lines: [line("12", "12.50", "0", "150")],
      actorReference: id(7),
      occurredAt: at(5),
    });
    expect(value).toMatchObject({
      workflow: "Issued",
      effectiveRevisionNumber: 1,
      pendingRevisionNumber: 2,
    });
    expect(
      value.revisions.map((entry) => [
        entry.revisionNumber,
        entry.lifecycle,
        entry.lines[0]?.orderedQuantity,
      ]),
    ).toEqual([
      [1, "Issued", "10"],
      [2, "Draft", "12"],
    ]);
  });
  it("invalidates an unissued approval by appending a new Draft revision", () => {
    let value = transitionPurchaseOrder(draft(), {
      expectedVersion: 1,
      action: "Submit",
      actorReference: id(7),
      occurredAt: at(2),
      approvalReference: null,
      buyerAuthorityDecisionReference: null,
      issueReference: null,
      reasonCode: null,
    });
    value = transitionPurchaseOrder(value, {
      expectedVersion: 2,
      action: "Approve",
      actorReference: id(8),
      occurredAt: at(3),
      approvalReference: id(30),
      buyerAuthorityDecisionReference: null,
      issueReference: null,
      reasonCode: null,
    });
    const revised = revisePurchaseOrder(value, {
      expectedVersion: 3,
      revisionReference: id(12),
      reasonCode: "MATERIAL_CHANGE",
      lines: [line("12", "12.50", "0", "150")],
      actorReference: id(7),
      occurredAt: at(4),
    });
    expect(revised).toMatchObject({ workflow: "Draft", pendingRevisionNumber: 2 });
    expect(revised.revisions.at(-1)).toMatchObject({
      lifecycle: "Draft",
      approvalReference: null,
    });
  });
  it("records Supplier response separately from issue and fulfillment", () => {
    const value = recordSupplierPurchaseOrderResponse(issued(), {
      expectedVersion: 4,
      responseReference: id(40),
      revisionNumber: 1,
      response: "Acknowledged",
      reasonCode: null,
      actorReference: id(9),
      occurredAt: at(5),
    });
    expect(value).toMatchObject({
      workflow: "Acknowledged",
      fulfillmentStatus: "NotReceived",
      closureStatus: "Open",
    });
  });
  it("closes only with final received or approved cancelled outcomes and no discrepancy", () => {
    const cancelled = cancelPurchaseOrderLineRemainder(issued(), {
      expectedVersion: 4,
      cancellationReference: id(40),
      lineReference: id(20),
      quantity: "4",
      reasonCode: "REMAINDER_CANCELLED",
      approvalReference: id(30),
      actorReference: id(8),
      occurredAt: at(5),
    });
    expect(() =>
      closePurchaseOrder(cancelled, {
        expectedVersion: 5,
        fulfillmentSnapshot: {
          snapshotReference: id(60),
          sourceAsOfUtc: at(6),
          openDiscrepancyCount: 1,
          lineReceivedQuantities: [{ lineReference: id(20), receivedQuantity: "6" }],
        },
        actorReference: id(8),
        occurredAt: at(7),
      }),
    ).toThrowError("PURCHASE_ORDER_CLOSE_BLOCKED");
    const closed = closePurchaseOrder(cancelled, {
      expectedVersion: 5,
      fulfillmentSnapshot: {
        snapshotReference: id(61),
        sourceAsOfUtc: at(6),
        openDiscrepancyCount: 0,
        lineReceivedQuantities: [{ lineReference: id(20), receivedQuantity: "6" }],
      },
      actorReference: id(8),
      occurredAt: at(7),
    });
    expect(closed).toMatchObject({
      workflow: "Issued",
      fulfillmentStatus: "PartiallyReceived",
      closureStatus: "Closed",
    });
  });
});
describe("Purchase Order application", () => {
  it("authorizes before idempotency or repository access", async () => {
    const values = ports();
    vi.mocked(values.authorization.authorize).mockResolvedValueOnce({
      ...access(),
      authorized: false,
    });
    await expect(executePurchaseOrder(command("Close"), values)).rejects.toMatchObject({
      code: "PURCHASE_ORDER_PERMISSION_DENIED",
    });
    expect(values.repository.resolveOperation).not.toHaveBeenCalled();
  });
  it("rejects an invalid issue decision without creating a Supplier commitment", async () => {
    let value = transitionPurchaseOrder(draft(), {
      expectedVersion: 1,
      action: "Submit",
      actorReference: id(7),
      occurredAt: at(2),
      approvalReference: null,
      buyerAuthorityDecisionReference: null,
      issueReference: null,
      reasonCode: null,
    });
    value = transitionPurchaseOrder(value, {
      expectedVersion: 2,
      action: "Approve",
      actorReference: id(8),
      occurredAt: at(3),
      approvalReference: id(30),
      buyerAuthorityDecisionReference: null,
      issueReference: null,
      reasonCode: null,
    });
    const values = ports(value);
    vi.mocked(values.issuePolicy.validate).mockResolvedValueOnce({
      ...(await values.issuePolicy.validate({
        command: command("Issue", value),
        purchaseOrder: value,
      })),
      supplierActive: false,
    });
    vi.mocked(values.issuePolicy.validate).mockClear();
    await expect(executePurchaseOrder(command("Issue", value), values)).rejects.toMatchObject({
      code: "PURCHASE_ORDER_ISSUE_BLOCKED",
    });
    expect(values.audit.create).not.toHaveBeenCalled();
  });
});
