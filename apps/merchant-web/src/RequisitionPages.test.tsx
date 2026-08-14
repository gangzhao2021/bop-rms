import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { RequisitionDetail, RequisitionList, RequisitionState } from "./RequisitionPages.js";
import { parseRequisitionView, RequisitionClientError } from "./requisition-pages.js";
const id = (n: number) => `018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(detail = false, masked = false) {
  return {
    screenId: detail ? "PROC-REQUISITION-DETAIL" : "PROC-REQUISITION-LIST",
    projectionName: "procurement_requisition_v1",
    projectionVersion: 1,
    brandLabel: "Synthetic Brand",
    asOfUtc: "2026-08-14T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      mayManage: true,
      mayReview: true,
      mayApprove: true,
      mayAllocate: true,
      mayViewAmount: !masked,
      mayViewApprovalIdentity: !masked,
      mayViewAllocationReferences: !masked,
    },
    rows: [
      {
        requisitionReference: id(20),
        requisitionVersion: 4,
        requestingScopeLabel: "Toronto Store",
        workflow: "Approved",
        allocationStatus: "PartiallyAllocated",
        closureStatus: "Open",
        urgency: "Urgent",
        lineCount: 1,
        amountEstimate: masked ? null : "125.50",
        currency: masked ? null : "CAD",
        requesterReference: id(4),
        approverReference: masked ? null : id(6),
        requiredByUtc: "2026-08-20T12:00:00.000Z",
      },
    ],
    detail: detail
      ? {
          requisitionReference: id(20),
          requisitionVersion: 4,
          needSourceReferences: [id(12)],
          lines: [
            {
              lineReference: id(10),
              inventoryItemReference: id(11),
              itemName: "Synthetic Tomatoes",
              requestedQuantity: "10",
              requestedUnit: "CASE",
              requiredByUtc: "2026-08-20T12:00:00.000Z",
              candidateSupplierSummaries: ["Synthetic Supplier"],
              allocationReferences: masked ? null : [id(40)],
            },
          ],
          approvalReference: masked ? null : id(30),
          approverReference: masked ? null : id(6),
          timeline: [{ action: "Approved", occurredAt: "2026-08-14T09:00:00.000Z" }],
        }
      : null,
    nextCursor: null,
  };
}
describe("Requisition pages", () => {
  it("strictly parses list/detail and rejects unregistered fields", () => {
    expect(parseRequisitionView(projection())).toMatchObject({
      screenId: "PROC-REQUISITION-LIST",
      rows: [{ workflow: "Approved" }],
    });
    expect(() => parseRequisitionView({ ...projection(), extra: true })).toThrow(
      RequisitionClientError,
    );
  });
  it("renders canonical list fields, filters and guarded actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RequisitionList view={parseRequisitionView(projection())} />
      </MemoryRouter>,
    );
    for (const value of [
      "PROC-REQUISITION-LIST",
      "Reference / Item",
      "Status / Store / Requester",
      "Urgency / Unallocated / Required date",
      "PartiallyAllocated",
      "Estimate 125.50 CAD",
      "Allocate to PO drafts",
      "internal work only",
    ])
      expect(html).toContain(value);
  });
  it("renders masked detail without approval or allocation references", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RequisitionDetail view={parseRequisitionView(projection(true, true))} />
      </MemoryRouter>,
    );
    for (const value of [
      "PROC-REQUISITION-DETAIL",
      "Need sources and requested lines",
      "Synthetic Tomatoes",
      "Candidate Suppliers",
      "Approval identity restricted",
      "Split / allocate to PO drafts",
      "Receipt belongs to Inventory",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain(id(30));
    expect(html).not.toContain(id(40));
  });
  it("makes stale detail read-only and covers mandatory states", () => {
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <RequisitionDetail
            view={parseRequisitionView({ ...projection(true), freshness: "Stale" })}
          />
        </MemoryRouter>,
      ),
    ).toContain("Projection stale");
    for (const state of [
      "Loading",
      "Empty",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "ValidationFailed",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<RequisitionState state={state} />)).toContain("status");
  });
});
