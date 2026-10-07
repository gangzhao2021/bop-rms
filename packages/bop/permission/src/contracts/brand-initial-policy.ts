import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBrandReference, parseCanonicalInstant } from "@bop/tenant";
import { parseRoleCode } from "../domain/permission-policy.js";
import {
  brandAdministrationPermissionActions,
  type BrandAdministrationPermissionAction,
} from "./brand-administration-permission.js";

export class BrandInitialPolicyError extends Error {
  constructor(
    readonly code:
      | "BRAND_INITIAL_POLICY_INPUT_INVALID"
      | "BRAND_INITIAL_POLICY_UNAVAILABLE"
      | "BRAND_INITIAL_POLICY_ALREADY_EXISTS" = "BRAND_INITIAL_POLICY_INPUT_INVALID",
  ) {
    super("Initial Brand policy is unavailable");
    this.name = "BrandInitialPolicyError";
  }
}
export interface BrandInitialPolicyGrant {
  readonly grantReference: string;
  readonly permissionReference: string;
  readonly action: BrandAdministrationPermissionAction;
}
export interface BrandInitialPolicyRecipient {
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly roleReference: string;
  readonly roleCode: string;
  readonly assignmentReference: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly grants: readonly BrandInitialPolicyGrant[];
}
export interface BrandInitialPolicyRequest {
  readonly profile: "BrandInitialPolicyV1";
  readonly operationReference: string;
  readonly brandReference: string;
  readonly planDigest: string;
  readonly approvalEvidenceReference: string;
  readonly operatorReference: string;
  readonly approvedByReference: string;
  readonly policySnapshotReference: string;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly recipients: readonly BrandInitialPolicyRecipient[];
}
const fail = (): never => {
  throw new BrandInitialPolicyError();
};
/** Descriptor-first closed arrays; no getters, holes, inherited or extra data. */
export function brandInitialPolicyArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}
const reference = (value: unknown): string => String(parseBrandReference(value));
export function parseBrandInitialPolicyRequest(value: unknown): BrandInitialPolicyRequest {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "operationReference",
      "brandReference",
      "planDigest",
      "approvalEvidenceReference",
      "operatorReference",
      "approvedByReference",
      "policySnapshotReference",
      "auditReference",
      "occurredAt",
      "recipients",
    ]);
    if (
      r.profile !== "BrandInitialPolicyV1" ||
      typeof r.planDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(r.planDigest)
    )
      return fail();
    const operatorReference = reference(r.operatorReference),
      approvedByReference = reference(r.approvedByReference);
    if (operatorReference === approvedByReference) return fail();
    const identities = new Set<string>(),
      members = new Set<string>(),
      codes = new Set<string>(),
      written = new Set<string>(),
      permissionActions = new Map<string, string>(),
      actionPermissions = new Map<string, string>();
    const unique = (set: Set<string>, item: string) => {
      if (set.has(item)) return fail();
      set.add(item);
      return item;
    };
    const policySnapshotReference = unique(written, reference(r.policySnapshotReference)),
      auditReference = unique(written, reference(r.auditReference));
    const recipients = brandInitialPolicyArray(r.recipients, 20).map((value) => {
      const row = readClosedRecord(value, [
        "actorReference",
        "membershipReference",
        "roleReference",
        "roleCode",
        "assignmentReference",
        "effectiveFrom",
        "effectiveUntil",
        "grants",
      ]);
      const effectiveFrom = String(parseCanonicalInstant(row.effectiveFrom)),
        effectiveUntil =
          row.effectiveUntil === null ? null : String(parseCanonicalInstant(row.effectiveUntil));
      if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
      const actions = new Set<string>();
      const grants = brandInitialPolicyArray(row.grants, 6).map((input) => {
        const grant = readClosedRecord(input, ["grantReference", "permissionReference", "action"]),
          action = brandAdministrationPermissionActions.find(
            (candidate) => candidate === grant.action,
          );
        if (!action) return fail();
        unique(actions, action);
        const permissionReference = reference(grant.permissionReference);
        if (
          (permissionActions.has(permissionReference) &&
            permissionActions.get(permissionReference) !== action) ||
          (actionPermissions.has(action) && actionPermissions.get(action) !== permissionReference)
        )
          return fail();
        permissionActions.set(permissionReference, action);
        actionPermissions.set(action, permissionReference);
        return Object.freeze({
          grantReference: unique(written, reference(grant.grantReference)),
          permissionReference,
          action,
        });
      });
      if (!actions.has("organization.manage")) return fail();
      return Object.freeze({
        actorReference: unique(identities, reference(row.actorReference)),
        membershipReference: unique(members, reference(row.membershipReference)),
        roleReference: unique(written, reference(row.roleReference)),
        roleCode: unique(codes, String(parseRoleCode(row.roleCode))),
        assignmentReference: unique(written, reference(row.assignmentReference)),
        effectiveFrom,
        effectiveUntil,
        grants: Object.freeze(grants),
      });
    });
    return Object.freeze({
      profile: "BrandInitialPolicyV1",
      operationReference: reference(r.operationReference),
      brandReference: reference(r.brandReference),
      planDigest: r.planDigest,
      approvalEvidenceReference: reference(r.approvalEvidenceReference),
      operatorReference,
      approvedByReference,
      policySnapshotReference,
      auditReference,
      occurredAt: String(parseCanonicalInstant(r.occurredAt)),
      recipients: Object.freeze(recipients),
    });
  } catch {
    return fail();
  }
}
/** Binds the complete closed request, including every recipient, period and reference.
 * Authority derives it from the signed static plan and fixed server observation,
 * then verifies this requestDigest; runtime occurredAt need not be pre-signed. */
export function hashBrandInitialPolicyRequest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalizeRfc8785(parseBrandInitialPolicyRequest(value)))}`;
}
