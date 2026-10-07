import type { BrandReference, StoreReference, TenantContext, TenantScopeKind } from "@bop/tenant";
import {
  parseBrandAdministrationPermissionAction,
  revalidateBrandAdministrationPermissionContext,
  type BrandAdministrationPermissionEvaluationRequest,
} from "../contracts/brand-administration-permission.js";
import {
  PermissionEvaluationContractError,
  parseBusinessAction,
  parseEvidenceInstant,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  permissionEvidenceSources,
  revalidateTenantContext,
  type PermissionDecision,
  type PermissionDecisionReason,
  type PermissionDecisionSource,
  type PermissionEvaluationRequest,
  type PermissionEvidence,
  type PermissionEvidenceSource,
  type PermissionActorReference,
  type PermissionResourceScope,
} from "../contracts/permission-evaluation.js";

function plain(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  const ownKeys = Reflect.ownKeys(value);
  const allowed = new Set(keys);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  )
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  const result: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

type ContextFacts = Pick<TenantContext, "actor" | "brand" | "store" | "resolvedAt">;
function scope(
  input: unknown,
  context: ContextFacts,
  kind: TenantScopeKind,
): PermissionResourceScope {
  const value = plain(input, ["kind", "brandReference", "storeReference"]);
  const expectedStore = context.store?.storeReference ?? null;
  if (
    value.kind !== kind ||
    value.brandReference !== context.brand.brandReference ||
    value.storeReference !== expectedStore
  )
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return Object.freeze({
    kind,
    brandReference: context.brand.brandReference,
    storeReference: expectedStore,
  });
}

function evidence(input: unknown): PermissionEvidence {
  const value = plain(input, [
    "source",
    "evidenceReference",
    "action",
    "actorReference",
    "roleReference",
    "brandReference",
    "storeReference",
    "effectiveFrom",
    "effectiveUntil",
  ]);
  if (
    typeof value.source !== "string" ||
    !permissionEvidenceSources.includes(value.source as PermissionEvidenceSource) ||
    typeof value.actorReference !== "string" ||
    typeof value.brandReference !== "string" ||
    (value.storeReference !== null && typeof value.storeReference !== "string")
  )
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  const source = value.source as PermissionEvidenceSource;
  if ((source === "RolePermission") !== (value.roleReference !== null))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  const from = parseEvidenceInstant(value.effectiveFrom);
  const until = value.effectiveUntil === null ? null : parseEvidenceInstant(value.effectiveUntil);
  if (until !== null && Date.parse(until) <= Date.parse(from))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return Object.freeze({
    source,
    evidenceReference: parseEvidenceReference(value.evidenceReference),
    action: parseBusinessAction(value.action),
    actorReference: value.actorReference as PermissionActorReference,
    roleReference: value.roleReference === null ? null : parseRoleReference(value.roleReference),
    brandReference: value.brandReference as BrandReference,
    storeReference: value.storeReference as StoreReference | null,
    effectiveFrom: from,
    effectiveUntil: until,
  });
}

function decision(
  request: {
    action: PermissionEvaluationRequest["action"];
    scope: PermissionResourceScope;
    policySnapshotReference: PermissionEvaluationRequest["policySnapshotReference"];
    policyVersion: PermissionEvaluationRequest["policyVersion"];
  },
  effect: PermissionDecision["effect"],
  reason: PermissionDecisionReason,
  source: PermissionDecisionSource,
): PermissionDecision {
  return Object.freeze({
    effect,
    reason,
    source,
    action: request.action,
    scopeKind: request.scope.kind,
    policySnapshotReference: request.policySnapshotReference,
    policyVersion: request.policyVersion,
    audit: Object.freeze({ effect, reason, source }),
  });
}

function sameEvidence(left: PermissionEvidence, right: PermissionEvidence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluatePermission(input: PermissionEvaluationRequest): PermissionDecision {
  const request = plain(input, [
    "tenantContext",
    "action",
    "resourceScope",
    "policySnapshotReference",
    "policyVersion",
    "evidence",
  ]);
  const context = revalidateTenantContext(
    request.tenantContext as PermissionEvaluationRequest["tenantContext"],
  );
  return evaluate(request, context, context.scopeKind);
}

export function evaluateBrandAdministrationPermission(
  input: BrandAdministrationPermissionEvaluationRequest,
): PermissionDecision {
  const request = plain(input, [
    "administrationContext",
    "action",
    "resourceScope",
    "policySnapshotReference",
    "policyVersion",
    "evidence",
  ]);
  const context = revalidateBrandAdministrationPermissionContext(request.administrationContext);
  parseBrandAdministrationPermissionAction(request.action);
  return evaluate(request, context, "Brand");
}

function evaluate(
  request: Readonly<Record<string, unknown>>,
  context: ContextFacts,
  kind: TenantScopeKind,
): PermissionDecision {
  const normalized = {
    action: parseBusinessAction(request.action),
    scope: scope(request.resourceScope, context, kind),
    policySnapshotReference: parsePolicyReference(request.policySnapshotReference),
    policyVersion: parsePolicyVersion(request.policyVersion),
  };
  if (!Array.isArray(request.evidence))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");

  let candidates: PermissionEvidence[];
  try {
    if (
      Object.getPrototypeOf(request.evidence) !== Array.prototype ||
      Reflect.ownKeys(request.evidence).length !== request.evidence.length + 1
    )
      return decision(normalized, "Deny", "INVALID_POLICY_EVIDENCE", "InvalidPolicy");
    candidates = [];
    for (let i = 0; i < request.evidence.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(request.evidence, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor))
        return decision(normalized, "Deny", "INVALID_POLICY_EVIDENCE", "InvalidPolicy");
      candidates.push(evidence(descriptor.value));
    }
  } catch {
    return decision(normalized, "Deny", "INVALID_POLICY_EVIDENCE", "InvalidPolicy");
  }
  const seen = new Map<string, PermissionEvidence>();
  for (const candidate of candidates) {
    const previous = seen.get(candidate.evidenceReference);
    if (previous && !sameEvidence(previous, candidate))
      return decision(normalized, "Deny", "INVALID_POLICY_EVIDENCE", "InvalidPolicy");
    seen.set(candidate.evidenceReference, candidate);
  }

  const at = Date.parse(context.resolvedAt);
  const matches = [...seen.values()].filter(
    (candidate) =>
      candidate.action === normalized.action &&
      candidate.actorReference === context.actor.actorReference &&
      candidate.brandReference === context.brand.brandReference &&
      (candidate.storeReference === null ||
        candidate.storeReference === normalized.scope.storeReference) &&
      Date.parse(candidate.effectiveFrom) <= at &&
      (candidate.effectiveUntil === null || at < Date.parse(candidate.effectiveUntil)),
  );
  if (matches.some((candidate) => candidate.source === "ExplicitDeny"))
    return decision(normalized, "Deny", "EXPLICIT_DENY", "ExplicitDeny");
  if (matches.some((candidate) => candidate.source === "ExplicitAllow"))
    return decision(normalized, "Allow", "EXPLICIT_ALLOW", "ExplicitAllow");
  if (matches.some((candidate) => candidate.source === "RolePermission"))
    return decision(normalized, "Allow", "ROLE_PERMISSION", "RolePermission");
  return decision(normalized, "Deny", "DEFAULT_DENY", "DefaultDeny");
}
