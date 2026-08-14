import { describe, expect, it, vi } from "vitest";
import {
  executeRequisition,
  queryRequisitions,
  RequisitionServiceError,
} from "../application/requisition-service.js";
import type { RequisitionPorts } from "../application/ports/requisition-ports.js";
import type {
  RequisitionCommand,
  RequisitionProjection,
  RequisitionQuery,
} from "../contracts/requisition.js";
import {
  allocateRequisitionLine,
  cancelRequisitionRemainder,
  createRequisition,
  reviseRequisitionDraft,
  transitionRequisition,
  type PurchaseRequisition,
  type RequisitionReference,
} from "../domain/aggregates/requisition.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as RequisitionReference;
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const line = {
  lineReference: id(10),
  inventoryItemReference: id(11),
  requestedQuantity: "10",
  requestedUnit: "CASE",
  requiredByUtc: at(20),
  needSourceReferences: [id(12)],
} as const;
function draft(): PurchaseRequisition {
  return createRequisition({
    requisitionReference: id(20),
    tenantReference: id(1),
    brandReference: id(2),
    requestingScopeKind: "Store",
    requestingScopeReference: id(3),
    requesterReference: id(4),
    urgency: "Urgent",
    lines: [line],
    actorReference: id(4),
    occurredAt: at(1),
  });
}
function approved() {
  let value = transitionRequisition(draft(), {
    expectedVersion: 1,
    action: "Submit",
    actorReference: id(4),
    occurredAt: at(2),
    approvalReference: null,
    reasonCode: null,
  });
  value = transitionRequisition(value, {
    expectedVersion: 2,
    action: "StartReview",
    actorReference: id(5),
    occurredAt: at(3),
    approvalReference: null,
    reasonCode: null,
  });
  return transitionRequisition(value, {
    expectedVersion: 3,
    action: "Approve",
    actorReference: id(6),
    occurredAt: at(4),
    approvalReference: id(30),
    reasonCode: null,
  });
}
const allocation = (quantity: string, n = 40) => ({
  allocationReference: id(n),
  purchaseOrderDraftReference: id(n + 1),
  purchaseOrderDraftLineReference: id(n + 2),
  offeringReference: id(n + 3),
  offeringVersionReference: id(n + 4),
  priceRecordReference: id(n + 5),
  priceVersionReference: id(n + 6),
  quantity,
  allocatedBy: id(7),
  allocatedAt: at(5),
});
function access() {
  return {
    authorized: true,
    mayManage: true,
    mayReview: true,
    mayApprove: true,
    mayAllocate: true,
    mayViewAmount: true,
    mayViewApprovalIdentity: true,
    mayViewAllocationReferences: true,
  };
}
function ports(existing: PurchaseRequisition | null = approved()): RequisitionPorts {
  return {
    authorization: { authorize: vi.fn(async () => access()) },
    projection: { query: vi.fn() },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => existing),
      needSourcesAvailable: vi.fn(async () => true),
      commit: vi.fn(async (record) => record),
    },
    approval: {
      validate: vi.fn(async ({ requisition, lineReference, quantity, command }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        requisitionReference: requisition.requisitionReference,
        requisitionVersion: requisition.aggregateVersion,
        lineReference,
        quantity,
        approvalReference: command.payload.approvalReference as RequisitionReference,
        approved: true,
        approvedAt: at(4),
      })),
    },
    purchaseOrderDraft: {
      allocate: vi.fn(async ({ requisition, command }) => {
        const target = requisition.lines.at(0);
        if (!target) throw new Error("fixture line missing");
        return {
          tenantReference: id(1),
          brandReference: id(2),
          requestingScopeKind: "Store" as const,
          requestingScopeReference: id(3),
          requisitionReference: requisition.requisitionReference,
          requisitionVersion: requisition.aggregateVersion,
          lineReference: target.lineReference,
          inventoryItemReference: target.inventoryItemReference,
          requestedUnit: target.requestedUnit,
          quantity: command.payload.quantity as string,
          purchaseOrderDraftReference: id(41),
          purchaseOrderDraftLineReference: id(42),
          offeringReference: id(43),
          offeringVersionReference: id(44),
          priceRecordReference: id(45),
          priceVersionReference: id(46),
          offeringApproved: true as const,
          priceApproved: true as const,
          poWorkflow: "Draft" as const,
          poApproved: false as const,
          poIssued: false as const,
        };
      }),
    },
    audit: { create: vi.fn(async () => ({ auditReference: id(99) })) },
    references: {
      generate: vi.fn((kind) =>
        kind === "Requisition" ? id(20) : kind === "Allocation" ? id(40) : id(50),
      ),
      hashIntent: vi.fn(() => "hash"),
      equals: vi.fn((left, right) => left === right),
    },
  };
}
function command(action: RequisitionCommand["action"], aggregate = approved()): RequisitionCommand {
  const permission =
    action === "Approve" || action === "CancelRemainder"
      ? "procurement.requisition.approve"
      : action === "AllocateToPurchaseOrderDraft"
        ? "procurement.requisition.allocate"
        : action === "StartReview" || action === "Reject"
          ? "procurement.requisition.review"
          : "procurement.requisition.manage";
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(7),
    purpose: "RequisitionManagement",
    permission,
    operationReference: id(70),
    occurredAt: at(10),
    action,
    payload:
      action === "AllocateToPurchaseOrderDraft"
        ? {
            requisitionReference: id(20),
            expectedVersion: aggregate.aggregateVersion,
            lineReference: id(10),
            quantity: "4",
          }
        : action === "CancelRemainder"
          ? {
              requisitionReference: id(20),
              expectedVersion: aggregate.aggregateVersion,
              lineReference: id(10),
              quantity: "6",
              reasonCode: "REMAINDER_WAIVED",
              approvalReference: id(30),
            }
          : {
              requisitionReference: id(20),
              expectedVersion: aggregate.aggregateVersion,
              reasonCode: action === "Reject" || action === "Cancel" ? "CONTROLLED_REASON" : null,
              approvalReference: action === "Approve" ? id(30) : null,
            },
  };
}
describe("Purchase Requisition", () => {
  it("revises only Draft and keeps the stable identity", () => {
    const revised = reviseRequisitionDraft(draft(), {
      expectedVersion: 1,
      urgency: "Emergency",
      lines: [{ ...line, requestedQuantity: "12.5" }],
      actorReference: id(4),
      occurredAt: at(2),
    });
    expect(revised).toMatchObject({
      requisitionReference: id(20),
      aggregateVersion: 2,
      workflow: "Draft",
      urgency: "Emergency",
    });
    expect(revised.lines[0]?.requestedQuantity).toBe("12.5");
  });
  it("enforces requester and approver segregation", () => {
    let value = transitionRequisition(draft(), {
      expectedVersion: 1,
      action: "Submit",
      actorReference: id(4),
      occurredAt: at(2),
      approvalReference: null,
      reasonCode: null,
    });
    value = transitionRequisition(value, {
      expectedVersion: 2,
      action: "StartReview",
      actorReference: id(5),
      occurredAt: at(3),
      approvalReference: null,
      reasonCode: null,
    });
    expect(() =>
      transitionRequisition(value, {
        expectedVersion: 3,
        action: "Approve",
        actorReference: id(4),
        occurredAt: at(4),
        approvalReference: id(30),
        reasonCode: null,
      }),
    ).toThrowError("REQUISITION_SEGREGATION_REQUIRED");
  });
  it("keeps approval stable across split allocation and closes after an approved remainder cancellation", () => {
    const first = allocateRequisitionLine(approved(), {
      expectedVersion: 4,
      lineReference: id(10),
      allocation: allocation("4"),
    });
    expect(first).toMatchObject({
      workflow: "Approved",
      allocationStatus: "PartiallyAllocated",
      closureStatus: "Open",
    });
    const closed = cancelRequisitionRemainder(first, {
      expectedVersion: 5,
      lineReference: id(10),
      cancellation: {
        cancellationReference: id(50),
        quantity: "6",
        reasonCode: "REMAINDER_WAIVED",
        approvalReference: id(30),
        cancelledBy: id(6),
        cancelledAt: at(6),
      },
    });
    expect(closed).toMatchObject({
      workflow: "Approved",
      allocationStatus: "PartiallyAllocated",
      closureStatus: "Closed",
      approvalReference: id(30),
    });
  });
  it("rejects over-allocation before the PO Draft dependency is invoked", async () => {
    const existing = allocateRequisitionLine(approved(), {
      expectedVersion: 4,
      lineReference: id(10),
      allocation: allocation("8"),
    });
    const values = ports(existing);
    await expect(
      executeRequisition(
        {
          ...command("AllocateToPurchaseOrderDraft", existing),
          payload: {
            requisitionReference: id(20),
            expectedVersion: 5,
            lineReference: id(10),
            quantity: "3",
          },
        },
        values,
      ),
    ).rejects.toMatchObject({ code: "REQUISITION_OVER_ALLOCATED" });
    expect(values.purchaseOrderDraft.allocate).not.toHaveBeenCalled();
  });
  it("rejects a PO result that claims issue or approval", async () => {
    const values = ports();
    vi.mocked(values.purchaseOrderDraft.allocate).mockResolvedValueOnce({
      ...(await values.purchaseOrderDraft.allocate({
        command: command("AllocateToPurchaseOrderDraft"),
        requisition: approved(),
      })),
      poApproved: true as never,
    });
    vi.mocked(values.purchaseOrderDraft.allocate).mockClear();
    await expect(
      executeRequisition(command("AllocateToPurchaseOrderDraft"), values),
    ).rejects.toMatchObject({ code: "REQUISITION_DEPENDENCY_UNAVAILABLE" });
  });
  it("authorizes before idempotency access and binds replay ownership", async () => {
    const values = ports();
    vi.mocked(values.authorization.authorize).mockResolvedValueOnce({
      ...access(),
      authorized: false,
    });
    await expect(
      executeRequisition(command("AllocateToPurchaseOrderDraft"), values),
    ).rejects.toMatchObject({ code: "REQUISITION_PERMISSION_DENIED" });
    expect(values.repository.resolveOperation).not.toHaveBeenCalled();
  });
});

describe("Requisition projection", () => {
  it("requires permission-trimmed financial, approval and allocation fields", async () => {
    const values = ports();
    const query: RequisitionQuery = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(7),
      purpose: "RequisitionRead",
      permission: "procurement.requisition.read",
      selectedRequisitionReference: null,
      search: null,
      workflow: "All",
      requestingScopeReference: null,
      requesterReference: null,
      urgency: "All",
      unallocatedOnly: false,
      requiredFromUtc: null,
      requiredUntilUtc: null,
      cursor: null,
    };
    vi.mocked(values.authorization.authorize).mockResolvedValueOnce({
      ...access(),
      mayViewAmount: false,
      mayViewApprovalIdentity: false,
      mayViewAllocationReferences: false,
    });
    const projection: RequisitionProjection = {
      projectionName: "procurement_requisition_v1",
      projectionVersion: 1,
      asOfUtc: at(10),
      stale: false,
      partial: false,
      tenantReference: id(1),
      brandReference: id(2),
      permissions: {
        mayManage: true,
        mayReview: true,
        mayApprove: true,
        mayAllocate: true,
        mayViewAmount: false,
        mayViewApprovalIdentity: false,
        mayViewAllocationReferences: false,
      },
      items: [
        {
          requisitionReference: id(20),
          requisitionVersion: 4,
          requestingScopeReference: id(3),
          requestingScopeLabel: "Toronto",
          workflow: "Approved",
          allocationStatus: "NotAllocated",
          closureStatus: "Open",
          urgency: "Urgent",
          lineCount: 1,
          amountEstimate: null,
          currency: null,
          requesterReference: id(4),
          approverReference: null,
          requiredByUtc: at(20),
        },
      ],
      detail: null,
      nextCursor: null,
    };
    vi.mocked(values.projection.query).mockResolvedValueOnce(projection);
    await expect(queryRequisitions(query, values)).resolves.toBe(projection);
    const first = projection.items.at(0);
    if (!first) throw new Error("fixture row missing");
    vi.mocked(values.projection.query).mockResolvedValueOnce({
      ...projection,
      items: [{ ...first, amountEstimate: "100", currency: "CAD" }],
    });
    await expect(queryRequisitions(query, values)).rejects.toBeInstanceOf(RequisitionServiceError);
  });
});
