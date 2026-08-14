import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createReportArtifactRevisionSnapshot,
  createReportArtifactRevocationSnapshot,
  createReportDefinitionSnapshot,
  createReportRunService,
  createReportRunSnapshot,
  createReportRunStateSnapshot,
  parseReportingReference,
  ReportRunError,
  type ReportArtifactRevisionSnapshot,
  type ReportArtifactRevocationSnapshot,
  type ReportRunOperationRecord,
  type ReportRunPorts,
  type ReportRunSnapshot,
  type ReportRunStateSnapshot,
} from "../index.js";

const id = (n: number) => `018f9810-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  report: id(7),
  reportVersion: id(8),
  metric: id(9),
  dataset: id(10),
  run: id(11),
  state1: id(12),
  state2: id(13),
  state3: id(14),
  operation: id(15),
  operation2: id(16),
  operation3: id(17),
  rerun: id(18),
  rerunState: id(19),
  rerunOperation: id(20),
  artifact: id(21),
  revision: id(22),
  asset: id(23),
  artifactOperation: id(24),
  revocation: id(25),
  revokeOperation: id(26),
  downloadOperation: id(27),
};
const before = "2026-08-14T15:00:00.000Z";
const at = "2026-08-14T16:00:00.000Z";
const later = "2026-08-14T16:01:00.000Z";
const completeAt = "2026-08-14T16:02:00.000Z";
const expires = "2026-08-15T16:02:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const ref = (value: string) => parseReportingReference(value);

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
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
const definition = createReportDefinitionSnapshot({
  reportReference: ids.report,
  versionReference: ids.reportVersion,
  stableCode: "DAILY_OPERATIONS",
  scope,
  aggregateVersion: 3,
  versionNumber: 3,
  snapshotDigest: digest("a"),
  lifecycle: "Published",
  certificationStatus: "Certified",
  reportNameCode: "DAILY_OPERATIONS",
  purposeCode: "MANAGEMENT_OPERATIONS",
  ownerReference: ids.actor,
  datasetVersionReferences: [ids.dataset],
  metricVersionReferences: [ids.metric],
  dimensionCodes: ["BUSINESS_DATE"],
  filters: [],
  sorts: [],
  visualization: "Table",
  rowLimit: 500,
  defaultTimeRange: "BusinessDate",
  timezone: "America/Toronto",
  dataFreshnessSeconds: 300,
  scopePolicy: "Brand",
  audience: "Manager",
  exportFormats: ["Csv"],
  exportRowLimit: 500,
  effectiveFrom: before,
  effectiveUntil: null,
  createdAt: before,
  createdByActorReference: ids.actor,
});
function run(reference = ids.run, rerunOf: string | null = null): ReportRunSnapshot {
  return createReportRunSnapshot({
    runReference: reference,
    reportReference: ids.report,
    reportVersionReference: ids.reportVersion,
    metricVersionReferences: [ids.metric],
    scope,
    parameterSnapshotDigest: digest("b"),
    triggerKind: "Manual",
    scheduleVersionReference: null,
    triggeredByActorReference: ids.actor,
    rerunOfRunReference: rerunOf,
    queuedAt: at,
  });
}
function state(
  reference: string,
  sequence: number,
  status: ReportRunStateSnapshot["status"],
  occurredAt: string,
): ReportRunStateSnapshot {
  const completed = status === "Completed";
  return createReportRunStateSnapshot({
    stateReference: reference,
    runReference: ids.run,
    sequence,
    status,
    occurredAt,
    actorReference: ids.actor,
    dataAsOf: completed ? at : null,
    projectionCheckpoint: completed ? "WAREHOUSE_42" : null,
    generatedAt: completed ? occurredAt : null,
    durationMilliseconds: completed ? 120_000 : null,
    rowCount: completed ? 42 : null,
    summaryDigest: completed ? digest("c") : null,
    errorCode: null,
  });
}

function fixture() {
  const runs = new Map<string, ReportRunSnapshot>();
  const states = new Map<string, ReportRunStateSnapshot>();
  const operations = new Map<string, ReportRunOperationRecord>();
  const artifacts = new Map<string, ReportArtifactRevisionSnapshot>();
  const revisions = new Map<string, ReportArtifactRevisionSnapshot>();
  const revocations = new Map<string, ReportArtifactRevocationSnapshot>();
  const ports: ReportRunPorts = {
    authorization: {
      async authorize(input) {
        const permission =
          input.action === "Queue" || input.action === "Rerun"
            ? "reporting.run.execute"
            : input.action === "Transition"
              ? "reporting.run.operate"
              : input.action === "DownloadArtifact"
                ? "reporting.artifact.download"
                : "reporting.artifact.manage";
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
            actionCode: `REPORT_RUN_${input.action.toUpperCase()}`,
            targetType: input.action.includes("Artifact") ? "ReportArtifact" : "ReportRun",
            targetId: input.targetReference,
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
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async loadReportDefinition(reference) {
        return reference === ref(ids.report) ? definition : null;
      },
      async loadRun(reference) {
        return runs.get(reference) ?? null;
      },
      async loadLatestState(reference) {
        return states.get(reference) ?? null;
      },
      async loadArtifact(reference) {
        return artifacts.get(reference) ?? null;
      },
      async loadArtifactRevision(reference) {
        return revisions.get(reference) ?? null;
      },
      async loadArtifactRevocation(reference) {
        return revocations.get(reference) ?? null;
      },
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async commitRun({ record }) {
        const value = record.result;
        if (value.kind !== "Run") throw new Error();
        runs.set(value.run.runReference, value.run);
        states.set(value.run.runReference, value.state);
        operations.set(record.operationReference, record);
        return record;
      },
      async commitState({ record }) {
        const value = record.result;
        if (value.kind !== "State") throw new Error();
        states.set(value.state.runReference, value.state);
        operations.set(record.operationReference, record);
        return record;
      },
      async commitArtifact({ record }) {
        const value = record.result;
        if (value.kind !== "Artifact") throw new Error();
        artifacts.set(value.artifact.artifactReference, value.artifact);
        revisions.set(value.artifact.revisionReference, value.artifact);
        operations.set(record.operationReference, record);
        return record;
      },
      async commitRevocation({ record }) {
        const value = record.result;
        if (value.kind !== "Revocation") throw new Error();
        revocations.set(value.revocation.revisionReference, value.revocation);
        operations.set(record.operationReference, record);
        return record;
      },
      async commitDownloadAudit({ record }) {
        operations.set(record.operationReference, record);
        return record;
      },
    },
  };
  return { service: createReportRunService(ports), runs, states };
}

describe("WP-2162 Report Run", () => {
  it("rejects unpinned versions and result-shaped queued state", () => {
    expect(() => createReportRunSnapshot({ ...run(), reportVersionReference: "latest" })).toThrow();
    expect(() =>
      createReportRunStateSnapshot({ ...state(ids.state1, 1, "Queued", at), rowCount: 1 }),
    ).toThrow();
  });
  it("queues idempotently and reruns only the exact pinned snapshot", async () => {
    const { service } = fixture();
    const initial = state(ids.state1, 1, "Queued", at);
    const input = {
      action: "Queue" as const,
      operationReference: ref(ids.operation),
      candidate: run(),
      initialState: initial,
      occurredAt: at,
    };
    expect((await service.queue(input)).status).toBe("Applied");
    expect((await service.queue(input)).status).toBe("AlreadyApplied");
    const rerunState = createReportRunStateSnapshot({
      ...initial,
      stateReference: ids.rerunState,
      runReference: ids.rerun,
    });
    expect(
      (
        await service.queue({
          action: "Rerun",
          operationReference: ref(ids.rerunOperation),
          candidate: run(ids.rerun, ids.run),
          initialState: rerunState,
          occurredAt: at,
        })
      ).run.rerunOfRunReference,
    ).toBe(ids.run);
  });
  it("enforces the append-only state machine and terminal finality", async () => {
    const { service } = fixture();
    await service.queue({
      action: "Queue",
      operationReference: ref(ids.operation),
      candidate: run(),
      initialState: state(ids.state1, 1, "Queued", at),
      occurredAt: at,
    });
    await service.transition({
      operationReference: ref(ids.operation2),
      expectedSequence: 1,
      candidate: state(ids.state2, 2, "Running", later),
      occurredAt: later,
    });
    await service.transition({
      operationReference: ref(ids.operation3),
      expectedSequence: 2,
      candidate: state(ids.state3, 3, "Completed", completeAt),
      occurredAt: completeAt,
    });
    await expect(
      service.transition({
        operationReference: ref(id(99)),
        expectedSequence: 3,
        candidate: createReportRunStateSnapshot({ ...state(id(98), 4, "Running", expires) }),
        occurredAt: expires,
      }),
    ).rejects.toMatchObject({
      code: "REPORT_RUN_STATE_CONFLICT",
    } satisfies Partial<ReportRunError>);
  });
  it("records opaque artifact metadata, denies revoked downloads, and returns no URL", async () => {
    const { service } = fixture();
    await service.queue({
      action: "Queue",
      operationReference: ref(ids.operation),
      candidate: run(),
      initialState: state(ids.state1, 1, "Queued", at),
      occurredAt: at,
    });
    await service.transition({
      operationReference: ref(ids.operation2),
      expectedSequence: 1,
      candidate: state(ids.state2, 2, "Running", later),
      occurredAt: later,
    });
    await service.transition({
      operationReference: ref(ids.operation3),
      expectedSequence: 2,
      candidate: state(ids.state3, 3, "Completed", completeAt),
      occurredAt: completeAt,
    });
    const artifact = createReportArtifactRevisionSnapshot({
      artifactReference: ids.artifact,
      revisionReference: ids.revision,
      runReference: ids.run,
      revisionNumber: 1,
      outputAssetReference: ids.asset,
      format: "Csv",
      classification: "Internal",
      createdAt: completeAt,
      expiresAt: expires,
      createdByActorReference: ids.actor,
    });
    await service.recordArtifact({
      operationReference: ref(ids.artifactOperation),
      expectedRevision: null,
      candidate: artifact,
      occurredAt: completeAt,
    });
    const authorization = await service.authorizeDownload({
      operationReference: ref(ids.downloadOperation),
      revisionReference: ref(ids.revision),
      occurredAt: later,
    });
    expect(JSON.stringify(authorization)).not.toContain("url");
    const revocation = createReportArtifactRevocationSnapshot({
      revocationReference: ids.revocation,
      artifactReference: ids.artifact,
      revisionReference: ids.revision,
      reasonCode: "ACCESS_REVOKED",
      revokedAt: completeAt,
      revokedByActorReference: ids.actor,
    });
    await service.revokeArtifact({
      operationReference: ref(ids.revokeOperation),
      candidate: revocation,
      occurredAt: completeAt,
    });
    await expect(
      service.authorizeDownload({
        operationReference: ref(id(100)),
        revisionReference: ref(ids.revision),
        occurredAt: later,
      }),
    ).rejects.toMatchObject({ code: "REPORT_ARTIFACT_UNAVAILABLE" });
  });
});
