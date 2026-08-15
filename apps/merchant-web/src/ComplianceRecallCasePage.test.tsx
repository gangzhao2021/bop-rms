import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComplianceRecallCase, ComplianceRecallState } from "./ComplianceRecallCasePage.js";
import { parseComplianceRecallView } from "./compliance-recall-case-page.js";

const ref = (value: string) => `018f9991-0000-7000-8000-${value.padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const at = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T19:00:00.000Z";
const first = <T,>(values: readonly T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic Recall item missing");
  return value;
};
const view = () => ({
  screenId: "RECALL-CASE",
  queryName: "compliance_recall_case_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayCalculateScope: true,
    mayEnforceContainment: true,
    mayCreateTasks: true,
    mayResolveNotice: true,
    mayRecordDisposition: true,
    mayVerifyClosure: true,
  },
  recall: {
    recallReference: ref("1"),
    revision: 6,
    caseReference: ref("2"),
    recallType: "Recall",
    sourceKind: "SupplierNotice",
    sourceReference: ref("3"),
    sourceSnapshotDigest: hash("a"),
    severity: "Critical",
    status: "Verification",
    effectiveFrom: before,
    effectiveTo: null,
    affectedScope: {
      traceRunReference: ref("4"),
      supplierReferences: [ref("5")],
      inventoryItemReferences: [ref("6")],
      lotReferences: [ref("7")],
      batchReferences: [ref("8")],
      productReferences: [ref("9")],
      skuReferences: [ref("10")],
      storeReferences: [],
      expectedNodeCount: "8",
      tracedNodeCount: "8",
      gapCount: "0",
      customerOrderCount: "12",
      fulfillmentCount: "9",
      coverage: "Complete",
      calculatedAt: before,
    },
    containmentOutcomeReferences: [ref("11"), ref("12"), ref("13"), ref("14"), ref("15")],
    taskOutcomeReference: ref("16"),
    noticeRequirement: "Required",
    noticeDecisionReference: ref("17"),
    noticeApprovalReference: ref("18"),
    notificationOutcomeReference: ref("19"),
    dispositions: [
      {
        dispositionReference: ref("20"),
        subjectKind: "Lot",
        subjectReference: ref("7"),
        decision: "Dispose",
        ownerOutcomeReference: ref("21"),
        decidedAt: before,
      },
    ],
    verification: null,
    requirementVersionReference: ref("22"),
  },
});

describe("WP-2177 RECALL-CASE", () => {
  it("renders scope, owner outcomes, aggregate notification scope and closure action", () => {
    const html = renderToStaticMarkup(
      <ComplianceRecallCase view={parseComplianceRecallView(view())} />,
    );
    expect(html).toContain("RECALL-CASE");
    expect(html).toContain("Complete trace coverage");
    expect(html).toContain("Customer Order scope 12");
    expect(html).toContain("Hard Block outcomes 5/5");
    expect(html).toContain("Verify Recall closure");
  });

  it("renders Partial coverage as an explicit closure blocker", () => {
    const partial = view();
    partial.completeness = "Partial";
    partial.recall.status = "Disposition";
    partial.recall.affectedScope = {
      ...partial.recall.affectedScope,
      tracedNodeCount: "7",
      gapCount: "1",
      coverage: "Partial",
    } as never;
    const html = renderToStaticMarkup(
      <ComplianceRecallCase view={parseComplianceRecallView(partial)} />,
    );
    expect(html).toContain("Partial trace coverage");
    expect(html).toContain("Trace Gaps block closure");
  });

  it("rejects hidden Gaps, incomplete owner outcomes, premature closure and restricted extras", () => {
    const hidden = view();
    hidden.recall.affectedScope = { ...hidden.recall.affectedScope, coverage: "Partial" } as never;
    expect(() => parseComplianceRecallView(hidden)).toThrow();
    const incomplete = view();
    incomplete.recall.containmentOutcomeReferences = [ref("11")];
    expect(() => parseComplianceRecallView(incomplete)).toThrow();
    const closed = view();
    closed.recall.status = "Closed";
    expect(() => parseComplianceRecallView(closed)).toThrow();
    expect(() => parseComplianceRecallView({ ...view(), customerEmail: "x" })).toThrow();
  });

  it("renders the pre-scope state without inventing affected facts", () => {
    const pending = view();
    pending.recall.status = "ScopeAssessment";
    pending.recall.affectedScope = null as never;
    pending.recall.containmentOutcomeReferences = [];
    pending.recall.taskOutcomeReference = null as never;
    pending.recall.noticeDecisionReference = null as never;
    pending.recall.noticeApprovalReference = null as never;
    pending.recall.notificationOutcomeReference = null as never;
    pending.recall.dispositions = [];
    const html = renderToStaticMarkup(
      <ComplianceRecallCase view={parseComplianceRecallView(pending)} />,
    );
    expect(html).toContain("Scope calculation required");
    expect(html).toContain("Calculate affected scope");
  });

  it("hides all mutations without exact permissions", () => {
    const denied = view();
    denied.permissions = {
      mayCalculateScope: false,
      mayEnforceContainment: false,
      mayCreateTasks: false,
      mayResolveNotice: false,
      mayRecordDisposition: false,
      mayVerifyClosure: false,
    };
    const html = renderToStaticMarkup(
      <ComplianceRecallCase view={parseComplianceRecallView(denied)} />,
    );
    expect(html).not.toMatch(
      /Calculate affected|Enforce owner|Create Recall|Approve \/ resolve|Record owner|Verify Recall/u,
    );
  });

  it("rejects unbounded affected scopes and disposition lists", () => {
    const huge = view();
    huge.recall.affectedScope.lotReferences = Array.from({ length: 501 }, (_, index) =>
      ref(String(100 + index)),
    );
    expect(() => parseComplianceRecallView(huge)).toThrow();
    const dispositions = view();
    dispositions.recall.dispositions = Array.from({ length: 501 }, () =>
      first(dispositions.recall.dispositions),
    ) as never;
    expect(() => parseComplianceRecallView(dispositions)).toThrow();
  });

  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "FeatureDisabled",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders %s", (state) => {
    expect(renderToStaticMarkup(<ComplianceRecallState state={state} />)).toContain(
      'role="status"',
    );
  });
});
