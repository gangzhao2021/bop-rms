import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createRecallRecord,
  type RecallDisposition,
  type RecallRecord,
} from "../contracts/compliance-recall.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceRecallCommand,
  ComplianceRecallEvent,
  ComplianceRecallOperation,
  ComplianceRecallPorts,
} from "./ports/compliance-recall-ports.js";

export type ComplianceRecallErrorCode =
  | "COMPLIANCE_RECALL_INPUT_INVALID"
  | "COMPLIANCE_RECALL_PERMISSION_DENIED"
  | "COMPLIANCE_RECALL_VERSION_CONFLICT"
  | "COMPLIANCE_RECALL_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_RECALL_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_RECALL_SOURCE_CONFLICT"
  | "COMPLIANCE_RECALL_DEPENDENCY_UNAVAILABLE";
export class ComplianceRecallError extends Error {
  constructor(readonly code: ComplianceRecallErrorCode) {
    super("Compliance Recall operation is unavailable");
    this.name = "ComplianceRecallError";
  }
}
const fail = (code: ComplianceRecallErrorCode = "COMPLIANCE_RECALL_INPUT_INVALID"): never => {
  throw new ComplianceRecallError(code);
};
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
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
function dependency(error?: unknown): never {
  if (error instanceof ComplianceRecallError) throw error;
  throw new ComplianceRecallError("COMPLIANCE_RECALL_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const permissions: Record<ComplianceRecallCommand, string> = {
  InitiateRecall: "compliance.recall.initiate",
  CalculateRecallScope: "compliance.recall.scope.calculate",
  EnforceRecallContainment: "compliance.recall.containment.enforce",
  CreateRecallTasks: "compliance.recall.task.create",
  ResolveRecallNotice: "compliance.recall.notice.resolve",
  RecordRecallDisposition: "compliance.recall.disposition.record",
  VerifyRecallClosure: "compliance.recall.closure.verify",
};
async function authorize(
  ports: ComplianceRecallPorts,
  input: {
    command: ComplianceRecallCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_RECALL_PERMISSION_DENIED");
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
      context.scopeKind !== evidence.permission.scopeKind ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permissions[input.command] ||
      audit.brandId !== input.scope.brandReference ||
      (audit.storeId ?? null) !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `COMPLIANCE_RECALL_${input.command.toUpperCase()}` ||
      audit.targetType !== "RecallRecord" ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    return fail("COMPLIANCE_RECALL_PERMISSION_DENIED");
  }
}
const sameCore = (left: RecallRecord, right: RecallRecord) =>
  left.recallReference === right.recallReference &&
  left.caseReference === right.caseReference &&
  sameScope(left.scope, right.scope) &&
  left.recallType === right.recallType &&
  left.sourceKind === right.sourceKind &&
  left.sourceReference === right.sourceReference &&
  left.sourceSnapshotDigest === right.sourceSnapshotDigest &&
  left.severity === right.severity &&
  left.effectiveFrom === right.effectiveFrom &&
  left.effectiveTo === right.effectiveTo &&
  left.noticeRequirement === right.noticeRequirement &&
  left.requirementVersionReference === right.requirementVersionReference;
function events(
  previous: RecallRecord | null,
  record: RecallRecord,
): readonly ComplianceRecallEvent[] {
  const eventType =
    previous === null
      ? "RecallInitiated"
      : previous.status !== "Closed" && record.status === "Closed"
        ? "RecallClosed"
        : null;
  return eventType === null
    ? []
    : [
        Object.freeze({
          eventType,
          recordReference: record.recallReference,
          tenantReference: record.scope.tenantReference,
          brandReference: record.scope.brandReference,
          storeReference: record.scope.storeReference,
          requirementVersionReference: record.requirementVersionReference,
          severity: record.severity,
          occurredAt: record.recordedAt,
        }),
      ];
}

export function createComplianceRecallService(ports: ComplianceRecallPorts) {
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
      return fail("COMPLIANCE_RECALL_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function load(reference: ComplianceReference, expectedRevision: number) {
    const latest = await ports.repository.loadLatest(reference).catch(dependency);
    if (
      latest === null ||
      latest.revision !== expectedRevision ||
      latest.status === "Closed" ||
      latest.status === "Cancelled"
    )
      return fail("COMPLIANCE_RECALL_VERSION_CONFLICT");
    return latest;
  }
  async function resolveCase(record: RecallRecord) {
    const raw = await ports.cases.resolve(record.caseReference).catch(dependency);
    let scope;
    try {
      scope = raw === null ? null : parseComplianceScope(raw.scope);
    } catch {
      return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
    }
    if (
      raw === null ||
      scope === null ||
      raw.caseType !== "RecallWithdrawal" ||
      !sameScope(scope, record.scope) ||
      raw.lifecycle === "Closed" ||
      raw.lifecycle === "Cancelled"
    )
      return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
  }
  async function persist(input: {
    command: ComplianceRecallCommand;
    operationReference: ComplianceReference;
    intentDigest: string;
    previous: RecallRecord | null;
    record: RecallRecord;
    expectedRevision: number;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    occurredAt: string;
    audit?: Awaited<ReturnType<typeof authorize>>;
  }) {
    const audit =
      input.audit ??
      (await authorize(ports, {
        command: input.command,
        operationReference: input.operationReference,
        targetReference: input.record.recallReference,
        scope: input.record.scope,
        purposeCode: input.purposeCode,
        observedAt: input.occurredAt,
      }));
    const operation: ComplianceRecallOperation = Object.freeze({
      command: input.command,
      operationReference: input.operationReference,
      intentDigest: input.intentDigest,
      recall: input.record,
      events: Object.freeze(events(input.previous, input.record)),
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision, audit })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, recall: committed.recall });
  }
  async function operationInput(input: {
    operationReference: string;
    recallReference: string;
    expectedRevision: number;
    purposeCode: string;
    occurredAt: string;
  }) {
    const parsed = await common(input);
    let recallReference;
    try {
      recallReference = parseComplianceReference(input.recallReference);
    } catch {
      return fail();
    }
    const intentDigest = ports.references.hashIntent(JSON.stringify(input));
    return { ...parsed, recallReference, intentDigest };
  }
  async function idempotent(
    parsed: Awaited<ReturnType<typeof operationInput>>,
    command: ComplianceRecallCommand,
  ) {
    const existing = await prior(parsed.operationReference, parsed.intentDigest);
    if (existing === null) return null;
    await authorize(ports, {
      command,
      operationReference: parsed.operationReference,
      targetReference: existing.recall.recallReference,
      scope: existing.recall.scope,
      purposeCode: parsed.purposeCode,
      observedAt: parsed.occurredAt,
    });
    return Object.freeze({ status: "AlreadyApplied" as const, recall: existing.recall });
  }
  return Object.freeze({
    async initiateRecall(input: {
      readonly operationReference: string;
      readonly expectedRevision: 0;
      readonly recall: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "recall",
        "purposeCode",
        "occurredAt",
      ]);
      let record;
      try {
        record = createRecallRecord(input.recall);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null) {
        await authorize(ports, {
          command: "InitiateRecall",
          operationReference: parsed.operationReference,
          targetReference: existing.recall.recallReference,
          scope: existing.recall.scope,
          purposeCode: parsed.purposeCode,
          observedAt: parsed.occurredAt,
        });
        return Object.freeze({ status: "AlreadyApplied" as const, recall: existing.recall });
      }
      const latest = await ports.repository.loadLatest(record.recallReference).catch(dependency);
      if (
        input.expectedRevision !== 0 ||
        latest !== null ||
        record.revision !== 1 ||
        record.status !== "ScopeAssessment" ||
        record.recordedAt !== parsed.occurredAt
      )
        return fail("COMPLIANCE_RECALL_VERSION_CONFLICT");
      await resolveCase(record);
      return persist({
        command: "InitiateRecall",
        operationReference: parsed.operationReference,
        intentDigest,
        previous: null,
        record,
        expectedRevision: 0,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async calculateRecallScope(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly traceRunReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "traceRunReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "CalculateRecallScope");
      if (replay !== null) return replay;
      let traceRunReference;
      try {
        traceRunReference = parseComplianceReference(input.traceRunReference);
      } catch {
        return fail();
      }
      const latest = await load(parsed.recallReference, input.expectedRevision);
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "CalculateRecallScope",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const affectedScope = await ports.traceScope
        .calculate({
          operationReference: parsed.operationReference,
          recall: latest,
          traceRunReference,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          status: "Containment",
          affectedScope,
          containmentOutcomes: null,
          taskOutcomeReference: null,
          noticeOutcomes: null,
          dispositions: [],
          verification: null,
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      if (
        record.affectedScope?.traceRunReference !== traceRunReference ||
        !sameCore(latest, record)
      )
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      return persist({
        command: "CalculateRecallScope",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
    async enforceRecallContainment(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "EnforceRecallContainment");
      if (replay !== null) return replay;
      const latest = await load(parsed.recallReference, input.expectedRevision);
      if (latest.status !== "Containment" || latest.affectedScope === null)
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "EnforceRecallContainment",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const containmentOutcomes = await ports.containment
        .enforce({
          operationReference: parsed.operationReference,
          recall: latest,
          requestedAt: parsed.occurredAt,
          hardBlock: true,
          overrideAllowed: false,
        })
        .catch(dependency);
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          status: "Notification",
          containmentOutcomes,
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      return persist({
        command: "EnforceRecallContainment",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
    async createRecallTasks(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "CreateRecallTasks");
      if (replay !== null) return replay;
      const latest = await load(parsed.recallReference, input.expectedRevision);
      if (latest.affectedScope === null || latest.taskOutcomeReference !== null)
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "CreateRecallTasks",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const outcome = await ports.tasks
        .create({
          operationReference: parsed.operationReference,
          recall: latest,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          taskOutcomeReference: parseComplianceReference(outcome.taskOutcomeReference),
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      return persist({
        command: "CreateRecallTasks",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
    async resolveRecallNotice(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "ResolveRecallNotice");
      if (replay !== null) return replay;
      const latest = await load(parsed.recallReference, input.expectedRevision);
      if (
        latest.status !== "Notification" ||
        latest.affectedScope === null ||
        latest.containmentOutcomes === null ||
        latest.noticeOutcomes !== null
      )
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "ResolveRecallNotice",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const noticeOutcomes = await ports.notices
        .resolve({
          operationReference: parsed.operationReference,
          recall: latest,
          customerOrderCount: latest.affectedScope.customerOrderCount,
          fulfillmentCount: latest.affectedScope.fulfillmentCount,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          status: "Disposition",
          noticeOutcomes,
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      return persist({
        command: "ResolveRecallNotice",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
    async recordRecallDisposition(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly expectedRevision: number;
      readonly subjectKind: RecallDisposition["subjectKind"];
      readonly subjectReference: string;
      readonly decision: RecallDisposition["decision"];
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "expectedRevision",
        "subjectKind",
        "subjectReference",
        "decision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "RecordRecallDisposition");
      if (replay !== null) return replay;
      let subjectReference;
      try {
        subjectReference = parseComplianceReference(input.subjectReference);
      } catch {
        return fail();
      }
      const latest = await load(parsed.recallReference, input.expectedRevision);
      if (
        (latest.status !== "Disposition" && latest.status !== "Verification") ||
        latest.noticeOutcomes === null
      )
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "RecordRecallDisposition",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const disposition = await ports.dispositions
        .record({
          operationReference: parsed.operationReference,
          recall: latest,
          subjectKind: input.subjectKind,
          subjectReference,
          decision: input.decision,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          status: "Verification",
          dispositions: [...latest.dispositions, disposition],
          verification: null,
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      if (
        record.dispositions.at(-1)?.subjectReference !== subjectReference ||
        record.dispositions.at(-1)?.subjectKind !== input.subjectKind ||
        record.dispositions.at(-1)?.decision !== input.decision
      )
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      return persist({
        command: "RecordRecallDisposition",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
    async verifyRecallClosure(input: {
      readonly operationReference: string;
      readonly recallReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "recallReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await operationInput(input);
      const replay = await idempotent(parsed, "VerifyRecallClosure");
      if (replay !== null) return replay;
      const latest = await load(parsed.recallReference, input.expectedRevision);
      if (
        latest.status !== "Verification" ||
        latest.affectedScope === null ||
        latest.containmentOutcomes === null ||
        latest.noticeOutcomes === null ||
        latest.dispositions.length < 1
      )
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const audit = await authorize(ports, {
        command: "VerifyRecallClosure",
        operationReference: parsed.operationReference,
        targetReference: latest.recallReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const verification = await ports.verification
        .verify({
          operationReference: parsed.operationReference,
          recall: latest,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      if (
        audit.actor.type === "System" ||
        verification.verifiedBy === audit.actor.reference ||
        latest.dispositions.some((item) => item.decidedBy === verification.verifiedBy)
      )
        return fail("COMPLIANCE_RECALL_LIFECYCLE_CONFLICT");
      let record;
      try {
        record = createRecallRecord({
          ...latest,
          revision: latest.revision + 1,
          status: verification.result === "Passed" ? "Closed" : "Disposition",
          verification,
          recordedAt: parsed.occurredAt,
        });
      } catch {
        return fail("COMPLIANCE_RECALL_SOURCE_CONFLICT");
      }
      return persist({
        command: "VerifyRecallClosure",
        operationReference: parsed.operationReference,
        intentDigest: parsed.intentDigest,
        previous: latest,
        record,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        audit,
      });
    },
  });
}
