import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  createPublishingApprovalEvidence,
  createPublishingScope,
  createPublishingValidationEvidence,
  type PublishingApprovalEvidence,
  type PublishingValidationEvidence,
} from "@bop/publishing";
import { revalidateTenantContext } from "@bop/permission";
import {
  createReportDefinitionSnapshot,
  createReportScheduleSnapshot,
  parseReportingDigest,
  parseReportingReference,
  parseReportingInstant,
  type ReportDefinitionSnapshot,
  type ReportScheduleSnapshot,
  type ReportingReference,
} from "../contracts/report-definition.js";
import type {
  ReportDefinitionAction,
  ReportDefinitionEvent,
  ReportDefinitionOperationRecord,
  ReportDefinitionPorts,
  ReportScheduleEvent,
  ReportScheduleOperationRecord,
} from "./ports/report-definition-ports.js";

export type ReportingWorkflowErrorCode =
  | "REPORTING_INPUT_INVALID"
  | "REPORTING_PERMISSION_DENIED"
  | "REPORTING_VERSION_CONFLICT"
  | "REPORTING_IDEMPOTENCY_CONFLICT"
  | "REPORTING_CODE_CONFLICT"
  | "REPORTING_LIFECYCLE_CONFLICT"
  | "REPORTING_VALIDATION_REQUIRED"
  | "REPORTING_APPROVAL_REQUIRED"
  | "REPORTING_SCHEDULE_CONFLICT"
  | "REPORTING_DEPENDENCY_UNAVAILABLE";

export class ReportingWorkflowError extends Error {
  constructor(readonly code: ReportingWorkflowErrorCode) {
    super("Reporting operation is unavailable");
    this.name = "ReportingWorkflowError";
  }
}

const invalid = (): never => {
  throw new ReportingWorkflowError("REPORTING_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field)))
    return invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function dependency(error: unknown): never {
  if (error instanceof ReportingWorkflowError) throw error;
  throw new ReportingWorkflowError("REPORTING_DEPENDENCY_UNAVAILABLE");
}
function sameScope(
  left: ReportDefinitionSnapshot["scope"],
  right: ReportDefinitionSnapshot["scope"],
): boolean {
  return (
    left.tenantReference === right.tenantReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}
function event(
  action: ReportDefinitionAction,
  snapshot: ReportDefinitionSnapshot,
  at: string,
): ReportDefinitionEvent {
  const eventTypes: Record<ReportDefinitionAction, ReportDefinitionEvent["eventType"]> = {
    CreateDraft: "ReportDefinitionDraftCreated",
    ReplaceDraft: "ReportDefinitionDraftReplaced",
    SubmitReview: "ReportDefinitionReviewSubmitted",
    Publish: "ReportDefinitionPublished",
    Archive: "ReportDefinitionArchived",
  };
  return Object.freeze({
    eventType: eventTypes[action],
    reportReference: snapshot.reportReference,
    versionReference: snapshot.versionReference,
    tenantReference: snapshot.scope.tenantReference,
    brandReference: snapshot.scope.brandReference,
    storeReference: snapshot.scope.storeReference,
    aggregateVersion: snapshot.aggregateVersion,
    lifecycle: snapshot.lifecycle,
    certificationStatus: snapshot.certificationStatus,
    snapshotDigest: snapshot.snapshotDigest,
    occurredAt: at,
  });
}

async function authorize(
  ports: ReportDefinitionPorts,
  action: ReportDefinitionAction | "Schedule",
  operationReference: ReportingReference,
  reportReference: ReportingReference,
  at: string,
): Promise<{
  readonly actor: ReportingReference;
  readonly scope: ReportDefinitionSnapshot["scope"];
  readonly audit: AppendAuditRecordInput;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, reportReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new ReportingWorkflowError("REPORTING_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    const expectedPermission =
      action === "Publish"
        ? "reporting.definition.certify"
        : action === "Schedule"
          ? "reporting.schedule.manage"
          : "reporting.definition.manage";
    if (
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== expectedPermission ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== context.store?.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `REPORTING_${action.toUpperCase()}` ||
      audit.targetType !== "ReportDefinition" ||
      audit.targetId !== reportReference ||
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
    throw new ReportingWorkflowError("REPORTING_PERMISSION_DENIED");
  }
}

function publishingScope(snapshot: ReportDefinitionSnapshot) {
  return createPublishingScope({
    kind: snapshot.scope.storeReference === null ? "Brand" : "Store",
    brandReference: snapshot.scope.brandReference as never,
    storeReference: snapshot.scope.storeReference as never,
  });
}
function assertValidation(
  snapshot: ReportDefinitionSnapshot,
  raw: PublishingValidationEvidence | null,
  at: string,
) {
  if (raw === null) throw new ReportingWorkflowError("REPORTING_VALIDATION_REQUIRED");
  let evidence: PublishingValidationEvidence;
  try {
    evidence = createPublishingValidationEvidence(raw);
  } catch {
    throw new ReportingWorkflowError("REPORTING_VALIDATION_REQUIRED");
  }
  const scope = publishingScope(snapshot);
  if (
    String(evidence.snapshotReference) !== snapshot.versionReference ||
    String(evidence.snapshotDigest) !== snapshot.snapshotDigest ||
    evidence.scope.kind !== scope.kind ||
    evidence.scope.brandReference !== scope.brandReference ||
    evidence.scope.storeReference !== scope.storeReference ||
    Date.parse(evidence.validUntil) <= Date.parse(at) ||
    !["REPORT_LINEAGE", "REPORT_PERMISSION", "REPORT_SAMPLE"].every((code) =>
      evidence.checkCodes.includes(code as never),
    )
  )
    throw new ReportingWorkflowError("REPORTING_VALIDATION_REQUIRED");
  return evidence;
}
function assertApproval(
  snapshot: ReportDefinitionSnapshot,
  raw: PublishingApprovalEvidence | null,
  actor: ReportingReference,
  author: ReportingReference,
  at: string,
) {
  if (raw === null) throw new ReportingWorkflowError("REPORTING_APPROVAL_REQUIRED");
  let evidence: PublishingApprovalEvidence;
  try {
    evidence = createPublishingApprovalEvidence(raw);
  } catch {
    throw new ReportingWorkflowError("REPORTING_APPROVAL_REQUIRED");
  }
  const scope = publishingScope(snapshot);
  if (
    String(evidence.snapshotReference) !== snapshot.versionReference ||
    String(evidence.snapshotDigest) !== snapshot.snapshotDigest ||
    evidence.scope.kind !== scope.kind ||
    evidence.scope.brandReference !== scope.brandReference ||
    evidence.scope.storeReference !== scope.storeReference ||
    Date.parse(evidence.validUntil) <= Date.parse(at) ||
    String(evidence.approvedActorReference) !== actor ||
    actor === author
  )
    throw new ReportingWorkflowError("REPORTING_APPROVAL_REQUIRED");
  return evidence;
}

export interface ExecuteReportDefinitionInput {
  readonly action: ReportDefinitionAction;
  readonly operationReference: ReportingReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: ReportDefinitionSnapshot;
  readonly occurredAt: string;
}
export interface RecordReportScheduleInput {
  readonly operationReference: ReportingReference;
  readonly expectedScheduleVersion: number | null;
  readonly candidate: ReportScheduleSnapshot;
  readonly occurredAt: string;
}

export function createReportDefinitionService(ports: ReportDefinitionPorts) {
  return Object.freeze({
    async execute(input: ExecuteReportDefinitionInput) {
      exact(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "occurredAt",
      ]);
      if (
        !(["CreateDraft", "ReplaceDraft", "SubmitReview", "Publish", "Archive"] as const).includes(
          input.action,
        )
      )
        invalid();
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportDefinitionSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new ReportingWorkflowError("REPORTING_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          aggregate: createReportDefinitionSnapshot(prior.aggregate),
        });
      }
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.reportReference,
        at,
      );
      if (!sameScope(candidate.scope, auth.scope))
        throw new ReportingWorkflowError("REPORTING_PERMISSION_DENIED");
      const current = await ports.repository.load(candidate.reportReference).catch(dependency);
      let validation: PublishingValidationEvidence;
      let approval: PublishingApprovalEvidence | null = null;
      if (input.action === "CreateDraft") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.aggregateVersion !== 1 ||
          candidate.versionNumber !== 1 ||
          candidate.lifecycle !== "Draft" ||
          candidate.createdByActorReference !== auth.actor
        )
          throw new ReportingWorkflowError("REPORTING_LIFECYCLE_CONFLICT");
        if (
          !(await ports.repository
            .codeAvailable({ scope: candidate.scope, stableCode: candidate.stableCode })
            .catch(dependency))
        )
          throw new ReportingWorkflowError("REPORTING_CODE_CONFLICT");
        validation = assertValidation(
          candidate,
          await ports.publishing.validate(candidate).catch(dependency),
          at,
        );
      } else {
        const expected = positive(input.expectedAggregateVersion);
        if (current === null || current.aggregateVersion !== expected)
          throw new ReportingWorkflowError("REPORTING_VERSION_CONFLICT");
        const target = {
          ReplaceDraft: "Draft",
          SubmitReview: "InReview",
          Publish: "Published",
          Archive: "Archived",
        } as const;
        if (
          candidate.reportReference !== current.reportReference ||
          candidate.stableCode !== current.stableCode ||
          !sameScope(candidate.scope, current.scope) ||
          candidate.aggregateVersion !== expected + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.lifecycle !== target[input.action] ||
          candidate.createdAt !== at ||
          candidate.createdByActorReference !== auth.actor
        )
          throw new ReportingWorkflowError("REPORTING_INPUT_INVALID");
        if (
          (input.action === "ReplaceDraft" || input.action === "SubmitReview") &&
          current.lifecycle !== "Draft"
        )
          throw new ReportingWorkflowError("REPORTING_LIFECYCLE_CONFLICT");
        if (input.action === "Publish" && current.lifecycle !== "InReview")
          throw new ReportingWorkflowError("REPORTING_LIFECYCLE_CONFLICT");
        if (input.action === "Archive" && current.lifecycle === "Archived")
          throw new ReportingWorkflowError("REPORTING_LIFECYCLE_CONFLICT");
        validation = assertValidation(
          candidate,
          await ports.publishing.validate(candidate).catch(dependency),
          at,
        );
        if (input.action === "Publish") {
          approval = assertApproval(
            candidate,
            await ports.publishing.approve({ snapshot: candidate, validation }).catch(dependency),
            auth.actor,
            current.createdByActorReference,
            at,
          );
        }
      }
      const record: ReportDefinitionOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: event(input.action, candidate, at),
      });
      const committed =
        input.action === "CreateDraft"
          ? await ports.repository.create({ record, audit: auth.audit }).catch(dependency)
          : await ports.repository
              .commit({
                record,
                expectedAggregateVersion: positive(input.expectedAggregateVersion),
                validation,
                approval,
                audit: auth.audit,
              })
              .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: createReportDefinitionSnapshot(committed.aggregate),
      });
    },
    async schedule(input: RecordReportScheduleInput) {
      exact(input, ["operationReference", "expectedScheduleVersion", "candidate", "occurredAt"]);
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createReportScheduleSnapshot(input.candidate);
      if (candidate.createdAt !== at) invalid();
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository
        .resolveScheduleOperation(operationReference)
        .catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new ReportingWorkflowError("REPORTING_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          schedule: createReportScheduleSnapshot(prior.schedule),
        });
      }
      const report = await ports.repository.load(candidate.reportReference).catch(dependency);
      if (
        report === null ||
        report.lifecycle !== "Published" ||
        report.certificationStatus !== "Certified" ||
        report.versionReference !== candidate.reportVersionReference ||
        !sameScope(report.scope, candidate.scope) ||
        !report.exportFormats.includes(candidate.format)
      )
        throw new ReportingWorkflowError("REPORTING_SCHEDULE_CONFLICT");
      const auth = await authorize(
        ports,
        "Schedule",
        operationReference,
        candidate.reportReference,
        at,
      );
      if (
        !sameScope(candidate.scope, auth.scope) ||
        candidate.createdByActorReference !== auth.actor
      )
        throw new ReportingWorkflowError("REPORTING_PERMISSION_DENIED");
      const current = await ports.repository
        .loadSchedule(candidate.scheduleReference)
        .catch(dependency);
      if (input.expectedScheduleVersion === null) {
        if (current !== null || candidate.versionNumber !== 1)
          throw new ReportingWorkflowError("REPORTING_SCHEDULE_CONFLICT");
      } else if (
        current === null ||
        current.versionNumber !== positive(input.expectedScheduleVersion) ||
        candidate.versionNumber !== current.versionNumber + 1 ||
        candidate.reportReference !== current.reportReference
      )
        throw new ReportingWorkflowError("REPORTING_SCHEDULE_CONFLICT");
      const scheduleEvent: ReportScheduleEvent = Object.freeze({
        eventType: "ReportScheduleVersionRecorded",
        scheduleReference: candidate.scheduleReference,
        scheduleVersionReference: candidate.scheduleVersionReference,
        reportReference: candidate.reportReference,
        reportVersionReference: candidate.reportVersionReference,
        tenantReference: candidate.scope.tenantReference,
        brandReference: candidate.scope.brandReference,
        storeReference: candidate.scope.storeReference,
        status: candidate.status,
        cadence: candidate.cadence,
        format: candidate.format,
        timezone: candidate.timezone,
        occurredAt: at,
      });
      const record: ReportScheduleOperationRecord = Object.freeze({
        operationReference,
        operationIntentHash: intent,
        schedule: candidate,
        event: scheduleEvent,
      });
      const committed = await ports.repository
        .commitSchedule({
          record,
          expectedScheduleVersion: input.expectedScheduleVersion,
          audit: auth.audit,
        })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        schedule: createReportScheduleSnapshot(committed.schedule),
      });
    },
  });
}
