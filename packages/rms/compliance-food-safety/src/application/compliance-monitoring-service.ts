import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createCleaningRecord,
  createTemperatureExcursionRecord,
  createTemperatureReadingRecord,
  type CleaningRecord,
  type TemperatureExcursionRecord,
} from "../contracts/compliance-monitoring.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceMonitoringCommand,
  ComplianceMonitoringEvent,
  ComplianceMonitoringOperation,
  ComplianceMonitoringPorts,
} from "./ports/compliance-monitoring-ports.js";

export type ComplianceMonitoringErrorCode =
  | "COMPLIANCE_MONITORING_INPUT_INVALID"
  | "COMPLIANCE_MONITORING_PERMISSION_DENIED"
  | "COMPLIANCE_MONITORING_VERSION_CONFLICT"
  | "COMPLIANCE_MONITORING_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_MONITORING_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_MONITORING_DEPENDENCY_UNAVAILABLE";
export class ComplianceMonitoringError extends Error {
  constructor(readonly code: ComplianceMonitoringErrorCode) {
    super("Compliance monitoring operation is unavailable");
    this.name = "ComplianceMonitoringError";
  }
}
const fail = (
  code: ComplianceMonitoringErrorCode = "COMPLIANCE_MONITORING_INPUT_INVALID",
): never => {
  throw new ComplianceMonitoringError(code);
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
  if (error instanceof ComplianceMonitoringError) throw error;
  throw new ComplianceMonitoringError("COMPLIANCE_MONITORING_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (a: ComplianceScope, b: ComplianceScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
const permissions: Record<ComplianceMonitoringCommand, string> = {
  RecordReading: "compliance.temperature.record",
  RecordExcursion: "compliance.temperature.excursion.record",
  UpdateExcursion: "compliance.temperature.excursion.manage",
  RecordCleaning: "compliance.cleaning.record",
  UpdateCleaning: "compliance.cleaning.manage",
};
const targetTypes: Record<ComplianceMonitoringCommand, string> = {
  RecordReading: "TemperatureReading",
  RecordExcursion: "TemperatureExcursion",
  UpdateExcursion: "TemperatureExcursion",
  RecordCleaning: "CleaningRecord",
  UpdateCleaning: "CleaningRecord",
};
async function authorize(
  ports: ComplianceMonitoringPorts,
  input: {
    command: ComplianceMonitoringCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_MONITORING_PERMISSION_DENIED");
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
      audit.actionCode !== `COMPLIANCE_MONITORING_${input.command.toUpperCase()}` ||
      audit.targetType !== targetTypes[input.command] ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return { actor: parseComplianceReference(actor), audit };
  } catch {
    return fail("COMPLIANCE_MONITORING_PERMISSION_DENIED");
  }
}
function sameExcursionCore(a: TemperatureExcursionRecord, b: TemperatureExcursionRecord) {
  return (
    a.excursionReference === b.excursionReference &&
    sameScope(a.scope, b.scope) &&
    a.policyVersionReference === b.policyVersionReference &&
    a.readingReference === b.readingReference &&
    JSON.stringify(a.affectedScope) === JSON.stringify(b.affectedScope)
  );
}
function sameCleaningCore(a: CleaningRecord, b: CleaningRecord) {
  return (
    a.cleaningReference === b.cleaningReference &&
    sameScope(a.scope, b.scope) &&
    a.scheduleReference === b.scheduleReference &&
    a.taskReference === b.taskReference &&
    a.policyVersionReference === b.policyVersionReference &&
    a.procedureVersionReference === b.procedureVersionReference &&
    JSON.stringify(a.targetScope) === JSON.stringify(b.targetScope)
  );
}
const excursionTransitions: Record<
  TemperatureExcursionRecord["status"],
  readonly TemperatureExcursionRecord["status"][]
> = {
  Open: ["Contained", "Cancelled"],
  Contained: ["DispositionPending", "Resolved", "Cancelled"],
  DispositionPending: ["Resolved", "Cancelled"],
  Resolved: [],
  Cancelled: [],
};
const cleaningTransitions: Record<CleaningRecord["status"], readonly CleaningRecord["status"][]> = {
  Scheduled: ["InProgress", "CannotComplete", "Missed", "Cancelled"],
  InProgress: ["Completed", "CannotComplete", "Missed", "Cancelled"],
  Completed: ["Verified", "VerificationFailed"],
  CannotComplete: ["Scheduled", "Cancelled"],
  Missed: ["Scheduled", "Cancelled"],
  VerificationFailed: ["InProgress", "Completed", "Cancelled"],
  Verified: [],
  Cancelled: [],
};
export function createComplianceMonitoringService(ports: ComplianceMonitoringPorts) {
  async function prior(reference: ComplianceReference, digest: string) {
    const existing = await ports.repository.resolveOperation(reference).catch(dependency);
    if (existing !== null && !ports.references.equals(existing.intentDigest, digest))
      return fail("COMPLIANCE_MONITORING_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function commit(
    operation: ComplianceMonitoringOperation,
    expectedVersion: number,
    audit: Awaited<ReturnType<typeof authorize>>["audit"],
  ) {
    return ports.repository.commit({ operation, expectedVersion, audit }).catch(dependency);
  }
  async function parsed(input: {
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
  return Object.freeze({
    async recordReading(input: {
      readonly operationReference: string;
      readonly expectedSequence: number;
      readonly reading: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedSequence",
        "reading",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createTemperatureReadingRecord(input.reading);
      } catch {
        return fail();
      }
      const common = await parsed(input);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(common.operationReference, digest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, reading: existing.reading });
      const latest = await ports.repository
        .loadLatestReading({
          scope: record.scope,
          policyVersionReference: record.policyVersionReference,
          targetReference: record.targetScope.reference,
          measurementTypeCode: record.measurementTypeCode,
        })
        .catch(dependency);
      const duplicate = await ports.repository
        .loadReading(record.readingReference)
        .catch(dependency);
      if (
        duplicate !== null ||
        (latest?.sequence ?? 0) !== input.expectedSequence ||
        record.sequence !== input.expectedSequence + 1 ||
        record.recordedAt !== common.occurredAt
      )
        return fail("COMPLIANCE_MONITORING_VERSION_CONFLICT");
      if (record.correctionOfReadingReference !== null) {
        const source = await ports.repository
          .loadReading(record.correctionOfReadingReference)
          .catch(dependency);
        if (
          source === null ||
          record.method !== "Manual" ||
          !sameScope(source.scope, record.scope) ||
          source.policyVersionReference !== record.policyVersionReference ||
          source.targetScope.reference !== record.targetScope.reference ||
          source.measurementTypeCode !== record.measurementTypeCode ||
          source.unitCode !== record.unitCode
        )
          return fail("COMPLIANCE_MONITORING_LIFECYCLE_CONFLICT");
      }
      const auth = await authorize(ports, {
        command: "RecordReading",
        operationReference: common.operationReference,
        targetReference: record.readingReference,
        scope: record.scope,
        purposeCode: common.purposeCode,
        observedAt: common.occurredAt,
      });
      if (record.operatorReference !== auth.actor)
        return fail("COMPLIANCE_MONITORING_PERMISSION_DENIED");
      const operation = Object.freeze({
        command: "RecordReading" as const,
        operationReference: common.operationReference,
        intentDigest: digest,
        reading: record,
        excursion: null,
        cleaning: null,
        events: Object.freeze([]),
      });
      const saved = await commit(operation, input.expectedSequence, auth.audit);
      return Object.freeze({ status: "Applied" as const, reading: saved.reading });
    },
    async recordExcursion(input: {
      readonly command: "RecordExcursion" | "UpdateExcursion";
      readonly operationReference: string;
      readonly expectedVersion: number;
      readonly excursion: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "command",
        "operationReference",
        "expectedVersion",
        "excursion",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createTemperatureExcursionRecord(input.excursion);
      } catch {
        return fail();
      }
      const common = await parsed(input);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(common.operationReference, digest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, excursion: existing.excursion });
      const reading = await ports.repository.loadReading(record.readingReference).catch(dependency);
      const latest = await ports.repository
        .loadLatestExcursion(record.excursionReference)
        .catch(dependency);
      if (
        reading === null ||
        !sameScope(reading.scope, record.scope) ||
        reading.policyVersionReference !== record.policyVersionReference ||
        record.recordedAt !== common.occurredAt
      )
        return fail("COMPLIANCE_MONITORING_LIFECYCLE_CONFLICT");
      if (
        input.command === "RecordExcursion"
          ? latest !== null ||
            input.expectedVersion !== 0 ||
            record.recordVersion !== 1 ||
            record.status !== "Open"
          : latest === null ||
            latest.recordVersion !== input.expectedVersion ||
            record.recordVersion !== input.expectedVersion + 1 ||
            record.priorRevisionReference !== latest.revisionReference ||
            !sameExcursionCore(record, latest) ||
            !excursionTransitions[latest.status].includes(record.status)
      )
        return fail("COMPLIANCE_MONITORING_VERSION_CONFLICT");
      const auth = await authorize(ports, {
        command: input.command,
        operationReference: common.operationReference,
        targetReference: record.excursionReference,
        scope: record.scope,
        purposeCode: common.purposeCode,
        observedAt: common.occurredAt,
      });
      if (record.actorReference !== auth.actor)
        return fail("COMPLIANCE_MONITORING_PERMISSION_DENIED");
      const events: readonly ComplianceMonitoringEvent[] =
        input.command === "RecordExcursion"
          ? [
              Object.freeze({
                eventType: "TemperatureExcursionDetected",
                recordReference: record.excursionReference,
                tenantReference: record.scope.tenantReference,
                brandReference: record.scope.brandReference,
                storeReference: record.scope.storeReference,
                requirementVersionReference: record.policyVersionReference,
                severity: record.severity,
                occurredAt: common.occurredAt,
              }),
            ]
          : [];
      const operation = Object.freeze({
        command: input.command,
        operationReference: common.operationReference,
        intentDigest: digest,
        reading: null,
        excursion: record,
        cleaning: null,
        events: Object.freeze(events),
      });
      const saved = await commit(operation, input.expectedVersion, auth.audit);
      return Object.freeze({ status: "Applied" as const, excursion: saved.excursion });
    },
    async recordCleaning(input: {
      readonly command: "RecordCleaning" | "UpdateCleaning";
      readonly operationReference: string;
      readonly expectedVersion: number;
      readonly cleaning: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "command",
        "operationReference",
        "expectedVersion",
        "cleaning",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createCleaningRecord(input.cleaning);
      } catch {
        return fail();
      }
      const common = await parsed(input);
      const digest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(common.operationReference, digest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, cleaning: existing.cleaning });
      const latest = await ports.repository
        .loadLatestCleaning(record.cleaningReference)
        .catch(dependency);
      if (
        record.recordedAt !== common.occurredAt ||
        (input.command === "RecordCleaning"
          ? latest !== null ||
            input.expectedVersion !== 0 ||
            record.recordVersion !== 1 ||
            record.status !== "Scheduled"
          : latest === null ||
            latest.recordVersion !== input.expectedVersion ||
            record.recordVersion !== input.expectedVersion + 1 ||
            record.priorRevisionReference !== latest.revisionReference ||
            !sameCleaningCore(record, latest) ||
            !cleaningTransitions[latest.status].includes(record.status))
      )
        return fail("COMPLIANCE_MONITORING_VERSION_CONFLICT");
      const auth = await authorize(ports, {
        command: input.command,
        operationReference: common.operationReference,
        targetReference: record.cleaningReference,
        scope: record.scope,
        purposeCode: common.purposeCode,
        observedAt: common.occurredAt,
      });
      if (record.actorReference !== auth.actor)
        return fail("COMPLIANCE_MONITORING_PERMISSION_DENIED");
      const failed =
        record.status === "VerificationFailed" && latest?.status !== "VerificationFailed";
      const events: readonly ComplianceMonitoringEvent[] = failed
        ? [
            Object.freeze({
              eventType: "CleaningVerificationFailed",
              recordReference: record.cleaningReference,
              tenantReference: record.scope.tenantReference,
              brandReference: record.scope.brandReference,
              storeReference: record.scope.storeReference,
              requirementVersionReference: record.policyVersionReference,
              severity: record.severity,
              occurredAt: common.occurredAt,
            }),
          ]
        : [];
      const operation = Object.freeze({
        command: input.command,
        operationReference: common.operationReference,
        intentDigest: digest,
        reading: null,
        excursion: null,
        cleaning: record,
        events: Object.freeze(events),
      });
      const saved = await commit(operation, input.expectedVersion, auth.audit);
      return Object.freeze({ status: "Applied" as const, cleaning: saved.cleaning });
    },
  });
}
