import { createIdentityActor, readClosedRecord, type IdentityActor } from "@bop/identity";
import {
  createBrand,
  parseCanonicalInstant,
  type Brand,
  type CanonicalInstant,
} from "../domain/brand-store.js";
import { TenantContextContractError } from "./tenant-context.js";

/** Administrative identity only. Membership, permission and each command's
 * lifecycle rules remain owning admissions; this is never an operational scope. */
export interface BrandAdministrationContext {
  readonly profile: "BrandAdministrationContextV1";
  readonly actor: IdentityActor;
  readonly brand: Brand;
  readonly store: null;
  readonly purposeCode: "BRAND_ADMINISTRATION";
  readonly resolvedAt: CanonicalInstant;
}

export function createBrandAdministrationContext(
  actorInput: IdentityActor,
  brandInput: Brand,
  resolvedAtInput: unknown,
): BrandAdministrationContext {
  let resolvedAt: CanonicalInstant;
  try {
    resolvedAt = parseCanonicalInstant(resolvedAtInput);
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_INPUT_INVALID");
  }
  let actor: IdentityActor;
  try {
    actor = createIdentityActor(actorInput);
    if (
      actor.actorType !== "User" ||
      actor.accountKind !== "Workforce" ||
      actor.status !== "Active" ||
      actor.actorReference === null ||
      parseCanonicalInstant(actor.authenticatedAt) > resolvedAt ||
      (actor.recentMfaAt !== null && parseCanonicalInstant(actor.recentMfaAt) > resolvedAt)
    )
      throw new TenantContextContractError("TENANT_CONTEXT_ACTOR_INVALID");
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_ACTOR_INVALID");
  }
  let brand: Brand;
  try {
    brand = createBrand(brandInput);
    if (brand.updatedAt > resolvedAt)
      throw new TenantContextContractError("TENANT_CONTEXT_BRAND_DENIED");
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_BRAND_DENIED");
  }
  return Object.freeze({
    profile: "BrandAdministrationContextV1",
    actor,
    brand,
    store: null,
    purposeCode: "BRAND_ADMINISTRATION",
    resolvedAt,
  });
}

export function parseBrandAdministrationContext(value: unknown): BrandAdministrationContext {
  let r: Readonly<Record<string, unknown>>;
  try {
    r = readClosedRecord(value, [
      "profile",
      "actor",
      "brand",
      "store",
      "purposeCode",
      "resolvedAt",
    ]);
    if (
      r.profile !== "BrandAdministrationContextV1" ||
      r.store !== null ||
      r.purposeCode !== "BRAND_ADMINISTRATION"
    )
      throw new TenantContextContractError("TENANT_CONTEXT_INPUT_INVALID");
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_INPUT_INVALID");
  }
  // Own constructors parse the unknown nested values without assuming authority.
  let actor: IdentityActor, brand: Brand;
  try {
    actor = createIdentityActor(r.actor);
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_ACTOR_INVALID");
  }
  try {
    brand = createBrand(r.brand);
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_BRAND_DENIED");
  }
  return createBrandAdministrationContext(actor, brand, r.resolvedAt);
}
