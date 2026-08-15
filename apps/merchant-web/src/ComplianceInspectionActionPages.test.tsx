import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComplianceCorrectiveActionList,
  ComplianceInspectionActionState,
  ComplianceInspectionList,
} from "./ComplianceInspectionActionPages.js";
import {
  parseComplianceCorrectiveActionView,
  parseComplianceInspectionView,
} from "./compliance-inspection-action-pages.js";

const ref = (value: string) => `018f9941-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T19:00:00.000Z";
const later = "2026-08-15T20:00:00.000Z";
const inspectionPermissions = {
  maySchedule: true,
  mayRecord: true,
  mayAddFinding: true,
  mayFinalize: true,
  mayCorrect: true,
};
const actionPermissions = {
  mayAssign: true,
  mayStart: true,
  maySubmitEvidence: true,
  mayRequestVerification: true,
  mayVerify: true,
  mayReject: true,
  mayClose: true,
};
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic Compliance item missing");
  return value;
};
const inspection = () => ({
  screenId: "CMP-INSPECTION",
  queryName: "compliance_inspection_list_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: inspectionPermissions,
  filters: {
    inspectionReference: null,
    inspectionType: null,
    storeReference: null,
    status: null,
    dateDisposition: null,
    findingSeverity: null,
  },
  inspections: [
    {
      inspectionReference: ref("1"),
      caseReference: ref("2"),
      inspectionType: "RegulatoryInspection",
      status: "Finalized",
      storeReference: null,
      scopeCode: "STORE_SCOPE",
      inspectorReference: ref("3"),
      authorityReference: ref("4"),
      scheduledAt: before,
      startedAt: before,
      completedAt: at,
      checklistVersionReference: ref("5"),
      requirementVersionReference: ref("6"),
      findingCount: "2",
      highestSeverity: "Critical",
      evidenceReferenceCount: "3",
      recordVersion: "1",
    },
  ],
});
const actions = () => ({
  screenId: "CMP-CORRECTIVE-ACTION",
  queryName: "compliance_corrective_action_list_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: actionPermissions,
  filters: {
    actionReference: null,
    status: null,
    ownerReference: null,
    dueDisposition: null,
    severity: null,
    storeReference: null,
  },
  actions: [
    {
      actionReference: ref("7"),
      caseReference: ref("2"),
      findingReference: ref("8"),
      storeReference: null,
      severity: "Critical",
      requiredActionCode: "QUARANTINE_PRODUCT",
      ownerReference: ref("9"),
      dueAt: later,
      dueTimezone: "America/Toronto",
      priority: "Critical",
      status: "Completed",
      completionEvidenceCount: "2",
      ownerOutcomeReference: ref("10"),
      verifierReference: null,
      verificationResult: null,
      independenceRequired: true,
      overdue: false,
      followUpTaskReference: null,
      recordVersion: "3",
    },
  ],
});

describe("WP-2172 Inspection and Corrective Action screens", () => {
  it("renders pinned Inspection fields and append-only correction action", () => {
    const html = renderToStaticMarkup(
      <ComplianceInspectionList view={parseComplianceInspectionView(inspection())} />,
    );
    expect(html).toContain("Regulatory Inspection");
    expect(html).toContain("Append correction");
    expect(html).toContain("Findings 2");
    expect(html).not.toContain("Finalize immutable record");
  });

  it("renders completion separately from independent Verification", () => {
    const html = renderToStaticMarkup(
      <ComplianceCorrectiveActionList view={parseComplianceCorrectiveActionView(actions())} />,
    );
    expect(html).toContain("Completed");
    expect(html).toContain("Not verified");
    expect(html).toContain("Independent verifier required");
    expect(html).toContain("Request verification");
    expect(html).not.toContain(">Close<");
  });

  it("rejects restricted, contradictory, and unbounded Inspection payloads", () => {
    expect(() => parseComplianceInspectionView({ ...inspection(), rawEvidence: [] })).toThrow();
    const invalid = inspection();
    invalid.inspections[0] = {
      ...first(invalid.inspections),
      completedAt: null as never,
    };
    expect(() => parseComplianceInspectionView(invalid)).toThrow();
    const huge = inspection();
    huge.inspections = Array.from({ length: 501 }, () => first(inspection().inspections));
    expect(() => parseComplianceInspectionView(huge)).toThrow();
  });

  it("rejects fabricated Verification and unsafe extra Action content", () => {
    const invalid = actions();
    invalid.actions[0] = {
      ...first(invalid.actions),
      verificationResult: "Passed" as never,
      verifierReference: null,
    };
    expect(() => parseComplianceCorrectiveActionView(invalid)).toThrow();
    expect(() =>
      parseComplianceCorrectiveActionView({ ...actions(), findingNarrative: "restricted" }),
    ).toThrow();
  });

  it("keeps permission-gated controls absent when authorization is false", () => {
    const view = inspection();
    view.permissions = {
      maySchedule: false,
      mayRecord: false,
      mayAddFinding: false,
      mayFinalize: false,
      mayCorrect: false,
    };
    const html = renderToStaticMarkup(
      <ComplianceInspectionList view={parseComplianceInspectionView(view)} />,
    );
    expect(html).not.toMatch(/Schedule Inspection|Add Finding|Append correction/);
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
    expect(renderToStaticMarkup(<ComplianceInspectionActionState state={state} />)).toContain(
      'role="status"',
    );
  });
});
