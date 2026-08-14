import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createPublishingApprovalEvidence,
  createPublishingScope,
  createPublishingValidationEvidence,
  type PublishingApprovalEvidence,
  type PublishingValidationEvidence,
} from "@bop/publishing";
import {
  createMetricDefinitionSnapshot,
  type MetricDefinitionSnapshot,
} from "../contracts/metric-definition.js";
import {
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  type ReportingReference,
} from "../contracts/report-definition.js";
import type {
  MetricDefinitionAction,
  MetricDefinitionEvent,
  MetricDefinitionOperationRecord,
  MetricDefinitionPorts,
} from "./ports/metric-definition-ports.js";

export type MetricWorkflowErrorCode =
  | "METRIC_INPUT_INVALID"
  | "METRIC_PERMISSION_DENIED"
  | "METRIC_VERSION_CONFLICT"
  | "METRIC_IDEMPOTENCY_CONFLICT"
  | "METRIC_CODE_CONFLICT"
  | "METRIC_LIFECYCLE_CONFLICT"
  | "METRIC_VALIDATION_REQUIRED"
  | "METRIC_APPROVAL_REQUIRED"
  | "METRIC_REPLACEMENT_INVALID"
  | "METRIC_DEPENDENCY_UNAVAILABLE";

export class MetricWorkflowError extends Error {
  constructor(readonly code: MetricWorkflowErrorCode) {
    super("Metric Definition operation is unavailable");
    this.name = "MetricWorkflowError";
  }
}

const invalid = (): never => {
  throw new MetricWorkflowError("METRIC_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !keys.includes(field)))
    return invalid();
  return value as Record<string, unknown>;
}
function dependency(error: unknown): never {
  if (error instanceof MetricWorkflowError) throw error;
  throw new MetricWorkflowError("METRIC_DEPENDENCY_UNAVAILABLE");
}
function sameScope(
  left: MetricDefinitionSnapshot["scope"],
  right: MetricDefinitionSnapshot["scope"],
): boolean {
  return (
    left.tenantReference === right.tenantReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}
function publishingScope(snapshot: MetricDefinitionSnapshot) {
  return createPublishingScope({
    kind: snapshot.scope.storeReference === null ? "Brand" : "Store",
    brandReference: snapshot.scope.brandReference as never,
    storeReference: snapshot.scope.storeReference as never,
  });
}
function sameSemantic(left: MetricDefinitionSnapshot, right: MetricDefinitionSnapshot): boolean {
  return (
    JSON.stringify({
      ownerDomainCode: left.ownerDomainCode,
      businessOwnerReference: left.businessOwnerReference,
      displayNameCode: left.displayNameCode,
      businessDefinitionCode: left.businessDefinitionCode,
      formulaReference: left.formulaReference,
      baseFactReference: left.baseFactReference,
      grainCode: left.grainCode,
      allowedDimensionCodes: left.allowedDimensionCodes,
      requiredFilterCodes: left.requiredFilterCodes,
      timeSemantics: left.timeSemantics,
      timezone: left.timezone,
      currencySemantics: left.currencySemantics,
      currencyCode: left.currencyCode,
      inclusionRuleCodes: left.inclusionRuleCodes,
      exclusionRuleCodes: left.exclusionRuleCodes,
      nullPolicy: left.nullPolicy,
      lineage: left.lineage,
      effectiveFrom: left.effectiveFrom,
      effectiveUntil: left.effectiveUntil,
    }) ===
    JSON.stringify({
      ownerDomainCode: right.ownerDomainCode,
      businessOwnerReference: right.businessOwnerReference,
      displayNameCode: right.displayNameCode,
      businessDefinitionCode: right.businessDefinitionCode,
      formulaReference: right.formulaReference,
      baseFactReference: right.baseFactReference,
      grainCode: right.grainCode,
      allowedDimensionCodes: right.allowedDimensionCodes,
      requiredFilterCodes: right.requiredFilterCodes,
      timeSemantics: right.timeSemantics,
      timezone: right.timezone,
      currencySemantics: right.currencySemantics,
      currencyCode: right.currencyCode,
      inclusionRuleCodes: right.inclusionRuleCodes,
      exclusionRuleCodes: right.exclusionRuleCodes,
      nullPolicy: right.nullPolicy,
      lineage: right.lineage,
      effectiveFrom: right.effectiveFrom,
      effectiveUntil: right.effectiveUntil,
    })
  );
}

async function authorize(
  ports: MetricDefinitionPorts,
  action: MetricDefinitionAction,
  operationReference: ReportingReference,
  metricReference: ReportingReference,
  at: string,
): Promise<{
  readonly actor: ReportingReference;
  readonly scope: MetricDefinitionSnapshot["scope"];
  readonly audit: AppendAuditRecordInput;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, metricReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new MetricWorkflowError("METRIC_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    const permission =
      action === "Certify" ? "reporting.metric.certify" : "reporting.metric.manage";
    if (
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== permission ||
      evidence.permission.scopeKind !== context.scopeKind ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== context.store?.storeReference ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `REPORTING_METRIC_${action.toUpperCase()}` ||
      audit.targetType !== "MetricDefinition" ||
      audit.targetId !== metricReference ||
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
    throw new MetricWorkflowError("METRIC_PERMISSION_DENIED");
  }
}

function assertValidation(
  snapshot: MetricDefinitionSnapshot,
  raw: PublishingValidationEvidence | null,
  at: string,
): PublishingValidationEvidence {
  if (raw === null) throw new MetricWorkflowError("METRIC_VALIDATION_REQUIRED");
  let evidence: PublishingValidationEvidence;
  try {
    evidence = createPublishingValidationEvidence(raw);
  } catch {
    throw new MetricWorkflowError("METRIC_VALIDATION_REQUIRED");
  }
  const scope = publishingScope(snapshot);
  if (
    String(evidence.snapshotReference) !== snapshot.versionReference ||
    String(evidence.snapshotDigest) !== snapshot.snapshotDigest ||
    evidence.scope.kind !== scope.kind ||
    evidence.scope.brandReference !== scope.brandReference ||
    evidence.scope.storeReference !== scope.storeReference ||
    Date.parse(evidence.validUntil) <= Date.parse(at) ||
    !["METRIC_SEMANTICS", "METRIC_LINEAGE", "METRIC_IMPACT"].every((code) =>
      evidence.checkCodes.includes(code as never),
    )
  )
    throw new MetricWorkflowError("METRIC_VALIDATION_REQUIRED");
  return evidence;
}

function assertApproval(
  snapshot: MetricDefinitionSnapshot,
  raw: PublishingApprovalEvidence | null,
  at: string,
): PublishingApprovalEvidence {
  if (raw === null) throw new MetricWorkflowError("METRIC_APPROVAL_REQUIRED");
  let evidence: PublishingApprovalEvidence;
  try {
    evidence = createPublishingApprovalEvidence(raw);
  } catch {
    throw new MetricWorkflowError("METRIC_APPROVAL_REQUIRED");
  }
  const scope = publishingScope(snapshot);
  if (
    String(evidence.snapshotReference) !== snapshot.versionReference ||
    String(evidence.snapshotDigest) !== snapshot.snapshotDigest ||
    evidence.scope.kind !== scope.kind ||
    evidence.scope.brandReference !== scope.brandReference ||
    evidence.scope.storeReference !== scope.storeReference ||
    Date.parse(evidence.validUntil) <= Date.parse(at)
  )
    throw new MetricWorkflowError("METRIC_APPROVAL_REQUIRED");
  return evidence;
}

function events(action: MetricDefinitionAction, snapshot: MetricDefinitionSnapshot, at: string) {
  const types: readonly MetricDefinitionEvent["eventType"][] =
    action === "Certify"
      ? ["MetricDefinitionPublished", "MetricCertified"]
      : action === "SubmitReview"
        ? ["MetricDefinitionReviewSubmitted"]
        : action === "Deprecate"
          ? ["MetricDeprecated"]
          : action === "Archive"
            ? ["MetricArchived"]
            : ["MetricDefinitionDraftRecorded"];
  return Object.freeze(
    types.map((eventType) =>
      Object.freeze({
        eventType,
        metricReference: snapshot.metricReference,
        versionReference: snapshot.versionReference,
        tenantReference: snapshot.scope.tenantReference,
        brandReference: snapshot.scope.brandReference,
        storeReference: snapshot.scope.storeReference,
        aggregateVersion: snapshot.aggregateVersion,
        lifecycle: snapshot.lifecycle,
        certificationStatus: snapshot.certificationStatus,
        snapshotDigest: snapshot.snapshotDigest,
        replacementMetricReference: snapshot.replacementMetricReference,
        occurredAt: at,
      }),
    ),
  );
}

export interface ExecuteMetricDefinitionInput {
  readonly action: MetricDefinitionAction;
  readonly operationReference: ReportingReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: MetricDefinitionSnapshot;
  readonly occurredAt: string;
}

export function createMetricDefinitionService(ports: MetricDefinitionPorts) {
  return Object.freeze({
    async execute(input: ExecuteMetricDefinitionInput) {
      exact(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "occurredAt",
      ]);
      if (
        !(
          [
            "CreateDraft",
            "ReplaceDraft",
            "CreateRevision",
            "SubmitReview",
            "Certify",
            "Deprecate",
            "Archive",
          ] as const
        ).includes(input.action)
      )
        invalid();
      const at = parseReportingInstant(input.occurredAt);
      const operationReference = parseReportingReference(input.operationReference);
      const candidate = createMetricDefinitionSnapshot(input.candidate);
      const intent = parseReportingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new MetricWorkflowError("METRIC_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, aggregate: prior.aggregate });
      }
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.metricReference,
        at,
      );
      if (!sameScope(candidate.scope, auth.scope))
        throw new MetricWorkflowError("METRIC_PERMISSION_DENIED");
      const current = await ports.repository.load(candidate.metricReference).catch(dependency);
      let validation: PublishingValidationEvidence | null = null;
      let businessApproval: PublishingApprovalEvidence | null = null;
      let dataApproval: PublishingApprovalEvidence | null = null;

      if (input.action === "CreateDraft") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.aggregateVersion !== 1 ||
          candidate.versionNumber !== 1 ||
          candidate.lifecycle !== "Draft" ||
          candidate.createdByActorReference !== auth.actor ||
          candidate.replacementMetricReference !== null
        )
          throw new MetricWorkflowError("METRIC_LIFECYCLE_CONFLICT");
        if (
          !(await ports.repository
            .codeAvailable({ scope: candidate.scope, stableCode: candidate.stableCode })
            .catch(dependency))
        )
          throw new MetricWorkflowError("METRIC_CODE_CONFLICT");
      } else {
        if (
          current === null ||
          input.expectedAggregateVersion !== current.aggregateVersion ||
          candidate.aggregateVersion !== current.aggregateVersion + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.metricReference !== current.metricReference ||
          candidate.stableCode !== current.stableCode ||
          !sameScope(candidate.scope, current.scope) ||
          candidate.createdByActorReference !== auth.actor
        )
          throw new MetricWorkflowError("METRIC_VERSION_CONFLICT");
        const transition = `${current.lifecycle}:${input.action}:${candidate.lifecycle}`;
        if (
          ![
            "Draft:ReplaceDraft:Draft",
            "Certified:CreateRevision:Draft",
            "Deprecated:CreateRevision:Draft",
            "Draft:SubmitReview:InReview",
            "InReview:Certify:Certified",
            "Certified:Deprecate:Deprecated",
            "Deprecated:Archive:Archived",
          ].includes(transition)
        )
          throw new MetricWorkflowError("METRIC_LIFECYCLE_CONFLICT");
        if (
          !["ReplaceDraft", "CreateRevision"].includes(input.action) &&
          !sameSemantic(candidate, current)
        )
          throw new MetricWorkflowError("METRIC_LIFECYCLE_CONFLICT");
        if (input.action !== "Deprecate" && candidate.replacementMetricReference !== null)
          throw new MetricWorkflowError("METRIC_REPLACEMENT_INVALID");
      }

      if (input.action === "SubmitReview" || input.action === "Certify") {
        validation = assertValidation(
          candidate,
          await ports.publishing.validate(candidate).catch(dependency),
          at,
        );
      }
      if (input.action === "Certify") {
        if (validation === null) throw new MetricWorkflowError("METRIC_VALIDATION_REQUIRED");
        const certificationValidation = validation;
        businessApproval = assertApproval(
          candidate,
          await ports.publishing
            .approve({
              role: "BusinessOwner",
              snapshot: candidate,
              validation: certificationValidation,
            })
            .catch(dependency),
          at,
        );
        dataApproval = assertApproval(
          candidate,
          await ports.publishing
            .approve({
              role: "DataOwner",
              snapshot: candidate,
              validation: certificationValidation,
            })
            .catch(dependency),
          at,
        );
        const businessActor = String(businessApproval.approvedActorReference);
        const dataActor = String(dataApproval.approvedActorReference);
        if (
          businessActor === dataActor ||
          businessActor !== candidate.businessOwnerReference ||
          businessActor === candidate.createdByActorReference ||
          dataActor === candidate.createdByActorReference ||
          businessApproval.evidenceReference === dataApproval.evidenceReference
        )
          throw new MetricWorkflowError("METRIC_APPROVAL_REQUIRED");
      }
      if (
        input.action === "Deprecate" &&
        candidate.replacementMetricReference !== null &&
        !(await ports.metrics
          .replacementIsCertified({
            metricReference: candidate.replacementMetricReference,
            scope: candidate.scope,
          })
          .catch(dependency))
      )
        throw new MetricWorkflowError("METRIC_REPLACEMENT_INVALID");

      const record: MetricDefinitionOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        validationEvidenceReference:
          validation === null ? null : parseReportingReference(validation.evidenceReference),
        businessApprovalEvidenceReference:
          businessApproval === null
            ? null
            : parseReportingReference(businessApproval.evidenceReference),
        dataApprovalEvidenceReference:
          dataApproval === null ? null : parseReportingReference(dataApproval.evidenceReference),
        events: events(input.action, candidate, at),
      });
      let committed: MetricDefinitionOperationRecord;
      if (input.action === "CreateDraft") {
        committed = await ports.repository.create({ record, audit: auth.audit }).catch(dependency);
      } else {
        if (input.expectedAggregateVersion === null)
          throw new MetricWorkflowError("METRIC_VERSION_CONFLICT");
        committed = await ports.repository
          .commit({
            record,
            expectedAggregateVersion: input.expectedAggregateVersion,
            validation,
            businessApproval,
            dataApproval,
            audit: auth.audit,
          })
          .catch(dependency);
      }
      return Object.freeze({
        status: "Applied" as const,
        aggregate: createMetricDefinitionSnapshot(committed.aggregate),
      });
    },
  });
}
