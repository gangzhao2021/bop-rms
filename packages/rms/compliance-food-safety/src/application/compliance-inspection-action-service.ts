import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createComplianceCaseSnapshot,
  type ComplianceCaseSnapshot,
} from "../contracts/compliance-case.js";
import {
  createComplianceCorrectiveActionRecord,
  createComplianceFindingRecord,
  createComplianceInspectionRecord,
  type ComplianceCorrectiveActionRecord,
  type ComplianceFindingRecord,
  type ComplianceInspectionRecord,
} from "../contracts/compliance-inspection-action.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceFindingActionEvent,
  ComplianceFindingActionEventType,
  ComplianceInspectionActionCommand,
  ComplianceInspectionActionOperation,
  ComplianceInspectionActionPorts,
} from "./ports/compliance-inspection-action-ports.js";

export type ComplianceInspectionActionErrorCode =
  | "COMPLIANCE_RECORD_INPUT_INVALID"
  | "COMPLIANCE_RECORD_PERMISSION_DENIED"
  | "COMPLIANCE_RECORD_VERSION_CONFLICT"
  | "COMPLIANCE_RECORD_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_RECORD_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_RECORD_INDEPENDENT_VERIFIER_REQUIRED"
  | "COMPLIANCE_RECORD_DEPENDENCY_UNAVAILABLE";
export class ComplianceInspectionActionError extends Error {
  constructor(readonly code: ComplianceInspectionActionErrorCode) {
    super("Compliance Inspection/Action operation is unavailable");
    this.name = "ComplianceInspectionActionError";
  }
}
const fail = (
  code: ComplianceInspectionActionErrorCode = "COMPLIANCE_RECORD_INPUT_INVALID",
): never => {
  throw new ComplianceInspectionActionError(code);
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function dependency(error: unknown): never {
  if (error instanceof ComplianceInspectionActionError) throw error;
  throw new ComplianceInspectionActionError("COMPLIANCE_RECORD_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const permissions: Record<ComplianceInspectionActionCommand, string> = {
  RecordInspection: "compliance.inspection.record",
  CorrectInspection: "compliance.inspection.correct",
  RecordFinding: "compliance.finding.record",
  ChangeFinding: "compliance.finding.manage",
  AssignAction: "compliance.corrective-action.assign",
  AdvanceAction: "compliance.corrective-action.manage",
  VerifyAction: "compliance.corrective-action.verify",
};
const targetTypes: Record<ComplianceInspectionActionCommand, string> = {
  RecordInspection: "ComplianceInspection",
  CorrectInspection: "ComplianceInspection",
  RecordFinding: "ComplianceFinding",
  ChangeFinding: "ComplianceFinding",
  AssignAction: "ComplianceCorrectiveAction",
  AdvanceAction: "ComplianceCorrectiveAction",
  VerifyAction: "ComplianceCorrectiveAction",
};
async function authorize(
  ports: ComplianceInspectionActionPorts,
  input: {
    command: ComplianceInspectionActionCommand;
    operationReference: ComplianceReference;
    caseReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(input.observedAt));
    const actor = context.actor.actorReference;
    if (
      actor === null ||
      evidence.tenantReference !== input.scope.tenantReference ||
      String(context.brand.brandReference) !== input.scope.brandReference ||
      (context.store === null ? null : String(context.store.storeReference)) !==
        input.scope.storeReference ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[input.command] ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== input.scope.brandReference ||
      (audit.storeId ?? null) !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `COMPLIANCE_${input.command.toUpperCase()}` ||
      audit.targetType !== targetTypes[input.command] ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return { actor: parseComplianceReference(actor), audit };
  } catch {
    return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
  }
}
function sameCaseIdentity(left: ComplianceCaseSnapshot, right: ComplianceCaseSnapshot) {
  return (
    left.caseReference === right.caseReference &&
    sameScope(left.scope, right.scope) &&
    left.caseType === right.caseType &&
    left.openedAt === right.openedAt &&
    left.openedByActorReference === right.openedByActorReference
  );
}
function unchangedCase(candidate: ComplianceCaseSnapshot, current: ComplianceCaseSnapshot) {
  return (Object.keys(current) as (keyof ComplianceCaseSnapshot)[]).every(
    (key) =>
      key === "aggregateVersion" ||
      key === "revisionReference" ||
      JSON.stringify(candidate[key]) === JSON.stringify(current[key]),
  );
}
function recordEvent(
  eventType: ComplianceFindingActionEventType,
  candidate: ComplianceCaseSnapshot,
  recordReference: ComplianceReference,
  severity: ComplianceFindingRecord["severity"],
  requirementVersionReference: ComplianceReference,
  occurredAt: string,
): ComplianceFindingActionEvent {
  return Object.freeze({
    eventType,
    caseReference: candidate.caseReference,
    recordReference,
    tenantReference: candidate.scope.tenantReference,
    brandReference: candidate.scope.brandReference,
    storeReference: candidate.scope.storeReference,
    aggregateVersion: candidate.aggregateVersion,
    severity,
    requirementVersionReference,
    occurredAt,
  });
}
function sameInspectionCore(
  candidate: ComplianceInspectionRecord,
  current: ComplianceInspectionRecord,
) {
  return (
    candidate.inspectionReference === current.inspectionReference &&
    candidate.caseReference === current.caseReference &&
    sameScope(candidate.scope, current.scope) &&
    candidate.inspectionType === current.inspectionType &&
    candidate.checklistVersionReference === current.checklistVersionReference &&
    candidate.requirementVersionReference === current.requirementVersionReference &&
    JSON.stringify(candidate.inspectionScope) === JSON.stringify(current.inspectionScope)
  );
}
function sameFindingCore(candidate: ComplianceFindingRecord, current: ComplianceFindingRecord) {
  return (
    candidate.findingReference === current.findingReference &&
    candidate.caseReference === current.caseReference &&
    sameScope(candidate.scope, current.scope) &&
    candidate.inspectionReference === current.inspectionReference &&
    candidate.requirementVersionReference === current.requirementVersionReference &&
    candidate.hardRequirement === current.hardRequirement
  );
}
function sameActionCore(
  candidate: ComplianceCorrectiveActionRecord,
  current: ComplianceCorrectiveActionRecord,
) {
  return (
    candidate.actionReference === current.actionReference &&
    candidate.caseReference === current.caseReference &&
    candidate.findingReference === current.findingReference &&
    sameScope(candidate.scope, current.scope) &&
    candidate.requirementVersionReference === current.requirementVersionReference &&
    candidate.hardRequirement === current.hardRequirement &&
    candidate.severity === current.severity &&
    candidate.requiredActionCode === current.requiredActionCode
  );
}
const inspectionTransitions: Record<
  ComplianceInspectionRecord["status"],
  readonly ComplianceInspectionRecord["status"][]
> = {
  Draft: ["Scheduled", "InProgress", "Finalized", "Cancelled"],
  Scheduled: ["InProgress", "Cancelled"],
  InProgress: ["Finalized", "Cancelled"],
  Finalized: [],
  Cancelled: [],
};
const findingTransitions: Record<
  ComplianceFindingRecord["status"],
  readonly ComplianceFindingRecord["status"][]
> = {
  Open: [
    "AcceptedRisk",
    "CorrectiveActionInProgress",
    "PendingVerification",
    "Resolved",
    "NotApplicable",
  ],
  AcceptedRisk: ["Open", "CorrectiveActionInProgress", "PendingVerification", "Resolved"],
  CorrectiveActionInProgress: ["PendingVerification", "Resolved"],
  PendingVerification: ["CorrectiveActionInProgress", "Resolved"],
  Resolved: [],
  NotApplicable: [],
};
const actionTransitions: Record<
  ComplianceCorrectiveActionRecord["status"],
  readonly ComplianceCorrectiveActionRecord["status"][]
> = {
  Planned: ["InProgress", "Blocked", "Cancelled"],
  InProgress: ["Blocked", "Completed", "Cancelled"],
  Blocked: ["InProgress", "Cancelled"],
  Completed: [],
  VerificationFailed: ["InProgress", "Completed", "Cancelled"],
  Verified: [],
  Cancelled: [],
};

export function createComplianceInspectionActionService(ports: ComplianceInspectionActionPorts) {
  async function prior(operationReference: ComplianceReference, intentDigest: string) {
    const existing = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (existing === null) return null;
    if (!ports.references.equals(existing.intentDigest, intentDigest))
      return fail("COMPLIANCE_RECORD_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function context(
    rawCase: unknown,
    expectedAggregateVersion: number,
    recordCaseReference: ComplianceReference,
    recordScope: ComplianceScope,
    recordAggregateVersion: number,
  ) {
    let candidate;
    try {
      candidate = createComplianceCaseSnapshot(rawCase);
    } catch {
      return fail();
    }
    const current = await ports.repository.loadCase(candidate.caseReference).catch(dependency);
    if (
      current === null ||
      current.lifecycle === "Closed" ||
      current.lifecycle === "Cancelled" ||
      current.aggregateVersion !== expectedAggregateVersion ||
      candidate.aggregateVersion !== current.aggregateVersion + 1 ||
      recordAggregateVersion !== candidate.aggregateVersion ||
      recordCaseReference !== candidate.caseReference ||
      !sameScope(recordScope, candidate.scope) ||
      !sameCaseIdentity(candidate, current) ||
      !unchangedCase(candidate, current)
    )
      return fail("COMPLIANCE_RECORD_VERSION_CONFLICT");
    return { candidate, current };
  }
  async function commit(
    operation: ComplianceInspectionActionOperation,
    expectedAggregateVersion: number,
    audit: Awaited<ReturnType<typeof authorize>>["audit"],
  ) {
    return ports.repository
      .commit({ operation, expectedAggregateVersion, audit })
      .catch(dependency);
  }
  return Object.freeze({
    async recordInspection(input: {
      readonly command: "RecordInspection" | "CorrectInspection";
      readonly operationReference: string;
      readonly expectedAggregateVersion: number;
      readonly case: unknown;
      readonly inspection: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "command",
        "operationReference",
        "expectedAggregateVersion",
        "case",
        "inspection",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        record = createComplianceInspectionRecord(input.inspection);
        operationReference = parseComplianceReference(input.operationReference);
        purposeCode = parseComplianceCode(input.purposeCode);
        occurredAt = parseComplianceInstant(input.occurredAt);
      } catch {
        return fail();
      }
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          inspection: existing.inspection,
        });
      const aggregate = await context(
        input.case,
        input.expectedAggregateVersion,
        record.caseReference,
        record.scope,
        record.aggregateVersion,
      );
      if (
        record.recordedAt !== occurredAt ||
        !aggregate.candidate.requirementVersionReferences.includes(
          record.requirementVersionReference,
        )
      )
        return fail("COMPLIANCE_RECORD_VERSION_CONFLICT");
      const latest = await ports.repository
        .loadLatestInspection(record.inspectionReference)
        .catch(dependency);
      if (input.command === "RecordInspection") {
        if (
          (latest === null && record.recordVersion !== 1) ||
          (latest !== null &&
            (record.recordVersion !== latest.recordVersion + 1 ||
              record.priorRevisionReference !== latest.revisionReference ||
              !sameInspectionCore(record, latest) ||
              !inspectionTransitions[latest.status].includes(record.status)))
        )
          return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      } else if (
        latest === null ||
        latest.status !== "Finalized" ||
        record.status !== "Finalized" ||
        record.recordVersion !== latest.recordVersion + 1 ||
        record.priorRevisionReference !== latest.revisionReference ||
        record.changeReasonCode === null ||
        !sameInspectionCore(record, latest)
      )
        return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      const auth = await authorize(ports, {
        command: input.command,
        operationReference,
        caseReference: record.caseReference,
        targetReference: record.inspectionReference,
        scope: record.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      if (record.actorReference !== auth.actor) return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
      const operation = Object.freeze({
        command: input.command,
        operationReference,
        intentDigest,
        case: aggregate.candidate,
        inspection: record,
        finding: null,
        correctiveAction: null,
        events: Object.freeze([]),
      });
      const committed = await commit(operation, input.expectedAggregateVersion, auth.audit);
      return Object.freeze({ status: "Applied" as const, inspection: committed.inspection });
    },
    async recordFinding(input: {
      readonly command: "RecordFinding" | "ChangeFinding";
      readonly operationReference: string;
      readonly expectedAggregateVersion: number;
      readonly case: unknown;
      readonly finding: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "command",
        "operationReference",
        "expectedAggregateVersion",
        "case",
        "finding",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        record = createComplianceFindingRecord(input.finding);
        operationReference = parseComplianceReference(input.operationReference);
        purposeCode = parseComplianceCode(input.purposeCode);
        occurredAt = parseComplianceInstant(input.occurredAt);
      } catch {
        return fail();
      }
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, finding: existing.finding });
      const aggregate = await context(
        input.case,
        input.expectedAggregateVersion,
        record.caseReference,
        record.scope,
        record.aggregateVersion,
      );
      if (
        record.recordedAt !== occurredAt ||
        !aggregate.candidate.requirementVersionReferences.includes(
          record.requirementVersionReference,
        )
      )
        return fail("COMPLIANCE_RECORD_VERSION_CONFLICT");
      const latest = await ports.repository
        .loadLatestFinding(record.findingReference)
        .catch(dependency);
      const sourceInspection =
        record.inspectionReference === null
          ? null
          : await ports.repository
              .loadLatestInspection(record.inspectionReference)
              .catch(dependency);
      if (
        record.inspectionReference !== null &&
        (sourceInspection === null ||
          sourceInspection.caseReference !== record.caseReference ||
          !sameScope(sourceInspection.scope, record.scope) ||
          sourceInspection.requirementVersionReference !== record.requirementVersionReference ||
          sourceInspection.status === "Cancelled")
      )
        return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      if (input.command === "RecordFinding") {
        if (latest !== null || record.recordVersion !== 1 || record.status !== "Open")
          return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      } else if (
        latest === null ||
        record.recordVersion !== latest.recordVersion + 1 ||
        record.priorRevisionReference !== latest.revisionReference ||
        !sameFindingCore(record, latest) ||
        !findingTransitions[latest.status].includes(record.status)
      )
        return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      const auth = await authorize(ports, {
        command: input.command,
        operationReference,
        caseReference: record.caseReference,
        targetReference: record.findingReference,
        scope: record.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      if (record.actorReference !== auth.actor) return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
      const eventTypes: ComplianceFindingActionEventType[] = [];
      if (input.command === "RecordFinding") eventTypes.push("ComplianceFindingRecorded");
      if (
        (record.severity === "Critical" || record.severity === "ImmediateDanger") &&
        (latest === null || latest.severity !== record.severity)
      )
        eventTypes.push("CriticalComplianceFindingDetected");
      const events = Object.freeze(
        eventTypes.map((eventType) =>
          recordEvent(
            eventType,
            aggregate.candidate,
            record.findingReference,
            record.severity,
            record.requirementVersionReference,
            occurredAt,
          ),
        ),
      );
      const operation = Object.freeze({
        command: input.command,
        operationReference,
        intentDigest,
        case: aggregate.candidate,
        inspection: null,
        finding: record,
        correctiveAction: null,
        events,
      });
      const committed = await commit(operation, input.expectedAggregateVersion, auth.audit);
      return Object.freeze({ status: "Applied" as const, finding: committed.finding });
    },
    async recordCorrectiveAction(input: {
      readonly command: "AssignAction" | "AdvanceAction" | "VerifyAction";
      readonly operationReference: string;
      readonly expectedAggregateVersion: number;
      readonly case: unknown;
      readonly correctiveAction: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "command",
        "operationReference",
        "expectedAggregateVersion",
        "case",
        "correctiveAction",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        record = createComplianceCorrectiveActionRecord(input.correctiveAction);
        operationReference = parseComplianceReference(input.operationReference);
        purposeCode = parseComplianceCode(input.purposeCode);
        occurredAt = parseComplianceInstant(input.occurredAt);
      } catch {
        return fail();
      }
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          correctiveAction: existing.correctiveAction,
        });
      const aggregate = await context(
        input.case,
        input.expectedAggregateVersion,
        record.caseReference,
        record.scope,
        record.aggregateVersion,
      );
      if (
        record.recordedAt !== occurredAt ||
        !aggregate.candidate.requirementVersionReferences.includes(
          record.requirementVersionReference,
        )
      )
        return fail("COMPLIANCE_RECORD_VERSION_CONFLICT");
      const latest = await ports.repository
        .loadLatestCorrectiveAction(record.actionReference)
        .catch(dependency);
      const sourceFinding = await ports.repository
        .loadLatestFinding(record.findingReference)
        .catch(dependency);
      if (
        sourceFinding === null ||
        sourceFinding.caseReference !== record.caseReference ||
        !sameScope(sourceFinding.scope, record.scope) ||
        sourceFinding.requirementVersionReference !== record.requirementVersionReference ||
        sourceFinding.hardRequirement !== record.hardRequirement ||
        sourceFinding.severity !== record.severity ||
        sourceFinding.status === "AcceptedRisk" ||
        sourceFinding.status === "Resolved" ||
        sourceFinding.status === "NotApplicable"
      )
        return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
      let eventType: ComplianceFindingActionEventType | null = null;
      if (input.command === "AssignAction") {
        if (latest !== null || record.recordVersion !== 1 || record.status !== "Planned")
          return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
        eventType = "CorrectiveActionAssigned";
      } else if (input.command === "AdvanceAction") {
        if (
          latest === null ||
          record.recordVersion !== latest.recordVersion + 1 ||
          record.priorRevisionReference !== latest.revisionReference ||
          !sameActionCore(record, latest) ||
          !actionTransitions[latest.status].includes(record.status) ||
          record.verificationResult !== null
        )
          return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
        if (record.status === "Completed") eventType = "CorrectiveActionCompleted";
      } else {
        if (
          latest === null ||
          latest.status !== "Completed" ||
          record.recordVersion !== latest.recordVersion + 1 ||
          record.priorRevisionReference !== latest.revisionReference ||
          !sameActionCore(record, latest) ||
          record.completedByActorReference !== latest.completedByActorReference ||
          record.ownerOutcomeReference !== latest.ownerOutcomeReference ||
          JSON.stringify(record.completionEvidenceReferences) !==
            JSON.stringify(latest.completionEvidenceReferences) ||
          !["Verified", "VerificationFailed", "Completed"].includes(record.status) ||
          record.verificationResult === null
        )
          return fail("COMPLIANCE_RECORD_LIFECYCLE_CONFLICT");
        if (record.status === "Verified") eventType = "CorrectiveActionVerified";
        if (record.status === "VerificationFailed")
          eventType = "CorrectiveActionVerificationFailed";
      }
      const auth = await authorize(ports, {
        command: input.command,
        operationReference,
        caseReference: record.caseReference,
        targetReference: record.actionReference,
        scope: record.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      if (record.actorReference !== auth.actor) return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
      if (
        input.command === "VerifyAction" &&
        (record.hardRequirement ||
          record.severity === "Critical" ||
          record.severity === "ImmediateDanger") &&
        record.completedByActorReference === auth.actor
      )
        return fail("COMPLIANCE_RECORD_INDEPENDENT_VERIFIER_REQUIRED");
      if (input.command === "VerifyAction" && record.verifierReference !== auth.actor)
        return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
      if (input.command === "AdvanceAction" && record.status === "Completed") {
        if (record.completedByActorReference !== auth.actor)
          return fail("COMPLIANCE_RECORD_PERMISSION_DENIED");
      }
      const events = Object.freeze(
        eventType === null
          ? []
          : [
              recordEvent(
                eventType,
                aggregate.candidate,
                record.actionReference,
                record.severity,
                record.requirementVersionReference,
                occurredAt,
              ),
            ],
      );
      const operation = Object.freeze({
        command: input.command,
        operationReference,
        intentDigest,
        case: aggregate.candidate,
        inspection: null,
        finding: null,
        correctiveAction: record,
        events,
      });
      const committed = await commit(operation, input.expectedAggregateVersion, auth.audit);
      return Object.freeze({
        status: "Applied" as const,
        correctiveAction: committed.correctiveAction,
      });
    },
  });
}
