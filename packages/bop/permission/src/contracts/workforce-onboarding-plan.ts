import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  readClosedRecord,
  parseSelectorHash,
  parseWorkforceOnboardingConfiguration,
  parseWorkforceOnboardingOriginal,
} from "@bop/identity";
import { parseApprovedWorkforceMembership } from "@bop/membership";
import { createBrand, parseOrganizationVersion } from "@bop/tenant";
import {
  approvedWorkforcePolicyReference as reference,
  approvedWorkforcePolicyInstant as instant,
  parseApprovedWorkforcePolicyPlan,
  hashApprovedWorkforcePolicyPlan,
  parsePrepareApprovedWorkforcePolicy,
} from "./approved-workforce-policy.js";
import { parseWorkforceOnboardingApprovalExpected } from "./workforce-onboarding-approval.js";

export class WorkforceOnboardingPlanError extends Error {
  readonly code = "WORKFORCE_ONBOARDING_PLAN_UNAVAILABLE";
  constructor() {
    super("Workforce onboarding plan is unavailable");
    this.name = "WorkforceOnboardingPlanError";
  }
}
export function workforceOnboardingPlanUnavailable(): never {
  throw new WorkforceOnboardingPlanError();
}
/** Complete static approved content, not a claim of current authentication,
 * signature approval, invitation delivery, relationship or policy qualification.
 * The digest is derived outside this payload so it cannot recursively hash itself. */
export function parseWorkforceOnboardingPlan(value: unknown) {
  try {
    const profileDescriptor = value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "profile") : undefined;
    if (!profileDescriptor?.enumerable || !("value" in profileDescriptor))
      return workforceOnboardingPlanUnavailable();
    const firstOwner = profileDescriptor.value === "FirstOwnerCreationPlanV1";
    const r = readClosedRecord(value, [
      "profile",
      "purposeCode",
      "configuration",
      "environmentReference",
      "operationReference",
      "operatorReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "brandReference",
      "actorReference",
      "membershipReference",
      "workforceRelationshipReference",
      "relationshipEvidenceReference",
      "relationshipRevision",
      "effectiveFrom",
      "effectiveUntil",
      "emailDigest",
      "policy",
      "expectedPolicy",
      "policySnapshotReference",
      "reasonCode",
      ...(firstOwner ? ["creation", "operatingEntityQualification", "corporateEmailQualification"] : []),
    ]);
    if ((!firstOwner && r.profile !== "WorkforceOnboardingPlanV1") || r.purposeCode !== "WORKFORCE_ONBOARDING")
      return workforceOnboardingPlanUnavailable();
    const configuration = parseWorkforceOnboardingConfiguration(r.configuration),
      environmentReference = reference(r.environmentReference),
      operationReference = reference(r.operationReference),
      operatorReference = reference(r.operatorReference),
      approvedByReference = reference(r.approvedByReference),
      actorReference = reference(r.actorReference),
      brandReference = reference(r.brandReference),
      membershipReference = reference(r.membershipReference),
      effectiveFrom = instant(r.effectiveFrom),
      effectiveUntil = instant(r.effectiveUntil),
      policy = parseApprovedWorkforcePolicyPlan(r.policy),
      policySnapshotReference = reference(r.policySnapshotReference);
    if (
      approvedByReference === operatorReference ||
      approvedByReference === actorReference ||
      effectiveUntil <= effectiveFrom ||
      typeof r.relationshipRevision !== "number" ||
      !Number.isSafeInteger(r.relationshipRevision) ||
      r.relationshipRevision < 1 ||
      typeof r.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(r.reasonCode) ||
      policy.brandReference !== brandReference ||
      policy.actorReference !== actorReference ||
      policy.membershipReference !== membershipReference ||
      policy.effectiveFrom !== effectiveFrom ||
      policy.effectiveUntil !== effectiveUntil
    )
      return workforceOnboardingPlanUnavailable();
    let expectedPolicy: { readonly snapshotReference: string; readonly version: number } | null =
      null;
    if (r.expectedPolicy !== null) {
      const head = readClosedRecord(r.expectedPolicy, ["snapshotReference", "version"]);
      if (
        typeof head.version !== "number" ||
        !Number.isSafeInteger(head.version) ||
        head.version < 1 ||
        head.version >= Number.MAX_SAFE_INTEGER
      )
        return workforceOnboardingPlanUnavailable();
      expectedPolicy = Object.freeze({
        snapshotReference: reference(head.snapshotReference),
        version: head.version,
      });
      if (expectedPolicy.snapshotReference === policySnapshotReference)
        return workforceOnboardingPlanUnavailable();
    }
    const common = {
      purposeCode: "WORKFORCE_ONBOARDING" as const,
      configuration,
      environmentReference,
      operationReference,
      operatorReference,
      approvedByReference,
      approvalEvidenceReference: reference(r.approvalEvidenceReference),
      brandReference,
      actorReference,
      membershipReference,
      workforceRelationshipReference: reference(r.workforceRelationshipReference),
      relationshipEvidenceReference: reference(r.relationshipEvidenceReference),
      relationshipRevision: r.relationshipRevision,
      effectiveFrom,
      effectiveUntil,
      emailDigest: parseSelectorHash(r.emailDigest),
      policy,
      expectedPolicy,
      policySnapshotReference,
      reasonCode: r.reasonCode,
    };
    if (!firstOwner) return Object.freeze({ profile: "WorkforceOnboardingPlanV1" as const, ...common });
    if (expectedPolicy !== null || policy.roles.length !== 1 || policy.roles[0]?.roleCode !== "owner")
      return workforceOnboardingPlanUnavailable();
    const c = readClosedRecord(r.creation, ["brand", "brandAuditReference", "membershipAuditReference", "policyAuditReference"]);
    const b = readClosedRecord(c.brand, ["brandReference", "code", "displayName", "defaultLocale", "currencyCode"]);
    const syntaxBrand = createBrand({ ...b, lifecycle: "Draft", version: 1, createdAt: "0001-01-01T00:00:00.000Z", updatedAt: "0001-01-01T00:00:00.000Z" });
    if (String(syntaxBrand.brandReference) !== brandReference || syntaxBrand.currencyCode !== "CAD")
      return workforceOnboardingPlanUnavailable();
    const occupied = new Set([environmentReference, operationReference, operatorReference, approvedByReference, common.approvalEvidenceReference, brandReference, actorReference, membershipReference, common.workforceRelationshipReference, common.relationshipEvidenceReference, policySnapshotReference]);
    for (const role of policy.roles) {
      occupied.add(role.roleReference);
      occupied.add(role.assignment.assignmentReference);
      for (const grant of role.grants) { occupied.add(grant.grantReference); occupied.add(grant.permissionReference); }
    }
    const auditReference = (value: unknown) => {
      const id = reference(value);
      if (occupied.has(id)) return workforceOnboardingPlanUnavailable();
      occupied.add(id);
      return id;
    };
    const creation = Object.freeze({
      brand: Object.freeze({ brandReference: String(syntaxBrand.brandReference), code: syntaxBrand.code, displayName: syntaxBrand.displayName, defaultLocale: syntaxBrand.defaultLocale, currencyCode: syntaxBrand.currencyCode }),
      brandAuditReference: auditReference(c.brandAuditReference),
      membershipAuditReference: auditReference(c.membershipAuditReference),
      policyAuditReference: auditReference(c.policyAuditReference),
    });
    const e = readClosedRecord(r.operatingEntityQualification, ["operatingEntityReference", "entityVersion", "entityDigest", "entityEvidenceReference", "reviewEvidenceReference", "materialDigest"]);
    const email = readClosedRecord(r.corporateEmailQualification, ["evidenceReference", "operatingEntityReference", "emailDigest", "materialDigest"]);
    const digest = (value: unknown): string => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : workforceOnboardingPlanUnavailable();
    const operatingEntityQualification = Object.freeze({
      operatingEntityReference: reference(e.operatingEntityReference),
      entityVersion: parseOrganizationVersion(e.entityVersion),
      entityDigest: digest(e.entityDigest),
      entityEvidenceReference: reference(e.entityEvidenceReference),
      reviewEvidenceReference: reference(e.reviewEvidenceReference),
      materialDigest: digest(e.materialDigest),
    });
    const corporateEmailQualification = Object.freeze({
      evidenceReference: reference(email.evidenceReference),
      operatingEntityReference: reference(email.operatingEntityReference),
      emailDigest: parseSelectorHash(email.emailDigest),
      materialDigest: digest(email.materialDigest),
    });
    if (corporateEmailQualification.operatingEntityReference !== operatingEntityQualification.operatingEntityReference || corporateEmailQualification.emailDigest !== common.emailDigest || [operatingEntityQualification.operatingEntityReference, operatingEntityQualification.entityEvidenceReference, operatingEntityQualification.reviewEvidenceReference, corporateEmailQualification.evidenceReference].some((id) => [creation.brandAuditReference, creation.membershipAuditReference, creation.policyAuditReference].includes(id)))
      return workforceOnboardingPlanUnavailable();
    return Object.freeze({ profile: "FirstOwnerCreationPlanV1" as const, ...common, creation, operatingEntityQualification, corporateEmailQualification });
  } catch {
    return workforceOnboardingPlanUnavailable();
  }
}
export type WorkforceOnboardingPlan = ReturnType<typeof parseWorkforceOnboardingPlan>;
export type FirstOwnerCreationPlan = Extract<WorkforceOnboardingPlan, { readonly profile: "FirstOwnerCreationPlanV1" }>;
export function hashWorkforceOnboardingPlan(value: unknown): string {
  return `sha256:${sha256Hex(canonicalizeRfc8785(parseWorkforceOnboardingPlan(value)))}`;
}
export function deriveWorkforceOnboardingPlan(value: unknown) {
  const plan = parseWorkforceOnboardingPlan(value),
    planDigest = hashWorkforceOnboardingPlan(plan);
  const approvalExpected = parseWorkforceOnboardingApprovalExpected({
    environmentReference: plan.environmentReference,
    operationReference: plan.operationReference,
    brandReference: plan.brandReference,
    actorReference: plan.actorReference,
    membershipReference: plan.membershipReference,
    operatorReference: plan.operatorReference,
    planDigest,
  });
  const approvedMembership = parseApprovedWorkforceMembership({
    profile: "ApprovedWorkforceMembershipV1",
    ...approvalExpected,
    approvedByReference: plan.approvedByReference,
    approvalEvidenceReference: plan.approvalEvidenceReference,
    workforceRelationshipReference: plan.workforceRelationshipReference,
    relationshipEvidenceReference: plan.relationshipEvidenceReference,
    relationshipRevision: plan.relationshipRevision,
    effectiveFrom: plan.effectiveFrom,
    effectiveUntil: plan.effectiveUntil,
    approvedPolicyDigest: hashApprovedWorkforcePolicyPlan(plan.policy),
  });
  const preparePolicy = parsePrepareApprovedWorkforcePolicy({
    profile: "PrepareApprovedWorkforcePolicyV1",
    operationReference: plan.operationReference,
    approval: approvedMembership,
    policy: plan.policy,
    expectedPolicy: plan.expectedPolicy,
    policySnapshotReference: plan.policySnapshotReference,
  });
  const original = parseWorkforceOnboardingOriginal({
    profile: "WorkforceOnboardingOriginalV1",
    configuration: plan.configuration,
    operationReference: plan.operationReference,
    operatorReference: plan.operatorReference,
    actorReference: plan.actorReference,
    brandReference: plan.brandReference,
    membershipReference: plan.membershipReference,
    storeAssignmentReferences: [],
    emailDigest: plan.emailDigest,
    approvedByReference: plan.approvedByReference,
    approvalEvidenceReference: plan.approvalEvidenceReference,
    relationshipEvidenceReference: plan.relationshipEvidenceReference,
    approvedPlanDigest: planDigest,
    reasonCode: plan.reasonCode,
  });
  return Object.freeze({
    plan,
    planDigest,
    approvalExpected,
    approvedMembership,
    preparePolicy,
    original,
  });
}
export function parseWorkforceOnboardingPlanExpected(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "configuration",
      "environmentReference",
      "operationReference",
      "brandReference",
      "actorReference",
      "membershipReference",
      "operatorReference",
    ]);
    return Object.freeze({
      configuration: parseWorkforceOnboardingConfiguration(r.configuration),
      environmentReference: reference(r.environmentReference),
      operationReference: reference(r.operationReference),
      brandReference: reference(r.brandReference),
      actorReference: reference(r.actorReference),
      membershipReference: reference(r.membershipReference),
      operatorReference: reference(r.operatorReference),
    });
  } catch {
    return workforceOnboardingPlanUnavailable();
  }
}
export type WorkforceOnboardingPlanExpected = ReturnType<
  typeof parseWorkforceOnboardingPlanExpected
>;
