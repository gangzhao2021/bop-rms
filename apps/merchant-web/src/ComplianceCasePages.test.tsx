import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComplianceCaseDetail,
  ComplianceCaseList,
  ComplianceCaseState,
} from "./ComplianceCasePages.js";
import {
  parseComplianceCaseDetailView,
  parseComplianceCaseListView,
} from "./compliance-case-pages.js";
const ref = (value: string) => `018f9931-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-14T18:00:00.000Z";
const before = "2026-08-14T17:55:00.000Z";
const permissions = {
  mayCreate: true,
  mayAssign: true,
  mayTransition: true,
  mayContain: true,
  mayRecordNotification: true,
  mayClose: true,
  mayReviewMergeSplit: true,
};
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic Case item missing");
  return value;
};
const summary = () => ({
  caseReference: ref("1"),
  caseType: "FoodSafetyIncident",
  severity: "Critical",
  lifecycle: "Verification",
  storeReference: null,
  ownerReference: ref("2"),
  deadlineAt: "2026-08-15T18:00:00.000Z",
  containmentStatus: "Applied",
  notificationStatus: "Submitted",
  openActionCount: "1",
});
const list = () => ({
  screenId: "CMP-CASE-LIST",
  queryName: "compliance_case_list_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions,
  filters: {
    caseReference: null,
    relatedReference: null,
    caseType: null,
    lifecycle: null,
    severity: null,
    storeReference: null,
    ownerReference: null,
    deadlineDisposition: null,
    regulatorReference: null,
  },
  cases: [summary()],
});
const detail = () => ({
  screenId: "CMP-CASE-DETAIL",
  queryName: "compliance_case_detail_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions,
  case: summary(),
  requirementVersionReferences: [ref("3")],
  relatedScopes: [{ kind: "STORE", reference: ref("4"), snapshotCode: "STORE_SCOPE" }],
  containment: [
    {
      containmentReference: ref("5"),
      action: "STOP_SELLING",
      status: "Applied",
      hardBlock: true,
      ownerActionReference: ref("6"),
      occurredAt: before,
    },
  ],
  notifications: [
    {
      notificationReference: ref("7"),
      authorityReference: ref("8"),
      requirementVersionReference: ref("3"),
      status: "Submitted",
      deadlineAt: at,
      submissionReference: ref("9"),
      occurredAt: before,
    },
  ],
  gateCounts: {
    openFindings: "1",
    mandatoryActionsIncomplete: "0",
    evidenceMissing: "0",
    verificationPending: "1",
  },
  legalHoldActive: true,
  timeline: [{ entryReference: ref("10"), eventCode: "CASE_OPENED", occurredAt: before }],
});
describe("WP-2171 Compliance Case screens", () => {
  it("renders list fields and permission-gated review actions", () => {
    const html = renderToStaticMarkup(
      <ComplianceCaseList view={parseComplianceCaseListView(list())} />,
    );
    expect(html).toContain("Compliance Cases");
    expect(html).toContain("Review merge / split");
    expect(html).toContain("open actions 1");
  });
  it("renders detail gates, containment, notification and Legal Hold without restricted content", () => {
    const html = renderToStaticMarkup(
      <ComplianceCaseDetail view={parseComplianceCaseDetailView(detail())} />,
    );
    expect(html).toContain("Legal Hold active");
    expect(html).toContain("Hard Block");
    expect(html).not.toContain("Not submitted");
    expect(html).toContain("Verify closure gates");
    expect(html).not.toMatch(
      /narrative|contact|health|allergyFact|evidenceContent|authorityPayload/,
    );
  });
  it("rejects extra, contradictory and unbounded payloads", () => {
    expect(() => parseComplianceCaseListView({ ...list(), rawEvidence: [] })).toThrow();
    const invalid = detail();
    invalid.notifications[0] = {
      ...first(invalid.notifications),
      submissionReference: null as never,
    };
    expect(() => parseComplianceCaseDetailView(invalid)).toThrow();
    const huge = list();
    huge.cases = Array.from({ length: 501 }, summary);
    expect(() => parseComplianceCaseListView(huge)).toThrow();
  });
  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders %s", (state) => {
    expect(renderToStaticMarkup(<ComplianceCaseState state={state} />)).toContain('role="status"');
  });
});
