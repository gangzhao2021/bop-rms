import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createTraceEvidenceSet,
  createTraceExportReceipt,
  createTraceRecallOutcome,
  createTraceRun,
  parseTraceCriteria,
  type TraceEvidenceSet,
  type TraceRun,
} from "../contracts/compliance-traceability.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceTraceabilityCommand,
  ComplianceTraceabilityOperation,
  ComplianceTraceabilityPorts,
} from "./ports/compliance-traceability-ports.js";

export type ComplianceTraceabilityErrorCode =
  | "COMPLIANCE_TRACEABILITY_INPUT_INVALID"
  | "COMPLIANCE_TRACEABILITY_PERMISSION_DENIED"
  | "COMPLIANCE_TRACEABILITY_VERSION_CONFLICT"
  | "COMPLIANCE_TRACEABILITY_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT"
  | "COMPLIANCE_TRACEABILITY_DEPENDENCY_UNAVAILABLE";
export class ComplianceTraceabilityError extends Error {
  constructor(readonly code: ComplianceTraceabilityErrorCode) {
    super("Compliance traceability operation is unavailable");
    this.name = "ComplianceTraceabilityError";
  }
}
const fail = (
  code: ComplianceTraceabilityErrorCode = "COMPLIANCE_TRACEABILITY_INPUT_INVALID",
): never => {
  throw new ComplianceTraceabilityError(code);
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
  if (error instanceof ComplianceTraceabilityError) throw error;
  throw new ComplianceTraceabilityError("COMPLIANCE_TRACEABILITY_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (left: ComplianceScope, right: ComplianceScope) =>
  left.tenantReference === right.tenantReference &&
  left.brandReference === right.brandReference &&
  left.storeReference === right.storeReference;
const permissions: Record<ComplianceTraceabilityCommand, string> = {
  PinEvidenceSet: "compliance.traceability.evidence.pin",
  ExportEvidenceSet: "compliance.traceability.evidence.export",
  OpenRecallFromTrace: "compliance.recall.open",
};
const targetTypes: Record<ComplianceTraceabilityCommand, string> = {
  PinEvidenceSet: "TraceEvidenceSet",
  ExportEvidenceSet: "TraceEvidenceSet",
  OpenRecallFromTrace: "TraceRun",
};
function validateAuthorizationBase(
  evidence: {
    readonly tenantReference: string;
    readonly tenantContext: Parameters<typeof revalidateTenantContext>[0];
    readonly permission: {
      readonly effect: string;
      readonly action: string;
      readonly scopeKind: string;
    };
  },
  scope: ComplianceScope,
  permission: string,
) {
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    if (
      context.actor.actorReference === null ||
      evidence.tenantReference !== scope.tenantReference ||
      String(context.brand.brandReference) !== scope.brandReference ||
      (context.store === null ? null : String(context.store.storeReference)) !==
        scope.storeReference ||
      context.scopeKind !== evidence.permission.scopeKind ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permission
    )
      throw new Error("denied");
    return context;
  } catch {
    return fail("COMPLIANCE_TRACEABILITY_PERMISSION_DENIED");
  }
}
async function authorizeQuery(
  ports: ComplianceTraceabilityPorts,
  input: {
    operationReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorizeQuery(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_TRACEABILITY_PERMISSION_DENIED");
  validateAuthorizationBase(evidence, input.scope, "compliance.traceability.view");
}
async function authorizeCommand(
  ports: ComplianceTraceabilityPorts,
  input: {
    command: ComplianceTraceabilityCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorizeCommand(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_TRACEABILITY_PERMISSION_DENIED");
  const context = validateAuthorizationBase(evidence, input.scope, permissions[input.command]);
  try {
    const audit = validateAuditRecord(evidence.audit, Date.parse(input.observedAt));
    if (
      audit.brandId !== input.scope.brandReference ||
      (audit.storeId ?? null) !== input.scope.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== context.actor.actorReference ||
      audit.actionCode !== `COMPLIANCE_TRACEABILITY_${input.command.toUpperCase()}` ||
      audit.targetType !== targetTypes[input.command] ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    return fail("COMPLIANCE_TRACEABILITY_PERMISSION_DENIED");
  }
}
function validateRunForRequest(
  run: TraceRun,
  input: {
    scope: ComplianceScope;
    operationReference?: ComplianceReference;
    criteria?: ReturnType<typeof parseTraceCriteria>;
    observedAt: string;
  },
) {
  if (
    !sameScope(run.scope, input.scope) ||
    (input.operationReference !== undefined && run.runReference !== input.operationReference) ||
    (input.criteria !== undefined &&
      JSON.stringify(run.criteria) !== JSON.stringify(input.criteria)) ||
    (input.criteria !== undefined
      ? run.requestedAt !== input.observedAt
      : Date.parse(run.completedAt) > Date.parse(input.observedAt))
  )
    return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
}
async function resolveCase(
  ports: ComplianceTraceabilityPorts,
  caseReference: ComplianceReference,
  scope: ComplianceScope,
  allowClosed: boolean,
) {
  const raw = await ports.cases.resolve(caseReference).catch(dependency);
  let caseScope;
  try {
    caseScope = raw === null ? null : parseComplianceScope(raw.scope);
  } catch {
    return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
  }
  if (
    raw === null ||
    caseScope === null ||
    !sameScope(caseScope, scope) ||
    raw.accessClass !== "Restricted" ||
    raw.lifecycle === "Cancelled" ||
    (!allowClosed && raw.lifecycle === "Closed")
  )
    return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
}
function selectionsBelongToRun(evidenceSet: TraceEvidenceSet, run: TraceRun) {
  const nodes = new Set(run.nodes.map((item) => item.nodeReference));
  const edges = new Set(run.edges.map((item) => item.edgeReference));
  const gaps = new Set(run.gaps.map((item) => item.gapReference));
  return (
    evidenceSet.nodeReferences.every((reference) => nodes.has(reference)) &&
    evidenceSet.edgeReferences.every((reference) => edges.has(reference)) &&
    evidenceSet.gapReferences.every((reference) => gaps.has(reference))
  );
}

export function createComplianceTraceabilityService(ports: ComplianceTraceabilityPorts) {
  async function common(input: {
    operationReference: string;
    scope: unknown;
    purposeCode: string;
    observedAt: string;
  }) {
    try {
      return {
        operationReference: parseComplianceReference(input.operationReference),
        scope: parseComplianceScope(input.scope),
        purposeCode: parseComplianceCode(input.purposeCode),
        observedAt: parseComplianceInstant(input.observedAt),
      };
    } catch {
      return fail();
    }
  }
  async function prior(reference: ComplianceReference, digest: string) {
    const existing = await ports.repository.resolveOperation(reference).catch(dependency);
    if (existing !== null && !ports.references.equals(existing.intentDigest, digest))
      return fail("COMPLIANCE_TRACEABILITY_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function loadRun(
    reference: ComplianceReference,
    scope: ComplianceScope,
    observedAt: string,
  ) {
    const raw = await ports.traceProjection.loadRun(reference).catch(dependency);
    if (raw === null) return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
    let run;
    try {
      run = createTraceRun(raw);
    } catch {
      return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
    }
    validateRunForRequest(run, { scope, observedAt });
    return run;
  }
  async function commit(
    operation: ComplianceTraceabilityOperation,
    expectedRevision: number,
    audit: Awaited<ReturnType<typeof authorizeCommand>>,
  ) {
    return ports.repository.commit({ operation, expectedRevision, audit }).catch(dependency);
  }
  return Object.freeze({
    async query(input: {
      readonly operationReference: string;
      readonly scope: unknown;
      readonly criteria: unknown;
      readonly purposeCode: string;
      readonly observedAt: string;
    }) {
      exact(input, ["operationReference", "scope", "criteria", "purposeCode", "observedAt"]);
      const parsed = await common(input);
      let criteria;
      try {
        criteria = parseTraceCriteria(input.criteria);
      } catch {
        return fail();
      }
      if (Date.parse(criteria.periodTo) > Date.parse(parsed.observedAt)) return fail();
      await authorizeQuery(ports, parsed);
      const raw = await ports.traceProjection
        .run({
          operationReference: parsed.operationReference,
          scope: parsed.scope,
          criteria,
          requestedAt: parsed.observedAt,
        })
        .catch(dependency);
      if (raw === null) return dependency();
      let run;
      try {
        run = createTraceRun(raw);
      } catch {
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      }
      validateRunForRequest(run, {
        scope: parsed.scope,
        operationReference: parsed.operationReference,
        criteria,
        observedAt: parsed.observedAt,
      });
      return run;
    },
    async pinEvidenceSet(input: {
      readonly operationReference: string;
      readonly expectedRevision: 0;
      readonly evidenceSet: unknown;
      readonly purposeCode: string;
      readonly observedAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "evidenceSet",
        "purposeCode",
        "observedAt",
      ]);
      let evidenceSet;
      try {
        evidenceSet = createTraceEvidenceSet(input.evidenceSet);
      } catch {
        return fail();
      }
      const parsed = await common({ ...input, scope: evidenceSet.scope });
      if (
        input.expectedRevision !== 0 ||
        evidenceSet.revision !== 1 ||
        evidenceSet.createdAt !== parsed.observedAt
      )
        return fail("COMPLIANCE_TRACEABILITY_VERSION_CONFLICT");
      const audit = await authorizeCommand(ports, {
        command: "PinEvidenceSet",
        operationReference: parsed.operationReference,
        targetReference: evidenceSet.evidenceSetReference,
        scope: parsed.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.observedAt,
      });
      if (audit.actor.type === "System" || evidenceSet.createdBy !== audit.actor.reference)
        return fail("COMPLIANCE_TRACEABILITY_PERMISSION_DENIED");
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...existing });
      const [latest, run] = await Promise.all([
        ports.repository.loadEvidenceSet(evidenceSet.evidenceSetReference).catch(dependency),
        loadRun(evidenceSet.runReference, evidenceSet.scope, parsed.observedAt),
      ]);
      if (latest !== null) return fail("COMPLIANCE_TRACEABILITY_VERSION_CONFLICT");
      await resolveCase(ports, evidenceSet.caseReference, evidenceSet.scope, false);
      if (!selectionsBelongToRun(evidenceSet, run))
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      const operation: ComplianceTraceabilityOperation = Object.freeze({
        command: "PinEvidenceSet",
        operationReference: parsed.operationReference,
        intentDigest,
        evidenceSet,
        exportReceipt: null,
        recallOutcome: null,
      });
      const committed = await commit(operation, 0, audit);
      return Object.freeze({ status: "Applied" as const, ...committed });
    },
    async exportEvidenceSet(input: {
      readonly operationReference: string;
      readonly scope: unknown;
      readonly evidenceSetReference: string;
      readonly caseReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly observedAt: string;
    }) {
      exact(input, [
        "operationReference",
        "scope",
        "evidenceSetReference",
        "caseReference",
        "expectedRevision",
        "purposeCode",
        "observedAt",
      ]);
      const parsed = await common(input);
      let evidenceSetReference;
      let caseReference;
      try {
        evidenceSetReference = parseComplianceReference(input.evidenceSetReference);
        caseReference = parseComplianceReference(input.caseReference);
      } catch {
        return fail();
      }
      const audit = await authorizeCommand(ports, {
        command: "ExportEvidenceSet",
        operationReference: parsed.operationReference,
        targetReference: evidenceSetReference,
        scope: parsed.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.observedAt,
      });
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...existing });
      const rawSet = await ports.repository.loadEvidenceSet(evidenceSetReference).catch(dependency);
      if (rawSet === null) return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      let evidenceSet;
      try {
        evidenceSet = createTraceEvidenceSet(rawSet);
      } catch {
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      }
      if (
        input.expectedRevision !== evidenceSet.revision ||
        evidenceSet.caseReference !== caseReference ||
        !sameScope(evidenceSet.scope, parsed.scope)
      )
        return fail("COMPLIANCE_TRACEABILITY_VERSION_CONFLICT");
      await resolveCase(ports, caseReference, parsed.scope, true);
      const rawReceipt = await ports.artifacts
        .exportRestricted({
          operationReference: parsed.operationReference,
          scope: parsed.scope,
          caseReference,
          evidenceSet,
          requestedAt: parsed.observedAt,
        })
        .catch(dependency);
      let receipt;
      try {
        receipt = createTraceExportReceipt(rawReceipt);
      } catch {
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      }
      if (
        receipt.exportOperationReference !== parsed.operationReference ||
        receipt.evidenceSetReference !== evidenceSetReference ||
        receipt.caseReference !== caseReference ||
        receipt.recordedAt !== parsed.observedAt
      )
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      const operation: ComplianceTraceabilityOperation = Object.freeze({
        command: "ExportEvidenceSet",
        operationReference: parsed.operationReference,
        intentDigest,
        evidenceSet: null,
        exportReceipt: receipt,
        recallOutcome: null,
      });
      const committed = await commit(operation, input.expectedRevision, audit);
      return Object.freeze({ status: "Applied" as const, ...committed });
    },
    async openRecallFromTrace(input: {
      readonly operationReference: string;
      readonly scope: unknown;
      readonly runReference: string;
      readonly caseReference: string;
      readonly purposeCode: string;
      readonly observedAt: string;
    }) {
      exact(input, [
        "operationReference",
        "scope",
        "runReference",
        "caseReference",
        "purposeCode",
        "observedAt",
      ]);
      const parsed = await common(input);
      let runReference;
      let caseReference;
      try {
        runReference = parseComplianceReference(input.runReference);
        caseReference = parseComplianceReference(input.caseReference);
      } catch {
        return fail();
      }
      const audit = await authorizeCommand(ports, {
        command: "OpenRecallFromTrace",
        operationReference: parsed.operationReference,
        targetReference: runReference,
        scope: parsed.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.observedAt,
      });
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({ status: "AlreadyApplied" as const, ...existing });
      const run = await loadRun(runReference, parsed.scope, parsed.observedAt);
      await resolveCase(ports, caseReference, parsed.scope, false);
      const rawOutcome = await ports.recalls
        .openFromTrace({
          operationReference: parsed.operationReference,
          scope: parsed.scope,
          caseReference,
          run,
          requestedAt: parsed.observedAt,
        })
        .catch(dependency);
      let outcome;
      try {
        outcome = createTraceRecallOutcome(rawOutcome);
      } catch {
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      }
      if (
        outcome.requestReference !== parsed.operationReference ||
        outcome.runReference !== runReference ||
        outcome.recordedAt !== parsed.observedAt
      )
        return fail("COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT");
      const operation: ComplianceTraceabilityOperation = Object.freeze({
        command: "OpenRecallFromTrace",
        operationReference: parsed.operationReference,
        intentDigest,
        evidenceSet: null,
        exportReceipt: null,
        recallOutcome: outcome,
      });
      const committed = await commit(operation, 0, audit);
      return Object.freeze({ status: "Applied" as const, ...committed });
    },
  });
}
