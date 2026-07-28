import { createIdentityActor, type IdentityActor } from "@bop/identity";
import {
  createBrand,
  createStore,
  parseCanonicalInstant,
  type Brand,
  type CanonicalInstant,
  type Store,
} from "../domain/brand-store.js";

export const tenantContextErrorCodes = [
  "TENANT_CONTEXT_INPUT_INVALID",
  "TENANT_CONTEXT_ACTOR_INVALID",
  "TENANT_CONTEXT_BRAND_DENIED",
  "TENANT_CONTEXT_STORE_DENIED",
] as const;
export type TenantContextErrorCode = (typeof tenantContextErrorCodes)[number];

const safeMessages: Readonly<Record<TenantContextErrorCode, string>> = {
  TENANT_CONTEXT_INPUT_INVALID: "tenant context input is invalid",
  TENANT_CONTEXT_ACTOR_INVALID: "tenant context actor is invalid",
  TENANT_CONTEXT_BRAND_DENIED: "tenant context brand is denied",
  TENANT_CONTEXT_STORE_DENIED: "tenant context store is denied",
};

export class TenantContextContractError extends Error {
  readonly code: TenantContextErrorCode;

  constructor(code: TenantContextErrorCode) {
    super(safeMessages[code]);
    this.name = "TenantContextContractError";
    this.code = code;
  }
}

export const tenantScopeKinds = ["Brand", "Store"] as const;
export type TenantScopeKind = (typeof tenantScopeKinds)[number];

export interface TenantContext {
  readonly actor: IdentityActor;
  readonly brand: Brand;
  readonly store: Store | null;
  readonly scopeKind: TenantScopeKind;
  readonly resolvedAt: CanonicalInstant;
}

function workforceActor(input: IdentityActor): IdentityActor {
  try {
    const actor = createIdentityActor(input);
    if (
      actor.actorType !== "User" ||
      actor.accountKind !== "Workforce" ||
      actor.actorReference === null
    )
      throw new TenantContextContractError("TENANT_CONTEXT_ACTOR_INVALID");
    return actor;
  } catch (error) {
    if (error instanceof TenantContextContractError) throw error;
    throw new TenantContextContractError("TENANT_CONTEXT_ACTOR_INVALID");
  }
}

function activeBrand(input: Brand): Brand {
  try {
    const brand = createBrand(input);
    if (brand.lifecycle !== "Active")
      throw new TenantContextContractError("TENANT_CONTEXT_BRAND_DENIED");
    return brand;
  } catch (error) {
    if (error instanceof TenantContextContractError) throw error;
    throw new TenantContextContractError("TENANT_CONTEXT_BRAND_DENIED");
  }
}

function activeStore(input: Store, brand: Brand): Store {
  try {
    const store = createStore(input);
    if (store.lifecycle !== "Active" || store.brandReference !== brand.brandReference)
      throw new TenantContextContractError("TENANT_CONTEXT_STORE_DENIED");
    return store;
  } catch (error) {
    if (error instanceof TenantContextContractError) throw error;
    throw new TenantContextContractError("TENANT_CONTEXT_STORE_DENIED");
  }
}

export function createTenantContext(
  actorInput: IdentityActor,
  brandInput: Brand,
  storeInput: Store | null,
  resolvedAtInput: unknown,
): TenantContext {
  const actor = workforceActor(actorInput);
  const brand = activeBrand(brandInput);
  const store = storeInput === null ? null : activeStore(storeInput, brand);
  let resolvedAt: CanonicalInstant;
  try {
    resolvedAt = parseCanonicalInstant(resolvedAtInput);
  } catch {
    throw new TenantContextContractError("TENANT_CONTEXT_INPUT_INVALID");
  }
  return Object.freeze({
    actor,
    brand,
    store,
    scopeKind: store === null ? "Brand" : "Store",
    resolvedAt,
  });
}
