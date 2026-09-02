import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComplianceAllergenIncidentState,
  ComplianceAllergenReview,
  ComplianceIncident,
} from "./ComplianceAllergenIncidentPages.js";
import {
  parseComplianceAllergenReviewView,
  parseComplianceIncidentView,
} from "./compliance-allergen-incident-pages.js";
const ref = (value: string) => `018f9971-0000-7000-8000-${value.padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const at = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T19:00:00.000Z";
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic food safety item missing");
  return value;
};
const allergenView = () => ({
  screenId: "CMP-ALLERGEN-REVIEW",
  queryName: "compliance_allergen_review_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayReview: true,
    mayApprove: true,
    mayInvalidate: true,
    mayEnforceBlocks: true,
    mayOpenIncident: true,
  },
  filters: {
    subjectReference: null,
    subjectKind: null,
    allergenReference: null,
    reviewStatus: null,
    evidenceStatus: null,
    storeReference: null,
  },
  records: [
    {
      reviewReference: ref("1"),
      revision: 2,
      subjectKind: "SellablePath",
      subjectReference: ref("2"),
      subjectCode: "SELLABLE_PATH_100",
      configurationDigest: hash("a"),
      allergenPolicyVersionReference: ref("3"),
      recipeVersionReferenceCount: "2",
      assertions: [
        {
          allergenReference: ref("4"),
          classification: "Contains",
          evidenceStatus: "Current",
          validUntil: "2027-01-01T00:00:00.000Z",
        },
      ],
      reviewStatus: "Rejected",
      reviewerReference: ref("5"),
      reviewedAt: before,
      severity: "Critical",
      requirementVersionReference: ref("6"),
      publicationBlockOutcomeReference: null,
      paymentBlockOutcomeReference: null,
      allergenFreeClaim: false,
    },
  ],
});
const incidentView = () => ({
  screenId: "CMP-INCIDENT",
  queryName: "compliance_incident_detail_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Partial",
  permissions: {
    mayEnforceBlocks: true,
    mayAssign: true,
    mayRecordNotificationDecision: true,
    mayLinkCases: true,
    mayCloseAfterVerification: true,
  },
  incident: {
    incidentReference: ref("10"),
    revision: 1,
    caseReference: ref("11"),
    incidentType: "ALLERGEN_EXPOSURE",
    severity: "Critical",
    status: "Reported",
    occurredAt: before,
    reportedAt: at,
    productReference: ref("12"),
    orderReference: ref("13"),
    lotReference: null,
    employeeScopePresent: false,
    restrictedSnapshotReferenceCount: "3",
    evidenceReferenceCount: "2",
    containmentOutcomeReferences: [],
    notificationReference: null,
    investigationReference: null,
    outcomeCode: null,
    verificationReference: null,
    availabilityBlockOutcomeReference: null,
    paymentBlockOutcomeReference: null,
    requirementVersionReference: ref("14"),
    accessClass: "Restricted",
  },
});
describe("WP-2175 Allergen and Incident screens", () => {
  it("renders controlled allergen truth and owner-block actions", () => {
    const html = renderToStaticMarkup(
      <ComplianceAllergenReview view={parseComplianceAllergenReviewView(allergenView())} />,
    );
    expect(html).toContain("CMP-ALLERGEN-REVIEW");
    expect(html).toContain("Contains");
    expect(html).toContain("Enforce owner blocks");
    expect(html).toContain("Open Food Safety Incident");
  });
  it("rejects false absence, unsafe approval, restricted extras, and unbounded rows", () => {
    const claim = allergenView();
    claim.records[0] = { ...first(claim.records), allergenFreeClaim: true };
    expect(() => parseComplianceAllergenReviewView(claim)).toThrow();
    const unsafe = allergenView();
    unsafe.records[0] = {
      ...first(unsafe.records),
      reviewStatus: "Approved",
      assertions: [{ ...first(first(unsafe.records).assertions), evidenceStatus: "Conflicting" }],
    };
    expect(() => parseComplianceAllergenReviewView(unsafe)).toThrow();
    expect(() =>
      parseComplianceAllergenReviewView({ ...allergenView(), customerNote: "fever" }),
    ).toThrow();
    const huge = allergenView();
    huge.records = Array.from({ length: 501 }, () => first(allergenView().records) as never);
    expect(() => parseComplianceAllergenReviewView(huge)).toThrow();
  });
  it("hides allergen mutations without exact permissions", () => {
    const denied = allergenView();
    denied.permissions = {
      mayReview: false,
      mayApprove: false,
      mayInvalidate: false,
      mayEnforceBlocks: false,
      mayOpenIncident: false,
    };
    const html = renderToStaticMarkup(
      <ComplianceAllergenReview view={parseComplianceAllergenReviewView(denied)} />,
    );
    expect(html).not.toMatch(/Review exact|Approve exact|Invalidate on|Enforce owner|Open Food/);
  });
  it("renders an explicit allergen empty state", () => {
    const empty = allergenView();
    empty.records = [];
    expect(
      renderToStaticMarkup(
        <ComplianceAllergenReview view={parseComplianceAllergenReviewView(empty)} />,
      ),
    ).toContain("No Allergen Reviews");
  });
  it("renders restricted Incident summaries without medical or Payment content", () => {
    const html = renderToStaticMarkup(
      <ComplianceIncident view={parseComplianceIncidentView(incidentView())} />,
    );
    expect(html).toContain("CMP-INCIDENT");
    expect(html).toContain("Restricted snapshots 3");
    expect(html).toContain("Trigger owner safety blocks");
    expect(html).not.toContain("fever");
  });
  it("rejects half-linked blocks, premature closure, raw narrative, and invalid counts", () => {
    const half = incidentView();
    half.incident = {
      ...half.incident,
      availabilityBlockOutcomeReference: ref("20"),
    } as never;
    expect(() => parseComplianceIncidentView(half)).toThrow();
    const closed = incidentView();
    closed.incident.status = "Closed";
    expect(() => parseComplianceIncidentView(closed)).toThrow();
    expect(() =>
      parseComplianceIncidentView({ ...incidentView(), symptoms: "restricted" }),
    ).toThrow();
    const invalid = incidentView();
    invalid.incident.evidenceReferenceCount = "-1";
    expect(() => parseComplianceIncidentView(invalid)).toThrow();
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
    expect(renderToStaticMarkup(<ComplianceAllergenIncidentState state={state} />)).toContain(
      'role="status"',
    );
  });
});
