import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createDataQualityCheckSnapshot,
  createDataQualityIssueActionSnapshot,
  createDataQualityReconciliationService,
  createDataQualityResultSnapshot,
  createReconciliationExceptionSnapshot,
  createReconciliationRunSnapshot,
  parseReportingReference,
  type DataQualityCheckSnapshot,
  type DataQualityIssueActionSnapshot,
  type DataQualityOperationRecord,
  type DataQualityReconciliationPorts,
  type DataQualityResultSnapshot,
  type ReconciliationExceptionSnapshot,
  type ReconciliationRunSnapshot,
} from "../index.js";

const id = (n: number) => `018f9910-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  owner: id(4),
  check: id(5),
  checkVersion: id(6),
  datasetVersion: id(7),
  resultFail: id(8),
  resultPass: id(9),
  executionFail: id(10),
  executionPass: id(11),
  issueAction: id(12),
  runDifference: id(13),
  runMatched: id(14),
  leftObservation: id(15),
  rightObservation: id(16),
  exception: id(17),
  exceptionOpen: id(18),
  exceptionInvestigating: id(19),
  exceptionResolved: id(20),
  operation1: id(21),
  operation2: id(22),
  operation3: id(23),
  operation4: id(24),
  operation5: id(25),
  operation6: id(26),
  operation7: id(27),
  audit: id(28),
  correlation: id(29),
  policy: id(30),
  incident: id(31),
};
const at = "2026-08-14T18:00:00.000Z";
const later = "2026-08-14T19:00:00.000Z";
const latest = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T17:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
const sha = (character: string) => `sha256:${character.repeat(64)}`;

function tenant(observedAt: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
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
    observedAt,
  );
}

function check(): DataQualityCheckSnapshot {
  return createDataQualityCheckSnapshot({
    checkReference: ids.check,
    checkVersionReference: ids.checkVersion,
    scope,
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: sha("a"),
    lifecycle: "Active",
    kind: "Completeness",
    datasetVersionReference: ids.datasetVersion,
    partitionCode: "BUSINESS_DATE_2026_08_14",
    ruleCode: "ORDER_TOTAL_PRESENT",
    expectationCode: "NULL_COUNT_ZERO",
    defaultSeverity: "Critical",
    ownerReference: ids.owner,
    effectiveFrom: before,
    effectiveUntil: null,
    createdAt: at,
    createdByActorReference: ids.actor,
  });
}

function result(
  outcome: "Pass" | "Fail",
  options: { reference?: string; execution?: string; detectedAt?: string } = {},
): DataQualityResultSnapshot {
  return createDataQualityResultSnapshot({
    resultReference: options.reference ?? ids.resultFail,
    executionReference: options.execution ?? ids.executionFail,
    checkReference: ids.check,
    checkVersionReference: ids.checkVersion,
    scope,
    datasetVersionReference: ids.datasetVersion,
    partitionCode: "BUSINESS_DATE_2026_08_14",
    outcome,
    severity: "Critical",
    expectedObservationCode: "NULL_COUNT_ZERO",
    actualObservationCode: outcome === "Pass" ? "NULL_COUNT_ZERO" : "NULL_COUNT_THREE",
    publicationDisposition: outcome === "Pass" ? "ContinueFormalReporting" : "BlockFormalReporting",
    affectedFrom: before,
    affectedUntil: at,
    detectedAt: options.detectedAt ?? at,
  });
}

function run(
  outcome: "Matched" | "Difference",
  options: { reference?: string; detectedAt?: string } = {},
): ReconciliationRunSnapshot {
  return createReconciliationRunSnapshot({
    runReference: options.reference ?? ids.runDifference,
    scope,
    control: "PaymentLedger",
    periodFrom: before,
    periodUntil: at,
    leftObservationReference: ids.leftObservation,
    rightObservationReference: ids.rightObservation,
    expectedValue: "0.3",
    actualValue: outcome === "Matched" ? "0.3" : "0.1",
    differenceValue: outcome === "Matched" ? "0.0" : "0.2",
    unitCode: "CAD",
    outcome,
    detectedAt: options.detectedAt ?? at,
  });
}

function exception(
  status: ReconciliationExceptionSnapshot["status"],
  options: { sequence?: number; reference?: string; occurredAt?: string } = {},
): ReconciliationExceptionSnapshot {
  return createReconciliationExceptionSnapshot({
    exceptionReference: ids.exception,
    runReference: ids.runDifference,
    scope,
    sequence: options.sequence ?? 1,
    status,
    ownerReference: status === "Open" ? null : ids.owner,
    investigationCode: status === "Investigating" ? "LEDGER_REVIEW" : null,
    resolutionCode: status === "Resolved" ? "RERUN_MATCHED" : null,
    resolutionRerunReference: status === "Resolved" ? ids.runMatched : null,
    occurredAt: options.occurredAt ?? at,
    actorReference: ids.actor,
  });
}

function resolveIssue() {
  return createDataQualityIssueActionSnapshot({
    actionReference: ids.issueAction,
    resultReference: ids.resultFail,
    scope,
    sequence: 1,
    action: "Resolve",
    ownerReference: null,
    incidentReference: null,
    backfillRequestReference: null,
    rerunResultReference: ids.resultPass,
    resolutionCode: "RERUN_PASSED",
    occurredAt: later,
    actorReference: ids.actor,
  });
}

function hash(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}

function fixture(options: { observationsAuthorized?: boolean } = {}) {
  let aggregate: DataQualityCheckSnapshot | null = null;
  const checkVersions = new Map<string, DataQualityCheckSnapshot>();
  const results = new Map<string, DataQualityResultSnapshot>();
  const issueActions = new Map<string, DataQualityIssueActionSnapshot>();
  const runs = new Map<string, ReconciliationRunSnapshot>();
  const exceptions = new Map<string, ReconciliationExceptionSnapshot>();
  const operations = new Map<string, DataQualityOperationRecord>();
  const ports: DataQualityReconciliationPorts = {
    authorization: {
      async authorize(input) {
        const permissionByAction = {
          CreateCheck: "reporting.quality.manage",
          ReplaceCheck: "reporting.quality.manage",
          ArchiveCheck: "reporting.quality.manage",
          RecordResult: "reporting.quality.run",
          ActOnIssue: "reporting.quality.manage",
          RecordReconciliation: "reporting.reconciliation.run",
          ActOnReconciliation: "reporting.reconciliation.manage",
        } as const;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permissionByAction[input.action],
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
            targetType: "DataQuality",
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
    observations: {
      async authorizeReconciliation() {
        return options.observationsAuthorized ?? true;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadCheck(reference) {
        return aggregate?.checkReference === reference ? aggregate : null;
      },
      async loadCheckVersion(reference) {
        return checkVersions.get(reference) ?? null;
      },
      async commitCheck(input) {
        aggregate = input.check;
        checkVersions.set(input.check.checkVersionReference, input.check);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async loadResult(reference) {
        return results.get(reference) ?? null;
      },
      async loadLatestIssueAction(reference) {
        return issueActions.get(reference) ?? null;
      },
      async commitResult(input) {
        results.set(input.result.resultReference, input.result);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async commitIssueAction(input) {
        issueActions.set(input.action.resultReference, input.action);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async loadReconciliationRun(reference) {
        return runs.get(reference) ?? null;
      },
      async loadLatestReconciliationException(reference) {
        return exceptions.get(reference) ?? null;
      },
      async commitReconciliation(input) {
        runs.set(input.run.runReference, input.run);
        if (input.exception !== null)
          exceptions.set(input.exception.exceptionReference, input.exception);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async commitReconciliationAction(input) {
        exceptions.set(input.action.exceptionReference, input.action);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
    },
  };
  return { service: createDataQualityReconciliationService(ports), operations };
}

describe("Data Quality and Reconciliation", () => {
  it("accepts only closed check/result contracts and decimal strings", () => {
    expect(check().kind).toBe("Completeness");
    expect(() =>
      createDataQualityCheckSnapshot({ ...check(), sql: "select private_data" }),
    ).toThrow();
    expect(() =>
      createDataQualityResultSnapshot({
        ...result("Fail"),
        publicationDisposition: "ContinueFormalReporting",
      }),
    ).toThrow();
    expect(() =>
      createReconciliationRunSnapshot({ ...run("Difference"), expectedValue: 0.3 }),
    ).toThrow();
  });

  it("detects a Critical issue, preserves idempotency, and resolves only after a later Pass", async () => {
    const { service, operations } = fixture();
    await service.recordCheck({
      action: "CreateCheck",
      operationReference: parseReportingReference(ids.operation1),
      expectedAggregateVersion: null,
      candidate: check(),
      occurredAt: at,
    });
    const failed = result("Fail");
    const input = {
      operationReference: parseReportingReference(ids.operation2),
      result: failed,
      occurredAt: at,
    };
    await service.recordResult(input);
    await expect(service.recordResult(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    expect(operations.get(ids.operation2)?.event?.eventType).toBe("DataQualityIssueDetected");
    await expect(
      service.actOnIssue({
        operationReference: parseReportingReference(ids.operation3),
        expectedSequence: 0,
        action: resolveIssue(),
        occurredAt: later,
      }),
    ).rejects.toMatchObject({ code: "DATA_QUALITY_LIFECYCLE_CONFLICT" });
    await service.recordResult({
      operationReference: parseReportingReference(ids.operation4),
      result: result("Pass", {
        reference: ids.resultPass,
        execution: ids.executionPass,
        detectedAt: later,
      }),
      occurredAt: later,
    });
    await service.actOnIssue({
      operationReference: parseReportingReference(ids.operation3),
      expectedSequence: 0,
      action: resolveIssue(),
      occurredAt: later,
    });
    expect(operations.get(ids.operation3)?.event?.eventType).toBe("DataQualityIssueResolved");
  });

  it("reconciles decimal values exactly and never reads unauthorized observations", async () => {
    const denied = fixture({ observationsAuthorized: false });
    await expect(
      denied.service.recordReconciliation({
        operationReference: parseReportingReference(ids.operation1),
        run: run("Difference"),
        exception: exception("Open"),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "DATA_QUALITY_OBSERVATION_DENIED" });
    const { service, operations } = fixture();
    await service.recordReconciliation({
      operationReference: parseReportingReference(ids.operation1),
      run: run("Difference"),
      exception: exception("Open"),
      occurredAt: at,
    });
    expect(operations.get(ids.operation1)?.event?.eventType).toBe(
      "ReconciliationDifferenceDetected",
    );
    await expect(
      service.recordReconciliation({
        operationReference: parseReportingReference(ids.operation2),
        run: createReconciliationRunSnapshot({
          ...run("Difference"),
          runReference: ids.runMatched,
          differenceValue: "0.199999999",
        }),
        exception: createReconciliationExceptionSnapshot({
          ...exception("Open"),
          runReference: ids.runMatched,
          exceptionReference: ids.exceptionOpen,
        }),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "DATA_QUALITY_DIFFERENCE_INVALID" });
  });

  it("resolves a reconciliation exception only after a later matched rerun", async () => {
    const { service } = fixture();
    await service.recordReconciliation({
      operationReference: parseReportingReference(ids.operation1),
      run: run("Difference"),
      exception: exception("Open"),
      occurredAt: at,
    });
    await service.actOnReconciliation({
      operationReference: parseReportingReference(ids.operation2),
      expectedSequence: 1,
      action: exception("Investigating", {
        sequence: 2,
        reference: ids.exceptionInvestigating,
        occurredAt: later,
      }),
      occurredAt: later,
    });
    await expect(
      service.actOnReconciliation({
        operationReference: parseReportingReference(ids.operation3),
        expectedSequence: 2,
        action: exception("Resolved", {
          sequence: 3,
          reference: ids.exceptionResolved,
          occurredAt: latest,
        }),
        occurredAt: latest,
      }),
    ).rejects.toMatchObject({ code: "DATA_QUALITY_LIFECYCLE_CONFLICT" });
    await service.recordReconciliation({
      operationReference: parseReportingReference(ids.operation4),
      run: run("Matched", { reference: ids.runMatched, detectedAt: later }),
      exception: null,
      occurredAt: later,
    });
    await expect(
      service.actOnReconciliation({
        operationReference: parseReportingReference(ids.operation3),
        expectedSequence: 2,
        action: exception("Resolved", {
          sequence: 3,
          reference: ids.exceptionResolved,
          occurredAt: latest,
        }),
        occurredAt: latest,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
  });
});
