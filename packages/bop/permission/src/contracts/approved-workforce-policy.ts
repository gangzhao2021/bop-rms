import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseApprovedWorkforceMembership } from "@bop/membership";
import { parseBrandReference, parseCanonicalInstant } from "@bop/tenant";
import { parseRoleCode } from "../domain/permission-policy.js";
import { brandAdministrationPermissionActions } from "./brand-administration-permission.js";

export const approvedWorkforcePolicyPurpose = "WORKFORCE_ONBOARDING";

export class ApprovedWorkforcePolicyError extends Error {
  constructor(
    readonly code:
      | "APPROVED_WORKFORCE_POLICY_INVALID"
      | "APPROVED_WORKFORCE_POLICY_UNAVAILABLE" = "APPROVED_WORKFORCE_POLICY_INVALID",
  ) {
    super("Approved Workforce policy is unavailable");
    this.name = "ApprovedWorkforcePolicyError";
  }
}
export function approvedWorkforcePolicyInvalid(): never {
  throw new ApprovedWorkforcePolicyError();
}
export const approvedWorkforcePolicyReference = (value: unknown): string =>
  String(parseBrandReference(value));
export function approvedWorkforcePolicyInstant(value: unknown): string {
  const at = String(parseCanonicalInstant(value));
  if (at.startsWith("0000-")) return approvedWorkforcePolicyInvalid();
  return at;
}
export function approvedWorkforcePolicyArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return approvedWorkforcePolicyInvalid();
  return Object.freeze(
    Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !("value" in d)) return approvedWorkforcePolicyInvalid();
      return d.value;
    }),
  );
}
function finitePeriod(record: Readonly<Record<string, unknown>>) {
  const effectiveFrom = approvedWorkforcePolicyInstant(record.effectiveFrom),
    effectiveUntil = approvedWorkforcePolicyInstant(record.effectiveUntil);
  if (effectiveUntil <= effectiveFrom) return approvedWorkforcePolicyInvalid();
  return { effectiveFrom, effectiveUntil };
}
/** Static approval content only: no runtime observation, authentication, policy
 * head or Audit allocation enters this digest. Arrays are canonically sorted.
 * Scope is Brand-only. Prepared assignments still require an Active Membership
 * in the unchanged operational materializer before any business permission. */
export function parseApprovedWorkforcePolicyPlan(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "brandReference",
      "actorReference",
      "membershipReference",
      "effectiveFrom",
      "effectiveUntil",
      "roles",
    ]);
    if (r.profile !== "ApprovedWorkforcePolicyV1") return approvedWorkforcePolicyInvalid();
    const effectiveFrom = approvedWorkforcePolicyInstant(r.effectiveFrom),
      effectiveUntil = approvedWorkforcePolicyInstant(r.effectiveUntil);
    if (effectiveUntil <= effectiveFrom) return approvedWorkforcePolicyInvalid();
    const ids = new Set<string>(),
      codes = new Set<string>(),
      permissions = new Map<string, string>(),
      actions = new Map<string, string>();
    const unique = (set: Set<string>, item: string) => {
      if (set.has(item)) return approvedWorkforcePolicyInvalid();
      set.add(item);
      return item;
    };
    const roles = approvedWorkforcePolicyArray(r.roles, 8)
      .map((value) => {
        const role = readClosedRecord(value, [
          "roleReference",
          "roleCode",
          "effectiveFrom",
          "effectiveUntil",
          "assignment",
          "grants",
        ]);
        const roleReference = unique(ids, approvedWorkforcePolicyReference(role.roleReference));
        const assignmentRow = readClosedRecord(role.assignment, [
          "assignmentReference",
          "effectiveFrom",
          "effectiveUntil",
        ]);
        const assignment = Object.freeze({
          assignmentReference: unique(
            ids,
            approvedWorkforcePolicyReference(assignmentRow.assignmentReference),
          ),
          ...finitePeriod(assignmentRow),
        });
        if (assignment.effectiveFrom < effectiveFrom || assignment.effectiveUntil > effectiveUntil)
          return approvedWorkforcePolicyInvalid();
        const roleCode = unique(codes, String(parseRoleCode(role.roleCode)));
        const seen = new Set<string>();
        const grants = approvedWorkforcePolicyArray(role.grants, 6)
          .map((value) => {
            const g = readClosedRecord(value, [
              "grantReference",
              "permissionReference",
              "action",
              "effectiveFrom",
              "effectiveUntil",
            ]);
            const action = brandAdministrationPermissionActions.find(
              (action) => action === g.action,
            );
            if (!action) return approvedWorkforcePolicyInvalid();
            unique(seen, action);
            const permissionReference = approvedWorkforcePolicyReference(g.permissionReference);
            if (
              (permissions.has(permissionReference) &&
                permissions.get(permissionReference) !== action) ||
              (actions.has(action) && actions.get(action) !== permissionReference)
            )
              return approvedWorkforcePolicyInvalid();
            permissions.set(permissionReference, action);
            actions.set(action, permissionReference);
            return Object.freeze({
              grantReference: unique(ids, approvedWorkforcePolicyReference(g.grantReference)),
              permissionReference,
              action,
              ...finitePeriod(g),
            });
          })
          .sort((a, b) => a.grantReference.localeCompare(b.grantReference));
        if (!grants.length) return approvedWorkforcePolicyInvalid();
        return Object.freeze({
          roleReference,
          roleCode,
          ...finitePeriod(role),
          assignment,
          grants: Object.freeze(grants),
        });
      })
      .sort((a, b) => a.roleReference.localeCompare(b.roleReference));
    if (!roles.length) return approvedWorkforcePolicyInvalid();
    return Object.freeze({
      profile: "ApprovedWorkforcePolicyV1" as const,
      brandReference: approvedWorkforcePolicyReference(r.brandReference),
      actorReference: approvedWorkforcePolicyReference(r.actorReference),
      membershipReference: approvedWorkforcePolicyReference(r.membershipReference),
      effectiveFrom,
      effectiveUntil,
      roles: Object.freeze(roles),
    });
  } catch {
    return approvedWorkforcePolicyInvalid();
  }
}
export type ApprovedWorkforcePolicyPlan = ReturnType<typeof parseApprovedWorkforcePolicyPlan>;
export function hashApprovedWorkforcePolicyPlan(value: unknown): string {
  return `sha256:${sha256Hex(canonicalizeRfc8785(parseApprovedWorkforcePolicyPlan(value)))}`;
}
function approved(approvalInput: unknown, policyInput: unknown) {
  const approval = parseApprovedWorkforceMembership(approvalInput),
    policy = parseApprovedWorkforcePolicyPlan(policyInput);
  if (
    approval.brandReference !== policy.brandReference ||
    approval.actorReference !== policy.actorReference ||
    approval.membershipReference !== policy.membershipReference ||
    policy.effectiveFrom !== approval.effectiveFrom ||
    policy.effectiveUntil !== approval.effectiveUntil ||
    approval.approvedPolicyDigest !== hashApprovedWorkforcePolicyPlan(policy)
  )
    return approvedWorkforcePolicyInvalid();
  return { approval, policy };
}
export function parsePrepareApprovedWorkforcePolicy(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "operationReference",
      "approval",
      "policy",
      "expectedPolicy",
      "policySnapshotReference",
    ]);
    if (r.profile !== "PrepareApprovedWorkforcePolicyV1") return approvedWorkforcePolicyInvalid();
    const facts = approved(r.approval, r.policy),
      operationReference = approvedWorkforcePolicyReference(r.operationReference),
      policySnapshotReference = approvedWorkforcePolicyReference(r.policySnapshotReference);
    if (operationReference !== facts.approval.operationReference)
      return approvedWorkforcePolicyInvalid();
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
        return approvedWorkforcePolicyInvalid();
      expectedPolicy = Object.freeze({
        snapshotReference: approvedWorkforcePolicyReference(head.snapshotReference),
        version: head.version,
      });
      if (expectedPolicy.snapshotReference === policySnapshotReference)
        return approvedWorkforcePolicyInvalid();
    }
    return Object.freeze({
      profile: "PrepareApprovedWorkforcePolicyV1" as const,
      operationReference,
      ...facts,
      expectedPolicy,
      policySnapshotReference,
    });
  } catch {
    return approvedWorkforcePolicyInvalid();
  }
}
export function parseHoldApprovedWorkforcePolicy(value: unknown) {
  try {
    const r = readClosedRecord(value, ["profile", "approval", "policy"]);
    if (r.profile !== "HoldApprovedWorkforcePolicyV1") return approvedWorkforcePolicyInvalid();
    return Object.freeze({
      profile: "HoldApprovedWorkforcePolicyV1" as const,
      ...approved(r.approval, r.policy),
    });
  } catch {
    return approvedWorkforcePolicyInvalid();
  }
}
export type PrepareApprovedWorkforcePolicy = ReturnType<typeof parsePrepareApprovedWorkforcePolicy>;
export type HoldApprovedWorkforcePolicy = ReturnType<typeof parseHoldApprovedWorkforcePolicy>;
export type ApprovedWorkforcePolicyRequest =
  PrepareApprovedWorkforcePolicy | HoldApprovedWorkforcePolicy;
export function hashApprovedWorkforcePolicyRequest(value: unknown): string {
  const d =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "profile")
      : undefined;
  const parsed =
    d && "value" in d && d.value === "PrepareApprovedWorkforcePolicyV1"
      ? parsePrepareApprovedWorkforcePolicy(value)
      : parseHoldApprovedWorkforcePolicy(value);
  return `sha256:${sha256Hex(canonicalizeRfc8785(parsed))}`;
}
