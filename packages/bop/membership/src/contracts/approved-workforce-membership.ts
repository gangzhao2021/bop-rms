import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { parseBrandReference } from "@bop/tenant";
import {
  MembershipContractError,
  parseMembershipInstant,
  parseMembershipReference,
} from "../domain/membership.js";
import { parseWorkforceRelationshipQualificationExpected } from "./workforce-relationship-qualification.js";

export const approvedWorkforceMembershipPurpose = "WORKFORCE_ONBOARDING";
export function approvedMembershipInvalid(): never {
  throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
}
export function approvedMembershipReference(value: unknown): string {
  return parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID");
}
export function approvedMembershipInstant(value: unknown): string {
  const at = parseMembershipInstant(value);
  if (at.startsWith("0000-")) return approvedMembershipInvalid();
  return at;
}
export function approvedMembershipDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return approvedMembershipInvalid();
  return value;
}
/** Static approval, not authentication or relationship qualification. The
 * owning authority must resolve this exact original and its current validity. */
export function parseApprovedWorkforceMembership(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "operationReference",
      "planDigest",
      "operatorReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "environmentReference",
      "brandReference",
      "membershipReference",
      "actorReference",
      "workforceRelationshipReference",
      "relationshipEvidenceReference",
      "relationshipRevision",
      "effectiveFrom",
      "effectiveUntil",
      "approvedPolicyDigest",
    ]);
    if (r.profile !== "ApprovedWorkforceMembershipV1") return approvedMembershipInvalid();
    const relationship = parseWorkforceRelationshipQualificationExpected({
      environmentReference: r.environmentReference,
      actorReference: r.actorReference,
      brandReference: r.brandReference,
      workforceRelationshipReference: r.workforceRelationshipReference,
      relationshipEvidenceReference: r.relationshipEvidenceReference,
    });
    const operatorReference = approvedMembershipReference(r.operatorReference),
      approvedByReference = approvedMembershipReference(r.approvedByReference),
      effectiveFrom = approvedMembershipInstant(r.effectiveFrom),
      effectiveUntil = approvedMembershipInstant(r.effectiveUntil);
    if (
      operatorReference === approvedByReference ||
      relationship.actorReference === approvedByReference ||
      typeof r.relationshipRevision !== "number" ||
      !Number.isSafeInteger(r.relationshipRevision) ||
      r.relationshipRevision < 1 ||
      effectiveUntil <= effectiveFrom
    )
      return approvedMembershipInvalid();
    return Object.freeze({
      profile: "ApprovedWorkforceMembershipV1" as const,
      operationReference: approvedMembershipReference(r.operationReference),
      planDigest: approvedMembershipDigest(r.planDigest),
      operatorReference,
      approvedByReference,
      approvalEvidenceReference: approvedMembershipReference(r.approvalEvidenceReference),
      ...relationship,
      brandReference: parseBrandReference(relationship.brandReference),
      membershipReference: parseMembershipReference(r.membershipReference),
      relationshipRevision: r.relationshipRevision,
      effectiveFrom,
      effectiveUntil,
      approvedPolicyDigest: approvedMembershipDigest(r.approvedPolicyDigest),
    });
  } catch {
    return approvedMembershipInvalid();
  }
}
export type ApprovedWorkforceMembership = ReturnType<typeof parseApprovedWorkforceMembership>;

export function parseCreateApprovedPendingMembership(value: unknown) {
  try {
    const r = readClosedRecord(value, ["profile", "approval"]);
    if (r.profile !== "CreateApprovedPendingMembershipV1") return approvedMembershipInvalid();
    return Object.freeze({
      profile: r.profile,
      approval: parseApprovedWorkforceMembership(r.approval),
    });
  } catch {
    return approvedMembershipInvalid();
  }
}
export function parseActivateApprovedMembership(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "operationReference",
      "approval",
      "expectedVersion",
      "pendingCreatedAt",
      "invitationReference",
    ]);
    if (r.profile !== "ActivateApprovedMembershipV1" || r.expectedVersion !== 1)
      return approvedMembershipInvalid();
    return Object.freeze({
      profile: r.profile,
      operationReference: approvedMembershipReference(r.operationReference),
      approval: parseApprovedWorkforceMembership(r.approval),
      expectedVersion: 1 as const,
      pendingCreatedAt: approvedMembershipInstant(r.pendingCreatedAt),
      invitationReference: approvedMembershipReference(r.invitationReference),
    });
  } catch {
    return approvedMembershipInvalid();
  }
}
export type CreateApprovedPendingMembership = ReturnType<
  typeof parseCreateApprovedPendingMembership
>;
export type ActivateApprovedMembership = ReturnType<typeof parseActivateApprovedMembership>;
export type ApprovedWorkforceMembershipRequest =
  CreateApprovedPendingMembership | ActivateApprovedMembership;
