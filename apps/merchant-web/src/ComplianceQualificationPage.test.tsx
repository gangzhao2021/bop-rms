import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComplianceQualification,
  ComplianceQualificationState,
} from "./ComplianceQualificationPage.js";
import { parseComplianceQualificationView } from "./compliance-qualification-page.js";
const ref = (value: string) => `018f9961-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T19:00:00.000Z";
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic qualification item missing");
  return value;
};
const view = () => ({
  screenId: "CMP-QUALIFICATION",
  queryName: "compliance_qualification_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayAddVerifiedRecord: true,
    mayReview: true,
    maySuspendEligibility: true,
    mayRequestRenewal: true,
  },
  filters: {
    subjectReference: null,
    subjectKind: null,
    qualificationTypeCode: null,
    status: null,
    expiryDisposition: null,
    storeReference: null,
    requirementVersionReference: null,
  },
  records: [
    {
      qualificationReference: ref("1"),
      revision: 2,
      storeReference: null,
      subjectKind: "Supplier",
      subjectReference: ref("2"),
      subjectCode: "SUPPLIER_100",
      owner: "Procurement",
      ownerRecordReference: ref("3"),
      ownerRecordVersion: 4,
      qualificationTypeCode: "FOOD_DISTRIBUTOR_LICENSE",
      jurisdictionCode: "CA_ON",
      issuerReference: ref("4"),
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      status: "Expiring",
      verificationResult: "Verified",
      verifiedAt: "2026-01-02T00:00:00.000Z",
      verifiedByReference: ref("5"),
      evidenceReference: ref("6"),
      requirementVersionReference: ref("7"),
      eligibilityOutcomeReference: null,
      renewalTaskReference: null,
      severity: "Critical",
    },
  ],
});
describe("WP-2174 qualification screen", () => {
  it("renders safe qualification summaries and owner-bound actions", () => {
    const html = renderToStaticMarkup(
      <ComplianceQualification view={parseComplianceQualificationView(view())} />,
    );
    expect(html).toContain("CMP-QUALIFICATION");
    expect(html).toContain("Supplier · SUPPLIER_100");
    expect(html).toContain("source owner Procurement");
    expect(html).toContain("Suspend eligibility through owner");
    expect(html).toContain("Request renewal Task");
    expect(html).not.toContain("PRIVATE-CERTIFICATE-100");
  });
  it("rejects owner contradictions, restricted extras and unbounded results", () => {
    const wrongOwner = view();
    wrongOwner.records[0] = { ...first(wrongOwner.records), owner: "Compliance" };
    expect(() => parseComplianceQualificationView(wrongOwner)).toThrow();
    expect(() =>
      parseComplianceQualificationView({ ...view(), certificateNumber: "PRIVATE" }),
    ).toThrow();
    const huge = view();
    huge.records = Array.from({ length: 501 }, () => first(view().records) as never);
    expect(() => parseComplianceQualificationView(huge)).toThrow();
  });
  it("rejects contradictory verification and duplicate stable records", () => {
    const pending = view();
    pending.records[0] = {
      ...first(pending.records),
      verificationResult: "Pending",
      verifiedAt: null,
      verifiedByReference: null,
    } as never;
    expect(() => parseComplianceQualificationView(pending)).toThrow();
    const duplicate = view();
    duplicate.records = [...duplicate.records, first(duplicate.records) as never];
    expect(() => parseComplianceQualificationView(duplicate)).toThrow();
  });
  it("hides mutation controls when permission is absent", () => {
    const denied = view();
    denied.permissions = {
      mayAddVerifiedRecord: false,
      mayReview: false,
      maySuspendEligibility: false,
      mayRequestRenewal: false,
    };
    const html = renderToStaticMarkup(
      <ComplianceQualification view={parseComplianceQualificationView(denied)} />,
    );
    expect(html).not.toMatch(/Add verified|Review immutable|Suspend eligibility|Request renewal/);
  });
  it("renders an explicit empty state", () => {
    const empty = view();
    empty.records = [];
    expect(
      renderToStaticMarkup(
        <ComplianceQualification view={parseComplianceQualificationView(empty)} />,
      ),
    ).toContain("No Qualification Records");
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
    expect(renderToStaticMarkup(<ComplianceQualificationState state={state} />)).toContain(
      'role="status"',
    );
  });
});
