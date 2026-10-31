import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor, readClosedRecord } from "@bop/identity";
import {
  hashInitialBrandMembershipRequest,
  parseInitialBrandMembershipAuthority,
  parseInitialBrandMembershipRequest,
} from "@bop/membership";
import {
  createBrand,
  parseBrandAdministrationReference,
  parseBrandReference,
  type BrandAdministrationOperation,
} from "@bop/tenant";
import {
  brandInitialPolicyArray,
  parseBrandInitialPolicyRequest,
  type BrandInitialPolicyGrant,
} from "./brand-initial-policy.js";
import {
  brandProvisioningApprovalPurpose,
  parseBrandProvisioningApprovalExpected,
  parseBrandProvisioningApprovalInstant,
} from "./brand-provisioning-approval.js";

export interface BrandInitialProvisioningRecipient {
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly workforceRelationshipReference: string;
  readonly relationshipEvidenceReference: string;
  readonly invitationEvidenceReference: string;
  readonly membershipEffectiveUntil: string;
  readonly roleEffectiveUntil: string;
  readonly roleReference: string;
  readonly roleCode: string;
  readonly assignmentReference: string;
  readonly grants: readonly BrandInitialPolicyGrant[];
}
export interface BrandInitialProvisioningPlan {
  readonly profile: "BrandInitialProvisioningPlanV1";
  readonly purposeCode: typeof brandProvisioningApprovalPurpose;
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly brand: Readonly<{
    brandReference: string;
    code: string;
    displayName: string;
    defaultLocale: string;
    currencyCode: "CAD";
  }>;
  readonly brandAuditReference: string;
  readonly membershipAuditReference: string;
  readonly policyAuditReference: string;
  readonly policySnapshotReference: string;
  readonly recipients: readonly BrandInitialProvisioningRecipient[];
}
export class BrandInitialProvisioningPlanError extends Error {
  readonly code = "BRAND_INITIAL_PROVISIONING_PLAN_INVALID";
  constructor() {
    super("Brand initialization plan is invalid");
    this.name = "BrandInitialProvisioningPlanError";
  }
}
const fail = (): never => {
  throw new BrandInitialProvisioningPlanError();
};
const reference = (value: unknown): string => String(parseBrandReference(value));
// Syntax-only input to existing owning validators, never an authored artifact or authority.
const syntaxInstant = "0001-01-01T00:00:00.000Z";
const placeholderDigest = `sha256:${"0".repeat(64)}`;
function requests(plan: BrandInitialProvisioningPlan, observedAt: string, planDigest: string) {
  const binding = {
    operationReference: plan.operationReference,
    brandReference: plan.brand.brandReference,
    planDigest,
    approvalEvidenceReference: plan.approvalEvidenceReference,
    operatorReference: plan.operatorReference,
    approvedByReference: plan.approvedByReference,
  };
  const membershipRequest = parseInitialBrandMembershipRequest({
    profile: "InitialBrandMembershipRequestV1",
    ...binding,
    members: plan.recipients.map((r) => ({
      membershipReference: r.membershipReference,
      actorReference: r.actorReference,
      workforceRelationshipReference: r.workforceRelationshipReference,
      effectiveUntil: r.membershipEffectiveUntil,
    })),
  });
  const policyRequest = parseBrandInitialPolicyRequest({
    profile: "BrandInitialPolicyV1",
    ...binding,
    policySnapshotReference: plan.policySnapshotReference,
    auditReference: plan.policyAuditReference,
    occurredAt: observedAt,
    recipients: plan.recipients.map((r) => ({
      actorReference: r.actorReference,
      membershipReference: r.membershipReference,
      roleReference: r.roleReference,
      roleCode: r.roleCode,
      assignmentReference: r.assignmentReference,
      effectiveFrom: observedAt,
      effectiveUntil: r.roleEffectiveUntil,
      grants: r.grants,
    })),
  });
  return { membershipRequest, policyRequest };
}
/** Validates the signed plan's syntax and internal bindings, not external Actor,
 * invitation, relationship or approval truth. Those require actual owning sources. */
export function parseBrandInitialProvisioningPlan(value: unknown): BrandInitialProvisioningPlan {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "purposeCode",
      "environmentReference",
      "operationReference",
      "operatorReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "brand",
      "brandAuditReference",
      "membershipAuditReference",
      "policyAuditReference",
      "policySnapshotReference",
      "recipients",
    ]);
    if (
      r.profile !== "BrandInitialProvisioningPlanV1" ||
      r.purposeCode !== brandProvisioningApprovalPurpose
    )
      return fail();
    const b = readClosedRecord(r.brand, [
      "brandReference",
      "code",
      "displayName",
      "defaultLocale",
      "currencyCode",
    ]);
    const syntaxBrand = createBrand({
      ...b,
      lifecycle: "Draft",
      version: 1,
      createdAt: syntaxInstant,
      updatedAt: syntaxInstant,
    });
    const brand = Object.freeze({
      brandReference: String(syntaxBrand.brandReference),
      code: syntaxBrand.code,
      displayName: syntaxBrand.displayName,
      defaultLocale: syntaxBrand.defaultLocale,
      currencyCode: syntaxBrand.currencyCode,
    });
    const ownIds = new Set<string>();
    const own = (value: unknown): string => {
      const id = reference(value);
      if (ownIds.has(id)) return fail();
      ownIds.add(id);
      return id;
    };
    own(brand.brandReference);
    const operationReference = own(r.operationReference),
      brandAuditReference = own(r.brandAuditReference),
      membershipAuditReference = own(r.membershipAuditReference),
      policyAuditReference = own(r.policyAuditReference),
      policySnapshotReference = own(r.policySnapshotReference);
    const recipients = brandInitialPolicyArray(r.recipients, 20).map((value) => {
      const row = readClosedRecord(value, [
        "actorReference",
        "membershipReference",
        "workforceRelationshipReference",
        "relationshipEvidenceReference",
        "invitationEvidenceReference",
        "membershipEffectiveUntil",
        "roleEffectiveUntil",
        "roleReference",
        "roleCode",
        "assignmentReference",
        "grants",
      ]);
      const membershipEffectiveUntil = parseBrandProvisioningApprovalInstant(
          row.membershipEffectiveUntil,
        ),
        roleEffectiveUntil = parseBrandProvisioningApprovalInstant(row.roleEffectiveUntil);
      if (roleEffectiveUntil > membershipEffectiveUntil || roleEffectiveUntil <= syntaxInstant)
        return fail();
      const grants = brandInitialPolicyArray(row.grants, 6).map((value) => {
        const g = readClosedRecord(value, ["grantReference", "permissionReference", "action"]);
        return Object.freeze({
          grantReference: own(g.grantReference),
          permissionReference: reference(g.permissionReference),
          action: g.action,
        });
      });
      return {
        actorReference: reference(row.actorReference),
        membershipReference: own(row.membershipReference),
        workforceRelationshipReference: reference(row.workforceRelationshipReference),
        relationshipEvidenceReference: reference(row.relationshipEvidenceReference),
        invitationEvidenceReference: reference(row.invitationEvidenceReference),
        membershipEffectiveUntil,
        roleEffectiveUntil,
        roleReference: own(row.roleReference),
        roleCode: row.roleCode,
        assignmentReference: own(row.assignmentReference),
        grants: Object.freeze(grants),
      };
    });
    // Existing policy parser owns role codes, action subset, required manage, and
    // consistent shared permission-definition IDs. It validates detached rows.
    const policy = parseBrandInitialPolicyRequest({
      profile: "BrandInitialPolicyV1",
      operationReference,
      brandReference: brand.brandReference,
      planDigest: placeholderDigest,
      approvalEvidenceReference: reference(r.approvalEvidenceReference),
      operatorReference: reference(r.operatorReference),
      approvedByReference: reference(r.approvedByReference),
      policySnapshotReference,
      auditReference: policyAuditReference,
      occurredAt: syntaxInstant,
      recipients: recipients.map((row) => ({
        actorReference: row.actorReference,
        membershipReference: row.membershipReference,
        roleReference: row.roleReference,
        roleCode: row.roleCode,
        assignmentReference: row.assignmentReference,
        effectiveFrom: syntaxInstant,
        effectiveUntil: row.roleEffectiveUntil,
        grants: row.grants,
      })),
    });
    const plan: BrandInitialProvisioningPlan = Object.freeze({
      profile: "BrandInitialProvisioningPlanV1",
      purposeCode: brandProvisioningApprovalPurpose,
      environmentReference: reference(r.environmentReference),
      operationReference,
      operatorReference: policy.operatorReference,
      approvedByReference: policy.approvedByReference,
      approvalEvidenceReference: policy.approvalEvidenceReference,
      brand,
      brandAuditReference,
      membershipAuditReference,
      policyAuditReference,
      policySnapshotReference,
      recipients: Object.freeze(
        recipients.map((row, index) => {
          const parsed = policy.recipients[index];
          if (!parsed) return fail();
          return Object.freeze({ ...row, roleCode: parsed.roleCode, grants: parsed.grants });
        }),
      ),
    });
    requests(plan, syntaxInstant, placeholderDigest);
    return plan;
  } catch {
    return fail();
  }
}
export function hashBrandInitialProvisioningPlan(value: unknown): string {
  return `sha256:${sha256Hex(canonicalizeRfc8785(parseBrandInitialProvisioningPlan(value)))}`;
}
export function deriveBrandInitialProvisioningRequests(value: unknown, observedAtInput: unknown) {
  try {
    const plan = parseBrandInitialProvisioningPlan(value),
      observedAt = parseBrandProvisioningApprovalInstant(observedAtInput),
      planDigest = hashBrandInitialProvisioningPlan(plan);
    if (
      plan.recipients.some(
        (r) => r.membershipEffectiveUntil <= observedAt || r.roleEffectiveUntil <= observedAt,
      )
    )
      return fail();
    const brand = createBrand({
      ...plan.brand,
      lifecycle: "Draft",
      version: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    const brandOperation: BrandAdministrationOperation = Object.freeze({
      command: "CreateBrand",
      operationReference: parseBrandAdministrationReference(plan.operationReference),
      brandReference: brand.brandReference,
      intentDigest: planDigest,
      brandVersion: brand.version,
      artifact: brand,
    });
    return Object.freeze({
      plan,
      planDigest,
      approvalExpected: parseBrandProvisioningApprovalExpected({
        environmentReference: plan.environmentReference,
        operationReference: plan.operationReference,
        brandReference: plan.brand.brandReference,
        planDigest,
        operatorReference: plan.operatorReference,
      }),
      brand,
      ...requests(plan, observedAt, planDigest),
      brandOperation,
    });
  } catch {
    return fail();
  }
}

/** Binds actual held Identity output. This parser does not authenticate its source. */
export function parseBrandInitialProvisioningOperator(
  rawPacket: unknown,
  planInput: unknown,
  observedAtInput: unknown,
) {
  try {
    const plan = parseBrandInitialProvisioningPlan(planInput),
      observedAt = parseBrandProvisioningApprovalInstant(observedAtInput),
      r = readClosedRecord(rawPacket, ["actor", "validUntil"]),
      actor = createIdentityActor(r.actor),
      validUntil = parseBrandProvisioningApprovalInstant(r.validUntil);
    if (
      actor.actorType !== "User" ||
      actor.status !== "Active" ||
      (actor.accountKind !== "Platform" && actor.accountKind !== "Workforce") ||
      actor.authenticationMethod !== "Oidc" ||
      actor.actorReference !== plan.operatorReference ||
      actor.verificationLevel !== "RecentMfa" ||
      actor.authenticatedAt === null ||
      actor.recentMfaAt === null ||
      String(actor.authenticatedAt) > observedAt ||
      String(actor.recentMfaAt) > observedAt ||
      Date.parse(observedAt) >= Date.parse(actor.recentMfaAt) + 900000 ||
      validUntil <= observedAt ||
      Date.parse(validUntil) > Date.parse(observedAt) + 5000 ||
      Date.parse(validUntil) > Date.parse(actor.recentMfaAt) + 900000
    )
      return fail();
    return Object.freeze({ actor, validUntil });
  } catch {
    return fail();
  }
}
/** Exact plan-to-owning relationship/invitation binding; no source truth is created. */
export function parseBrandInitialProvisioningMembers(
  planInput: unknown,
  originalObservedAtInput: unknown,
  observedAtInput: unknown,
  operatorInput: unknown,
  rawPacket: unknown,
) {
  try {
    const derived = deriveBrandInitialProvisioningRequests(planInput, originalObservedAtInput),
      observedAt = parseBrandProvisioningApprovalInstant(observedAtInput),
      originalObservedAt = parseBrandProvisioningApprovalInstant(originalObservedAtInput),
      r = readClosedRecord(rawPacket, ["members", "validUntil"]),
      operator = createIdentityActor(operatorInput),
      packetDeadline = parseBrandProvisioningApprovalInstant(r.validUntil);
    if (
      observedAt < originalObservedAt ||
      Date.parse(packetDeadline) > Date.parse(originalObservedAt) + 5000
    )
      return fail();
    const authority = parseInitialBrandMembershipAuthority(
      {
        brand: derived.brand,
        operator,
        operationReference: derived.plan.operationReference,
        brandReference: derived.plan.brand.brandReference,
        planDigest: derived.planDigest,
        requestDigest: hashInitialBrandMembershipRequest(derived.membershipRequest),
        approvalEvidenceReference: derived.plan.approvalEvidenceReference,
        approvedByReference: derived.plan.approvedByReference,
        members: r.members,
        observedAt,
        validUntil: r.validUntil,
      },
      derived.membershipRequest,
      originalObservedAt,
      observedAt,
      hashInitialBrandMembershipRequest(derived.membershipRequest),
    );
    for (let index = 0; index < authority.members.length; index++) {
      const member = authority.members[index],
        recipient = derived.plan.recipients[index];
      if (
        !member ||
        !recipient ||
        member.relationshipEvidenceReference !== recipient.relationshipEvidenceReference ||
        member.invitationEvidenceReference !== recipient.invitationEvidenceReference
      )
        return fail();
    }
    if (Date.parse(authority.validUntil) > Date.parse(originalObservedAt) + 5000) return fail();
    return authority;
  } catch {
    return fail();
  }
}

/** Verifies the stored immutable result against the signed static plan. This
 * does not requalify today's recipient periods or identify a receipt Actor:
 * original Actor/purpose/Audit binding belongs to Tenant's receipt source. */
export function assertBrandInitialProvisioningOriginal(
  planInput: unknown,
  original: BrandAdministrationOperation,
): void {
  try {
    const plan = parseBrandInitialProvisioningPlan(planInput);
    const r = readClosedRecord(original, [
      "command",
      "operationReference",
      "brandReference",
      "intentDigest",
      "brandVersion",
      "artifact",
    ]);
    const brand = createBrand(r.artifact);
    if (
      r.command !== "CreateBrand" ||
      r.operationReference !== plan.operationReference ||
      r.brandReference !== plan.brand.brandReference ||
      r.intentDigest !== hashBrandInitialProvisioningPlan(plan) ||
      r.brandVersion !== 1 ||
      brand.version !== 1 ||
      brand.lifecycle !== "Draft" ||
      brand.createdAt !== brand.updatedAt ||
      brand.brandReference !== plan.brand.brandReference ||
      brand.code !== plan.brand.code ||
      brand.displayName !== plan.brand.displayName ||
      brand.defaultLocale !== plan.brand.defaultLocale ||
      brand.currencyCode !== plan.brand.currencyCode
    )
      return fail();
    parseBrandProvisioningApprovalInstant(brand.createdAt);
    parseBrandProvisioningApprovalInstant(brand.updatedAt);
  } catch {
    return fail();
  }
}
