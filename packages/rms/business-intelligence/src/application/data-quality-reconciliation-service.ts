import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createDataQualityCheckSnapshot,
  createDataQualityIssueActionSnapshot,
  createDataQualityResultSnapshot,
  createReconciliationExceptionSnapshot,
  createReconciliationRunSnapshot,
  type DataQualityCheckSnapshot,
  type DataQualityIssueActionSnapshot,
  type DataQualityResultSnapshot,
  type ReconciliationExceptionSnapshot,
  type ReconciliationRunSnapshot,
} from "../contracts/data-quality-reconciliation.js";
import {
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  type ReportingReference,
} from "../contracts/report-definition.js";
import type {
  DataQualityAction,
  DataQualityOperationRecord,
  DataQualityReconciliationPorts,
} from "./ports/data-quality-reconciliation-ports.js";

export type DataQualityWorkflowErrorCode =
  | "DATA_QUALITY_INPUT_INVALID"
  | "DATA_QUALITY_PERMISSION_DENIED"
  | "DATA_QUALITY_VERSION_CONFLICT"
  | "DATA_QUALITY_IDEMPOTENCY_CONFLICT"
  | "DATA_QUALITY_LIFECYCLE_CONFLICT"
  | "DATA_QUALITY_OBSERVATION_DENIED"
  | "DATA_QUALITY_DIFFERENCE_INVALID"
  | "DATA_QUALITY_DEPENDENCY_UNAVAILABLE";
export class DataQualityWorkflowError extends Error {
  constructor(readonly code: DataQualityWorkflowErrorCode) {
    super("Data Quality operation is unavailable");
    this.name = "DataQualityWorkflowError";
  }
}
const invalid = (): never => {
  throw new DataQualityWorkflowError("DATA_QUALITY_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field)))
    return invalid();
  return value as Record<string, unknown>;
}
function dependency(error: unknown): never {
  if (error instanceof DataQualityWorkflowError) throw error;
  throw new DataQualityWorkflowError("DATA_QUALITY_DEPENDENCY_UNAVAILABLE");
}
function sameScope(
  left: DataQualityCheckSnapshot["scope"],
  right: DataQualityCheckSnapshot["scope"],
): boolean {
  return (
    left.tenantReference === right.tenantReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}
const permissionByAction: Record<DataQualityAction, string> = {
  CreateCheck: "reporting.quality.manage",
  ReplaceCheck: "reporting.quality.manage",
  ArchiveCheck: "reporting.quality.manage",
  RecordResult: "reporting.quality.run",
  ActOnIssue: "reporting.quality.manage",
  RecordReconciliation: "reporting.reconciliation.run",
  ActOnReconciliation: "reporting.reconciliation.manage",
};
async function authorize(
  ports: DataQualityReconciliationPorts,
  action: DataQualityAction,
  operationReference: ReportingReference,
  targetReference: ReportingReference,
  at: string,
): Promise<{
  readonly actor: ReportingReference;
  readonly scope: DataQualityCheckSnapshot["scope"];
  readonly audit: AppendAuditRecordInput;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, targetReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new DataQualityWorkflowError("DATA_QUALITY_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissionByAction[action] ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== context.store?.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `REPORTING_${action.toUpperCase()}` ||
      audit.targetType !== "DataQuality" ||
      audit.targetId !== targetReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      actor: parseReportingReference(actor),
      scope: {
        tenantReference: parseReportingReference(evidence.tenantReference),
        brandReference: parseReportingReference(context.brand.brandReference),
        storeReference:
          context.store === null ? null : parseReportingReference(context.store.storeReference),
      },
      audit,
    };
  } catch {
    throw new DataQualityWorkflowError("DATA_QUALITY_PERMISSION_DENIED");
  }
}
function scaled(value: string): { readonly integer: bigint; readonly scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const integer = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { integer, scale: fraction.length };
}
function differenceMatches(expected: string, actual: string, difference: string): boolean {
  const expectedValue = scaled(expected);
  const actualValue = scaled(actual);
  const differenceValue = scaled(difference);
  const values = [expectedValue, actualValue, differenceValue];
  const scale = Math.max(...values.map((item) => item.scale));
  const align = (item: { readonly integer: bigint; readonly scale: number }) =>
    item.integer * 10n ** BigInt(scale - item.scale);
  return align(expectedValue) - align(actualValue) === align(differenceValue);
}
function sameCheckSemantics(
  left: DataQualityCheckSnapshot,
  right: DataQualityCheckSnapshot,
): boolean {
  return (
    left.kind === right.kind &&
    left.datasetVersionReference === right.datasetVersionReference &&
    left.partitionCode === right.partitionCode &&
    left.ruleCode === right.ruleCode &&
    left.expectationCode === right.expectationCode &&
    left.defaultSeverity === right.defaultSeverity &&
    left.ownerReference === right.ownerReference &&
    left.effectiveFrom === right.effectiveFrom &&
    left.effectiveUntil === right.effectiveUntil
  );
}
function issueActionEvent(
  action: DataQualityIssueActionSnapshot,
  resolvedAt: string,
): DataQualityOperationRecord["event"] {
  if (action.action !== "Resolve") return null;
  const rerunResultReference = action.rerunResultReference;
  const resolutionCode = action.resolutionCode;
  if (rerunResultReference === null || resolutionCode === null)
    throw new DataQualityWorkflowError("DATA_QUALITY_INPUT_INVALID");
  return Object.freeze({
    eventType: "DataQualityIssueResolved",
    resultReference: action.resultReference,
    rerunResultReference,
    resolutionCode,
    scope: action.scope,
    resolvedAt,
  });
}
async function idempotency(
  ports: DataQualityReconciliationPorts,
  operationReference: ReportingReference,
  intent: ReturnType<typeof parseReportingDigest>,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
  if (prior !== null && !ports.references.equals(prior.operationIntentHash, intent))
    throw new DataQualityWorkflowError("DATA_QUALITY_IDEMPOTENCY_CONFLICT");
  return prior;
}

export function createDataQualityReconciliationService(ports: DataQualityReconciliationPorts) {
  return Object.freeze({
    async recordCheck(input: {
      readonly action: "CreateCheck" | "ReplaceCheck" | "ArchiveCheck";
      readonly operationReference: ReportingReference;
      readonly expectedAggregateVersion: number | null;
      readonly candidate: DataQualityCheckSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "occurredAt",
      ]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createDataQualityCheckSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.checkReference,
        at,
      );
      if (
        !sameScope(candidate.scope, auth.scope) ||
        candidate.createdByActorReference !== auth.actor
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_PERMISSION_DENIED");
      const current = await ports.repository.loadCheck(candidate.checkReference).catch(dependency);
      if (input.action === "CreateCheck") {
        if (
          current !== null ||
          input.expectedAggregateVersion !== null ||
          candidate.aggregateVersion !== 1 ||
          candidate.versionNumber !== 1 ||
          candidate.lifecycle !== "Active"
        )
          throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      } else {
        if (
          current === null ||
          input.expectedAggregateVersion !== current.aggregateVersion ||
          candidate.aggregateVersion !== current.aggregateVersion + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.checkReference !== current.checkReference ||
          !sameScope(candidate.scope, current.scope) ||
          current.lifecycle !== "Active" ||
          (input.action === "ReplaceCheck" && candidate.lifecycle !== "Active") ||
          (input.action === "ArchiveCheck" &&
            (candidate.lifecycle !== "Archived" || !sameCheckSemantics(candidate, current)))
        )
          throw new DataQualityWorkflowError("DATA_QUALITY_VERSION_CONFLICT");
      }
      const operation: DataQualityOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        resultReference: candidate.checkVersionReference,
        event: null,
      });
      const committed = await ports.repository
        .commitCheck({
          operation,
          check: candidate,
          expectedAggregateVersion: input.expectedAggregateVersion,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },

    async recordResult(input: {
      readonly operationReference: ReportingReference;
      readonly result: DataQualityResultSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "result", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const result = createDataQualityResultSnapshot(input.result);
      if (result.detectedAt !== at) invalid();
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(
        ports,
        "RecordResult",
        operationReference,
        result.resultReference,
        at,
      );
      const check = await ports.repository
        .loadCheckVersion(result.checkVersionReference)
        .catch(dependency);
      if (
        check === null ||
        check.checkReference !== result.checkReference ||
        check.lifecycle !== "Active" ||
        check.datasetVersionReference !== result.datasetVersionReference ||
        check.partitionCode !== result.partitionCode ||
        !sameScope(result.scope, check.scope) ||
        !sameScope(result.scope, auth.scope)
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      const operation: DataQualityOperationRecord = Object.freeze({
        action: "RecordResult",
        operationReference,
        operationIntentHash: intent,
        resultReference: result.resultReference,
        event:
          result.outcome === "Fail"
            ? Object.freeze({
                eventType: "DataQualityIssueDetected" as const,
                resultReference: result.resultReference,
                checkReference: result.checkReference,
                checkVersionReference: result.checkVersionReference,
                datasetVersionReference: result.datasetVersionReference,
                partitionCode: result.partitionCode,
                scope: result.scope,
                severity: result.severity,
                publicationDisposition: result.publicationDisposition,
                detectedAt: at,
              })
            : null,
      });
      const committed = await ports.repository
        .commitResult({ operation, result, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },

    async actOnIssue(input: {
      readonly operationReference: ReportingReference;
      readonly expectedSequence: number;
      readonly action: DataQualityIssueActionSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "expectedSequence", "action", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const action = createDataQualityIssueActionSnapshot(input.action);
      if (action.occurredAt !== at) invalid();
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(
        ports,
        "ActOnIssue",
        operationReference,
        action.resultReference,
        at,
      );
      const result = await ports.repository.loadResult(action.resultReference).catch(dependency);
      const latest = await ports.repository
        .loadLatestIssueAction(action.resultReference)
        .catch(dependency);
      const expected = latest?.sequence ?? 0;
      if (
        result === null ||
        result.outcome !== "Fail" ||
        !sameScope(result.scope, action.scope) ||
        !sameScope(action.scope, auth.scope) ||
        action.actorReference !== auth.actor ||
        input.expectedSequence !== expected ||
        action.sequence !== expected + 1
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_VERSION_CONFLICT");
      if (action.action === "Resolve") {
        const rerunResultReference = action.rerunResultReference;
        if (rerunResultReference === null)
          throw new DataQualityWorkflowError("DATA_QUALITY_INPUT_INVALID");
        const rerun = await ports.repository.loadResult(rerunResultReference).catch(dependency);
        if (
          rerun === null ||
          rerun.outcome !== "Pass" ||
          rerun.checkReference !== result.checkReference ||
          !sameScope(rerun.scope, result.scope) ||
          Date.parse(rerun.detectedAt) <= Date.parse(result.detectedAt)
        )
          throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      }
      const operation: DataQualityOperationRecord = Object.freeze({
        action: "ActOnIssue",
        operationReference,
        operationIntentHash: intent,
        resultReference: action.actionReference,
        event: issueActionEvent(action, at),
      });
      const committed = await ports.repository
        .commitIssueAction({
          operation,
          action,
          expectedSequence: input.expectedSequence,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },

    async recordReconciliation(input: {
      readonly operationReference: ReportingReference;
      readonly run: ReconciliationRunSnapshot;
      readonly exception: ReconciliationExceptionSnapshot | null;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "run", "exception", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const run = createReconciliationRunSnapshot(input.run);
      const exception =
        input.exception === null ? null : createReconciliationExceptionSnapshot(input.exception);
      if (
        run.detectedAt !== at ||
        !differenceMatches(run.expectedValue, run.actualValue, run.differenceValue)
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_DIFFERENCE_INVALID");
      if (
        (run.outcome === "Difference") !== (exception !== null) ||
        (exception !== null &&
          (exception.runReference !== run.runReference ||
            exception.sequence !== 1 ||
            exception.status !== "Open" ||
            exception.occurredAt !== at))
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(
        ports,
        "RecordReconciliation",
        operationReference,
        run.runReference,
        at,
      );
      if (
        !sameScope(run.scope, auth.scope) ||
        (exception !== null &&
          (!sameScope(exception.scope, run.scope) || exception.actorReference !== auth.actor))
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_PERMISSION_DENIED");
      if (
        !(await ports.observations
          .authorizeReconciliation({
            scope: run.scope,
            leftObservationReference: run.leftObservationReference,
            rightObservationReference: run.rightObservationReference,
            control: run.control,
          })
          .catch(dependency))
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_OBSERVATION_DENIED");
      const operation: DataQualityOperationRecord = Object.freeze({
        action: "RecordReconciliation",
        operationReference,
        operationIntentHash: intent,
        resultReference: exception?.exceptionReference ?? run.runReference,
        event:
          exception === null
            ? null
            : Object.freeze({
                eventType: "ReconciliationDifferenceDetected" as const,
                exceptionReference: exception.exceptionReference,
                runReference: run.runReference,
                scope: run.scope,
                control: run.control,
                periodFrom: run.periodFrom,
                periodUntil: run.periodUntil,
                unitCode: run.unitCode,
                detectedAt: at,
              }),
      });
      const committed = await ports.repository
        .commitReconciliation({ operation, run, exception, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },

    async actOnReconciliation(input: {
      readonly operationReference: ReportingReference;
      readonly expectedSequence: number;
      readonly action: ReconciliationExceptionSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "expectedSequence", "action", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const action = createReconciliationExceptionSnapshot(input.action);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(
        ports,
        "ActOnReconciliation",
        operationReference,
        action.exceptionReference,
        at,
      );
      const current = await ports.repository
        .loadLatestReconciliationException(action.exceptionReference)
        .catch(dependency);
      if (
        current === null ||
        current.runReference !== action.runReference ||
        input.expectedSequence !== current.sequence ||
        action.sequence !== current.sequence + 1 ||
        action.occurredAt !== at ||
        action.actorReference !== auth.actor ||
        !sameScope(action.scope, current.scope) ||
        !sameScope(action.scope, auth.scope)
      )
        throw new DataQualityWorkflowError("DATA_QUALITY_VERSION_CONFLICT");
      if (!(
        (current.status === "Open" && action.status === "Investigating") ||
        (current.status === "Investigating" && action.status === "Resolved")
      ))
        throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      if (action.status === "Resolved") {
        const resolutionRerunReference = action.resolutionRerunReference;
        if (resolutionRerunReference === null)
          throw new DataQualityWorkflowError("DATA_QUALITY_INPUT_INVALID");
        const original = await ports.repository
          .loadReconciliationRun(action.runReference)
          .catch(dependency);
        const rerun = await ports.repository
          .loadReconciliationRun(resolutionRerunReference)
          .catch(dependency);
        if (
          original === null ||
          rerun === null ||
          rerun.outcome !== "Matched" ||
          rerun.control !== original.control ||
          !sameScope(rerun.scope, original.scope) ||
          rerun.periodFrom !== original.periodFrom ||
          rerun.periodUntil !== original.periodUntil ||
          Date.parse(rerun.detectedAt) <= Date.parse(original.detectedAt)
        )
          throw new DataQualityWorkflowError("DATA_QUALITY_LIFECYCLE_CONFLICT");
      }
      const operation: DataQualityOperationRecord = Object.freeze({
        action: "ActOnReconciliation",
        operationReference,
        operationIntentHash: intent,
        resultReference: action.exceptionReference,
        event: null,
      });
      const committed = await ports.repository
        .commitReconciliationAction({
          operation,
          action,
          expectedSequence: input.expectedSequence,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },
  });
}
