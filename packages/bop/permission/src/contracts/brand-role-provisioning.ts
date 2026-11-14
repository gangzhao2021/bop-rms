import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  brandRoleTemplateActions,
  brandRoleTemplateCodes,
  brandRoleTemplateProfiles,
  type BrandRoleTemplateCode,
} from "../catalog/store-permission-catalog.js";
import {
  approvalBase64url,
  approvalInstant,
  approvalReference,
  closedApprovalRecord,
  parseStoreRoleProvisioningTrust,
  StoreRoleProvisioningError,
} from "./store-role-provisioning.js";

/**
 * WP-2423 / DEC-PERM-BRAND-ROLES: a Brand's template System roles (no Store) are created once by a
 * Platform operator under a plan signed by an independent Platform approver, with the same trust
 * model as Store role provisioning but its own purpose, signature domain and keys. Later catalog
 * versions upgrade them strictly forward. A plan may assign the Brand Owner while the Brand has none.
 */
export const brandRoleProvisioningPurpose = "BRAND_ROLE_PROVISIONING" as const;
export const brandRoleProvisioningSignatureDomain = "BOP-RMS:BrandRoleProvisioningApprovalV1\n";
const planDigestDomain = "BOP-RMS:BrandRoleProvisioningPlanV1\n";
const invalidPlan = (): never => {
  throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_PLAN_INVALID");
};
const unavailable = (): never => {
  throw new StoreRoleProvisioningError("STORE_ROLE_PROVISIONING_APPROVAL_UNAVAILABLE");
};
function list(value: unknown, maximum: number, fail: () => never): readonly unknown[] {
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

export interface BrandRoleProvisioningRole {
  readonly template: BrandRoleTemplateCode;
  readonly roleReference: string;
  readonly administrationReference: string;
  readonly roleCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly actions: readonly string[];
}
export interface BrandRoleProvisioningOwnerAssignment {
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly assignmentReference: string;
}
export interface BrandRoleProvisioningPlan {
  readonly profile: "BrandRoleProvisioningPlanV1";
  readonly purposeCode: typeof brandRoleProvisioningPurpose;
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly catalogVersion: number;
  readonly catalogDigest: string;
  readonly previousCatalogVersion: number | null;
  readonly ownerAssignment: BrandRoleProvisioningOwnerAssignment | null;
  readonly effectiveFrom: string;
  readonly reasonCode: string;
  readonly roles: readonly BrandRoleProvisioningRole[];
}

/** Exact released content: every role equals its template profile and template actions. */
export function parseBrandRoleProvisioningPlan(value: unknown): BrandRoleProvisioningPlan {
  const r = closedApprovalRecord(
    value,
    [
      "profile",
      "purposeCode",
      "environmentReference",
      "operationReference",
      "operatorReference",
      "tenantReference",
      "brandReference",
      "catalogVersion",
      "catalogDigest",
      "previousCatalogVersion",
      "ownerAssignment",
      "effectiveFrom",
      "reasonCode",
      "roles",
    ],
    invalidPlan,
  );
  if (
    r.profile !== "BrandRoleProvisioningPlanV1" ||
    r.purposeCode !== brandRoleProvisioningPurpose ||
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
    environmentReference: approvalReference(r.environmentReference, invalidPlan),
    operationReference: unique(approvalReference(r.operationReference, invalidPlan)),
    operatorReference: approvalReference(r.operatorReference, invalidPlan),
    tenantReference: approvalReference(r.tenantReference, invalidPlan),
    brandReference: approvalReference(r.brandReference, invalidPlan),
  };
  const templates = new Set<string>();
  const roles = list(r.roles, brandRoleTemplateCodes.length, invalidPlan).map((item) => {
    const role = closedApprovalRecord(
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
    const template = brandRoleTemplateCodes.find((code) => code === role.template);
    if (!template || templates.has(template)) return invalidPlan();
    templates.add(template);
    const profile = brandRoleTemplateProfiles[template],
      actions = list(role.actions, 512, invalidPlan),
      expected = brandRoleTemplateActions(template);
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
      roleReference: unique(approvalReference(role.roleReference, invalidPlan)),
      administrationReference: unique(approvalReference(role.administrationReference, invalidPlan)),
      roleCode: profile.roleCode,
      displayName: profile.displayName,
      description: profile.description,
      actions: expected,
    });
  });
  if (!templates.has("brand-owner")) return invalidPlan();
  const previousCatalogVersion = r.previousCatalogVersion;
  if (
    previousCatalogVersion !== null &&
    (typeof previousCatalogVersion !== "number" ||
      !Number.isSafeInteger(previousCatalogVersion) ||
      previousCatalogVersion < 1 ||
      previousCatalogVersion >= r.catalogVersion)
  )
    return invalidPlan();
  let ownerAssignment: BrandRoleProvisioningOwnerAssignment | null = null;
  if (r.ownerAssignment !== null) {
    const owner = closedApprovalRecord(
      r.ownerAssignment,
      ["actorReference", "membershipReference", "assignmentReference"],
      invalidPlan,
    );
    ownerAssignment = Object.freeze({
      actorReference: approvalReference(owner.actorReference, invalidPlan),
      membershipReference: approvalReference(owner.membershipReference, invalidPlan),
      assignmentReference: unique(approvalReference(owner.assignmentReference, invalidPlan)),
    });
    if (ownerAssignment.actorReference === scope.operatorReference) return invalidPlan();
  }
  return Object.freeze({
    profile: "BrandRoleProvisioningPlanV1",
    purposeCode: brandRoleProvisioningPurpose,
    ...scope,
    catalogVersion: r.catalogVersion,
    catalogDigest: r.catalogDigest,
    previousCatalogVersion,
    ownerAssignment,
    effectiveFrom: approvalInstant(r.effectiveFrom, invalidPlan),
    reasonCode: r.reasonCode,
    roles: Object.freeze(
      roles.sort(
        (a, b) =>
          brandRoleTemplateCodes.indexOf(a.template) - brandRoleTemplateCodes.indexOf(b.template),
      ),
    ),
  });
}
export function brandRoleProvisioningPlanDigest(value: unknown): string {
  const plan = parseBrandRoleProvisioningPlan(value);
  return (
    "sha256:" +
    createHash("sha256")
      .update(planDigestDomain + canonicalizeRfc8785(plan))
      .digest("hex")
  );
}

export interface BrandRoleProvisioningApproval {
  readonly profile: "BrandRoleProvisioningApprovalV1";
  readonly purposeCode: typeof brandRoleProvisioningPurpose;
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly brandReference: string;
  readonly planDigest: string;
  readonly operatorReference: string;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly keyReference: string;
  readonly signature: string;
}
export function parseBrandRoleProvisioningApproval(value: unknown): BrandRoleProvisioningApproval {
  const r = closedApprovalRecord(
    value,
    [
      "profile",
      "purposeCode",
      "environmentReference",
      "operationReference",
      "brandReference",
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
  const operatorReference = approvalReference(r.operatorReference, unavailable),
    approvedByReference = approvalReference(r.approvedByReference, unavailable),
    notBefore = approvalInstant(r.notBefore, unavailable),
    validUntil = approvalInstant(r.validUntil, unavailable);
  if (
    r.profile !== "BrandRoleProvisioningApprovalV1" ||
    r.purposeCode !== brandRoleProvisioningPurpose ||
    typeof r.planDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(r.planDigest) ||
    operatorReference === approvedByReference ||
    validUntil <= notBefore
  )
    return unavailable();
  return Object.freeze({
    profile: "BrandRoleProvisioningApprovalV1",
    purposeCode: brandRoleProvisioningPurpose,
    environmentReference: approvalReference(r.environmentReference, unavailable),
    operationReference: approvalReference(r.operationReference, unavailable),
    brandReference: approvalReference(r.brandReference, unavailable),
    planDigest: r.planDigest,
    operatorReference,
    approvedByReference,
    approvalEvidenceReference: approvalReference(r.approvalEvidenceReference, unavailable),
    notBefore,
    validUntil,
    keyReference: approvalReference(r.keyReference, unavailable),
    signature: approvalBase64url(r.signature, 64, unavailable),
  });
}
/** Exact bytes the approver signs: the domain line plus the canonical approval without signature. */
export function brandRoleProvisioningSigningBytes(
  approval: Omit<BrandRoleProvisioningApproval, "signature">,
): string {
  const payload = { ...approval } as Record<string, unknown>;
  delete payload.signature;
  return brandRoleProvisioningSignatureDomain + canonicalizeRfc8785(payload);
}

/** Verified before the write and again before COMMIT with freshly read trust. */
export function verifyBrandRoleProvisioningApproval(input: {
  readonly plan: BrandRoleProvisioningPlan;
  readonly approval: unknown;
  readonly trust: unknown;
  readonly now: string;
}): BrandRoleProvisioningApproval {
  const approval = parseBrandRoleProvisioningApproval(input.approval),
    trust = parseStoreRoleProvisioningTrust(input.trust, brandRoleProvisioningPurpose),
    now = approvalInstant(input.now, unavailable),
    plan = input.plan;
  if (
    approval.environmentReference !== plan.environmentReference ||
    approval.operationReference !== plan.operationReference ||
    approval.brandReference !== plan.brandReference ||
    approval.operatorReference !== plan.operatorReference ||
    approval.planDigest !== brandRoleProvisioningPlanDigest(plan) ||
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
        Buffer.from(brandRoleProvisioningSigningBytes(approval), "utf8"),
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

/** Prepares the complete plan for the released Brand templates; the approver reviews and signs it. */
export function buildBrandRoleProvisioningPlan(input: {
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly operatorReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly catalogVersion: number;
  readonly catalogDigest: string;
  readonly previousCatalogVersion?: number | null;
  readonly ownerAssignment?: Omit<
    BrandRoleProvisioningOwnerAssignment,
    "assignmentReference"
  > | null;
  readonly existingRoles?: Readonly<
    Partial<
      Record<
        BrandRoleTemplateCode,
        { readonly roleReference: string; readonly administrationReference: string }
      >
    >
  >;
  readonly effectiveFrom: string;
  readonly reasonCode: string;
  readonly templates: readonly BrandRoleTemplateCode[];
  readonly nextReference: () => string;
}): BrandRoleProvisioningPlan {
  return parseBrandRoleProvisioningPlan({
    profile: "BrandRoleProvisioningPlanV1",
    purposeCode: brandRoleProvisioningPurpose,
    environmentReference: input.environmentReference,
    operationReference: input.operationReference,
    operatorReference: input.operatorReference,
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
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
      ...brandRoleTemplateProfiles[template],
      actions: [...brandRoleTemplateActions(template)],
    })),
  });
}
