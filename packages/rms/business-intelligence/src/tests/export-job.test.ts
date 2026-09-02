import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createExportAccessGrantSnapshot,
  createExportArtifactSnapshot,
  createExportJobService,
  createExportJobSnapshot,
  createExportJobStateSnapshot,
  parseReportingReference,
  protectCsvTextCell,
  type ExportOperationRecord,
} from "../index.js";
const id = (n: number) => `018f9816-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  job: id(7),
  view: id(8),
  state: id(9),
  operation: id(10),
  artifact: id(11),
  object: id(12),
  grant: id(13),
};
const at = "2026-08-15T16:00:00.000Z",
  digest = (c: string) => `sha256:${c.repeat(64)}`,
  ref = (value: string) => parseReportingReference(value);
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function job(overrides: Record<string, unknown> = {}) {
  return createExportJobSnapshot({
    jobReference: ids.job,
    scope,
    sourceScreenId: "ORDER_QUEUE",
    sourceViewReference: ids.view,
    sourceProjection: "ORDER_OPERATIONAL_V1",
    sourceCheckpoint: "CHECKPOINT_42",
    filterSnapshotDigest: digest("a"),
    columnSnapshotDigest: digest("b"),
    selectedFieldKeys: ["ORDER_REFERENCE", "STATUS"],
    format: "Csv",
    classification: "Internal",
    purposeCode: "OPERATIONS_REVIEW",
    requestedByActorReference: ids.actor,
    requestedAt: at,
    ...overrides,
  });
}
function state() {
  return createExportJobStateSnapshot({
    stateReference: ids.state,
    jobReference: ids.job,
    sequence: 1,
    status: "Queued",
    occurredAt: at,
    actorReference: ids.actor,
    rowCount: null,
    artifactByteCount: null,
    errorCode: null,
  });
}
function context() {
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
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
describe("WP-2196 Export Job", () => {
  it("permits only CSV/canonical JSON and enforces 24-hour, row and byte limits", () => {
    expect(() => job({ format: "Spreadsheet" })).toThrow();
    expect(() =>
      createExportArtifactSnapshot({
        artifactReference: ids.artifact,
        jobReference: ids.job,
        objectEvidenceReference: ids.object,
        checksum: digest("c"),
        format: "Csv",
        classification: "Internal",
        encrypted: true,
        rowCount: 100_001,
        byteCount: 12,
        createdAt: at,
        expiresAt: "2026-08-15T17:00:00.000Z",
      }),
    ).toThrow("export limit exceeded");
    expect(() =>
      createExportAccessGrantSnapshot({
        grantReference: ids.grant,
        artifactReference: ids.artifact,
        actorReference: ids.actor,
        issuedAt: at,
        expiresAt: "2026-08-15T16:06:00.000Z",
      }),
    ).toThrow();
  });
  it("neutralizes spreadsheet formulas only for text cells", () => {
    expect(protectCsvTextCell('=HYPERLINK("bad")')).toBe('\'=HYPERLINK("bad")');
    expect(protectCsvTextCell("42")).toBe("42");
  });
  it("queues only a source-authorized field/scope snapshot and commits Audit atomically", async () => {
    const operations = new Map<string, ExportOperationRecord>(),
      commits: unknown[] = [];
    const service = createExportJobService({
      authorization: {
        authorize: async (input) =>
          ({
            tenantReference: ids.tenant,
            tenantContext: context(),
            permission: {
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
              action: "reporting.export.create",
              scopeKind: "Brand",
              policySnapshotReference: ids.policy,
              policyVersion: 1,
              audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
            },
            audit: {
              auditId: ids.audit,
              brandId: ids.brand,
              actor: { type: "User", reference: ids.actor },
              actionCode: "EXPORT_QUEUE",
              targetType: "ExportJob",
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
          }) as never,
      },
      source: {
        authorize: async (candidate) => ({
          sourceScreenId: candidate.sourceScreenId,
          sourceViewReference: candidate.sourceViewReference,
          sourceProjection: candidate.sourceProjection,
          sourceCheckpoint: candidate.sourceCheckpoint,
          permittedFieldKeys: candidate.selectedFieldKeys,
          classification: candidate.classification,
          stepUpSatisfied: true,
        }),
      },
      references: { hashIntent: () => digest("d"), equals: (left, right) => left === right },
      repository: {
        loadJob: async () => null,
        loadLatestState: async () => null,
        loadArtifact: async () => null,
        loadArtifactForJob: async () => null,
        loadGrant: async () => null,
        loadConsumption: async () => null,
        loadRevocation: async () => null,
        resolveOperation: async (reference) => operations.get(reference) ?? null,
        commitJob: async (input) => {
          operations.set(input.record.operationReference, input.record);
          commits.push(input);
          return input.record;
        },
        commitState: async () => {
          throw new Error();
        },
        commitRevocation: async () => {
          throw new Error();
        },
        commitGrant: async () => {
          throw new Error();
        },
        consumeGrant: async () => {
          throw new Error();
        },
      },
    });
    const input = {
      operationReference: ref(ids.operation),
      candidate: job(),
      initialState: state(),
      occurredAt: at,
    };
    expect((await service.queue(input)).status).toBe("Applied");
    expect((await service.queue(input)).status).toBe("AlreadyApplied");
    expect(commits).toHaveLength(1);
  });
});
