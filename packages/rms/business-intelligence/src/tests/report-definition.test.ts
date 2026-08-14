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
  createReportDefinitionService,
  createReportDefinitionSnapshot,
  createReportScheduleSnapshot,
  parseReportingReference,
  type ReportDefinitionOperationRecord,
  type ReportDefinitionPorts,
  type ReportDefinitionSnapshot,
  type ReportScheduleOperationRecord,
  type ReportScheduleSnapshot,
} from "../index.js";

const id = (n: number) => `018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  author: id(4),
  report: id(5),
  v1: id(6),
  v2: id(7),
  operation: id(8),
  audit: id(9),
  correlation: id(10),
  policy: id(11),
  dataset: id(12),
  metric: id(13),
  validation: id(14),
  approval: id(15),
  review: id(16),
  schedule: id(17),
  scheduleVersion: id(18),
  recipientScope: id(19),
  scheduleOperation: id(20),
};
const at = "2026-08-14T16:00:00.000Z";
const before = "2026-08-14T15:00:00.000Z";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const ref = (value: string) => parseReportingReference(value);

function report(lifecycle: ReportDefinitionSnapshot["lifecycle"], sameAuthor = false) {
  const current = lifecycle === "InReview";
  return createReportDefinitionSnapshot({
    reportReference: ids.report,
    versionReference: current ? ids.v1 : ids.v2,
    stableCode: "DAILY_OPERATIONS",
    scope: { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null },
    aggregateVersion: current ? 2 : 3,
    versionNumber: current ? 2 : 3,
    snapshotDigest: sha(current ? "a" : "b"),
    lifecycle,
    certificationStatus: current ? "InReview" : "Certified",
    reportNameCode: "DAILY_OPERATIONS_NAME",
    purposeCode: "MANAGEMENT_OPERATIONS",
    ownerReference: ids.author,
    datasetVersionReferences: [ids.dataset],
    metricVersionReferences: [ids.metric],
    dimensionCodes: ["BUSINESS_DATE", "STORE"],
    filters: [{ dimensionCode: "STORE", operator: "Equal", valueCodes: ["AUTHORIZED_STORE"] }],
    sorts: [{ fieldCode: "BUSINESS_DATE", direction: "Descending" }],
    visualization: "Table",
    rowLimit: 500,
    defaultTimeRange: "BusinessDate",
    timezone: "America/Toronto",
    dataFreshnessSeconds: 300,
    scopePolicy: "Brand",
    audience: "Manager",
    exportFormats: ["Csv", "Json"],
    exportRowLimit: 500,
    effectiveFrom: "2026-08-01T04:00:00.000Z",
    effectiveUntil: null,
    createdAt: current ? before : at,
    createdByActorReference: current && !sameAuthor ? ids.author : ids.actor,
  });
}

function schedule(): ReportScheduleSnapshot {
  return createReportScheduleSnapshot({
    scheduleReference: ids.schedule,
    scheduleVersionReference: ids.scheduleVersion,
    reportReference: ids.report,
    reportVersionReference: ids.v2,
    scope: { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null },
    versionNumber: 1,
    status: "Active",
    cadence: "Daily",
    localTime: "06:30",
    timezone: "America/Toronto",
    format: "Csv",
    recipientScopeReference: ids.recipientScope,
    createdAt: at,
    createdByActorReference: ids.actor,
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

function fixture(options: { sameActor?: boolean; stale?: boolean } = {}) {
  let aggregate: ReportDefinitionSnapshot | null = report("InReview", options.sameActor);
  let currentSchedule: ReportScheduleSnapshot | null = null;
  const operations = new Map<string, ReportDefinitionOperationRecord>();
  const scheduleOperations = new Map<string, ReportScheduleOperationRecord>();
  const ports: ReportDefinitionPorts = {
    authorization: {
      async authorize(input) {
        const permission =
          input.action === "Publish"
            ? "reporting.definition.certify"
            : input.action === "Schedule"
              ? "reporting.schedule.manage"
              : "reporting.definition.manage";
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permission,
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `REPORTING_${input.action.toUpperCase()}`,
            targetType: "ReportDefinition",
            targetId: ids.report,
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
          scope: createPublishingScope({
            kind: "Brand",
            brandReference: ids.brand as never,
            storeReference: null,
          }),
          result: "Pass",
          checkedAt: before as never,
          validUntil: "2026-08-15T16:00:00.000Z" as never,
          checkCodes: ["REPORT_LINEAGE", "REPORT_PERMISSION", "REPORT_SAMPLE"].map(
            parsePublishingCode,
          ),
        });
      },
      async approve({ snapshot }) {
        return createPublishingApprovalEvidence({
          evidenceReference: parsePublishingReference(ids.approval),
          reviewLifecycleId: parsePublishingReference(ids.review),
          reviewVersion: parsePublishingVersion(1),
          snapshotReference: parsePublishingReference(snapshot.versionReference),
          snapshotDigest: parsePublishingDigest(snapshot.snapshotDigest),
          scope: createPublishingScope({
            kind: "Brand",
            brandReference: ids.brand as never,
            storeReference: null,
          }),
          decision: "Accepted",
          approvedActorReference: parsePublishingReference(ids.actor),
          approvedAt: at as never,
          validUntil: "2026-08-15T16:00:00.000Z" as never,
        });
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async load(reference) {
        if (options.stale && aggregate !== null) return { ...aggregate, aggregateVersion: 9 };
        return aggregate?.reportReference === reference ? aggregate : null;
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
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async loadSchedule(reference) {
        return currentSchedule?.scheduleReference === reference ? currentSchedule : null;
      },
      async resolveScheduleOperation(reference) {
        return scheduleOperations.get(reference) ?? null;
      },
      async commitSchedule(input) {
        currentSchedule = input.record.schedule;
        scheduleOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return { service: createReportDefinitionService(ports), operations, scheduleOperations };
}

describe("Report Definition", () => {
  it("pins only closed Dataset, Metric, dimension, filter and time contracts", () => {
    expect(report("Published")).toMatchObject({ lifecycle: "Published", rowLimit: 500 });
    expect(() =>
      createReportDefinitionSnapshot({
        ...report("Published"),
        metricVersionReferences: ["SELECT * FROM private"],
      }),
    ).toThrowError(expect.objectContaining({ code: "REPORTING_INPUT_INVALID" }));
    expect(() =>
      createReportDefinitionSnapshot({
        ...report("Published"),
        filters: [{ dimensionCode: "UNKNOWN", operator: "Equal", valueCodes: ["X"] }],
      }),
    ).toThrowError(expect.objectContaining({ code: "REPORTING_INPUT_INVALID" }));
  });

  it("publishes only a validated four-eyes revision and replays idempotently", async () => {
    const target = fixture();
    const input = {
      action: "Publish" as const,
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 2,
      candidate: report("Published"),
      occurredAt: at,
    };
    await expect(target.service.execute(input)).resolves.toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Published" },
    });
    expect(target.operations.get(ids.operation)?.event.eventType).toBe("ReportDefinitionPublished");
    await expect(target.service.execute(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });

  it("rejects self-certification and stale Expected Version", async () => {
    const input = {
      action: "Publish" as const,
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 2,
      candidate: report("Published"),
      occurredAt: at,
    };
    await expect(fixture({ sameActor: true }).service.execute(input)).rejects.toMatchObject({
      code: "REPORTING_APPROVAL_REQUIRED",
    });
    await expect(fixture({ stale: true }).service.execute(input)).rejects.toMatchObject({
      code: "REPORTING_VERSION_CONFLICT",
    });
  });

  it("records only version-pinned, scope-safe schedules without executing a run", async () => {
    const target = fixture();
    await target.service.execute({
      action: "Publish",
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 2,
      candidate: report("Published"),
      occurredAt: at,
    });
    const input = {
      operationReference: ref(ids.scheduleOperation),
      expectedScheduleVersion: null,
      candidate: schedule(),
      occurredAt: at,
    };
    await expect(target.service.schedule(input)).resolves.toMatchObject({
      status: "Applied",
      schedule: { cadence: "Daily", format: "Csv" },
    });
    expect(target.scheduleOperations.get(ids.scheduleOperation)?.event.eventType).toBe(
      "ReportScheduleVersionRecorded",
    );
    await expect(target.service.schedule(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });
});
