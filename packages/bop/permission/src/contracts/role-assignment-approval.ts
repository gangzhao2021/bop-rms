import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  approvalBase64url,
  approvalInstant,
  approvalReference,
  closedApprovalRecord,
  parseStoreRoleProvisioningTrust,
} from "./store-role-provisioning.js";

/**
 * WP-2423 / DEC-PERM-CATALOG A: Platform support may approve a Store's pending role assignment
 * request when no other administrator of the Store can (for example a Store with a single Owner).
 * The approval is an Ed25519 signature by a configured Platform approver over the exact pending
 * request; the approver is never its requester or its subject.
 */
export const roleAssignmentApprovalPurpose = "ROLE_ASSIGNMENT_APPROVAL" as const;
export const roleAssignmentApprovalSignatureDomain = "BOP-RMS:RoleAssignmentPlatformApprovalV1\n";
export class RoleAssignmentApprovalError extends Error {
  readonly code = "ROLE_ASSIGNMENT_APPROVAL_UNAVAILABLE";
  constructor() {
    super("Role assignment approval is unavailable");
    this.name = "RoleAssignmentApprovalError";
  }
}
const unavailable = (): never => {
  throw new RoleAssignmentApprovalError();
};
export interface RoleAssignmentPlatformApproval {
  readonly profile: "RoleAssignmentPlatformApprovalV1";
  readonly purposeCode: typeof roleAssignmentApprovalPurpose;
  readonly environmentReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly changeReference: string;
  readonly roleReference: string;
  readonly subjectReference: string;
  readonly requestedByReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly keyReference: string;
  readonly signature: string;
}
const fields = [
  "profile",
  "purposeCode",
  "environmentReference",
  "brandReference",
  "storeReference",
  "changeReference",
  "roleReference",
  "subjectReference",
  "requestedByReference",
  "approvedByReference",
  "approvalEvidenceReference",
  "notBefore",
  "validUntil",
  "keyReference",
  "signature",
] as const;
export function parseRoleAssignmentPlatformApproval(
  value: unknown,
): RoleAssignmentPlatformApproval {
  const r = closedApprovalRecord(value, fields, unavailable);
  const parsed = {
    profile: r.profile,
    purposeCode: r.purposeCode,
    environmentReference: approvalReference(r.environmentReference, unavailable),
    brandReference: approvalReference(r.brandReference, unavailable),
    storeReference: approvalReference(r.storeReference, unavailable),
    changeReference: approvalReference(r.changeReference, unavailable),
    roleReference: approvalReference(r.roleReference, unavailable),
    subjectReference: approvalReference(r.subjectReference, unavailable),
    requestedByReference: approvalReference(r.requestedByReference, unavailable),
    approvedByReference: approvalReference(r.approvedByReference, unavailable),
    approvalEvidenceReference: approvalReference(r.approvalEvidenceReference, unavailable),
    notBefore: approvalInstant(r.notBefore, unavailable),
    validUntil: approvalInstant(r.validUntil, unavailable),
    keyReference: approvalReference(r.keyReference, unavailable),
    signature: approvalBase64url(r.signature, 64, unavailable),
  };
  if (
    parsed.profile !== "RoleAssignmentPlatformApprovalV1" ||
    parsed.purposeCode !== roleAssignmentApprovalPurpose ||
    parsed.validUntil <= parsed.notBefore ||
    parsed.approvedByReference === parsed.requestedByReference ||
    parsed.approvedByReference === parsed.subjectReference
  )
    return unavailable();
  return Object.freeze(parsed) as RoleAssignmentPlatformApproval;
}
export function roleAssignmentApprovalSigningBytes(
  approval: Omit<RoleAssignmentPlatformApproval, "signature">,
): string {
  const payload = { ...approval } as Record<string, unknown>;
  delete payload.signature;
  return roleAssignmentApprovalSignatureDomain + canonicalizeRfc8785(payload);
}
/** Verifies the signature for exactly this pending request against current, unrevoked trust. */
export function verifyRoleAssignmentPlatformApproval(input: {
  readonly approval: unknown;
  readonly trust: unknown;
  readonly now: string;
  readonly expected: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly changeReference: string;
    readonly roleReference: string;
    readonly subjectReference: string;
    readonly requestedByReference: string;
  };
}): RoleAssignmentPlatformApproval {
  try {
    const approval = parseRoleAssignmentPlatformApproval(input.approval),
      trust = parseStoreRoleProvisioningTrust(input.trust, roleAssignmentApprovalPurpose),
      now = approvalInstant(input.now, unavailable),
      expected = input.expected;
    if (
      approval.brandReference !== expected.brandReference ||
      approval.storeReference !== expected.storeReference ||
      approval.changeReference !== expected.changeReference ||
      approval.roleReference !== expected.roleReference ||
      approval.subjectReference !== expected.subjectReference ||
      approval.requestedByReference !== expected.requestedByReference ||
      approval.notBefore > now ||
      approval.validUntil <= now ||
      trust.revokedApprovalEvidenceReferences.includes(approval.approvalEvidenceReference)
    )
      return unavailable();
    const key = trust.keys.find((item) => item.keyReference === approval.keyReference);
    if (
      !key ||
      key.approvedByReference !== approval.approvedByReference ||
      key.environmentReference !== approval.environmentReference ||
      key.notBefore > now ||
      key.validUntil <= now
    )
      return unavailable();
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(roleAssignmentApprovalSigningBytes(approval), "utf8"),
        publicKey,
        Buffer.from(approval.signature, "base64url"),
      )
    )
      return unavailable();
    return approval;
  } catch {
    return unavailable();
  }
}
