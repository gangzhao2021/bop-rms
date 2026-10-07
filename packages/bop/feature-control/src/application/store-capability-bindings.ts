import { parseBrandReference, parseStoreReference } from "@bop/tenant";
import { parseFeatureControlInstant } from "../contracts/feature-control.js";
import {
  parseStoreCapabilityKey,
  StoreCapabilityUnavailableError,
  type CurrentStoreCapabilityPorts,
  type StoreCapabilityBinding,
} from "./current-store-capability.js";

/** Repository-owned naming configuration, not a Store enablement or Phase grant.
 * Keys are explicit: no caller key is rewritten into an owning control key. */
export const productStoreCapabilityBindings: readonly StoreCapabilityBinding[] = Object.freeze([
  Object.freeze({
    capabilityKey: "catalog.cat_product_create",
    controlKey: "catalog.product.create",
    mappingReference: "019a0024-2421-7000-8000-000000000001",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_product_detail",
    controlKey: "catalog.product.detail",
    mappingReference: "019a0024-2421-7000-8000-000000000002",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_product_edit",
    controlKey: "catalog.product.edit",
    mappingReference: "019a0024-2421-7000-8000-000000000003",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "organization.store_capability",
    controlKey: "organization.store.capability",
    mappingReference: "019a0024-2421-7000-8000-000000000004",
    mappingVersion: 1,
    phase: "phase_2",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_product_list",
    controlKey: "catalog.product.list",
    mappingReference: "019a0024-2421-7000-8000-000000000005",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_sku_detail",
    controlKey: "catalog.sku.detail",
    mappingReference: "019a0024-2421-7000-8000-000000000006",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
]);

/** Section 88 Option Set pages have their own controls. These mappings supply
 * neither enabled definitions nor permission or publication eligibility. */
export const optionSetStoreCapabilityBindings: readonly StoreCapabilityBinding[] = Object.freeze([
  Object.freeze({
    capabilityKey: "catalog.cat_optionset_create",
    controlKey: "catalog.optionset.create",
    mappingReference: "019a0024-2421-7000-8000-000000000007",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_optionset_detail",
    controlKey: "catalog.optionset.detail",
    mappingReference: "019a0024-2421-7000-8000-000000000008",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_optionset_edit",
    controlKey: "catalog.optionset.edit",
    mappingReference: "019a0024-2421-7000-8000-000000000009",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "catalog.cat_optionset_list",
    controlKey: "catalog.optionset.list",
    mappingReference: "019a0024-2421-7000-8000-00000000000a",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
]);

export function createOptionSetStoreCapabilityBindings(): CurrentStoreCapabilityPorts["bindings"] {
  return Object.freeze({
    async withCurrentBinding(input, work) {
      parseBrandReference(input.brandReference);
      parseStoreReference(input.storeReference);
      parseFeatureControlInstant(input.observedAt);
      const key = parseStoreCapabilityKey(input.capabilityKey);
      const binding = optionSetStoreCapabilityBindings.find((row) => row.capabilityKey === key);
      if (!binding) throw new StoreCapabilityUnavailableError();
      return work(binding);
    },
  });
}

/** Immutable for the lifetime of this composition. Replacing this catalog requires
 * a new reviewed build/version; actual definitions and dependencies remain current
 * owner sources held through the consumer and transaction. */
export function createProductStoreCapabilityBindings(): CurrentStoreCapabilityPorts["bindings"] {
  return Object.freeze({
    async withCurrentBinding(input, work) {
      parseBrandReference(input.brandReference);
      parseStoreReference(input.storeReference);
      parseFeatureControlInstant(input.observedAt);
      const key = parseStoreCapabilityKey(input.capabilityKey);
      const binding = productStoreCapabilityBindings.find((row) => row.capabilityKey === key);
      if (!binding) throw new StoreCapabilityUnavailableError();
      return work(binding);
    },
  });
}

/** Complete owner definitions can prove that no dependencies were declared.
 * This supplies no receipt for a declared dependency or Future Trigger. */
export function createEmptyStoreCapabilityDependencySource(): CurrentStoreCapabilityPorts["dependencies"] {
  return Object.freeze({
    async withCurrentEvidence(input, work) {
      parseBrandReference(input.brandReference);
      parseStoreReference(input.storeReference);
      parseFeatureControlInstant(input.observedAt);
      if (!Array.isArray(input.dependencies) || input.dependencies.length !== 0)
        throw new StoreCapabilityUnavailableError();
      return work(Object.freeze([]));
    },
  });
}

/** Section 88 Pricing page mappings are naming configuration only. Current
 * owning definitions and Pricing permission still decide admission. */
export const pricingStoreCapabilityBindings: readonly StoreCapabilityBinding[] = Object.freeze([
  Object.freeze({
    capabilityKey: "pricing.tax_config",
    controlKey: "pricing.taxconfig.authoring",
    mappingReference: "019a0024-2421-7000-8000-00000000000d",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "pricing.price_book_list",
    controlKey: "pricing.pricebook.list",
    mappingReference: "019a0024-2421-7000-8000-00000000000b",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
  Object.freeze({
    capabilityKey: "pricing.price_book_editor",
    controlKey: "pricing.pricebook.editor",
    mappingReference: "019a0024-2421-7000-8000-00000000000c",
    mappingVersion: 1,
    phase: "phase_1",
    commitment: "Committed",
  }),
]);
export function createPricingStoreCapabilityBindings(): CurrentStoreCapabilityPorts["bindings"] {
  return Object.freeze({
    async withCurrentBinding(input, work) {
      parseBrandReference(input.brandReference);
      parseStoreReference(input.storeReference);
      parseFeatureControlInstant(input.observedAt);
      const key = parseStoreCapabilityKey(input.capabilityKey);
      const binding = pricingStoreCapabilityBindings.find((row) => row.capabilityKey === key);
      if (!binding) throw new StoreCapabilityUnavailableError();
      return work(binding);
    },
  });
}

/** Registered Brand list/detail naming only; current definitions and Brand permission decide admission. */
export const organizationStoreCapabilityBindings: readonly StoreCapabilityBinding[] = Object.freeze(
  [
    Object.freeze({
      capabilityKey: "organization.org_brand_detail",
      controlKey: "organization.brand.detail",
      mappingReference: "019a0024-2421-7000-8000-00000000000e",
      mappingVersion: 1,
      phase: "phase_1a",
      commitment: "Committed",
    }),
    Object.freeze({
      capabilityKey: "organization.org_brand_list",
      controlKey: "organization.brand.list",
      mappingReference: "019a0024-2421-7000-8000-00000000000f",
      mappingVersion: 1,
      phase: "phase_1a",
      commitment: "Committed",
    }),
  ],
);
export function createOrganizationStoreCapabilityBindings(): CurrentStoreCapabilityPorts["bindings"] {
  return Object.freeze({
    async withCurrentBinding(input, work) {
      parseBrandReference(input.brandReference);
      parseStoreReference(input.storeReference);
      parseFeatureControlInstant(input.observedAt);
      const key = parseStoreCapabilityKey(input.capabilityKey);
      const binding = organizationStoreCapabilityBindings.find((row) => row.capabilityKey === key);
      if (!binding) throw new StoreCapabilityUnavailableError();
      return work(binding);
    },
  });
}
