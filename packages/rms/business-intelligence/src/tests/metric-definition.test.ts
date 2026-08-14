import {
  createPublishingApprovalEvidence,
  createPublishingScope,
  createPublishingValidationEvidence,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingReference,
  parsePublishingVersion,
} from "@bop/publishing";
import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createMetricDefinitionService,
  createMetricDefinitionSnapshot,
  parseReportingReference,
  type MetricDefinitionOperationRecord,
  type MetricDefinitionPorts,
  type MetricDefinitionSnapshot,
} from "../index.js";

const id = (n: number) => `018f9900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  author: id(4),
  businessApprover: id(5),
  dataApprover: id(6),
  metric: id(7),
  version1: id(8),
  version2: id(9),
  operation: id(10),
  audit: id(11),
  correlation: id(12),
  policy: id(13),
  formula: id(14),
  fact: id(15),
  dataset: id(16),
  transform: id(17),
  query: id(18),
  validation: id(19),
  businessEvidence: id(20),
  dataEvidence: id(21),
  businessReview: id(22),
  dataReview: id(23),
  replacement: id(24),
};
const at = "2026-08-14T18:00:00.000Z";
const before = "2026-08-14T17:00:00.000Z";
const sha = (character: string) => `sha256:${character.repeat(64)}`;

function metric(
  lifecycle: MetricDefinitionSnapshot["lifecycle"],
  options: { version?: number; replacement?: string | null; actor?: string } = {},
) {
  const version = options.version ?? (lifecycle === "InReview" ? 1 : 2);
  return createMetricDefinitionSnapshot({
    metricReference: ids.metric,
    versionReference: version === 1 ? ids.version1 : ids.version2,
    stableCode: "NET_SALES",
    scope: { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null },
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: sha(version === 1 ? "a" : "b"),
    lifecycle,
    certificationStatus:
      lifecycle === "InReview"
        ? "InReview"
        : lifecycle === "Certified"
          ? "Certified"
          : lifecycle === "Deprecated" || lifecycle === "Archived"
            ? "Deprecated"
            : "Draft",
    ownerDomainCode: "ORDERING",
    businessOwnerReference: ids.businessApprover,
    displayNameCode: "NET_SALES_NAME",
    businessDefinitionCode: "NET_SALES_DEFINITION_V1",
    formulaReference: ids.formula,
    baseFactReference: ids.fact,
    grainCode: "STORE_BUSINESS_DATE_CURRENCY",
    allowedDimensionCodes: ["STORE", "BUSINESS_DATE", "CURRENCY"],
    requiredFilterCodes: ["STORE"],
    timeSemantics: "BusinessDate",
    timezone: "America/Toronto",
    currencySemantics: "OriginalCurrency",
    currencyCode: null,
    inclusionRuleCodes: ["COMPLETED_ORDER"],
    exclusionRuleCodes: ["VOIDED_ORDER"],
    nullPolicy: "Fail",
    lineage: {
      datasetVersionReferences: [ids.dataset],
      transformationVersionReferences: [ids.transform],
      queryExpressionReference: ids.query,
      dependencyMetricVersionReferences: [],
      lastSuccessfulBuildAt: before,
      dataFreshnessSeconds: 300,
      dataQualityStatus: "Pass",
    },
    effectiveFrom: "2026-08-01T04:00:00.000Z",
    effectiveUntil: null,
    replacementMetricReference: options.replacement ?? null,
    createdAt: version === 1 ? before : at,
    createdByActorReference: options.actor ?? (version === 1 ? ids.author : ids.actor),
  });
}

function tenant() {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "REPORTING",
      displayName: "Synthetic Reporting Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: before,
      updatedAt: before,
    }),
    null,
    at,
  );
}
function hash(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
function scope() {
  return createPublishingScope({
    kind: "Brand",
    brandReference: ids.brand as never,
    storeReference: null,
  });
}

function fixture(
  options: {
    sameApprover?: boolean;
    replacementCertified?: boolean;
    initialLifecycle?: MetricDefinitionSnapshot["lifecycle"];
  } = {},
) {
  let aggregate: MetricDefinitionSnapshot | null = metric(options.initialLifecycle ?? "InReview", {
    version: 1,
    actor: ids.author,
  });
  const operations = new Map<string, MetricDefinitionOperationRecord>();
  const ports: MetricDefinitionPorts = {
    authorization: {
      async authorize(input) {
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action:
              input.action === "Certify" ? "reporting.metric.certify" : "reporting.metric.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `REPORTING_METRIC_${input.action.toUpperCase()}`,
            targetType: "MetricDefinition",
            targetId: ids.metric,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    publishing: {
      async validate(snapshot) {
        return createPublishingValidationEvidence({
          evidenceReference: parsePublishingReference(ids.validation),
          snapshotReference: parsePublishingReference(snapshot.versionReference),
          snapshotDigest: parsePublishingDigest(snapshot.snapshotDigest),
          scope: scope(),
          result: "Pass",
          checkedAt: before as never,
          validUntil: "2026-08-15T18:00:00.000Z" as never,
          checkCodes: ["METRIC_SEMANTICS", "METRIC_LINEAGE", "METRIC_IMPACT"].map(
            parsePublishingCode,
          ),
        });
      },
      async approve({ role, snapshot }) {
        const business = role === "BusinessOwner";
        return createPublishingApprovalEvidence({
          evidenceReference: parsePublishingReference(
            business
              ? ids.businessEvidence
              : options.sameApprover
                ? ids.businessEvidence
                : ids.dataEvidence,
          ),
          reviewLifecycleId: parsePublishingReference(
            business ? ids.businessReview : ids.dataReview,
          ),
          reviewVersion: parsePublishingVersion(1),
          snapshotReference: parsePublishingReference(snapshot.versionReference),
          snapshotDigest: parsePublishingDigest(snapshot.snapshotDigest),
          scope: scope(),
          decision: "Accepted",
          approvedActorReference: parsePublishingReference(
            business || options.sameApprover ? ids.businessApprover : ids.dataApprover,
          ),
          approvedAt: at as never,
          validUntil: "2026-08-15T18:00:00.000Z" as never,
        });
      },
    },
    metrics: {
      async replacementIsCertified() {
        return options.replacementCertified ?? true;
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async load(reference) {
        return aggregate?.metricReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return true;
      },
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async commit(input) {
        if (aggregate?.aggregateVersion !== input.expectedAggregateVersion)
          throw new Error("stale");
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return { service: createMetricDefinitionService(ports), operations };
}

describe("Metric Definition contract", () => {
  it("accepts only closed semantic and lineage references", () => {
    const valid = metric("Certified");
    expect(valid.lifecycle).toBe("Certified");
    expect(() =>
      createMetricDefinitionSnapshot({ ...valid, sql: "select * from private_table" }),
    ).toThrow("METRIC_DEFINITION_INPUT_INVALID");
    expect(() =>
      createMetricDefinitionSnapshot({ ...valid, formulaReference: "SUM(order.total)" }),
    ).toThrow();
  });

  it("certifies only with current validation and distinct Business/Data Owner approvals", async () => {
    const { service, operations } = fixture();
    const candidate = metric("Certified", { actor: ids.actor });
    const result = await service.execute({
      action: "Certify",
      operationReference: parseReportingReference(ids.operation),
      expectedAggregateVersion: 1,
      candidate,
      occurredAt: at,
    });
    expect(result.aggregate.lifecycle).toBe("Certified");
    expect(operations.get(ids.operation)?.events.map((event) => event.eventType)).toEqual([
      "MetricDefinitionPublished",
      "MetricCertified",
    ]);
  });

  it("rejects approval-role collapse and preserves idempotency", async () => {
    const collapsed = fixture({ sameApprover: true });
    const input = {
      action: "Certify" as const,
      operationReference: parseReportingReference(ids.operation),
      expectedAggregateVersion: 1,
      candidate: metric("Certified", { actor: ids.actor }),
      occurredAt: at,
    };
    await expect(collapsed.service.execute(input)).rejects.toMatchObject({
      code: "METRIC_APPROVAL_REQUIRED",
    });
    const valid = fixture();
    await valid.service.execute(input);
    await expect(valid.service.execute(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
  });

  it("fails closed when a deprecation replacement is not certified", async () => {
    const { service } = fixture({
      replacementCertified: false,
      initialLifecycle: "Certified",
    });
    await expect(
      service.execute({
        action: "Deprecate",
        operationReference: parseReportingReference(ids.operation),
        expectedAggregateVersion: 1,
        candidate: metric("Deprecated", {
          version: 2,
          replacement: ids.replacement,
          actor: ids.actor,
        }),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "METRIC_REPLACEMENT_INVALID" });
  });
});
