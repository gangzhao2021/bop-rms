import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  CompliancePolicyError,
  createCompliancePolicyService,
  createCompliancePolicyVersion,
  type CompliancePolicyOperation,
  type CompliancePolicyPorts,
  type CompliancePolicyVersion,
} from "../index.js";

const id = (n: number) => `018f9991-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policySnapshot: id(4),
  audit: id(5),
  correlation: id(6),
  policy: id(7),
  version: id(8),
  author: id(9),
  reviewer: id(10),
  counsel: id(11),
  second: id(12),
  authority: id(13),
  evidenceMapping: id(14),
  controlMapping: id(15),
  parentVersion: id(16),
  store: id(17),
};
const times = Array.from(
  { length: 10 },
  (_, index) => `2026-08-${String(14 + index).padStart(2, "0")}T10:00:00.000Z`,
);
const time = (index: number) => {
  const value = times[index];
  if (value === undefined) throw new Error("synthetic policy instant missing");
  return value;
};
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(
  observedAt: string,
  storeReference: string | null = null,
  actorReference = ids.actor,
) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "POLICY",
      displayName: "Synthetic Policy Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: time(0),
      updatedAt: time(0),
    }),
    storeReference === null
      ? null
      : createStore({
          storeReference,
          brandReference: ids.brand,
          code: "POLICY-1",
          displayName: "Synthetic Policy Store",
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: time(0),
          updatedAt: time(0),
        }),
    observedAt,
  );
}
function policy(options: Record<string, unknown> = {}): CompliancePolicyVersion {
  return createCompliancePolicyVersion({
    policyReference: ids.policy,
    versionReference: ids.version,
    revision: 1,
    policyVersion: 1,
    scope,
    layer: "Platform",
    parentVersionReference: null,
    kind: "RegulatoryRequirement",
    nameCode: "FOOD_SAFETY_POLICY",
    jurisdictionCode: "CA-ON",
    authorityReference: ids.authority,
    requirementTypeCode: "ALLERGEN_SAFETY",
    strength: "HardRequirement",
    overrideAllowed: false,
    applicableScopeCodes: ["MENU", "ORDERING"],
    timeZone: "America/Toronto",
    effectiveFrom: time(3),
    effectiveTo: null,
    evidenceRequirements: [
      { requirementCode: "SOURCE_EVIDENCE", classificationCode: "RESTRICTED", mandatory: true },
    ],
    monitoringFrequencyHours: "24",
    threshold: { operator: "LessThanOrEqual", decimalValue: "4.0", unitCode: "CELSIUS" },
    retentionDays: "2555",
    escalationRuleCode: "CRITICAL_IMMEDIATE",
    notificationRequirement: "Required",
    legalReviewStatus: "Required",
    evidenceMappings: [
      {
        mappingReference: ids.evidenceMapping,
        requirementCode: "SOURCE_EVIDENCE",
        evidenceTypeCode: "APPROVED_SOURCE",
        ownerDomainCode: "EVIDENCE",
      },
    ],
    controlMappings: [
      {
        mappingReference: ids.controlMapping,
        controlCode: "PUBLISH_BLOCK",
        ownerDomainCode: "CATALOG",
        requiredOutcomeCode: "BLOCKED",
        status: "Validated",
      },
    ],
    status: "Draft",
    authoredByReference: ids.actor,
    reviewedByReference: null,
    counselReviewerReference: null,
    secondApproverReference: null,
    reviewedAt: null,
    publishedAt: null,
    retiredAt: null,
    recordedAt: time(0),
    ...options,
  });
}
function fixture(
  options: {
    readonly parent?: CompliancePolicyVersion;
    readonly deny?: boolean;
    readonly reviewersValid?: boolean;
  } = {},
) {
  let latest: CompliancePolicyVersion | null = null;
  let deny = options.deny ?? false;
  let reviewersValid = options.reviewersValid ?? true;
  const operations = new Map<string, CompliancePolicyOperation>();
  const versions = new Map<string, CompliancePolicyVersion>();
  if (options.parent) versions.set(options.parent.versionReference, options.parent);
  const actions = {
    CreateDraft: "compliance.policy.create",
    ReviseDraft: "compliance.policy.edit",
    SubmitReview: "compliance.policy.review.request",
    ApproveVersion: "compliance.policy.approve",
    PublishVersion: "compliance.policy.publish",
    RetireVersion: "compliance.policy.retire",
  } as const;
  const ports: CompliancePolicyPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        const actorReference = input.command === "ApproveVersion" ? ids.reviewer : ids.actor;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt, input.scope.storeReference, actorReference),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: actions[input.command],
            scopeKind: input.scope.storeReference === null ? "Brand" : "Store",
            policySnapshotReference: ids.policySnapshot,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            ...(input.scope.storeReference === null ? {} : { storeId: input.scope.storeReference }),
            actor: { type: "User", reference: actorReference },
            actionCode: `COMPLIANCE_POLICY_${input.command.toUpperCase()}`,
            targetType: "CompliancePolicy",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_POLICY_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "COMPLIANCE_POLICY",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: (value) => `intent:${value}`, equals: (a, b) => a === b },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadLatest() {
        return latest;
      },
      async loadVersion(reference) {
        return versions.get(reference) ?? null;
      },
      async hasOpenVersion(reference) {
        return [...versions.values()].some(
          (item) =>
            item.policyReference === reference &&
            ["Draft", "InReview", "Approved"].includes(item.status),
        );
      },
      async commit({ operation, expectedRevision }) {
        if ((latest?.revision ?? 0) !== expectedRevision) throw new Error("stale");
        latest = operation.policy;
        versions.set(operation.policy.versionReference, operation.policy);
        operations.set(operation.operationReference, operation);
        return operation;
      },
    },
    reviewers: {
      async validate() {
        return reviewersValid;
      },
    },
  };
  return {
    service: createCompliancePolicyService(ports),
    latest: () => latest,
    operations,
    setDeny(value: boolean) {
      deny = value;
    },
    setReviewersValid(value: boolean) {
      reviewersValid = value;
    },
  };
}
const command = (operation: number, expectedRevision: number, value: CompliancePolicyVersion) => ({
  operationReference: id(operation),
  expectedRevision,
  policy: value,
  purposeCode: "COMPLIANCE_POLICY_ADMINISTRATION",
  occurredAt: value.recordedAt,
});
function revised(
  previous: CompliancePolicyVersion,
  status: CompliancePolicyVersion["status"],
  at: string,
  values: Record<string, unknown> = {},
) {
  return policy({
    ...previous,
    revision: previous.revision + 1,
    status,
    recordedAt: at,
    ...values,
  });
}
async function publish(f: ReturnType<typeof fixture>) {
  const draft = policy();
  await f.service.createDraft(command(30, 0, draft));
  const review = revised(draft, "InReview", time(1));
  await f.service.submitReview(command(31, 1, review));
  const approved = revised(review, "Approved", time(2), {
    legalReviewStatus: "Passed",
    reviewedByReference: ids.reviewer,
    counselReviewerReference: ids.counsel,
    secondApproverReference: ids.second,
    reviewedAt: time(2),
  });
  await f.service.approveVersion(command(32, 2, approved));
  const published = revised(approved, "Published", time(3), { publishedAt: time(3) });
  await f.service.publishVersion(command(33, 3, published));
  return published;
}

describe("WP-2178 Compliance Policy", () => {
  it("publishes an immutable reviewed Version and retires it prospectively without events", async () => {
    const f = fixture();
    const published = await publish(f);
    expect(f.latest()?.status).toBe("Published");
    expect(f.operations.get(id(33))?.events).toEqual([]);
    const retired = revised(published, "Retired", time(4), {
      effectiveTo: time(4),
      retiredAt: time(4),
    });
    await expect(f.service.retireVersion(command(34, 4, retired))).resolves.toMatchObject({
      status: "Applied",
      policy: { status: "Retired", effectiveTo: time(4) },
    });
    expect(f.operations.get(id(33))?.policy.status).toBe("Published");
  });

  it("re-authorizes an idempotent replay after permission revocation", async () => {
    const f = fixture();
    const input = command(40, 0, policy());
    await f.service.createDraft(input);
    f.setDeny(true);
    await expect(f.service.createDraft(input)).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_PERMISSION_DENIED",
    });
  });

  it("rejects a Store rule that weakens its published Brand parent", async () => {
    const parent = policy({
      layer: "Brand",
      parentVersionReference: ids.parentVersion,
      status: "Published",
      legalReviewStatus: "Passed",
      reviewedByReference: ids.reviewer,
      counselReviewerReference: ids.counsel,
      secondApproverReference: ids.second,
      reviewedAt: time(1),
      publishedAt: time(2),
    });
    const f = fixture({ parent });
    const child = policy({
      policyReference: id(50),
      versionReference: id(51),
      scope: { ...scope, storeReference: ids.store },
      layer: "Store",
      parentVersionReference: parent.versionReference,
      strength: "Mandatory",
      authoredByReference: ids.actor,
    });
    await expect(f.service.createDraft(command(53, 0, child))).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_WEAKENING_FORBIDDEN",
    });
  });

  it("blocks publication until every mandatory Evidence and Control mapping is validated", async () => {
    const f = fixture();
    const draft = policy({
      controlMappings: [
        {
          mappingReference: ids.controlMapping,
          controlCode: "PUBLISH_BLOCK",
          ownerDomainCode: "CATALOG",
          requiredOutcomeCode: "BLOCKED",
          status: "Proposed",
        },
      ],
    });
    await f.service.createDraft(command(60, 0, draft));
    const review = revised(draft, "InReview", time(1));
    await f.service.submitReview(command(61, 1, review));
    const approved = revised(review, "Approved", time(2), {
      legalReviewStatus: "Passed",
      reviewedByReference: ids.reviewer,
      counselReviewerReference: ids.counsel,
      secondApproverReference: ids.second,
      reviewedAt: time(2),
    });
    await f.service.approveVersion(command(62, 2, approved));
    const candidate = revised(approved, "Published", time(3), { publishedAt: time(3) });
    await expect(f.service.publishVersion(command(63, 3, candidate))).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_PUBLISH_BLOCKED",
    });
  });

  it("requires independently validated reviewer decisions", async () => {
    const f = fixture({ reviewersValid: false });
    const draft = policy();
    await f.service.createDraft(command(70, 0, draft));
    const review = revised(draft, "InReview", time(1));
    await f.service.submitReview(command(71, 1, review));
    const candidate = revised(review, "Approved", time(2), {
      legalReviewStatus: "Passed",
      reviewedByReference: ids.reviewer,
      counselReviewerReference: ids.counsel,
      secondApproverReference: ids.second,
      reviewedAt: time(2),
    });
    await expect(f.service.approveVersion(command(72, 2, candidate))).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_PUBLISH_BLOCKED",
    });
  });

  it("creates a replacement Version without rewriting the published predecessor", async () => {
    const f = fixture();
    const published = await publish(f);
    const replacement = policy({
      versionReference: id(80),
      revision: 5,
      policyVersion: 2,
      effectiveFrom: time(5),
      recordedAt: time(4),
    });
    await expect(f.service.createDraft(command(81, 4, replacement))).resolves.toMatchObject({
      status: "Applied",
      policy: { policyVersion: 2, status: "Draft" },
    });
    expect(f.operations.get(id(33))?.policy).toEqual(published);
    const retiredPredecessor = policy({
      ...published,
      revision: 6,
      status: "Retired",
      effectiveTo: time(6),
      retiredAt: time(6),
      recordedAt: time(6),
    });
    await expect(
      f.service.retireVersion(command(82, 5, retiredPredecessor)),
    ).resolves.toMatchObject({ policy: { versionReference: ids.version, status: "Retired" } });
    const duplicateDraft = policy({
      versionReference: id(83),
      revision: 7,
      policyVersion: 2,
      effectiveFrom: time(7),
      recordedAt: time(7),
    });
    await expect(f.service.createDraft(command(84, 6, duplicateDraft))).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_LIFECYCLE_CONFLICT",
    });
  });

  it("rejects unknown content, invalid zones, hard overrides and idempotency conflicts", async () => {
    expect(() => createCompliancePolicyVersion({ ...policy(), legalText: "invented" })).toThrow();
    expect(() => policy({ timeZone: "Canada/Not_A_Zone" })).toThrow();
    expect(() => policy({ overrideAllowed: true })).toThrow();
    const f = fixture();
    await f.service.createDraft(command(90, 0, policy()));
    const changed = policy({ retentionDays: "3000" });
    await expect(f.service.createDraft(command(90, 0, changed))).rejects.toBeInstanceOf(
      CompliancePolicyError,
    );
    await expect(f.service.createDraft(command(91, 0, policy()))).rejects.toMatchObject({
      code: "COMPLIANCE_POLICY_VERSION_CONFLICT",
    });
  });
});
