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
]);

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
