import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createAllergenControlReview,
  createFoodSafetyIncidentRecord,
  type AllergenControlReview,
  type FoodSafetyIncidentRecord,
  type FoodSafetyIncidentStatus,
} from "../contracts/compliance-allergen-incident.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  ComplianceAllergenIncidentCommand,
  ComplianceAllergenIncidentEvent,
  ComplianceAllergenIncidentOperation,
  ComplianceAllergenIncidentPorts,
} from "./ports/compliance-allergen-incident-ports.js";

export type ComplianceAllergenIncidentErrorCode =
  | "COMPLIANCE_ALLERGEN_INCIDENT_INPUT_INVALID"
  | "COMPLIANCE_ALLERGEN_INCIDENT_PERMISSION_DENIED"
  | "COMPLIANCE_ALLERGEN_INCIDENT_VERSION_CONFLICT"
  | "COMPLIANCE_ALLERGEN_INCIDENT_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_ALLERGEN_INCIDENT_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_ALLERGEN_INCIDENT_SOURCE_CONFLICT"
  | "COMPLIANCE_ALLERGEN_INCIDENT_DEPENDENCY_UNAVAILABLE";
export class ComplianceAllergenIncidentError extends Error {
  constructor(readonly code: ComplianceAllergenIncidentErrorCode) {
    super("Compliance allergen or incident operation is unavailable");
    this.name = "ComplianceAllergenIncidentError";
  }
}
const fail = (
  code: ComplianceAllergenIncidentErrorCode = "COMPLIANCE_ALLERGEN_INCIDENT_INPUT_INVALID",
): never => {
  throw new ComplianceAllergenIncidentError(code);
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
  if (error instanceof ComplianceAllergenIncidentError) throw error;
  throw new ComplianceAllergenIncidentError("COMPLIANCE_ALLERGEN_INCIDENT_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (a: ComplianceScope, b: ComplianceScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
const permissions: Record<ComplianceAllergenIncidentCommand, string> = {
  RecordAllergenReview: "compliance.allergen.review.record",
  ReviseAllergenReview: "compliance.allergen.review.manage",
  EnforceAllergenBlocks: "compliance.allergen.block.enforce",
  ReportFoodSafetyIncident: "compliance.incident.report",
  ReviseFoodSafetyIncident: "compliance.incident.manage",
  EnforceIncidentBlocks: "compliance.incident.block.enforce",
};
const targetTypes: Record<ComplianceAllergenIncidentCommand, string> = {
  RecordAllergenReview: "AllergenControlReview",
  ReviseAllergenReview: "AllergenControlReview",
  EnforceAllergenBlocks: "AllergenControlReview",
  ReportFoodSafetyIncident: "FoodSafetyIncident",
  ReviseFoodSafetyIncident: "FoodSafetyIncident",
  EnforceIncidentBlocks: "FoodSafetyIncident",
};
const incidentTransitions: Record<FoodSafetyIncidentStatus, readonly FoodSafetyIncidentStatus[]> = {
  Reported: ["Contained", "Investigating", "Cancelled"],
  Contained: ["Investigating", "CorrectiveAction", "Verification", "Cancelled"],
  Investigating: ["Contained", "CorrectiveAction", "Verification", "Cancelled"],
  CorrectiveAction: ["Verification", "Cancelled"],
  Verification: ["CorrectiveAction", "Closed", "Cancelled"],
  Closed: [],
  Cancelled: [],
};
const reviewTransitions: Record<
  AllergenControlReview["reviewStatus"],
  readonly AllergenControlReview["reviewStatus"][]
> = {
  Pending: ["Approved", "Rejected", "Invalidated"],
  Approved: ["Invalidated"],
  Rejected: ["Invalidated"],
  Invalidated: [],
};
async function authorize(
  ports: ComplianceAllergenIncidentPorts,
  input: {
    command: ComplianceAllergenIncidentCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_ALLERGEN_INCIDENT_PERMISSION_DENIED");
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
      audit.actionCode !== `COMPLIANCE_ALLERGEN_INCIDENT_${input.command.toUpperCase()}` ||
      audit.targetType !== targetTypes[input.command] ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return audit;
  } catch {
    return fail("COMPLIANCE_ALLERGEN_INCIDENT_PERMISSION_DENIED");
  }
}
function sameReviewCore(a: AllergenControlReview, b: AllergenControlReview) {
  return (
    a.reviewReference === b.reviewReference &&
    sameScope(a.scope, b.scope) &&
    a.subjectKind === b.subjectKind &&
    a.subjectReference === b.subjectReference &&
    a.configurationDigest === b.configurationDigest &&
    a.allergenPolicyVersionReference === b.allergenPolicyVersionReference &&
    JSON.stringify(a.recipeVersionReferences) === JSON.stringify(b.recipeVersionReferences) &&
    JSON.stringify(a.sourceAssertions) === JSON.stringify(b.sourceAssertions) &&
    a.requirementVersionReference === b.requirementVersionReference &&
    a.allergenFreeClaim === false
  );
}
function sameIncidentCore(a: FoodSafetyIncidentRecord, b: FoodSafetyIncidentRecord) {
  return (
    a.incidentReference === b.incidentReference &&
    a.caseReference === b.caseReference &&
    sameScope(a.scope, b.scope) &&
    a.incidentType === b.incidentType &&
    a.severity === b.severity &&
    a.occurredAt === b.occurredAt &&
    a.reportedAt === b.reportedAt &&
    a.reporterReference === b.reporterReference &&
    a.productReference === b.productReference &&
    a.orderReference === b.orderReference &&
    a.lotReference === b.lotReference &&
    a.employeeReference === b.employeeReference &&
    a.allegationSnapshotReference === b.allegationSnapshotReference &&
    a.healthSnapshotReference === b.healthSnapshotReference &&
    a.configurationSnapshotDigest === b.configurationSnapshotDigest &&
    a.recipeSnapshotDigest === b.recipeSnapshotDigest &&
    a.handlingSnapshotDigest === b.handlingSnapshotDigest &&
    a.requirementVersionReference === b.requirementVersionReference &&
    a.accessClass === "Restricted"
  );
}
const isSuperset = (before: readonly string[], after: readonly string[]) =>
  before.every((reference) => after.includes(reference));
function preservedIncidentFacts(a: FoodSafetyIncidentRecord, b: FoodSafetyIncidentRecord) {
  return (
    isSuperset(a.containmentOutcomeReferences, b.containmentOutcomeReferences) &&
    isSuperset(a.evidenceReferences, b.evidenceReferences) &&
    (a.notificationReference === null || a.notificationReference === b.notificationReference) &&
    (a.investigationReference === null || a.investigationReference === b.investigationReference) &&
    (a.verificationReference === null || a.verificationReference === b.verificationReference) &&
    (a.availabilityBlockOutcomeReference === null ||
      a.availabilityBlockOutcomeReference === b.availabilityBlockOutcomeReference) &&
    (a.paymentBlockOutcomeReference === null ||
      a.paymentBlockOutcomeReference === b.paymentBlockOutcomeReference)
  );
}
function reviewEvents(
  previous: AllergenControlReview | null,
  record: AllergenControlReview,
): readonly ComplianceAllergenIncidentEvent[] {
  if (
    previous?.reviewStatus === record.reviewStatus ||
    (record.reviewStatus !== "Rejected" && record.reviewStatus !== "Invalidated")
  )
    return [];
  return [
    Object.freeze({
      eventType: "AllergenControlFailureDetected",
      recordReference: record.reviewReference,
      tenantReference: record.scope.tenantReference,
      brandReference: record.scope.brandReference,
      storeReference: record.scope.storeReference,
      requirementVersionReference: record.requirementVersionReference,
      severity: record.severity,
      occurredAt: record.recordedAt,
    }),
  ];
}
function incidentEvents(
  previous: FoodSafetyIncidentRecord | null,
  record: FoodSafetyIncidentRecord,
): readonly ComplianceAllergenIncidentEvent[] {
  if (previous !== null) return [];
  return [
    Object.freeze({
      eventType: "FoodSafetyIncidentReported",
      recordReference: record.incidentReference,
      tenantReference: record.scope.tenantReference,
      brandReference: record.scope.brandReference,
      storeReference: record.scope.storeReference,
      requirementVersionReference: record.requirementVersionReference,
      severity: record.severity,
      occurredAt: record.recordedAt,
    }),
  ];
}

export function createComplianceAllergenIncidentService(ports: ComplianceAllergenIncidentPorts) {
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
      return fail("COMPLIANCE_ALLERGEN_INCIDENT_IDEMPOTENCY_CONFLICT");
    return existing;
  }
  async function assessReview(record: AllergenControlReview, occurredAt: string) {
    const assessment = await ports.allergenSources
      .assess({
        scope: record.scope,
        subjectKind: record.subjectKind,
        subjectReference: record.subjectReference,
        configurationDigest: record.configurationDigest,
        allergenPolicyVersionReference: record.allergenPolicyVersionReference,
        recipeVersionReferences: record.recipeVersionReferences,
        sourceVersionReferences: record.sourceAssertions.map((item) => item.sourceVersionReference),
      })
      .catch(dependency);
    let assessedScope;
    let assessedAt;
    let invalidatingSourceVersionReference;
    try {
      assessedScope = parseComplianceScope(assessment.scope);
      assessedAt = parseComplianceInstant(assessment.assessedAt);
      invalidatingSourceVersionReference =
        assessment.invalidatingSourceVersionReference === null
          ? null
          : parseComplianceReference(assessment.invalidatingSourceVersionReference);
    } catch {
      return fail("COMPLIANCE_ALLERGEN_INCIDENT_SOURCE_CONFLICT");
    }
    if (
      !sameScope(assessedScope, record.scope) ||
      Date.parse(assessedAt) > Date.parse(occurredAt) ||
      (record.reviewStatus === "Approved" && !assessment.matchesPinned) ||
      (record.reviewStatus === "Invalidated" &&
        (assessment.matchesPinned ||
          invalidatingSourceVersionReference !== record.invalidatedBySourceVersionReference))
    )
      return fail("COMPLIANCE_ALLERGEN_INCIDENT_SOURCE_CONFLICT");
  }
  async function resolveCase(record: FoodSafetyIncidentRecord) {
    const snapshot = await ports.cases.resolve(record.caseReference).catch(dependency);
    let snapshotScope;
    try {
      snapshotScope = snapshot === null ? null : parseComplianceScope(snapshot.scope);
    } catch {
      return fail("COMPLIANCE_ALLERGEN_INCIDENT_SOURCE_CONFLICT");
    }
    if (
      snapshot === null ||
      snapshot.caseType !== "FoodSafetyIncident" ||
      snapshotScope === null ||
      !sameScope(snapshotScope, record.scope) ||
      snapshot.lifecycle === "Closed" ||
      snapshot.lifecycle === "Cancelled"
    )
      return fail("COMPLIANCE_ALLERGEN_INCIDENT_SOURCE_CONFLICT");
  }
  async function persist(input: {
    command: ComplianceAllergenIncidentCommand;
    operationReference: ComplianceReference;
    intentDigest: string;
    review: AllergenControlReview | null;
    incident: FoodSafetyIncidentRecord | null;
    previousReview: AllergenControlReview | null;
    previousIncident: FoodSafetyIncidentRecord | null;
    expectedRevision: number;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    occurredAt: string;
    authorizedAudit?: Awaited<ReturnType<typeof authorize>>;
  }) {
    const record = input.review ?? input.incident;
    if (record === null) return fail();
    const targetReference =
      input.review?.reviewReference ?? input.incident?.incidentReference ?? fail();
    const audit =
      input.authorizedAudit ??
      (await authorize(ports, {
        command: input.command,
        operationReference: input.operationReference,
        targetReference,
        scope: record.scope,
        purposeCode: input.purposeCode,
        observedAt: input.occurredAt,
      }));
    const operation: ComplianceAllergenIncidentOperation = Object.freeze({
      command: input.command,
      operationReference: input.operationReference,
      intentDigest: input.intentDigest,
      allergenReview: input.review,
      incident: input.incident,
      events: Object.freeze(
        input.review !== null
          ? reviewEvents(input.previousReview, input.review)
          : incidentEvents(input.previousIncident, input.incident ?? fail()),
      ),
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision, audit })
      .catch(dependency);
    return Object.freeze({
      status: "Applied" as const,
      allergenReview: committed.allergenReview,
      incident: committed.incident,
    });
  }
  return Object.freeze({
    async recordAllergenReview(input: {
      readonly operationReference: string;
      readonly expectedRevision: 0;
      readonly review: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "review",
        "purposeCode",
        "occurredAt",
      ]);
      let review;
      try {
        review = createAllergenControlReview(input.review);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository
        .loadLatestReview(review.reviewReference)
        .catch(dependency);
      if (
        input.expectedRevision !== 0 ||
        latest !== null ||
        review.revision !== 1 ||
        review.recordedAt !== parsed.occurredAt
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_VERSION_CONFLICT");
      await assessReview(review, parsed.occurredAt);
      return persist({
        command: "RecordAllergenReview",
        operationReference: parsed.operationReference,
        intentDigest,
        review,
        incident: null,
        previousReview: null,
        previousIncident: null,
        expectedRevision: 0,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async reviseAllergenReview(input: {
      readonly operationReference: string;
      readonly expectedRevision: number;
      readonly review: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "review",
        "purposeCode",
        "occurredAt",
      ]);
      let review;
      try {
        review = createAllergenControlReview(input.review);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository
        .loadLatestReview(review.reviewReference)
        .catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        review.revision !== input.expectedRevision + 1 ||
        review.recordedAt !== parsed.occurredAt ||
        !sameReviewCore(latest, review) ||
        !reviewTransitions[latest.reviewStatus].includes(review.reviewStatus)
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_LIFECYCLE_CONFLICT");
      await assessReview(review, parsed.occurredAt);
      return persist({
        command: "ReviseAllergenReview",
        operationReference: parsed.operationReference,
        intentDigest,
        review,
        incident: null,
        previousReview: latest,
        previousIncident: null,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async enforceAllergenBlocks(input: {
      readonly operationReference: string;
      readonly reviewReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "reviewReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await common(input);
      const reviewReference = parseComplianceReference(input.reviewReference);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository.loadLatestReview(reviewReference).catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        latest.publicationBlockOutcomeReference !== null ||
        latest.paymentBlockOutcomeReference !== null ||
        (latest.reviewStatus === "Approved" &&
          latest.sourceAssertions.every(
            (item) =>
              item.classification !== "Unverified" &&
              item.evidenceStatus === "Current" &&
              Date.parse(item.validUntil) > Date.parse(parsed.occurredAt),
          ))
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_LIFECYCLE_CONFLICT");
      await assessReview(latest, parsed.occurredAt);
      const authorizedAudit = await authorize(ports, {
        command: "EnforceAllergenBlocks",
        operationReference: parsed.operationReference,
        targetReference: latest.reviewReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const outcomes = await ports.ownerBlocks
        .enforce({
          operationReference: parsed.operationReference,
          scope: latest.scope,
          reasonCode: "ALLERGEN_REVIEW_UNSAFE",
          subjectReference: latest.subjectReference,
          orderReference: null,
          requirementVersionReference: latest.requirementVersionReference,
          configurationDigest: latest.configurationDigest,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      const review = createAllergenControlReview({
        ...latest,
        revision: latest.revision + 1,
        publicationBlockOutcomeReference: outcomes.availabilityBlockOutcomeReference,
        paymentBlockOutcomeReference: outcomes.paymentBlockOutcomeReference,
        recordedAt: parsed.occurredAt,
      });
      return persist({
        command: "EnforceAllergenBlocks",
        operationReference: parsed.operationReference,
        intentDigest,
        review,
        incident: null,
        previousReview: latest,
        previousIncident: null,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        authorizedAudit,
      });
    },
    async reportFoodSafetyIncident(input: {
      readonly operationReference: string;
      readonly expectedRevision: 0;
      readonly incident: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "incident",
        "purposeCode",
        "occurredAt",
      ]);
      let incident;
      try {
        incident = createFoodSafetyIncidentRecord(input.incident);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository
        .loadLatestIncident(incident.incidentReference)
        .catch(dependency);
      if (
        input.expectedRevision !== 0 ||
        latest !== null ||
        incident.revision !== 1 ||
        incident.status !== "Reported" ||
        incident.recordedAt !== parsed.occurredAt
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_VERSION_CONFLICT");
      await resolveCase(incident);
      return persist({
        command: "ReportFoodSafetyIncident",
        operationReference: parsed.operationReference,
        intentDigest,
        review: null,
        incident,
        previousReview: null,
        previousIncident: null,
        expectedRevision: 0,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async reviseFoodSafetyIncident(input: {
      readonly operationReference: string;
      readonly expectedRevision: number;
      readonly incident: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "expectedRevision",
        "incident",
        "purposeCode",
        "occurredAt",
      ]);
      let incident;
      try {
        incident = createFoodSafetyIncidentRecord(input.incident);
      } catch {
        return fail();
      }
      const parsed = await common(input);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository
        .loadLatestIncident(incident.incidentReference)
        .catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        incident.revision !== input.expectedRevision + 1 ||
        incident.recordedAt !== parsed.occurredAt ||
        !sameIncidentCore(latest, incident) ||
        !preservedIncidentFacts(latest, incident) ||
        !incidentTransitions[latest.status].includes(incident.status)
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_LIFECYCLE_CONFLICT");
      await resolveCase(incident);
      return persist({
        command: "ReviseFoodSafetyIncident",
        operationReference: parsed.operationReference,
        intentDigest,
        review: null,
        incident,
        previousReview: null,
        previousIncident: latest,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
      });
    },
    async enforceIncidentBlocks(input: {
      readonly operationReference: string;
      readonly incidentReference: string;
      readonly expectedRevision: number;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) {
      exact(input, [
        "operationReference",
        "incidentReference",
        "expectedRevision",
        "purposeCode",
        "occurredAt",
      ]);
      const parsed = await common(input);
      const incidentReference = parseComplianceReference(input.incidentReference);
      const intentDigest = ports.references.hashIntent(JSON.stringify(input));
      const existing = await prior(parsed.operationReference, intentDigest);
      if (existing !== null)
        return Object.freeze({
          status: "AlreadyApplied" as const,
          allergenReview: existing.allergenReview,
          incident: existing.incident,
        });
      const latest = await ports.repository.loadLatestIncident(incidentReference).catch(dependency);
      if (
        latest === null ||
        latest.revision !== input.expectedRevision ||
        latest.status === "Closed" ||
        latest.status === "Cancelled" ||
        latest.availabilityBlockOutcomeReference !== null ||
        latest.paymentBlockOutcomeReference !== null ||
        (latest.incidentType !== "AllergenExposure" && latest.severity !== "ImmediateDanger")
      )
        return fail("COMPLIANCE_ALLERGEN_INCIDENT_LIFECYCLE_CONFLICT");
      await resolveCase(latest);
      const authorizedAudit = await authorize(ports, {
        command: "EnforceIncidentBlocks",
        operationReference: parsed.operationReference,
        targetReference: latest.incidentReference,
        scope: latest.scope,
        purposeCode: parsed.purposeCode,
        observedAt: parsed.occurredAt,
      });
      const outcomes = await ports.ownerBlocks
        .enforce({
          operationReference: parsed.operationReference,
          scope: latest.scope,
          reasonCode: "FOOD_SAFETY_INCIDENT",
          subjectReference: latest.productReference,
          orderReference: latest.orderReference,
          requirementVersionReference: latest.requirementVersionReference,
          configurationDigest: latest.configurationSnapshotDigest,
          requestedAt: parsed.occurredAt,
        })
        .catch(dependency);
      const incident = createFoodSafetyIncidentRecord({
        ...latest,
        revision: latest.revision + 1,
        availabilityBlockOutcomeReference: outcomes.availabilityBlockOutcomeReference,
        paymentBlockOutcomeReference: outcomes.paymentBlockOutcomeReference,
        recordedAt: parsed.occurredAt,
      });
      return persist({
        command: "EnforceIncidentBlocks",
        operationReference: parsed.operationReference,
        intentDigest,
        review: null,
        incident,
        previousReview: null,
        previousIncident: latest,
        expectedRevision: input.expectedRevision,
        purposeCode: parsed.purposeCode,
        occurredAt: parsed.occurredAt,
        authorizedAudit,
      });
    },
  });
}
