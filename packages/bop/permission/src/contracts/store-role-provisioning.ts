import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  storeRoleTemplateActions,
  storeRoleTemplateCodes,
  storeRoleTemplateProfiles,
  type StoreRoleTemplateCode,
} from "../catalog/store-permission-catalog.js";

/**
 * WP-2423 / DEC-PERM-CATALOG: a Store's template System roles are created once at Store opening by
 * a Platform operator under a plan signed by an independent Platform approver (Ed25519, configured
 * trust, revocable). The plan lists every role and action verbatim so the approver signs exactly
 * what will be granted; the plan must equal the released templates of the installed catalog.
 */
export const storeRoleProvisioningPurpose = "STORE_ROLE_PROVISIONING" as const;
export const storeRoleProvisioningSignatureDomain = "BOP-RMS:StoreRoleProvisioningApprovalV1\n";
const planDigestDomain = "BOP-RMS:StoreRoleProvisioningPlanV2\n";

export class StoreRoleProvisioningError extends Error {
  constructor(
    readonly code:
      | "STORE_ROLE_PROVISIONING_PLAN_INVALID"
      | "STORE_ROLE_PROVISIONING_APPROVAL_UNAVAILABLE"
      | "STORE_ROLE_PROVISIONING_CATALOG_MISMATCH"
      | "STORE_ROLE_PROVISIONING_CONFLICT"
      | "STORE_ROLE_PROVISIONING_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "StoreRoleProvisioningError";
  }
}
const invalidPlan = (): never => {
  throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_PLAN_INVALID");
};
const unavailable = (): never => {
  throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_APPROVAL_UNAVAILABLE");
};

function record(
  value: unknown,
  fields: readonly string[],
  fail: () => never,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function array(value: unknown, maximum: number, fail: () => never): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return descriptor.value;
  });
}
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: unknown, fail: () => never): string =>
  typeof value === "string" && uuidV7.test(value) ? value : fail();
function instant(value: unknown, fail: () => never): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    value.startsWith("0000-") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function base64url(value: unknown, bytes: number, fail: () => never): string {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return fail();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return fail();
  return value;
}

export interface StoreRoleProvisioningRole {
  readonly template: StoreRoleTemplateCode;
  readonly roleReference: string;
  readonly administrationReference: string;
  readonly roleCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly actions: readonly string[];
}
export interface StoreRoleProvisioningOwnerAssignment {
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly storeAssignmentReference: string;
  readonly assignmentReference: string;
}
/**
 * V2 (V1 was only ever applied to an internal test database). `previousCatalogVersion` is null when
 * the Store is opened and otherwise the version its template roles are upgraded from. A plan may
 * assign an Owner while the Store has none; the Owner must be an Active member assigned to the Store.
 */
export interface StoreRoleProvisioningPlan {
  readonly profile: "StoreRoleProvisioningPlanV2";
  readonly purposeCode: typeof storeRoleProvisioningPurpose;
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly catalogVersion: number;
  readonly catalogDigest: string;
  readonly previousCatalogVersion: number | null;
  readonly ownerAssignment: StoreRoleProvisioningOwnerAssignment | null;
  readonly effectiveFrom: string;
  readonly reasonCode: string;
  readonly roles: readonly StoreRoleProvisioningRole[];
}
const planFields = [
  "profile",
  "purposeCode",
  "environmentReference",
  "operationReference",
  "operatorReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "catalogVersion",
  "catalogDigest",
  "previousCatalogVersion",
  "ownerAssignment",
  "effectiveFrom",
  "reasonCode",
  "roles",
] as const;

/** Exact released content: every role equals its template profile and template actions. */
export function parseStoreRoleProvisioningPlan(value: unknown): StoreRoleProvisioningPlan {
  const r = record(value, planFields, invalidPlan);
  if (
    r.profile !== "StoreRoleProvisioningPlanV2" ||
    r.purposeCode !== storeRoleProvisioningPurpose ||
    typeof r.catalogVersion !== "number" ||
    !Number.isSafeInteger(r.catalogVersion) ||
    r.catalogVersion < 1 ||
    typeof r.catalogDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(r.catalogDigest) ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(r.reasonCode)
  )
    return invalidPlan();
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) return invalidPlan();
    ids.add(id);
    return id;
  };
  const scope = {
    environmentReference: reference(r.environmentReference, invalidPlan),
    operationReference: unique(reference(r.operationReference, invalidPlan)),
    operatorReference: reference(r.operatorReference, invalidPlan),
    tenantReference: reference(r.tenantReference, invalidPlan),
    brandReference: reference(r.brandReference, invalidPlan),
    storeReference: reference(r.storeReference, invalidPlan),
  };
  const templates = new Set<string>();
  const roles = array(r.roles, storeRoleTemplateCodes.length, invalidPlan).map((item) => {
    const role = record(
      item,
      [
        "template",
        "roleReference",
        "administrationReference",
        "roleCode",
        "displayName",
        "description",
        "actions",
      ],
      invalidPlan,
    );
    const template = storeRoleTemplateCodes.find((code) => code === role.template);
    if (!template || templates.has(template)) return invalidPlan();
    templates.add(template);
    const profile = storeRoleTemplateProfiles[template],
      actions = array(role.actions, 512, invalidPlan),
      expected = storeRoleTemplateActions(template);
    if (
      role.roleCode !== profile.roleCode ||
      role.displayName !== profile.displayName ||
      role.description !== profile.description ||
      actions.length !== expected.length ||
      actions.some((action, index) => action !== expected[index])
    )
      return invalidPlan();
    return Object.freeze({
      template,
      roleReference: unique(reference(role.roleReference, invalidPlan)),
      administrationReference: unique(reference(role.administrationReference, invalidPlan)),
      roleCode: profile.roleCode,
      displayName: profile.displayName,
      description: profile.description,
      actions: expected,
    });
  });
  if (!templates.has("owner")) return invalidPlan();
  const previousCatalogVersion = r.previousCatalogVersion;
  if (
    previousCatalogVersion !== null &&
    (typeof previousCatalogVersion !== "number" ||
      !Number.isSafeInteger(previousCatalogVersion) ||
      previousCatalogVersion < 1 ||
      previousCatalogVersion >= r.catalogVersion)
  )
    return invalidPlan();
  let ownerAssignment: StoreRoleProvisioningOwnerAssignment | null = null;
  if (r.ownerAssignment !== null) {
    const owner = record(
      r.ownerAssignment,
      ["actorReference", "membershipReference", "storeAssignmentReference", "assignmentReference"],
      invalidPlan,
    );
    ownerAssignment = Object.freeze({
      actorReference: reference(owner.actorReference, invalidPlan),
      membershipReference: reference(owner.membershipReference, invalidPlan),
      storeAssignmentReference: reference(owner.storeAssignmentReference, invalidPlan),
      assignmentReference: unique(reference(owner.assignmentReference, invalidPlan)),
    });
    if (ownerAssignment.actorReference === scope.operatorReference) return invalidPlan();
  }
  return Object.freeze({
    profile: "StoreRoleProvisioningPlanV2",
    purposeCode: storeRoleProvisioningPurpose,
    ...scope,
    catalogVersion: r.catalogVersion,
    catalogDigest: r.catalogDigest,
    previousCatalogVersion,
    ownerAssignment,
    effectiveFrom: instant(r.effectiveFrom, invalidPlan),
    reasonCode: r.reasonCode,
    roles: Object.freeze(
      roles.sort((a, b) =>
        storeRoleTemplateCodes.indexOf(a.template) < storeRoleTemplateCodes.indexOf(b.template)
          ? -1
          : 1,
      ),
    ),
  });
}
export function storeRoleProvisioningPlanDigest(value: unknown): string {
  const plan = parseStoreRoleProvisioningPlan(value);
  return (
    "sha256:" +
    createHash("sha256")
      .update(planDigestDomain + canonicalizeRfc8785(plan))
      .digest("hex")
  );
}

export interface StoreRoleProvisioningApproval {
  readonly profile: "StoreRoleProvisioningApprovalV1";
  readonly purposeCode: typeof storeRoleProvisioningPurpose;
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly storeReference: string;
  readonly planDigest: string;
  readonly operatorReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly keyReference: string;
  readonly signature: string;
}
export function parseStoreRoleProvisioningApproval(value: unknown): StoreRoleProvisioningApproval {
  const r = record(
    value,
    [
      "profile",
      "purposeCode",
      "environmentReference",
      "operationReference",
      "storeReference",
      "planDigest",
      "operatorReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "notBefore",
      "validUntil",
      "keyReference",
      "signature",
    ],
    unavailable,
  );
  const operatorReference = reference(r.operatorReference, unavailable),
    approvedByReference = reference(r.approvedByReference, unavailable),
    notBefore = instant(r.notBefore, unavailable),
    validUntil = instant(r.validUntil, unavailable);
  if (
    r.profile !== "StoreRoleProvisioningApprovalV1" ||
    r.purposeCode !== storeRoleProvisioningPurpose ||
    typeof r.planDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(r.planDigest) ||
    operatorReference === approvedByReference ||
    validUntil <= notBefore
  )
    return unavailable();
  return Object.freeze({
    profile: "StoreRoleProvisioningApprovalV1",
    purposeCode: storeRoleProvisioningPurpose,
    environmentReference: reference(r.environmentReference, unavailable),
    operationReference: reference(r.operationReference, unavailable),
    storeReference: reference(r.storeReference, unavailable),
    planDigest: r.planDigest,
    operatorReference,
    approvedByReference,
    approvalEvidenceReference: reference(r.approvalEvidenceReference, unavailable),
    notBefore,
    validUntil,
    keyReference: reference(r.keyReference, unavailable),
    signature: base64url(r.signature, 64, unavailable),
  });
}
/** Exact bytes the approver signs: the domain line plus the canonical approval without signature. */
export function storeRoleProvisioningSigningBytes(
  approval: Omit<StoreRoleProvisioningApproval, "signature">,
): string {
  const payload = { ...approval } as Record<string, unknown>;
  delete payload.signature;
  return storeRoleProvisioningSignatureDomain + canonicalizeRfc8785(payload);
}

export interface StoreRoleProvisioningTrustKey {
  readonly keyReference: string;
  readonly approvedByReference: string;
  readonly environmentReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly publicKeySpki: string;
}
export interface StoreRoleProvisioningTrust {
  readonly keys: readonly StoreRoleProvisioningTrustKey[];
  readonly revokedApprovalEvidenceReferences: readonly string[];
}
export function parseStoreRoleProvisioningTrust(value: unknown): StoreRoleProvisioningTrust {
  const r = record(value, ["profile", "keys", "revokedApprovalEvidenceReferences"], unavailable);
  if (r.profile !== "StoreRoleProvisioningTrustV1") return unavailable();
  const keys = array(r.keys, 32, unavailable).map((item) => {
    const k = record(
      item,
      [
        "keyReference",
        "approvedByReference",
        "environmentReference",
        "purposeCode",
        "notBefore",
        "validUntil",
        "publicKeySpki",
      ],
      unavailable,
    );
    const notBefore = instant(k.notBefore, unavailable),
      validUntil = instant(k.validUntil, unavailable);
    if (k.purposeCode !== storeRoleProvisioningPurpose || validUntil <= notBefore)
      return unavailable();
    return Object.freeze({
      keyReference: reference(k.keyReference, unavailable),
      approvedByReference: reference(k.approvedByReference, unavailable),
      environmentReference: reference(k.environmentReference, unavailable),
      notBefore,
      validUntil,
      publicKeySpki: base64url(k.publicKeySpki, 44, unavailable),
    });
  });
  const revoked = array(r.revokedApprovalEvidenceReferences, 256, unavailable).map((item) =>
    reference(item, unavailable),
  );
  if (
    new Set(keys.map((key) => key.keyReference)).size !== keys.length ||
    new Set(revoked).size !== revoked.length
  )
    return unavailable();
  return Object.freeze({
    keys: Object.freeze(keys),
    revokedApprovalEvidenceReferences: Object.freeze(revoked),
  });
}

/**
 * Verifies the approval against the plan, the current trust and the current instant. Called before
 * the write and again immediately before COMMIT with freshly read trust, so a revocation or expiry
 * observed in between refuses the provisioning.
 */
export function verifyStoreRoleProvisioningApproval(input: {
  readonly plan: StoreRoleProvisioningPlan;
  readonly approval: unknown;
  readonly trust: unknown;
  readonly now: string;
}): StoreRoleProvisioningApproval {
  const approval = parseStoreRoleProvisioningApproval(input.approval),
    trust = parseStoreRoleProvisioningTrust(input.trust),
    now = instant(input.now, unavailable),
    plan = input.plan;
  if (
    approval.environmentReference !== plan.environmentReference ||
    approval.operationReference !== plan.operationReference ||
    approval.storeReference !== plan.storeReference ||
    approval.operatorReference !== plan.operatorReference ||
    approval.planDigest !== storeRoleProvisioningPlanDigest(plan) ||
    approval.notBefore > now ||
    approval.validUntil <= now ||
    trust.revokedApprovalEvidenceReferences.includes(approval.approvalEvidenceReference) ||
    approval.approvedByReference === plan.ownerAssignment?.actorReference
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
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(storeRoleProvisioningSigningBytes(approval), "utf8"),
        publicKey,
        Buffer.from(approval.signature, "base64url"),
      )
    )
      return unavailable();
  } catch {
    return unavailable();
  }
  return approval;
}

/** Prepares the complete plan for the released templates; the approver reviews and signs it. */
export function buildStoreRoleProvisioningPlan(input: {
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly catalogVersion: number;
  readonly catalogDigest: string;
  readonly previousCatalogVersion?: number | null;
  readonly ownerAssignment?: Omit<
    StoreRoleProvisioningOwnerAssignment,
    "assignmentReference"
  > | null;
  /** Existing template roles of the Store keep their references when upgraded. */
  readonly existingRoles?: Readonly<
    Partial<
      Record<
        StoreRoleTemplateCode,
        { readonly roleReference: string; readonly administrationReference: string }
      >
    >
  >;
  readonly effectiveFrom: string;
  readonly reasonCode: string;
  readonly templates: readonly StoreRoleTemplateCode[];
  readonly nextReference: () => string;
}): StoreRoleProvisioningPlan {
  return parseStoreRoleProvisioningPlan({
    profile: "StoreRoleProvisioningPlanV2",
    purposeCode: storeRoleProvisioningPurpose,
    environmentReference: input.environmentReference,
    operationReference: input.operationReference,
    operatorReference: input.operatorReference,
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    catalogVersion: input.catalogVersion,
    catalogDigest: input.catalogDigest,
    previousCatalogVersion: input.previousCatalogVersion ?? null,
    ownerAssignment:
      input.ownerAssignment == null
        ? null
        : { ...input.ownerAssignment, assignmentReference: input.nextReference() },
    effectiveFrom: input.effectiveFrom,
    reasonCode: input.reasonCode,
    roles: input.templates.map((template) => ({
      template,
      roleReference: input.existingRoles?.[template]?.roleReference ?? input.nextReference(),
      administrationReference:
        input.existingRoles?.[template]?.administrationReference ?? input.nextReference(),
      ...storeRoleTemplateProfiles[template],
      actions: [...storeRoleTemplateActions(template)],
    })),
  });
}
