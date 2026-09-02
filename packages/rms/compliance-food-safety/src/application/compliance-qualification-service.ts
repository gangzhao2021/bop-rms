import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createComplianceQualificationRecord,
  type ComplianceQualificationRecord,
  type QualificationStatus,
} from "../contracts/compliance-qualification.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceQualificationCommand,
  ComplianceQualificationEvent,
  ComplianceQualificationOperation,
  ComplianceQualificationPorts,
} from "./ports/compliance-qualification-ports.js";

export type ComplianceQualificationErrorCode =
  | "COMPLIANCE_QUALIFICATION_INPUT_INVALID"
  | "COMPLIANCE_QUALIFICATION_PERMISSION_DENIED"
  | "COMPLIANCE_QUALIFICATION_VERSION_CONFLICT"
  | "COMPLIANCE_QUALIFICATION_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_QUALIFICATION_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_QUALIFICATION_DEPENDENCY_UNAVAILABLE";
export class ComplianceQualificationError extends Error {
  constructor(readonly code: ComplianceQualificationErrorCode) {
    super("Compliance qualification operation is unavailable");
    this.name = "ComplianceQualificationError";
  }
}
const fail = (
  code: ComplianceQualificationErrorCode = "COMPLIANCE_QUALIFICATION_INPUT_INVALID",
): never => {
  throw new ComplianceQualificationError(code);
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
}
function dependency(error: unknown): never {
  if (error instanceof ComplianceQualificationError) throw error;
  throw new ComplianceQualificationError("COMPLIANCE_QUALIFICATION_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (a: ComplianceScope, b: ComplianceScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
const permissions: Record<ComplianceQualificationCommand, string> = {
  RecordQualification: "compliance.qualification.record",
  ReviseQualification: "compliance.qualification.review",
  RequestRenewal: "compliance.qualification.renewal.request",
  SuspendEligibility: "compliance.qualification.eligibility.suspend",
};
const transitions: Record<QualificationStatus, readonly QualificationStatus[]> = {
  Draft: ["PendingVerification", "Closed"],
  PendingVerification: ["Active", "Closed"],
  Active: ["Expiring", "Expired", "Suspended", "Revoked", "Closed"],
  Expiring: ["Expired", "Suspended", "Revoked", "Closed"],
  Expired: ["Suspended", "Closed"],
  Suspended: ["Active", "Expiring", "Expired", "Revoked", "Closed"],
  Revoked: ["Closed"],
  Closed: [],
};
function sameCore(a: ComplianceQualificationRecord, b: ComplianceQualificationRecord) {
  return (
    a.qualificationReference === b.qualificationReference &&
    sameScope(a.scope, b.scope) &&
    a.subjectKind === b.subjectKind &&
    a.subjectReference === b.subjectReference &&
    a.owner === b.owner &&
    a.ownerRecordReference === b.ownerRecordReference &&
    a.ownerRecordVersion === b.ownerRecordVersion &&
    a.qualificationTypeCode === b.qualificationTypeCode &&
    a.jurisdictionCode === b.jurisdictionCode &&
    a.issuerReference === b.issuerReference &&
    a.numberReference === b.numberReference &&
    a.authorityReference === b.authorityReference &&
    a.holderLegalEntityReference === b.holderLegalEntityReference &&
    a.membershipReference === b.membershipReference &&
    a.requirementVersionReference === b.requirementVersionReference &&
    a.evidenceReference === b.evidenceReference &&
    a.issuedAt === b.issuedAt &&
    a.effectiveFrom === b.effectiveFrom &&
    a.expiresAt === b.expiresAt &&
    a.renewalWindowStartsAt === b.renewalWindowStartsAt
  );
}
function eventFor(
  previous: ComplianceQualificationRecord | null,
  record: ComplianceQualificationRecord,
): readonly ComplianceQualificationEvent[] {
  if (previous?.status === record.status) return [];
  const eventType =
    record.subjectKind === "Permit"
      ? record.status === "Expiring"
        ? "LicenseExpiring"
        : record.status === "Expired"
          ? "LicenseExpired"
          : record.status === "Suspended"
            ? "LicenseSuspended"
            : null
      : record.subjectKind === "Employee"
        ? record.status === "Expiring"
          ? "EmployeeQualificationExpiring"
          : record.status === "Expired"
            ? "EmployeeQualificationExpired"
            : null
        : null;
  return eventType === null
    ? []
    : [
        Object.freeze({
          eventType,
          recordReference: record.qualificationReference,
          tenantReference: record.scope.tenantReference,
          brandReference: record.scope.brandReference,
          storeReference: record.scope.storeReference,
          requirementVersionReference: record.requirementVersionReference,
          severity: record.severity,
          occurredAt: record.recordedAt,
        }),
      ];
}

async function authorize(
  ports: ComplianceQualificationPorts,
  input: {
    command: ComplianceQualificationCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_QUALIFICATION_PERMISSION_DENIED");
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
      audit.actionCode !== `COMPLIANCE_QUALIFICATION_${input.command.toUpperCase()}` ||
      audit.targetType !== "ComplianceQualification" ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    return fail("COMPLIANCE_QUALIFICATION_PERMISSION_DENIED");
  }
}

export function createComplianceQualificationService(ports: ComplianceQualificationPorts) {
  async function common(input: {
    operationReference: string;
    purposeCode: string;
    occurredAt: string;
  }) {
    try {
      return {
        operationReference: parseComplianceReference(input.operationReference),
        purposeCode: parseComplianceCode(input.purposeCode),
        occurredAt: parseComplianceInstant(input.occurredAt),
      };
    } catch {
      return fail();
    }
  }
  async function prior(reference: ComplianceReference, digest: string) {
    const existing = await ports.repository.resolveOperation(reference).catch(dependency);
    if (existing !== null && !ports.references.equals(existing.intentDigest, digest))
      return fail("COMPLIANCE_QUALIFICATION_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function persist(input: {
    command: ComplianceQualificationCommand;
    operationReference: ComplianceReference;
    intentDigest: string;
    record: ComplianceQualificationRecord;
    previous: ComplianceQualificationRecord | null;
    expectedRevision: number;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    occurredAt: string;
    authorizedAudit?: Awaited<ReturnType<typeof authorize>>;
  }) {
    const audit =
      input.authorizedAudit ??
      (await authorize(ports, {
        command: input.command,
        operationReference: input.operationReference,
        targetReference: input.record.qualificationReference,
        scope: input.record.scope,
        purposeCode: input.purposeCode,
        observedAt: input.occurredAt,
      }));
    const operation: ComplianceQualificationOperation = Object.freeze({
      command: input.command,
      operationReference: input.operationReference,
      intentDigest: input.intentDigest,
      qualification: input.record,
      events: Object.freeze(eventFor(input.previous, input.record)),
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision, audit })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, qualification: committed.qualification });
  }
  return Object.freeze({
    async recordQualification(input: {
      readonly operationReference: string;
      readonly expectedRevision: 0;
      readonly qualification: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "qualification",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createComplianceQualificationRecord(input.qualification);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, digest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          qualification: existing.qualification,
        });
      const latest = await ports.repository
        .loadLatest(record.qualificationReference)
        .catch(dependency);
      if (
        input.expectedRevision !== 0 ||
        record.revision !== 1 ||
        latest !== null ||
        record.recordedAt !== parsed.occurredAt
      )
        return fail("COMPLIANCE_QUALIFICATION_VERSION_CONFLICT");
      return persist({
        command: "RecordQualification",
        operationReference: parsed.operationReference,
        intentDigest: digest,
        record,
        previous: null,
        expectedRevision: 0,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async reviseQualification(input: {
      readonly operationReference: string;
      readonly expectedRevision: number;
      readonly qualification: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "qualification",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createComplianceQualificationRecord(input.qualification);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, digest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          qualification: existing.qualification,
        });
      const latest = await ports.repository
        .loadLatest(record.qualificationReference)
        .catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        record.revision !== input.expectedRevision + 1 ||
        record.recordedAt !== parsed.occurredAt ||
        !sameCore(latest, record) ||
        !transitions[latest.status].includes(record.status)
      )
        return fail("COMPLIANCE_QUALIFICATION_LIFECYCLE_CONFLICT");
      return persist({
        command: "ReviseQualification",
        operationReference: parsed.operationReference,
        intentDigest: digest,
        record,
        previous: latest,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async requestRenewal(input: {
      readonly operationReference: string;
      readonly qualificationReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "qualificationReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await common(input);
      const qualificationReference = parseComplianceReference(input.qualificationReference);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, digest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          qualification: existing.qualification,
        });
      const latest = await ports.repository.loadLatest(qualificationReference).catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        latest.renewalTaskReference !== null ||
        !["Active", "Expiring", "Expired", "Suspended"].includes(latest.status)
      )
        return fail("COMPLIANCE_QUALIFICATION_LIFECYCLE_CONFLICT");
      const authorizedAudit = await authorize(ports, {
        command: "RequestRenewal",
        operationReference: parsed.operationReference,
        targetReference: latest.qualificationReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const renewalTaskReference = await ports.renewalTasks
        .request({
          operationReference: parsed.operationReference,
          qualificationReference,
          scope: latest.scope,
          requirementVersionReference: latest.requirementVersionReference,
          dueAt: latest.expiresAt,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      const record = createComplianceQualificationRecord({
        ...latest,
        revision: latest.revision + 1,
        renewalTaskReference,
        recordedAt: parsed.occurredAt,
      });
      return persist({
        command: "RequestRenewal",
        operationReference: parsed.operationReference,
        intentDigest: digest,
        record,
        previous: latest,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        authorizedAudit,
      });
    },
    async suspendEligibility(input: {
      readonly operationReference: string;
      readonly qualificationReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "qualificationReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await common(input);
      const qualificationReference = parseComplianceReference(input.qualificationReference);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, digest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          qualification: existing.qualification,
        });
      const latest = await ports.repository.loadLatest(qualificationReference).catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        latest.eligibilityOutcomeReference !== null ||
        !["Active", "Expiring", "Expired"].includes(latest.status)
      )
        return fail("COMPLIANCE_QUALIFICATION_LIFECYCLE_CONFLICT");
      const authorizedAudit = await authorize(ports, {
        command: "SuspendEligibility",
        operationReference: parsed.operationReference,
        targetReference: latest.qualificationReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const eligibilityOutcomeReference = await ports.eligibility
        .suspend({
          operationReference: parsed.operationReference,
          subjectKind: latest.subjectKind,
          subjectReference: latest.subjectReference,
          ownerRecordReference: latest.ownerRecordReference,
          ownerRecordVersion: latest.ownerRecordVersion,
          scope: latest.scope,
          requirementVersionReference: latest.requirementVersionReference,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      const record = createComplianceQualificationRecord({
        ...latest,
        revision: latest.revision + 1,
        status: "Suspended",
        eligibilityOutcomeReference,
        recordedAt: parsed.occurredAt,
      });
      return persist({
        command: "SuspendEligibility",
        operationReference: parsed.operationReference,
        intentDigest: digest,
        record,
        previous: latest,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        authorizedAudit,
      });
    },
  });
}
