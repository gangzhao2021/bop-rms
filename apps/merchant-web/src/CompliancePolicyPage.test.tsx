import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompliancePolicies, CompliancePolicyState } from "./CompliancePolicyPage.js";
import { parseCompliancePolicyView } from "./compliance-policy-page.js";

const ref = (value: string) => `018f9992-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const before = "2026-08-15T09:00:00.000Z";
const first = <T,>(items: readonly T[]) => {
  const item = items[0];
  if (item === undefined) throw new Error("synthetic policy missing");
  return item;
};
const view = () => ({
  screenId: "CMP-POLICY-EDITOR",
  queryName: "compliance_policy_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayCreateRevision: true,
    mayMapControl: true,
    mayRequestReview: true,
    mayApprove: true,
    mayPublish: true,
    mayRetire: true,
  },
  filters: {
    nameCode: null,
    requirementTypeCode: null,
    jurisdictionCode: "CA-ON",
    layer: null,
    status: null,
    effectiveDisposition: "Upcoming",
  },
  policies: [
    {
      policyReference: ref("1"),
      versionReference: ref("2"),
      revision: 1,
      policyVersion: 1,
      storeReference: null,
      layer: "Platform",
      parentVersionReference: null,
      kind: "RegulatoryRequirement",
      nameCode: "ALLERGEN_SAFETY",
      jurisdictionCode: "CA-ON",
      authorityReference: ref("3"),
      requirementTypeCode: "FOOD_SAFETY",
      strength: "HardRequirement",
      overrideAllowed: false,
      applicableScopeCodes: ["MENU", "ORDERING"],
      timeZone: "America/Toronto",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      monitoringFrequencyHours: "24",
      threshold: {
        operator: "LessThanOrEqual",
        decimalValue: "4.0",
        unitCode: "CELSIUS",
      },
      retentionDays: "2555",
      escalationRuleCode: "CRITICAL_IMMEDIATE",
      notificationRequirement: "Required",
      legalReviewStatus: "Required",
      status: "Draft",
      evidenceRequirements: [
        {
          requirementCode: "SOURCE_EVIDENCE",
          classificationCode: "RESTRICTED",
          mandatory: true,
          mappingReference: ref("4"),
          ownerDomainCode: "EVIDENCE",
        },
      ],
      controlMappings: [
        {
          mappingReference: ref("5"),
          controlCode: "PUBLISH_BLOCK",
          ownerDomainCode: "CATALOG",
          requiredOutcomeCode: "BLOCKED",
          status: "Validated",
        },
      ],
      authoredByReference: ref("6"),
      reviewedByReference: null,
      counselReviewerReference: null,
      secondApproverReference: null,
      reviewedAt: null,
      publishedAt: null,
      retiredAt: null,
    },
  ],
});

describe("WP-2178 Compliance Policy screens", () => {
  it("renders safe policy, Evidence and owner-Control mappings", () => {
    const html = renderToStaticMarkup(
      <CompliancePolicies view={parseCompliancePolicyView(view())} />,
    );
    expect(html).toContain("CMP-POLICY-EDITOR");
    expect(html).toContain("ALLERGEN SAFETY");
    expect(html).toContain("Evidence requirements 1");
    expect(html).toContain("Controls 1");
    expect(html).toContain("Map Evidence / Controls");
    expect(html).toContain("Request review");
    expect(html).not.toContain("regulatory legal prose");
  });

  it("enforces editor cardinality and bounded unique Versions", () => {
    const none = view();
    none.policies = [];
    expect(() => parseCompliancePolicyView(none)).toThrow();
    const duplicate = view();
    duplicate.screenId = "CMP-POLICY-LIST";
    duplicate.policies = [first(duplicate.policies), first(duplicate.policies)];
    expect(() => parseCompliancePolicyView(duplicate)).toThrow();
    const huge = view();
    huge.screenId = "CMP-POLICY-LIST";
    huge.policies = Array.from({ length: 501 }, () => first(view().policies));
    expect(() => parseCompliancePolicyView(huge)).toThrow();
  });

  it("rejects weakening contradictions and restricted extras", () => {
    const weakening = view();
    weakening.policies[0] = { ...first(weakening.policies), overrideAllowed: true };
    expect(() => parseCompliancePolicyView(weakening)).toThrow();
    expect(() =>
      parseCompliancePolicyView({ ...view(), legalText: "regulatory legal prose" }),
    ).toThrow();
    const wrongLayer = view();
    wrongLayer.policies[0] = {
      ...first(wrongLayer.policies),
      layer: "Store",
      storeReference: null,
    };
    expect(() => parseCompliancePolicyView(wrongLayer)).toThrow();
  });

  it("rejects malformed time, decimal and Evidence mapping shapes", () => {
    const badZone = view();
    badZone.policies[0] = { ...first(badZone.policies), timeZone: "Canada/Unknown" };
    expect(() => parseCompliancePolicyView(badZone)).toThrow();
    const badDecimal = view();
    badDecimal.policies[0] = {
      ...first(badDecimal.policies),
      threshold: { ...first(badDecimal.policies).threshold, decimalValue: "NaN" },
    };
    expect(() => parseCompliancePolicyView(badDecimal)).toThrow();
    const dangling = view();
    dangling.policies[0] = {
      ...first(dangling.policies),
      evidenceRequirements: [
        {
          ...first(first(dangling.policies).evidenceRequirements),
          ownerDomainCode: null as never,
        },
      ],
    };
    expect(() => parseCompliancePolicyView(dangling)).toThrow();
  });

  it("shows only lifecycle- and permission-authorized actions", () => {
    const denied = view();
    denied.permissions = {
      mayCreateRevision: false,
      mayMapControl: false,
      mayRequestReview: false,
      mayApprove: false,
      mayPublish: false,
      mayRetire: false,
    };
    const html = renderToStaticMarkup(
      <CompliancePolicies view={parseCompliancePolicyView(denied)} />,
    );
    expect(html).not.toContain("<button>");
  });

  it("renders the list empty state", () => {
    const empty = view();
    empty.screenId = "CMP-POLICY-LIST";
    empty.policies = [];
    expect(
      renderToStaticMarkup(<CompliancePolicies view={parseCompliancePolicyView(empty)} />),
    ).toContain("No Compliance Policies");
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
    expect(renderToStaticMarkup(<CompliancePolicyState state={state} />)).toContain(
      'role="status"',
    );
  });
});
