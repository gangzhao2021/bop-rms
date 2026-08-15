import { validateAuditRecord } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createCompliancePolicyVersion,
  type CompliancePolicyVersion,
} from "../contracts/compliance-policy.js";
import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  type ComplianceReference,
  type ComplianceScope,
} from "../contracts/compliance-dashboard.js";
import type {
  CompliancePolicyCommand,
  CompliancePolicyOperation,
  CompliancePolicyPorts,
} from "./ports/compliance-policy-ports.js";

export type CompliancePolicyErrorCode =
  | "COMPLIANCE_POLICY_INPUT_INVALID"
  | "COMPLIANCE_POLICY_PERMISSION_DENIED"
  | "COMPLIANCE_POLICY_VERSION_CONFLICT"
  | "COMPLIANCE_POLICY_IDEMPOTENCY_CONFLICT"
  | "COMPLIANCE_POLICY_LIFECYCLE_CONFLICT"
  | "COMPLIANCE_POLICY_PARENT_INVALID"
  | "COMPLIANCE_POLICY_WEAKENING_FORBIDDEN"
  | "COMPLIANCE_POLICY_PUBLISH_BLOCKED"
  | "COMPLIANCE_POLICY_DEPENDENCY_UNAVAILABLE";
export class CompliancePolicyError extends Error {
  constructor(readonly code: CompliancePolicyErrorCode) {
    super("Compliance policy operation is unavailable");
    this.name = "CompliancePolicyError";
  }
}
const fail = (code: CompliancePolicyErrorCode = "COMPLIANCE_POLICY_INPUT_INVALID"): never => {
  throw new CompliancePolicyError(code);
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
function dependency(error: unknown): never {
  if (error instanceof CompliancePolicyError) throw error;
  throw new CompliancePolicyError("COMPLIANCE_POLICY_DEPENDENCY_UNAVAILABLE");
}
const sameScope = (a: ComplianceScope, b: ComplianceScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;
const permissions: Record<CompliancePolicyCommand, string> = {
  CreateDraft: "compliance.policy.create",
  ReviseDraft: "compliance.policy.edit",
  SubmitReview: "compliance.policy.review.request",
  ApproveVersion: "compliance.policy.approve",
  PublishVersion: "compliance.policy.publish",
  RetireVersion: "compliance.policy.retire",
};
const strength = { Advisory: 0, Mandatory: 1, HardRequirement: 2 } as const;
const notice = { NotRequired: 0, Conditional: 1, Required: 2 } as const;
function sameThreshold(
  left: CompliancePolicyVersion["threshold"],
  right: CompliancePolicyVersion["threshold"],
) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.operator === right.operator &&
      left.decimalValue === right.decimalValue &&
      left.unitCode === right.unitCode)
  );
}
function sameDefinition(a: CompliancePolicyVersion, b: CompliancePolicyVersion) {
  return (
    a.policyReference === b.policyReference &&
    a.versionReference === b.versionReference &&
    a.policyVersion === b.policyVersion &&
    sameScope(a.scope, b.scope) &&
    a.layer === b.layer &&
    a.parentVersionReference === b.parentVersionReference &&
    a.kind === b.kind &&
    a.nameCode === b.nameCode &&
    a.jurisdictionCode === b.jurisdictionCode &&
    a.authorityReference === b.authorityReference &&
    a.requirementTypeCode === b.requirementTypeCode &&
    a.strength === b.strength &&
    a.overrideAllowed === b.overrideAllowed &&
    JSON.stringify(a.applicableScopeCodes) === JSON.stringify(b.applicableScopeCodes) &&
    a.timeZone === b.timeZone &&
    a.effectiveFrom === b.effectiveFrom &&
    a.effectiveTo === b.effectiveTo &&
    JSON.stringify(a.evidenceRequirements) === JSON.stringify(b.evidenceRequirements) &&
    a.monitoringFrequencyHours === b.monitoringFrequencyHours &&
    sameThreshold(a.threshold, b.threshold) &&
    a.retentionDays === b.retentionDays &&
    a.escalationRuleCode === b.escalationRuleCode &&
    a.notificationRequirement === b.notificationRequirement &&
    JSON.stringify(a.evidenceMappings) === JSON.stringify(b.evidenceMappings) &&
    JSON.stringify(a.controlMappings) === JSON.stringify(b.controlMappings) &&
    a.authoredByReference === b.authoredByReference
  );
}
function sameIdentity(a: CompliancePolicyVersion, b: CompliancePolicyVersion) {
  return (
    a.policyReference === b.policyReference &&
    sameScope(a.scope, b.scope) &&
    a.layer === b.layer &&
    a.kind === b.kind &&
    a.nameCode === b.nameCode
  );
}
async function authorize(
  ports: CompliancePolicyPorts,
  input: {
    command: CompliancePolicyCommand;
    operationReference: ComplianceReference;
    targetReference: ComplianceReference;
    scope: ComplianceScope;
    purposeCode: ReturnType<typeof parseComplianceCode>;
    observedAt: string;
  },
) {
  const evidence = await ports.authorization.authorize(input).catch(dependency);
  if (evidence === null) return fail("COMPLIANCE_POLICY_PERMISSION_DENIED");
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
      audit.actionCode !== `COMPLIANCE_POLICY_${input.command.toUpperCase()}` ||
      audit.targetType !== "CompliancePolicy" ||
      audit.targetId !== input.targetReference ||
      audit.occurredAt !== input.observedAt
    )
      throw new Error("denied");
    return Object.freeze({ audit, actorReference: parseComplianceReference(actor) });
  } catch {
    return fail("COMPLIANCE_POLICY_PERMISSION_DENIED");
  }
}

export function createCompliancePolicyService(ports: CompliancePolicyPorts) {
  async function parentFor(record: CompliancePolicyVersion) {
    if (record.parentVersionReference === null) return null;
    const parent = await ports.repository
      .loadVersion(record.parentVersionReference)
      .catch(dependency);
    if (
      parent === null ||
      parent.status !== "Published" ||
      parent.scope.tenantReference !== record.scope.tenantReference ||
      parent.scope.brandReference !== record.scope.brandReference ||
      (record.layer === "Brand" ? parent.layer !== "Platform" : parent.layer !== "Brand") ||
      (record.layer === "Store" && parent.scope.storeReference !== null) ||
      parent.jurisdictionCode !== record.jurisdictionCode ||
      parent.requirementTypeCode !== record.requirementTypeCode
    )
      return fail("COMPLIANCE_POLICY_PARENT_INVALID");
    if (
      Date.parse(record.effectiveFrom) < Date.parse(parent.effectiveFrom) ||
      (parent.effectiveTo !== null &&
        (record.effectiveTo === null ||
          Date.parse(record.effectiveTo) > Date.parse(parent.effectiveTo)))
    )
      return fail("COMPLIANCE_POLICY_WEAKENING_FORBIDDEN");
    return parent;
  }
  function enforceNotWeaker(record: CompliancePolicyVersion, parent: CompliancePolicyVersion) {
    const mandatoryEvidence = parent.evidenceRequirements.filter((item) => item.mandatory);
    const missingEvidence = mandatoryEvidence.some(
      (required) =>
        !record.evidenceRequirements.some(
          (candidate) =>
            candidate.requirementCode === required.requirementCode && candidate.mandatory,
        ),
    );
    const missingControl = parent.controlMappings.some(
      (required) =>
        !record.controlMappings.some(
          (candidate) =>
            candidate.controlCode === required.controlCode &&
            candidate.ownerDomainCode === required.ownerDomainCode &&
            candidate.requiredOutcomeCode === required.requiredOutcomeCode,
        ),
    );
    if (
      strength[record.strength] < strength[parent.strength] ||
      (parent.overrideAllowed === false && record.overrideAllowed) ||
      BigInt(record.retentionDays) < BigInt(parent.retentionDays) ||
      BigInt(record.monitoringFrequencyHours) > BigInt(parent.monitoringFrequencyHours) ||
      notice[record.notificationRequirement] < notice[parent.notificationRequirement] ||
      missingEvidence ||
      missingControl ||
      (parent.strength === "HardRequirement" && !sameThreshold(record.threshold, parent.threshold))
    )
      return fail("COMPLIANCE_POLICY_WEAKENING_FORBIDDEN");
  }
  async function apply(input: {
    readonly command: CompliancePolicyCommand;
    readonly operationReference: string;
    readonly expectedRevision: number;
    readonly policy: unknown;
    readonly purposeCode: string;
    readonly occurredAt: string;
  }) {
    exact(input, [
      "command",
      "operationReference",
      "expectedRevision",
      "policy",
      "purposeCode",
      "occurredAt",
    ]);
    let record: CompliancePolicyVersion;
    let operationReference: ComplianceReference;
    let purposeCode: ReturnType<typeof parseComplianceCode>;
    let occurredAt: string;
    try {
      record = createCompliancePolicyVersion(input.policy);
      operationReference = parseComplianceReference(input.operationReference);
      purposeCode = parseComplianceCode(input.purposeCode);
      occurredAt = parseComplianceInstant(input.occurredAt);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        return fail();
    } catch {
      return fail();
    }
    if (record.recordedAt !== occurredAt) return fail("COMPLIANCE_POLICY_VERSION_CONFLICT");
    const audit = await authorize(ports, {
      command: input.command,
      operationReference,
      targetReference: record.policyReference,
      scope: record.scope,
      purposeCode,
      observedAt: occurredAt,
    });
    if (
      (input.command === "CreateDraft" && record.authoredByReference !== audit.actorReference) ||
      (input.command === "ApproveVersion" && record.reviewedByReference !== audit.actorReference)
    )
      return fail("COMPLIANCE_POLICY_PERMISSION_DENIED");
    const digest = ports.references.hashIntent(JSON.stringify(input));
    const existing = await ports.repository.resolveOperation(operationReference).catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("COMPLIANCE_POLICY_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, policy: existing.policy });
    }
    const latest = await ports.repository.loadLatest(record.policyReference).catch(dependency);
    if (
      record.revision !== input.expectedRevision + 1 ||
      (latest === null ? input.expectedRevision !== 0 : latest.revision !== input.expectedRevision)
    )
      return fail("COMPLIANCE_POLICY_VERSION_CONFLICT");
    const parent = await parentFor(record);
    if (parent !== null) enforceNotWeaker(record, parent);
    if (input.command === "CreateDraft") {
      const hasOpenVersion = await ports.repository
        .hasOpenVersion(record.policyReference)
        .catch(dependency);
      if (
        hasOpenVersion ||
        record.status !== "Draft" ||
        record.reviewedByReference !== null ||
        record.publishedAt !== null ||
        (latest === null
          ? record.policyVersion !== 1
          : !["Published", "Retired"].includes(latest.status) ||
            !sameIdentity(latest, record) ||
            record.policyVersion !== latest.policyVersion + 1 ||
            record.versionReference === latest.versionReference)
      )
        return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
    } else {
      const current = await ports.repository.loadVersion(record.versionReference).catch(dependency);
      if (
        current === null ||
        current.policyReference !== record.policyReference ||
        current.policyVersion !== record.policyVersion ||
        current.authoredByReference !== record.authoredByReference
      )
        return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
      const transition = `${current.status}:${record.status}`;
      const expected: Record<Exclude<CompliancePolicyCommand, "CreateDraft">, string> = {
        ReviseDraft: "Draft:Draft",
        SubmitReview: "Draft:InReview",
        ApproveVersion: "InReview:Approved",
        PublishVersion: "Approved:Published",
        RetireVersion: "Published:Retired",
      };
      if (transition !== expected[input.command as Exclude<CompliancePolicyCommand, "CreateDraft">])
        return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
      if (input.command !== "ReviseDraft" && input.command !== "RetireVersion") {
        const normalized = { ...record, status: current.status } as CompliancePolicyVersion;
        if (!sameDefinition(current, normalized))
          return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
      }
      if (
        input.command === "RetireVersion" &&
        (!sameDefinition(current, {
          ...record,
          effectiveTo: current.effectiveTo,
        } as CompliancePolicyVersion) ||
          record.retiredAt !== occurredAt ||
          record.effectiveTo !== occurredAt)
      )
        return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
    }
    if (input.command === "SubmitReview" && record.reviewedByReference !== null)
      return fail("COMPLIANCE_POLICY_LIFECYCLE_CONFLICT");
    if (input.command === "ApproveVersion") {
      if (
        record.reviewedByReference === null ||
        record.reviewedAt !== occurredAt ||
        record.legalReviewStatus === "Required" ||
        record.legalReviewStatus === "Failed" ||
        (record.kind === "RegulatoryRequirement" && record.legalReviewStatus !== "Passed")
      )
        return fail("COMPLIANCE_POLICY_PUBLISH_BLOCKED");
      const reviewersValid = await ports.reviewers
        .validate({
          versionReference: record.versionReference,
          scope: record.scope,
          authoredByReference: record.authoredByReference,
          reviewedByReference: record.reviewedByReference,
          counselReviewerReference: record.counselReviewerReference,
          secondApproverReference: record.secondApproverReference,
          reviewedAt: record.reviewedAt,
        })
        .catch(dependency);
      if (!reviewersValid) return fail("COMPLIANCE_POLICY_PUBLISH_BLOCKED");
    }
    if (input.command === "PublishVersion") {
      const evidenceCodes = new Set(record.evidenceMappings.map((item) => item.requirementCode));
      if (
        record.publishedAt !== occurredAt ||
        (record.effectiveTo !== null && Date.parse(record.effectiveTo) <= Date.parse(occurredAt)) ||
        record.evidenceRequirements.some(
          (item) => item.mandatory && !evidenceCodes.has(item.requirementCode),
        ) ||
        record.controlMappings.length === 0 ||
        record.controlMappings.some((item) => item.status !== "Validated") ||
        record.legalReviewStatus === "Required" ||
        record.legalReviewStatus === "Failed"
      )
        return fail("COMPLIANCE_POLICY_PUBLISH_BLOCKED");
    }
    const operation: CompliancePolicyOperation = Object.freeze({
      command: input.command,
      operationReference,
      intentDigest: digest,
      policy: record,
      events: Object.freeze([] as const),
    });
    const committed = await ports.repository
      .commit({ operation, expectedRevision: input.expectedRevision, audit: audit.audit })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, policy: committed.policy });
  }
  const invoke =
    (command: CompliancePolicyCommand) =>
    (input: {
      readonly operationReference: string;
      readonly expectedRevision: number;
      readonly policy: unknown;
      readonly purposeCode: string;
      readonly occurredAt: string;
    }) =>
      apply({ ...input, command });
  return Object.freeze({
    createDraft: invoke("CreateDraft"),
    reviseDraft: invoke("ReviseDraft"),
    submitReview: invoke("SubmitReview"),
    approveVersion: invoke("ApproveVersion"),
    publishVersion: invoke("PublishVersion"),
    retireVersion: invoke("RetireVersion"),
  });
}
