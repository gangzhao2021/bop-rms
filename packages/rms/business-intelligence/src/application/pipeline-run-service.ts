import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createBackfillRequestSnapshot,
  createPipelineRunSnapshot,
  createPipelineRunStateSnapshot,
  type BackfillRequestSnapshot,
  type PipelineRunSnapshot,
  type PipelineRunStateSnapshot,
} from "../contracts/pipeline-run.js";
import {
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  type ReportingReference,
} from "../contracts/report-definition.js";
import type {
  PipelineAction,
  PipelineOperationRecord,
  PipelineRunPorts,
} from "./ports/pipeline-run-ports.js";

export type PipelineWorkflowErrorCode =
  | "PIPELINE_INPUT_INVALID"
  | "PIPELINE_PERMISSION_DENIED"
  | "PIPELINE_VERSION_CONFLICT"
  | "PIPELINE_IDEMPOTENCY_CONFLICT"
  | "PIPELINE_LIFECYCLE_CONFLICT"
  | "PIPELINE_APPROVAL_REQUIRED"
  | "PIPELINE_DEPENDENCY_UNAVAILABLE";
export class PipelineWorkflowError extends Error {
  constructor(readonly code: PipelineWorkflowErrorCode) {
    super("Pipeline operation is unavailable");
    this.name = "PipelineWorkflowError";
  }
}
const invalid = (): never => {
  throw new PipelineWorkflowError("PIPELINE_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function dependency(error: unknown): never {
  if (error instanceof PipelineWorkflowError) throw error;
  throw new PipelineWorkflowError("PIPELINE_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (left: PipelineRunSnapshot["scope"], right: PipelineRunSnapshot["scope"]) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const sameRetryIntent = (retry: PipelineRunSnapshot, prior: PipelineRunSnapshot) =>
  sameScope(retry.scope, prior.scope) &&
  retry.pipelineReference === prior.pipelineReference &&
  retry.pipelineVersionReference === prior.pipelineVersionReference &&
  retry.transformationVersionReference === prior.transformationVersionReference &&
  retry.inputCheckpointReference === prior.inputCheckpointReference &&
  retry.outputDatasetVersionReference === prior.outputDatasetVersionReference &&
  retry.outputPartitionCode === prior.outputPartitionCode &&
  retry.environmentCode === prior.environmentCode &&
  retry.logicalBatchDigest === prior.logicalBatchDigest &&
  retry.backfillRequestVersionReference === prior.backfillRequestVersionReference &&
  retry.correctionReasonCode === prior.correctionReasonCode &&
  retry.correctionCodeVersionReference === prior.correctionCodeVersionReference &&
  retry.preReconciliationRunReference === prior.preReconciliationRunReference;
const permissions: Record<PipelineAction, string> = {
  CreateRun: "reporting.pipeline.run",
  AdvanceRun: "reporting.pipeline.run",
  RequestBackfill: "reporting.pipeline.backfill.request",
  ApproveBackfill: "reporting.pipeline.backfill.approve",
  RejectBackfill: "reporting.pipeline.backfill.approve",
  BindBackfill: "reporting.pipeline.backfill.manage",
  CompleteBackfill: "reporting.pipeline.backfill.manage",
  FailBackfill: "reporting.pipeline.backfill.manage",
  CancelBackfill: "reporting.pipeline.backfill.manage",
};
async function authorize(
  ports: PipelineRunPorts,
  action: PipelineAction,
  operationReference: ReportingReference,
  targetReference: ReportingReference,
  at: string,
): Promise<{
  actor: ReportingReference;
  scope: PipelineRunSnapshot["scope"];
  audit: AppendAuditRecordInput;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, targetReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new PipelineWorkflowError("PIPELINE_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[action] ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== context.store?.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `REPORTING_PIPELINE_${action.toUpperCase()}` ||
      audit.targetType !== (action.includes("Backfill") ? "BackfillRequest" : "PipelineRun") ||
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
    throw new PipelineWorkflowError("PIPELINE_PERMISSION_DENIED");
  }
}
async function idempotency(
  ports: PipelineRunPorts,
  reference: ReportingReference,
  intent: ReturnType<typeof parseReportingDigest>,
) {
  const prior = await ports.repository.resolveOperation(reference).catch(dependency);
  if (prior !== null && !ports.references.equals(prior.operationIntentHash, intent))
    throw new PipelineWorkflowError("PIPELINE_IDEMPOTENCY_CONFLICT");
  return prior;
}
const sameBackfillSemantic = (a: BackfillRequestSnapshot, b: BackfillRequestSnapshot) =>
  a.pipelineReference === b.pipelineReference &&
  a.pipelineVersionReference === b.pipelineVersionReference &&
  a.transformationVersionReference === b.transformationVersionReference &&
  a.outputDatasetVersionReference === b.outputDatasetVersionReference &&
  a.outputPartitionCode === b.outputPartitionCode &&
  a.rangeFrom === b.rangeFrom &&
  a.rangeUntil === b.rangeUntil &&
  a.reasonCode === b.reasonCode &&
  a.requestedAt === b.requestedAt &&
  a.requestedByActorReference === b.requestedByActorReference;
function runEvent(
  run: PipelineRunSnapshot,
  state: PipelineRunStateSnapshot,
): PipelineOperationRecord["event"] {
  if (state.status === "Failed") {
    const errorReference = state.errorReference;
    if (errorReference === null) throw new PipelineWorkflowError("PIPELINE_INPUT_INVALID");
    return Object.freeze({
      eventType: "AnalyticsLoadFailed",
      runReference: run.runReference,
      pipelineVersionReference: run.pipelineVersionReference,
      errorReference,
      occurredAt: state.occurredAt,
    });
  }
  if (state.status !== "Succeeded" && state.status !== "SucceededWithWarning") return null;
  if (run.backfillRequestVersionReference !== null) {
    const backfillRequestVersionReference = run.backfillRequestVersionReference;
    if (backfillRequestVersionReference === null)
      throw new PipelineWorkflowError("PIPELINE_INPUT_INVALID");
    return Object.freeze({
      eventType: "AnalyticsBackfillCompleted",
      runReference: run.runReference,
      backfillRequestVersionReference,
      outputDatasetVersionReference: run.outputDatasetVersionReference,
      outputPartitionCode: run.outputPartitionCode,
      occurredAt: state.occurredAt,
    });
  }
  return Object.freeze({
    eventType: "AnalyticsLoadCompleted",
    runReference: run.runReference,
    pipelineVersionReference: run.pipelineVersionReference,
    outputDatasetVersionReference: run.outputDatasetVersionReference,
    outputPartitionCode: run.outputPartitionCode,
    status: state.status,
    watermarkOccurredAt: state.watermarkOccurredAt,
    occurredAt: state.occurredAt,
  });
}

export function createPipelineRunService(ports: PipelineRunPorts) {
  return Object.freeze({
    async createRun(input: {
      readonly operationReference: ReportingReference;
      readonly run: PipelineRunSnapshot;
      readonly initialState: PipelineRunStateSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "run", "initialState", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const run = createPipelineRunSnapshot(input.run);
      const state = createPipelineRunStateSnapshot(input.initialState);
      if (
        run.queuedAt !== at ||
        state.occurredAt !== at ||
        state.runReference !== run.runReference ||
        state.sequence !== 1 ||
        state.status !== "Queued"
      )
        invalid();
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(ports, "CreateRun", operationReference, run.runReference, at);
      if (
        !sameScope(run.scope, auth.scope) ||
        !sameScope(state.scope, run.scope) ||
        run.requestedByActorReference !== auth.actor ||
        state.actorReference !== auth.actor ||
        (await ports.repository.loadRun(run.runReference).catch(dependency)) !== null
      )
        throw new PipelineWorkflowError("PIPELINE_VERSION_CONFLICT");
      const logicalBatchRun = await ports.repository
        .loadRunByLogicalBatch(run.logicalBatchDigest)
        .catch(dependency);
      if (run.executionKind === "Retry") {
        if (
          logicalBatchRun === null ||
          run.retryOfRunReference !== logicalBatchRun.runReference ||
          !sameRetryIntent(run, logicalBatchRun)
        )
          throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
        const priorState = await ports.repository
          .loadLatestRunState(logicalBatchRun.runReference)
          .catch(dependency);
        if (priorState?.status !== "Failed")
          throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
      } else if (logicalBatchRun !== null) {
        throw new PipelineWorkflowError("PIPELINE_IDEMPOTENCY_CONFLICT");
      }
      if (run.backfillRequestVersionReference !== null) {
        const request = await ports.repository
          .loadBackfillVersion(run.backfillRequestVersionReference)
          .catch(dependency);
        if (
          request === null ||
          request.lifecycle !== "Approved" ||
          !sameScope(request.scope, run.scope) ||
          request.pipelineReference !== run.pipelineReference ||
          request.pipelineVersionReference !== run.pipelineVersionReference ||
          request.transformationVersionReference !== run.transformationVersionReference ||
          request.outputDatasetVersionReference !== run.outputDatasetVersionReference ||
          request.outputPartitionCode !== run.outputPartitionCode
        )
          throw new PipelineWorkflowError("PIPELINE_APPROVAL_REQUIRED");
      }
      const operation: PipelineOperationRecord = Object.freeze({
        action: "CreateRun",
        operationReference,
        operationIntentHash: intent,
        resultReference: run.runReference,
        event: null,
      });
      const committed = await ports.repository
        .commitRun({ operation, run, state, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },
    async advanceRun(input: {
      readonly operationReference: ReportingReference;
      readonly expectedSequence: number;
      readonly state: PipelineRunStateSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "expectedSequence", "state", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const state = createPipelineRunStateSnapshot(input.state);
      if (state.occurredAt !== at) invalid();
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await idempotency(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          reference: prior.resultReference,
        });
      const auth = await authorize(ports, "AdvanceRun", operationReference, state.runReference, at);
      const run = await ports.repository.loadRun(state.runReference).catch(dependency);
      const current = await ports.repository
        .loadLatestRunState(state.runReference)
        .catch(dependency);
      if (
        run === null ||
        current === null ||
        input.expectedSequence !== current.sequence ||
        state.sequence !== current.sequence + 1 ||
        !sameScope(state.scope, run.scope) ||
        !sameScope(state.scope, auth.scope) ||
        state.actorReference !== auth.actor ||
        Date.parse(state.occurredAt) < Date.parse(current.occurredAt)
      )
        throw new PipelineWorkflowError("PIPELINE_VERSION_CONFLICT");
      if (!(
        (current.status === "Queued" && ["Running", "Cancelled"].includes(state.status)) ||
        (current.status === "Running" &&
          ["Succeeded", "SucceededWithWarning", "Failed", "Cancelled"].includes(state.status))
      ))
        throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
      const reconciled = state.postReconciliationRunReference !== null;
      if (
        (run.preReconciliationRunReference !== null &&
          ["Succeeded", "SucceededWithWarning"].includes(state.status)) !== reconciled
      )
        throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
      const operation: PipelineOperationRecord = Object.freeze({
        action: "AdvanceRun",
        operationReference,
        operationIntentHash: intent,
        resultReference: state.stateReference,
        event: runEvent(run, state),
      });
      const committed = await ports.repository
        .commitRunState({
          operation,
          state,
          expectedSequence: input.expectedSequence,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },
    async recordBackfill(input: {
      readonly action: Exclude<PipelineAction, "CreateRun" | "AdvanceRun">;
      readonly operationReference: ReportingReference;
      readonly expectedAggregateVersion: number | null;
      readonly candidate: BackfillRequestSnapshot;
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
      const candidate = createBackfillRequestSnapshot(input.candidate);
      if (candidate.recordedAt !== at) invalid();
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
        candidate.requestReference,
        at,
      );
      if (
        !sameScope(candidate.scope, auth.scope) ||
        candidate.recordedByActorReference !== auth.actor
      )
        throw new PipelineWorkflowError("PIPELINE_PERMISSION_DENIED");
      const current = await ports.repository
        .loadBackfill(candidate.requestReference)
        .catch(dependency);
      const target: Record<typeof input.action, BackfillRequestSnapshot["lifecycle"]> = {
        RequestBackfill: "Requested",
        ApproveBackfill: "Approved",
        RejectBackfill: "Rejected",
        BindBackfill: "Running",
        CompleteBackfill: "Completed",
        FailBackfill: "Failed",
        CancelBackfill: "Cancelled",
      };
      if (input.action === "RequestBackfill") {
        if (
          current !== null ||
          input.expectedAggregateVersion !== null ||
          candidate.aggregateVersion !== 1 ||
          candidate.versionNumber !== 1 ||
          candidate.lifecycle !== "Requested" ||
          candidate.requestedByActorReference !== auth.actor
        )
          throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
      } else {
        if (
          current === null ||
          input.expectedAggregateVersion !== current.aggregateVersion ||
          candidate.aggregateVersion !== current.aggregateVersion + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.requestReference !== current.requestReference ||
          !sameScope(candidate.scope, current.scope) ||
          !sameBackfillSemantic(candidate, current) ||
          Date.parse(candidate.recordedAt) < Date.parse(current.recordedAt) ||
          candidate.lifecycle !== target[input.action]
        )
          throw new PipelineWorkflowError("PIPELINE_VERSION_CONFLICT");
        const transition = `${current.lifecycle}:${candidate.lifecycle}`;
        if (
          ![
            "Requested:Approved",
            "Requested:Rejected",
            "Requested:Cancelled",
            "Approved:Running",
            "Approved:Cancelled",
            "Running:Completed",
            "Running:Failed",
            "Running:Cancelled",
          ].includes(transition)
        )
          throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
        if (
          ["ApproveBackfill", "RejectBackfill"].includes(input.action) &&
          candidate.decidedByActorReference !== auth.actor
        )
          throw new PipelineWorkflowError("PIPELINE_PERMISSION_DENIED");
        if (
          !["ApproveBackfill", "RejectBackfill"].includes(input.action) &&
          (candidate.decidedAt !== current.decidedAt ||
            candidate.decidedByActorReference !== current.decidedByActorReference)
        )
          throw new PipelineWorkflowError("PIPELINE_VERSION_CONFLICT");
        if (
          input.action !== "BindBackfill" &&
          candidate.boundRunReference !== current.boundRunReference
        )
          throw new PipelineWorkflowError("PIPELINE_VERSION_CONFLICT");
        if (input.action === "BindBackfill") {
          const boundRunReference = candidate.boundRunReference;
          if (boundRunReference === null) throw new PipelineWorkflowError("PIPELINE_INPUT_INVALID");
          const run = await ports.repository.loadRun(boundRunReference).catch(dependency);
          if (
            run === null ||
            run.backfillRequestVersionReference !== current.requestVersionReference ||
            !["Backfill", "Rebuild"].includes(run.executionKind)
          )
            throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
        }
        if (["CompleteBackfill", "FailBackfill"].includes(input.action)) {
          const boundRunReference = candidate.boundRunReference;
          if (boundRunReference === null) throw new PipelineWorkflowError("PIPELINE_INPUT_INVALID");
          const state = await ports.repository
            .loadLatestRunState(boundRunReference)
            .catch(dependency);
          if (
            state === null ||
            (input.action === "CompleteBackfill"
              ? !["Succeeded", "SucceededWithWarning"].includes(state.status)
              : state.status !== "Failed")
          )
            throw new PipelineWorkflowError("PIPELINE_LIFECYCLE_CONFLICT");
        }
      }
      const operation: PipelineOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        resultReference: candidate.requestVersionReference,
        event: null,
      });
      const committed = await ports.repository
        .commitBackfill({
          operation,
          request: candidate,
          expectedAggregateVersion: input.expectedAggregateVersion,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, reference: committed.resultReference });
    },
  });
}
