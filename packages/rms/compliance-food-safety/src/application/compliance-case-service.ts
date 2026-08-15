import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createComplianceCaseSnapshot,
  createComplianceContainmentRecord,
  createRegulatoryNotificationRecord,
  type ComplianceCaseSnapshot,
} from "../contracts/compliance-case.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceCaseAction,
  ComplianceCaseEvent,
  ComplianceCasePorts,
  ComplianceCloseGateEvidence,
} from "./ports/compliance-case-ports.js";

export type ComplianceCaseErrorCode =
  | "COMPLIANCE_CASE_INPUT_INVALID"
  | "COMPLIANCE_CASE_PERMISSION_DENIED"
  | "COMPLIANCE_CASE_VERSION_CONFLICT"
  | "COMPLIANCE_CASE_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_CASE_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_CASE_CLOSE_GATES_REQUIRED"
  | "COMPLIANCE_CASE_DEPENDENCY_UNAVAILABLE";
export class ComplianceCaseError extends Error {
  constructor(readonly code: ComplianceCaseErrorCode) {
    super("Compliance Case operation is unavailable");
    this.name = "ComplianceCaseError";
  }
}
const fail = (code: ComplianceCaseErrorCode = "COMPLIANCE_CASE_INPUT_INVALID"): never => {
  throw new ComplianceCaseError(code);
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
  if (error instanceof ComplianceCaseError) throw error;
  throw new ComplianceCaseError("COMPLIANCE_CASE_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const permissions: Record<ComplianceCaseAction, string> = {
  Open: "compliance.case.manage",
  Assign: "compliance.case.assign",
  Transition: "compliance.case.manage",
  Escalate: "compliance.case.escalate",
  Cancel: "compliance.case.cancel",
  Close: "compliance.case.close",
  RecordContainment: "compliance.containment.record",
  RecordNotification: "compliance.notification.record",
};
async function authorize(
  ports: ComplianceCasePorts,
  input: {
    action: ComplianceCaseAction;
    operationReference: ComplianceReference;
    caseReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_CASE_PERMISSION_DENIED");
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
      evidence.permission.action !== permissions[input.action] ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== input.scope.brandReference ||
      (audit.storeId ?? null) !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `COMPLIANCE_CASE_${input.action.toUpperCase()}` ||
      audit.targetType !== "ComplianceCase" ||
      audit.targetId !== input.caseReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return { actor: parseComplianceReference(actor), audit };
  } catch {
    return fail("COMPLIANCE_CASE_PERMISSION_DENIED");
  }
}
function sameIdentity(left: ComplianceCaseSnapshot, right: ComplianceCaseSnapshot) {
  return (
    left.caseReference === right.caseReference &&
    sameScope(left.scope, right.scope) &&
    left.caseType === right.caseType &&
    left.openedAt === right.openedAt &&
    left.openedByActorReference === right.openedByActorReference
  );
}
function sameExcept(
  candidate: ComplianceCaseSnapshot,
  current: ComplianceCaseSnapshot,
  changed: readonly (keyof ComplianceCaseSnapshot)[],
) {
  return (Object.keys(current) as (keyof ComplianceCaseSnapshot)[]).every(
    (key) =>
      changed.includes(key) || JSON.stringify(candidate[key]) === JSON.stringify(current[key]),
  );
}
function event(
  eventType: ComplianceCaseEvent["eventType"] | null,
  snapshot: ComplianceCaseSnapshot,
  occurredAt: string,
  requirementVersionReference: ComplianceReference,
): ComplianceCaseEvent | null {
  return eventType === null
    ? null
    : Object.freeze({
        eventType,
        caseReference: snapshot.caseReference,
        tenantReference: snapshot.scope.tenantReference,
        brandReference: snapshot.scope.brandReference,
        storeReference: snapshot.scope.storeReference,
        aggregateVersion: snapshot.aggregateVersion,
        severity: snapshot.severity,
        requirementVersionReference,
        occurredAt,
      });
}
function parseCloseGate(
  value: unknown,
  candidate: ComplianceCaseSnapshot,
  observedAt: string,
): ComplianceCloseGateEvidence {
  const raw = exact(value, [
    "caseReference",
    "aggregateVersion",
    "criticalFindingsReady",
    "mandatoryActionsComplete",
    "evidenceComplete",
    "reinspectionComplete",
    "regulatoryNotificationSatisfied",
    "linkedDomainActionsValid",
    "verifiedAt",
    "verifierReference",
    "evidenceReference",
  ]);
  const booleans = [
    raw.criticalFindingsReady,
    raw.mandatoryActionsComplete,
    raw.evidenceComplete,
    raw.reinspectionComplete,
    raw.regulatoryNotificationSatisfied,
    raw.linkedDomainActionsValid,
  ];
  if (
    raw.caseReference !== candidate.caseReference ||
    raw.aggregateVersion !== candidate.aggregateVersion ||
    booleans.some((item) => item !== true) ||
    parseComplianceInstant(raw.verifiedAt) !== observedAt
  )
    return fail("COMPLIANCE_CASE_CLOSE_GATES_REQUIRED");
  return Object.freeze({
    caseReference: candidate.caseReference,
    aggregateVersion: candidate.aggregateVersion,
    criticalFindingsReady: true,
    mandatoryActionsComplete: true,
    evidenceComplete: true,
    reinspectionComplete: true,
    regulatoryNotificationSatisfied: true,
    linkedDomainActionsValid: true,
    verifiedAt: observedAt,
    verifierReference: parseComplianceReference(raw.verifierReference),
    evidenceReference: parseComplianceReference(raw.evidenceReference),
  });
}
const allowed: Record<
  ComplianceCaseSnapshot["lifecycle"],
  readonly ComplianceCaseSnapshot["lifecycle"][]
> = {
  Open: [
    "Investigating",
    "CorrectiveAction",
    "Verification",
    "Closed",
    "OnHold",
    "Escalated",
    "Cancelled",
  ],
  Investigating: ["CorrectiveAction", "Verification", "OnHold", "Escalated", "Cancelled"],
  CorrectiveAction: ["Verification", "OnHold", "Escalated", "Cancelled"],
  Verification: ["CorrectiveAction", "Closed", "OnHold", "Escalated", "Cancelled"],
  OnHold: ["Open", "Investigating", "CorrectiveAction", "Verification", "Escalated", "Cancelled"],
  Escalated: ["Investigating", "CorrectiveAction", "Verification", "Closed", "OnHold", "Cancelled"],
  Closed: [],
  Cancelled: [],
};
export function createComplianceCaseService(ports: ComplianceCasePorts) {
  async function prior(operationReference: ComplianceReference, intentDigest: string) {
    const resolved = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (resolved !== null && !ports.references.equals(resolved.intentDigest, intentDigest))
      fail("COMPLIANCE_CASE_IDEMPOTENCY_CONFLICT");
    return resolved;
  }
  return Object.freeze({
    async execute(input: {
      readonly action: "Open" | "Assign" | "Transition" | "Escalate" | "Cancel" | "Close";
      readonly operationReference: string;
      readonly expectedAggregateVersion: number | null;
      readonly candidate: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
      readonly closeGate: unknown | null;
    }) {
      exact(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "purposeCode",
        "occurredAt",
        "closeGate",
      ]);
      if (!["Open", "Assign", "Transition", "Escalate", "Cancel", "Close"].includes(input.action))
        return fail();
      let candidate;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        candidate = createComplianceCaseSnapshot(input.candidate);
        operationReference = parseComplianceReference(input.operationReference);
        purposeCode = parseComplianceCode(input.purposeCode);
        occurredAt = parseComplianceInstant(input.occurredAt);
      } catch {
        return fail();
      }
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, case: existing.case });
      const auth = await authorize(ports, {
        action: input.action,
        operationReference,
        caseReference: candidate.caseReference,
        scope: candidate.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      const current = await ports.repository.load(candidate.caseReference).catch(dependency);
      let closeGate: ComplianceCloseGateEvidence | null = null;
      if (input.action === "Open") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.aggregateVersion !== 1 ||
          candidate.lifecycle !== "Open" ||
          candidate.openedAt !== occurredAt ||
          candidate.openedByActorReference !== auth.actor
        )
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
      } else {
        if (
          current === null ||
          input.expectedAggregateVersion !== current.aggregateVersion ||
          candidate.aggregateVersion !== current.aggregateVersion + 1 ||
          !sameIdentity(candidate, current) ||
          current.lifecycle === "Closed" ||
          current.lifecycle === "Cancelled"
        )
          return fail("COMPLIANCE_CASE_VERSION_CONFLICT");
        const permittedChanges: Record<
          Exclude<typeof input.action, "Open">,
          readonly (keyof ComplianceCaseSnapshot)[]
        > = {
          Assign: ["aggregateVersion", "revisionReference", "ownerReference"],
          Transition: ["aggregateVersion", "revisionReference", "lifecycle"],
          Escalate: ["aggregateVersion", "revisionReference", "lifecycle"],
          Cancel: ["aggregateVersion", "revisionReference", "lifecycle", "cancellationReasonCode"],
          Close: ["aggregateVersion", "revisionReference", "lifecycle", "closedAt"],
        };
        if (!sameExcept(candidate, current, permittedChanges[input.action]))
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
        if (
          input.action === "Assign" &&
          (candidate.lifecycle !== current.lifecycle ||
            candidate.ownerReference === current.ownerReference)
        )
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
        if (input.action === "Escalate" && candidate.lifecycle !== "Escalated")
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
        if (input.action === "Cancel" && candidate.lifecycle !== "Cancelled")
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
        if (
          (input.action === "Transition" || input.action === "Close") &&
          !allowed[current.lifecycle].includes(candidate.lifecycle)
        )
          return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
        if (input.action === "Close") {
          if (
            candidate.lifecycle !== "Closed" ||
            candidate.closedAt !== occurredAt ||
            input.closeGate === null
          )
            return fail("COMPLIANCE_CASE_CLOSE_GATES_REQUIRED");
          closeGate = parseCloseGate(input.closeGate, candidate, occurredAt);
          if (
            closeGate.verifierReference !== auth.actor ||
            (closeGate.verifierReference === candidate.ownerReference &&
              (candidate.severity === "Critical" || candidate.severity === "ImmediateDanger"))
          )
            return fail("COMPLIANCE_CASE_CLOSE_GATES_REQUIRED");
        }
      }
      if (input.action !== "Close" && input.closeGate !== null) return fail();
      const eventType: ComplianceCaseEvent["eventType"] | null =
        input.action === "Open"
          ? "ComplianceCaseOpened"
          : input.action === "Escalate"
            ? "ComplianceCaseEscalated"
            : input.action === "Cancel"
              ? "ComplianceCaseCancelled"
              : input.action === "Close"
                ? "ComplianceCaseClosed"
                : input.action === "Transition" && candidate.lifecycle === "CorrectiveAction"
                  ? "ComplianceCaseEnteredCorrectiveAction"
                  : input.action === "Transition" && candidate.lifecycle === "Verification"
                    ? "ComplianceCaseVerificationStarted"
                    : null;
      const requirementVersionReference = candidate.requirementVersionReferences[0];
      if (requirementVersionReference === undefined) return fail();
      const operation = Object.freeze({
        action: input.action,
        operationReference,
        intentDigest,
        case: candidate,
        containment: null,
        notification: null,
        event: event(eventType, candidate, occurredAt, requirementVersionReference),
      });
      const committed = await ports.repository
        .commit({
          operation,
          expectedAggregateVersion: input.expectedAggregateVersion,
          audit: auth.audit,
          closeGate,
        })
        .catch(dependency);
      return Object.freeze({
        status: "Applied" as const,
        case: createComplianceCaseSnapshot(committed.case),
      });
    },
    async recordContainment(input: {
      readonly operationReference: string;
      readonly expectedAggregateVersion: number;
      readonly case: unknown;
      readonly containment: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedAggregateVersion",
        "case",
        "containment",
        "purposeCode",
        "occurredAt",
      ]);
      let snapshot;
      let record;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        snapshot = createComplianceCaseSnapshot(input.case);
        record = createComplianceContainmentRecord(input.containment);
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
          containment: existing.containment,
        });
      const current = await ports.repository.load(snapshot.caseReference).catch(dependency);
      if (
        current === null ||
        current.aggregateVersion !== input.expectedAggregateVersion ||
        snapshot.aggregateVersion !== current.aggregateVersion + 1 ||
        !sameIdentity(snapshot, current) ||
        !sameExcept(snapshot, current, ["aggregateVersion", "revisionReference"]) ||
        record.caseReference !== snapshot.caseReference ||
        !sameScope(record.scope, snapshot.scope) ||
        record.occurredAt !== occurredAt
      )
        return fail("COMPLIANCE_CASE_VERSION_CONFLICT");
      const latest = await ports.repository
        .loadLatestContainment(snapshot.caseReference)
        .catch(dependency);
      if (
        record.sequence !== (latest?.sequence ?? 0) + 1 ||
        (record.status === "Released" &&
          (latest === null ||
            latest.status !== "Applied" ||
            latest.action !== record.action ||
            latest.targetScope.reference !== record.targetScope.reference))
      )
        return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
      const auth = await authorize(ports, {
        action: "RecordContainment",
        operationReference,
        caseReference: snapshot.caseReference,
        scope: snapshot.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      if (record.actorReference !== auth.actor) return fail("COMPLIANCE_CASE_PERMISSION_DENIED");
      const operation = Object.freeze({
        action: "RecordContainment" as const,
        operationReference,
        intentDigest,
        case: snapshot,
        containment: record,
        notification: null,
        event: null,
      });
      const committed = await ports.repository
        .commit({
          operation,
          expectedAggregateVersion: input.expectedAggregateVersion,
          audit: auth.audit,
          closeGate: null,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, containment: committed.containment });
    },
    async recordNotification(input: {
      readonly operationReference: string;
      readonly expectedAggregateVersion: number;
      readonly case: unknown;
      readonly notification: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedAggregateVersion",
        "case",
        "notification",
        "purposeCode",
        "occurredAt",
      ]);
      let snapshot;
      let record;
      let operationReference;
      let purposeCode;
      let occurredAt;
      try {
        snapshot = createComplianceCaseSnapshot(input.case);
        record = createRegulatoryNotificationRecord(input.notification);
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
          notification: existing.notification,
        });
      const current = await ports.repository.load(snapshot.caseReference).catch(dependency);
      if (
        current === null ||
        current.aggregateVersion !== input.expectedAggregateVersion ||
        snapshot.aggregateVersion !== current.aggregateVersion + 1 ||
        !sameIdentity(snapshot, current) ||
        !sameExcept(snapshot, current, ["aggregateVersion", "revisionReference"]) ||
        record.caseReference !== snapshot.caseReference ||
        !sameScope(record.scope, snapshot.scope) ||
        record.occurredAt !== occurredAt ||
        !snapshot.requirementVersionReferences.includes(record.requirementVersionReference)
      )
        return fail("COMPLIANCE_CASE_VERSION_CONFLICT");
      const latest = await ports.repository
        .loadLatestNotification(snapshot.caseReference)
        .catch(dependency);
      if (
        record.sequence !== (latest?.sequence ?? 0) + 1 ||
        (latest !== null &&
          (record.notificationReference !== latest.notificationReference ||
            record.authorityReference !== latest.authorityReference ||
            record.requirementVersionReference !== latest.requirementVersionReference))
      )
        return fail("COMPLIANCE_CASE_LIFECYCLE_CONFLICT");
      const auth = await authorize(ports, {
        action: "RecordNotification",
        operationReference,
        caseReference: snapshot.caseReference,
        scope: snapshot.scope,
        purposeCode,
        observedAt: occurredAt,
      });
      if (record.actorReference !== auth.actor) return fail("COMPLIANCE_CASE_PERMISSION_DENIED");
      const notificationEvent =
        record.status === "Required"
          ? ("RegulatoryNotificationRequired" as const)
          : record.status === "Submitted"
            ? ("RegulatoryNotificationSubmitted" as const)
            : null;
      const operation = Object.freeze({
        action: "RecordNotification" as const,
        operationReference,
        intentDigest,
        case: snapshot,
        containment: null,
        notification: record,
        event: event(notificationEvent, snapshot, occurredAt, record.requirementVersionReference),
      });
      const committed = await ports.repository
        .commit({
          operation,
          expectedAggregateVersion: input.expectedAggregateVersion,
          audit: auth.audit,
          closeGate: null,
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, notification: committed.notification });
    },
  });
}
