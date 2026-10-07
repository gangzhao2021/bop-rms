import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  brandRoleProvisioningPlanDigest,
  brandRoleProvisioningSigningBytes,
  buildBrandRoleProvisioningPlan,
  buildStoreRoleProvisioningPlan,
  provisionBrandRoles,
  permissionCatalogDigest,
  provisionStoreRoles,
  storePermissionCatalogVersion,
  storeRoleProvisioningPlanDigest,
  storeRoleProvisioningSigningBytes,
  synchronizePermissionCatalog,
} from "../../bop/permission/src/index.ts";
import {
  confirmBrandMemberScope,
  confirmStoreMemberScope,
} from "../../bop/membership/src/index.ts";
import { confirmStoreOpeningScope } from "../../bop/tenant/src/index.ts";

/**
 * Test-only: installs the catalog and opens a synthetic Store's template roles through the real
 * signed provisioning path, using a key pair generated for the test. `admin` is an isolated-database
 * owner client; the Store, Membership and StoreAssignment rows must already exist.
 */
export async function openSyntheticStoreRoles(admin, input) {
  const { tenant, brand, store, operator, approver, at, next, owner } = input;
  await admin.query("BEGIN");
  await synchronizePermissionCatalog(admin, {
    operationReference: next(),
    operatorReference: operator,
    approvedByReference: approver,
    approvalEvidenceReference: next(),
    auditReference: next(),
    occurredAt: at,
    nextPermissionReference: next,
  });
  await admin.query("COMMIT");
  const environment = next(),
    keyReference = next();
  const plan = buildStoreRoleProvisioningPlan({
    environmentReference: environment,
    operationReference: next(),
    operatorReference: operator,
    tenantReference: tenant,
    brandReference: brand,
    storeReference: store,
    catalogVersion: storePermissionCatalogVersion,
    catalogDigest: permissionCatalogDigest(),
    ownerAssignment: owner ?? null,
    effectiveFrom: at,
    reasonCode: "STORE_OPENING",
    templates: ["owner", "store-manager", "front-of-house", "kitchen", "inventory-manager"],
    nextReference: next,
  });
  const keys = generateKeyPairSync("ed25519");
  const unsigned = {
    profile: "StoreRoleProvisioningApprovalV1",
    purposeCode: "STORE_ROLE_PROVISIONING",
    environmentReference: environment,
    operationReference: plan.operationReference,
    storeReference: store,
    planDigest: storeRoleProvisioningPlanDigest(plan),
    operatorReference: operator,
    approvedByReference: approver,
    approvalEvidenceReference: next(),
    notBefore: new Date(Date.parse(at) - 3_600_000).toISOString(),
    validUntil: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
    keyReference,
  };
  const approval = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(storeRoleProvisioningSigningBytes(unsigned), "utf8"),
      keys.privateKey,
    ).toString("base64url"),
  };
  const trust = {
    profile: "StoreRoleProvisioningTrustV1",
    keys: [
      {
        keyReference,
        approvedByReference: approver,
        environmentReference: environment,
        purposeCode: "STORE_ROLE_PROVISIONING",
        notBefore: unsigned.notBefore,
        validUntil: unsigned.validUntil,
        publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
    ],
    revokedApprovalEvidenceReferences: [],
  };
  await admin.query("BEGIN");
  try {
    const result = await provisionStoreRoles(admin, plan, {
      clock: { now: () => at },
      readApprovalMaterial: async () => ({ approval, trust }),
      storeScope: { confirm: confirmStoreOpeningScope },
      memberScope: { confirm: confirmStoreMemberScope },
      nextReference: next,
    });
    await admin.query("COMMIT");
    return { plan, result };
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

/**
 * Test-only: opens a synthetic Brand's template roles (DEC-PERM-BRAND-ROLES) through the real signed
 * provisioning path with a test key pair. The catalog must already be installed and the Brand
 * Owner's Membership must exist.
 */
export async function openSyntheticBrandRoles(admin, input) {
  const { tenant, brand, operator, approver, at, next, owner } = input;
  const environment = next(),
    keyReference = next();
  const plan = buildBrandRoleProvisioningPlan({
    environmentReference: environment,
    operationReference: next(),
    operatorReference: operator,
    tenantReference: tenant,
    brandReference: brand,
    catalogVersion: storePermissionCatalogVersion,
    catalogDigest: permissionCatalogDigest(),
    ownerAssignment: owner ?? null,
    effectiveFrom: at,
    reasonCode: "BRAND_ROLE_OPENING",
    templates: ["brand-owner", "recipe-developer", "recipe-reviewer"],
    nextReference: next,
  });
  const keys = generateKeyPairSync("ed25519");
  const unsigned = {
    profile: "BrandRoleProvisioningApprovalV1",
    purposeCode: "BRAND_ROLE_PROVISIONING",
    environmentReference: environment,
    operationReference: plan.operationReference,
    brandReference: brand,
    planDigest: brandRoleProvisioningPlanDigest(plan),
    operatorReference: operator,
    approvedByReference: approver,
    approvalEvidenceReference: next(),
    notBefore: new Date(Date.parse(at) - 3_600_000).toISOString(),
    validUntil: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
    keyReference,
  };
  const approval = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(brandRoleProvisioningSigningBytes(unsigned), "utf8"),
      keys.privateKey,
    ).toString("base64url"),
  };
  const trust = {
    profile: "StoreRoleProvisioningTrustV1",
    keys: [
      {
        keyReference,
        approvedByReference: approver,
        environmentReference: environment,
        purposeCode: "BRAND_ROLE_PROVISIONING",
        notBefore: unsigned.notBefore,
        validUntil: unsigned.validUntil,
        publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
    ],
    revokedApprovalEvidenceReferences: [],
  };
  await admin.query("BEGIN");
  try {
    const result = await provisionBrandRoles(admin, plan, {
      clock: { now: () => at },
      readApprovalMaterial: async () => ({ approval, trust }),
      memberScope: { confirm: confirmBrandMemberScope },
      nextReference: next,
    });
    await admin.query("COMMIT");
    return { plan, result, approval, trust };
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
