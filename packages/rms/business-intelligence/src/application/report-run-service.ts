import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  type ReportingReference,
  type ReportingScope,
} from "../contracts/report-definition.js";
import {
  createReportArtifactRevisionSnapshot,
  createReportArtifactRevocationSnapshot,
  createReportRunSnapshot,
  createReportRunStateSnapshot,
  type ReportArtifactRevisionSnapshot,
  type ReportRunSnapshot,
  type ReportRunStateSnapshot,
} from "../contracts/report-run.js";
import type {
  ReportRunAction,
  ReportRunOperationRecord,
  ReportRunPorts,
} from "./ports/report-run-ports.js";

export type ReportRunErrorCode =
  | "REPORT_RUN_INPUT_INVALID"
  | "REPORT_RUN_PERMISSION_DENIED"
  | "REPORT_RUN_IDEMPOTENCY_CONFLICT"
  | "REPORT_RUN_DEFINITION_CONFLICT"
  | "REPORT_RUN_STATE_CONFLICT"
  | "REPORT_ARTIFACT_CONFLICT"
  | "REPORT_ARTIFACT_UNAVAILABLE"
  | "REPORT_RUN_DEPENDENCY_UNAVAILABLE";
export class ReportRunError extends Error {
  constructor(readonly code: ReportRunErrorCode) {
    super("Report Run operation is unavailable");
    this.name = "ReportRunError";
  }
}
const invalid = (): never => {
  throw new ReportRunError("REPORT_RUN_INPUT_INVALID");
};
const dependency = (error: unknown): never => {
  if (error instanceof ReportRunError) throw error;
  throw new ReportRunError("REPORT_RUN_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
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
const sameScope = (left: ReportingScope, right: ReportingScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const sameRefs = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const permissionByAction: Record<ReportRunAction, string> = {
  Queue: "reporting.run.execute",
  Rerun: "reporting.run.execute",
  Transition: "reporting.run.operate",
  RecordArtifact: "reporting.artifact.manage",
  RevokeArtifact: "reporting.artifact.manage",
  DownloadArtifact: "reporting.artifact.download",
};
async function authorize(
  ports: ReportRunPorts,
  action: ReportRunAction,
  operationReference: ReportingReference,
  targetReference: ReportingReference,
  at: string,
) {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, targetReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new ReportRunError("REPORT_RUN_PERMISSION_DENIED");
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
      audit.actionCode !== `REPORT_RUN_${action.toUpperCase()}` ||
      audit.targetType !== (action.includes("Artifact") ? "ReportArtifact" : "ReportRun") ||
      audit.targetId !== targetReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return Object.freeze({
      actor: parseReportingReference(actor),
      scope: Object.freeze({
        tenantReference: parseReportingReference(evidence.tenantReference),
        brandReference: parseReportingReference(context.brand.brandReference),
        storeReference:
          context.store === null ? null : parseReportingReference(context.store.storeReference),
      }),
      audit,
    });
  } catch {
    throw new ReportRunError("REPORT_RUN_PERMISSION_DENIED");
  }
}
async function operation(
  ports: ReportRunPorts,
  reference: ReportingReference,
  intent: ReturnType<typeof parseReportingDigest>,
) {
  const prior = await ports.repository.resolveOperation(reference).catch(dependency);
  if (prior !== null && !ports.references.equals(prior.intentDigest, intent))
    throw new ReportRunError("REPORT_RUN_IDEMPOTENCY_CONFLICT");
  return prior;
}
const result = <T extends ReportRunOperationRecord["result"]["kind"]>(
  record: ReportRunOperationRecord,
  kind: T,
) => {
  if (record.result.kind !== kind) throw new ReportRunError("REPORT_RUN_IDEMPOTENCY_CONFLICT");
  return record.result as Extract<ReportRunOperationRecord["result"], { readonly kind: T }>;
};

export function createReportRunService(ports: ReportRunPorts) {
  return Object.freeze({
    async queue(input: {
      readonly action: "Queue" | "Rerun";
      readonly operationReference: ReportingReference;
      readonly candidate: ReportRunSnapshot;
      readonly initialState: ReportRunStateSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["action", "operationReference", "candidate", "initialState", "occurredAt"]);
      if (input.action !== "Queue" && input.action !== "Rerun") invalid();
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportRunSnapshot(input.candidate);
      const state = createReportRunStateSnapshot(input.initialState);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await operation(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...result(prior, "Run") });
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.runReference,
        at,
      );
      if (
        !sameScope(candidate.scope, auth.scope) ||
        candidate.triggeredByActorReference !== auth.actor ||
        candidate.queuedAt !== at ||
        state.runReference !== candidate.runReference ||
        state.sequence !== 1 ||
        state.status !== "Queued" ||
        state.occurredAt !== at ||
        state.actorReference !== auth.actor ||
        (input.action === "Queue") !== (candidate.rerunOfRunReference === null)
      )
        throw new ReportRunError("REPORT_RUN_PERMISSION_DENIED");
      if (await ports.repository.loadRun(candidate.runReference).catch(dependency))
        throw new ReportRunError("REPORT_RUN_STATE_CONFLICT");
      const definition = await ports.repository
        .loadReportDefinition(candidate.reportReference)
        .catch(dependency);
      if (
        definition === null ||
        definition.lifecycle !== "Published" ||
        definition.certificationStatus !== "Certified" ||
        definition.versionReference !== candidate.reportVersionReference ||
        !sameScope(definition.scope, candidate.scope) ||
        !sameRefs(definition.metricVersionReferences, candidate.metricVersionReferences)
      )
        throw new ReportRunError("REPORT_RUN_DEFINITION_CONFLICT");
      if (input.action === "Rerun") {
        const source = await ports.repository
          .loadRun(candidate.rerunOfRunReference as ReportingReference)
          .catch(dependency);
        if (
          source === null ||
          source.reportVersionReference !== candidate.reportVersionReference ||
          !sameScope(source.scope, candidate.scope) ||
          !sameRefs(source.metricVersionReferences, candidate.metricVersionReferences) ||
          source.parameterSnapshotDigest !== candidate.parameterSnapshotDigest
        )
          throw new ReportRunError("REPORT_RUN_DEFINITION_CONFLICT");
      }
      const record: ReportRunOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        event: Object.freeze({
          eventType: "ReportRunQueued",
          runReference: candidate.runReference,
          reportReference: candidate.reportReference,
          reportVersionReference: candidate.reportVersionReference,
          parameterSnapshotDigest: candidate.parameterSnapshotDigest,
          triggerKind: candidate.triggerKind,
          queuedAt: candidate.queuedAt,
        }),
        result: Object.freeze({ kind: "Run", run: candidate, state }),
      });
      const committed = await ports.repository
        .commitRun({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, ...result(committed, "Run") });
    },
    async transition(input: {
      readonly operationReference: ReportingReference;
      readonly expectedSequence: number;
      readonly candidate: ReportRunStateSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "expectedSequence", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportRunStateSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await operation(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          state: result(prior, "State").state,
        });
      const run = await ports.repository.loadRun(candidate.runReference).catch(dependency);
      const current = await ports.repository
        .loadLatestState(candidate.runReference)
        .catch(dependency);
      if (
        run === null ||
        current === null ||
        current.sequence !== input.expectedSequence ||
        candidate.sequence !== current.sequence + 1 ||
        candidate.occurredAt !== at
      )
        throw new ReportRunError("REPORT_RUN_STATE_CONFLICT");
      const auth = await authorize(
        ports,
        "Transition",
        operationReference,
        candidate.runReference,
        at,
      );
      const allowed =
        (current.status === "Queued" && ["Running", "Cancelled"].includes(candidate.status)) ||
        (current.status === "Running" &&
          ["Completed", "CompletedWithWarning", "Failed", "Cancelled"].includes(candidate.status));
      if (!allowed || !sameScope(run.scope, auth.scope) || candidate.actorReference !== auth.actor)
        throw new ReportRunError("REPORT_RUN_STATE_CONFLICT");
      const record: ReportRunOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        event: Object.freeze({
          eventType: "ReportRunStateRecorded",
          runReference: candidate.runReference,
          stateReference: candidate.stateReference,
          sequence: candidate.sequence,
          status: candidate.status,
          dataAsOf: candidate.dataAsOf,
          generatedAt: candidate.generatedAt,
          rowCount: candidate.rowCount,
          summaryDigest: candidate.summaryDigest,
          errorCode: candidate.errorCode,
          occurredAt: candidate.occurredAt,
        }),
        result: Object.freeze({ kind: "State", state: candidate }),
      });
      const committed = await ports.repository
        .commitState({ record, expectedSequence: input.expectedSequence, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, state: result(committed, "State").state });
    },
    async recordArtifact(input: {
      readonly operationReference: ReportingReference;
      readonly expectedRevision: number | null;
      readonly candidate: ReportArtifactRevisionSnapshot;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "expectedRevision", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportArtifactRevisionSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await operation(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          artifact: result(prior, "Artifact").artifact,
        });
      const run = await ports.repository.loadRun(candidate.runReference).catch(dependency);
      const state = await ports.repository
        .loadLatestState(candidate.runReference)
        .catch(dependency);
      if (
        run === null ||
        state === null ||
        !["Completed", "CompletedWithWarning"].includes(state.status) ||
        candidate.createdAt !== at
      )
        throw new ReportRunError("REPORT_ARTIFACT_CONFLICT");
      const auth = await authorize(
        ports,
        "RecordArtifact",
        operationReference,
        candidate.artifactReference,
        at,
      );
      const current = await ports.repository
        .loadArtifact(candidate.artifactReference)
        .catch(dependency);
      if (
        !sameScope(run.scope, auth.scope) ||
        candidate.createdByActorReference !== auth.actor ||
        (input.expectedRevision === null
          ? current !== null || candidate.revisionNumber !== 1
          : current === null ||
            current.revisionNumber !== input.expectedRevision ||
            candidate.revisionNumber !== input.expectedRevision + 1 ||
            current.runReference !== candidate.runReference)
      )
        throw new ReportRunError("REPORT_ARTIFACT_CONFLICT");
      const record: ReportRunOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        event: Object.freeze({
          eventType: "ReportArtifactRevisionRecorded",
          artifactReference: candidate.artifactReference,
          revisionReference: candidate.revisionReference,
          runReference: candidate.runReference,
          revisionNumber: candidate.revisionNumber,
          outputAssetReference: candidate.outputAssetReference,
          format: candidate.format,
          classification: candidate.classification,
          expiresAt: candidate.expiresAt,
          occurredAt: candidate.createdAt,
        }),
        result: Object.freeze({ kind: "Artifact", artifact: candidate }),
      });
      const committed = await ports.repository
        .commitArtifact({ record, expectedRevision: input.expectedRevision, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        artifact: result(committed, "Artifact").artifact,
      });
    },
    async revokeArtifact(input: {
      readonly operationReference: ReportingReference;
      readonly candidate: unknown;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportArtifactRevocationSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await operation(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          revocation: result(prior, "Revocation").revocation,
        });
      const artifact = await ports.repository
        .loadArtifactRevision(candidate.revisionReference)
        .catch(dependency);
      if (
        artifact === null ||
        artifact.artifactReference !== candidate.artifactReference ||
        Date.parse(at) < Date.parse(artifact.createdAt) ||
        (await ports.repository
          .loadArtifactRevocation(candidate.revisionReference)
          .catch(dependency))
      )
        throw new ReportRunError("REPORT_ARTIFACT_CONFLICT");
      const run = await ports.repository.loadRun(artifact.runReference).catch(dependency);
      const auth = await authorize(
        ports,
        "RevokeArtifact",
        operationReference,
        candidate.artifactReference,
        at,
      );
      if (
        run === null ||
        !sameScope(run.scope, auth.scope) ||
        candidate.revokedAt !== at ||
        candidate.revokedByActorReference !== auth.actor
      )
        throw new ReportRunError("REPORT_ARTIFACT_CONFLICT");
      const record: ReportRunOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        event: Object.freeze({
          eventType: "ReportArtifactRevoked",
          artifactReference: candidate.artifactReference,
          revisionReference: candidate.revisionReference,
          reasonCode: candidate.reasonCode,
          revokedAt: candidate.revokedAt,
        }),
        result: Object.freeze({ kind: "Revocation", revocation: candidate }),
      });
      const committed = await ports.repository
        .commitRevocation({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        revocation: result(committed, "Revocation").revocation,
      });
    },
    async authorizeDownload(input: {
      readonly operationReference: ReportingReference;
      readonly revisionReference: ReportingReference;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "revisionReference", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const revisionReference = parseReportingReference(input.revisionReference);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await operation(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          authorization: result(prior, "DownloadAuthorization"),
        });
      const artifact = await ports.repository
        .loadArtifactRevision(revisionReference)
        .catch(dependency);
      if (
        artifact === null ||
        Date.parse(at) >= Date.parse(artifact.expiresAt) ||
        (await ports.repository.loadArtifactRevocation(revisionReference).catch(dependency))
      )
        throw new ReportRunError("REPORT_ARTIFACT_UNAVAILABLE");
      const run = await ports.repository.loadRun(artifact.runReference).catch(dependency);
      const auth = await authorize(
        ports,
        "DownloadArtifact",
        operationReference,
        artifact.artifactReference,
        at,
      );
      if (run === null || !sameScope(run.scope, auth.scope))
        throw new ReportRunError("REPORT_ARTIFACT_UNAVAILABLE");
      const authorization = Object.freeze({
        kind: "DownloadAuthorization" as const,
        revisionReference,
        authorizedAt: at,
      });
      const record: ReportRunOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        event: null,
        result: authorization,
      });
      const committed = await ports.repository
        .commitDownloadAudit({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        authorization: result(committed, "DownloadAuthorization"),
      });
    },
  });
}
