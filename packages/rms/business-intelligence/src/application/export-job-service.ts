import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createExportAccessGrantSnapshot,
  createExportArtifactSnapshot,
  createExportGrantConsumptionSnapshot,
  createExportJobSnapshot,
  createExportJobStateSnapshot,
  createExportRevocationSnapshot,
  type ExportArtifactSnapshot,
  type ExportJobSnapshot,
} from "../contracts/export-job.js";
import {
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  type ReportingReference,
} from "../contracts/report-definition.js";
import type {
  ExportJobAction,
  ExportJobPorts,
  ExportOperationRecord,
} from "./ports/export-job-ports.js";

export class ExportJobServiceError extends Error {
  constructor(
    readonly code:
      | "EXPORT_INPUT_INVALID"
      | "EXPORT_PERMISSION_DENIED"
      | "EXPORT_SOURCE_DENIED"
      | "EXPORT_STATE_CONFLICT"
      | "EXPORT_ARTIFACT_UNAVAILABLE"
      | "EXPORT_GRANT_UNAVAILABLE"
      | "EXPORT_IDEMPOTENCY_CONFLICT"
      | "EXPORT_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Export operation is unavailable");
    this.name = "ExportJobServiceError";
  }
}
const invalid = (): never => {
  throw new ExportJobServiceError("EXPORT_INPUT_INVALID");
};
const dependency = (error: unknown): never => {
  if (error instanceof ExportJobServiceError) throw error;
  throw new ExportJobServiceError("EXPORT_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const permissions: Record<ExportJobAction, string> = {
  Queue: "reporting.export.create",
  Transition: "reporting.export.operate",
  Revoke: "reporting.export.revoke",
  IssueGrant: "reporting.export.download",
  ConsumeGrant: "reporting.export.download",
};
const sameScope = (
  job: ExportJobSnapshot,
  tenantReference: string,
  brandReference: string,
  storeReference: string | undefined,
) =>
  job.scope.tenantReference === tenantReference &&
  job.scope.brandReference === brandReference &&
  job.scope.storeReference === (storeReference ?? null);
async function authorize(
  ports: ExportJobPorts,
  action: ExportJobAction,
  operationReference: ReportingReference,
  targetReference: ReportingReference,
  at: string,
) {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, targetReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new ExportJobServiceError("EXPORT_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext),
      audit = validateAuditRecord(evidence.audit, Date.parse(at)),
      actor = context.actor.actorReference;
    if (
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[action] ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== context.store?.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `EXPORT_${action.toUpperCase()}` ||
      audit.targetType !== "ExportJob" ||
      audit.targetId !== targetReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return Object.freeze({
      tenantReference: parseReportingReference(evidence.tenantReference),
      brandReference: parseReportingReference(context.brand.brandReference),
      storeReference:
        context.store === null ? null : parseReportingReference(context.store.storeReference),
      actor: parseReportingReference(actor),
      audit,
    });
  } catch {
    throw new ExportJobServiceError("EXPORT_PERMISSION_DENIED");
  }
}
async function replay(
  ports: ExportJobPorts,
  reference: ReportingReference,
  intent: ReturnType<typeof parseReportingDigest>,
) {
  const prior = await ports.repository.resolveOperation(reference).catch(dependency);
  if (prior !== null && !ports.references.equals(prior.intentDigest, intent))
    throw new ExportJobServiceError("EXPORT_IDEMPOTENCY_CONFLICT");
  return prior;
}
const result = <T extends ExportOperationRecord["result"]["kind"]>(
  record: ExportOperationRecord,
  kind: T,
) => {
  if (record.result.kind !== kind) throw new ExportJobServiceError("EXPORT_IDEMPOTENCY_CONFLICT");
  return record.result as Extract<ExportOperationRecord["result"], { readonly kind: T }>;
};
export function createExportJobService(ports: ExportJobPorts) {
  return Object.freeze({
    async queue(input: {
      readonly operationReference: ReportingReference;
      readonly candidate: ExportJobSnapshot;
      readonly initialState: unknown;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "candidate", "initialState", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt),
        operationReference = parseReportingReference(input.operationReference),
        candidate = createExportJobSnapshot(input.candidate),
        state = createExportJobStateSnapshot(input.initialState),
        intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input))),
        prior = await replay(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...result(prior, "Job") });
      const auth = await authorize(ports, "Queue", operationReference, candidate.jobReference, at),
        source = await ports.source.authorize(candidate).catch(dependency);
      if (
        source === null ||
        !sameScope(
          candidate,
          auth.tenantReference,
          auth.brandReference,
          auth.storeReference ?? undefined,
        ) ||
        candidate.requestedByActorReference !== auth.actor ||
        candidate.requestedAt !== at ||
        state.jobReference !== candidate.jobReference ||
        state.sequence !== 1 ||
        state.status !== "Queued" ||
        state.actorReference !== auth.actor ||
        state.occurredAt !== at ||
        source.sourceScreenId !== candidate.sourceScreenId ||
        source.sourceViewReference !== candidate.sourceViewReference ||
        source.sourceProjection !== candidate.sourceProjection ||
        source.sourceCheckpoint !== candidate.sourceCheckpoint ||
        source.classification !== candidate.classification ||
        candidate.selectedFieldKeys.some((field) => !source.permittedFieldKeys.includes(field)) ||
        (["Confidential", "Restricted"].includes(candidate.classification) &&
          !source.stepUpSatisfied)
      )
        throw new ExportJobServiceError("EXPORT_SOURCE_DENIED");
      if (await ports.repository.loadJob(candidate.jobReference).catch(dependency))
        throw new ExportJobServiceError("EXPORT_STATE_CONFLICT");
      const record: ExportOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        result: Object.freeze({ kind: "Job", job: candidate, state }),
      });
      const committed = await ports.repository
        .commitJob({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, ...result(committed, "Job") });
    },
    async transition(input: {
      readonly operationReference: ReportingReference;
      readonly expectedSequence: number;
      readonly candidate: unknown;
      readonly artifact: unknown | null;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedSequence",
        "candidate",
        "artifact",
        "occurredAt",
      ]);
      const at = parseReportingInstant(input.occurredAt),
        operationReference = parseReportingReference(input.operationReference),
        state = createExportJobStateSnapshot(input.candidate),
        artifact = input.artifact === null ? null : createExportArtifactSnapshot(input.artifact),
        intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input))),
        prior = await replay(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...result(prior, "State") });
      const job = await ports.repository.loadJob(state.jobReference).catch(dependency),
        current = await ports.repository.loadLatestState(state.jobReference).catch(dependency);
      if (
        job === null ||
        current === null ||
        current.sequence !== input.expectedSequence ||
        state.sequence !== current.sequence + 1 ||
        state.occurredAt !== at
      )
        throw new ExportJobServiceError("EXPORT_STATE_CONFLICT");
      const auth = await authorize(ports, "Transition", operationReference, state.jobReference, at),
        allowed =
          (current.status === "Queued" && ["Running", "Cancelled"].includes(state.status)) ||
          (current.status === "Running" &&
            ["Completed", "Failed", "Cancelled"].includes(state.status));
      if (
        !allowed ||
        !sameScope(
          job,
          auth.tenantReference,
          auth.brandReference,
          auth.storeReference ?? undefined,
        ) ||
        state.actorReference !== auth.actor ||
        (state.status === "Completed") !== (artifact !== null) ||
        (artifact !== null &&
          (artifact.jobReference !== job.jobReference ||
            artifact.format !== job.format ||
            artifact.classification !== job.classification ||
            artifact.rowCount !== state.rowCount ||
            artifact.byteCount !== state.artifactByteCount ||
            artifact.createdAt !== at))
      )
        throw new ExportJobServiceError("EXPORT_STATE_CONFLICT");
      const record: ExportOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        result: Object.freeze({ kind: "State", state, artifact }),
      });
      const committed = await ports.repository
        .commitState({ record, expectedSequence: input.expectedSequence, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, ...result(committed, "State") });
    },
    async issueGrant(input: {
      readonly operationReference: ReportingReference;
      readonly candidate: unknown;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt),
        operationReference = parseReportingReference(input.operationReference),
        grant = createExportAccessGrantSnapshot(input.candidate),
        intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input))),
        prior = await replay(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          grant: result(prior, "Grant").grant,
        });
      const artifact = await ports.repository
        .loadArtifact(grant.artifactReference)
        .catch(dependency);
      if (
        artifact === null ||
        Date.parse(artifact.expiresAt) <= Date.parse(at) ||
        grant.issuedAt !== at
      )
        throw new ExportJobServiceError("EXPORT_ARTIFACT_UNAVAILABLE");
      const job = await ports.repository.loadJob(artifact.jobReference).catch(dependency),
        revocation = await ports.repository.loadRevocation(artifact.jobReference).catch(dependency),
        auth = await authorize(ports, "IssueGrant", operationReference, artifact.jobReference, at);
      if (
        job === null ||
        revocation !== null ||
        !sameScope(
          job,
          auth.tenantReference,
          auth.brandReference,
          auth.storeReference ?? undefined,
        ) ||
        grant.actorReference !== auth.actor
      )
        throw new ExportJobServiceError("EXPORT_ARTIFACT_UNAVAILABLE");
      const record: ExportOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        result: Object.freeze({ kind: "Grant", grant }),
      });
      const committed = await ports.repository
        .commitGrant({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, grant: result(committed, "Grant").grant });
    },
    async consumeGrant(input: {
      readonly operationReference: ReportingReference;
      readonly candidate: unknown;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt),
        operationReference = parseReportingReference(input.operationReference),
        consumption = createExportGrantConsumptionSnapshot(input.candidate),
        intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input))),
        prior = await replay(ports, operationReference, intent);
      if (prior !== null) throw new ExportJobServiceError("EXPORT_GRANT_UNAVAILABLE");
      const grant = await ports.repository.loadGrant(consumption.grantReference).catch(dependency),
        existing = await ports.repository
          .loadConsumption(consumption.grantReference)
          .catch(dependency),
        artifact = await ports.repository
          .loadArtifact(consumption.artifactReference)
          .catch(dependency);
      if (
        grant === null ||
        existing !== null ||
        artifact === null ||
        grant.artifactReference !== artifact.artifactReference ||
        grant.actorReference !== consumption.actorReference ||
        consumption.consumedAt !== at ||
        Date.parse(grant.issuedAt) > Date.parse(at) ||
        Date.parse(grant.expiresAt) <= Date.parse(at) ||
        Date.parse(artifact.expiresAt) <= Date.parse(at)
      )
        throw new ExportJobServiceError("EXPORT_GRANT_UNAVAILABLE");
      const job = await ports.repository.loadJob(artifact.jobReference).catch(dependency),
        revocation = await ports.repository.loadRevocation(artifact.jobReference).catch(dependency),
        auth = await authorize(
          ports,
          "ConsumeGrant",
          operationReference,
          artifact.jobReference,
          at,
        );
      if (
        job === null ||
        revocation !== null ||
        auth.actor !== consumption.actorReference ||
        !sameScope(job, auth.tenantReference, auth.brandReference, auth.storeReference ?? undefined)
      )
        throw new ExportJobServiceError("EXPORT_GRANT_UNAVAILABLE");
      const record: ExportOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        result: Object.freeze({ kind: "Consumption", consumption }),
      });
      const committed = await ports.repository
        .consumeGrant({ record, audit: auth.audit })
        .catch(dependency);
      result(committed, "Consumption");
      return Object.freeze({
        objectEvidenceReference: artifact.objectEvidenceReference,
        contentDisposition: "attachment",
        cacheControl: "no-store",
      });
    },
    async revoke(input: {
      readonly operationReference: ReportingReference;
      readonly candidate: unknown;
      readonly occurredAt: string;
    }) {
      exact(input, ["operationReference", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt),
        operationReference = parseReportingReference(input.operationReference),
        revocation = createExportRevocationSnapshot(input.candidate),
        intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input))),
        prior = await replay(ports, operationReference, intent);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          revocation: result(prior, "Revocation").revocation,
        });
      const job = await ports.repository.loadJob(revocation.jobReference).catch(dependency),
        current = await ports.repository.loadRevocation(revocation.jobReference).catch(dependency),
        artifact: ExportArtifactSnapshot | null = await ports.repository
          .loadArtifactForJob(revocation.jobReference)
          .catch(dependency),
        auth = await authorize(ports, "Revoke", operationReference, revocation.jobReference, at);
      if (
        job === null ||
        current !== null ||
        revocation.revokedAt !== at ||
        revocation.revokedByActorReference !== auth.actor ||
        !sameScope(
          job,
          auth.tenantReference,
          auth.brandReference,
          auth.storeReference ?? undefined,
        ) ||
        revocation.artifactReference !== (artifact?.artifactReference ?? null)
      )
        throw new ExportJobServiceError("EXPORT_STATE_CONFLICT");
      const record: ExportOperationRecord = Object.freeze({
        operationReference,
        intentDigest: intent,
        result: Object.freeze({ kind: "Revocation", revocation }),
      });
      const committed = await ports.repository
        .commitRevocation({ record, audit: auth.audit })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        revocation: result(committed, "Revocation").revocation,
      });
    },
  });
}
