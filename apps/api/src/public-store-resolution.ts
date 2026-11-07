import {
  createPostgresMerchantOrganizationSource,
  parseCanonicalInstant,
  type MerchantOrganizationTransaction,
} from "@bop/tenant";
import {
  parseGetPublicStoreRequest,
  parsePublicStoreResolutionEvidence,
  parseStoreAdministrationReference,
  type PublicStoreResolutionPort,
} from "@rms/store";

export interface ConfiguredPublicStoreBinding {
  readonly tenantReference: string;
  readonly publicStoreReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly lookupEvidenceReference: string;
  readonly validFrom: string;
  readonly validUntil: string;
}

/** Server-configured binding, not discovery or browser-selected internal scope.
 * Caller retains the transaction through dependent profile reads. Authorization
 * must establish current binding, Tenant association and the requested public purpose.
 * The Tenant reader supplies facts only; no Merchant permission is borrowed.
 */
export function createConfiguredPublicStoreResolution(options: {
  transaction: MerchantOrganizationTransaction;
  binding: ConfiguredPublicStoreBinding;
  authorize(
    transaction: MerchantOrganizationTransaction,
    binding: Readonly<ConfiguredPublicStoreBinding>,
    request: Readonly<{ evaluatedAt: string; purpose: "CustomerEntry" | "CustomerCart" }>,
  ): Promise<boolean>;
}): PublicStoreResolutionPort {
  const parsed = parsePublicStoreResolutionEvidence({
    publicStoreReference: options.binding.publicStoreReference,
    brandReference: options.binding.brandReference,
    storeReference: options.binding.storeReference,
    lookupEvidenceReference: options.binding.lookupEvidenceReference,
    validUntil: options.binding.validUntil,
    brandLifecycle: "Draft",
    storeLifecycle: "Draft",
  });
  const binding = Object.freeze({
    tenantReference: parseStoreAdministrationReference(options.binding.tenantReference),
    publicStoreReference: parsed.publicStoreReference,
    brandReference: parsed.brandReference,
    storeReference: parsed.storeReference,
    lookupEvidenceReference: parsed.lookupEvidenceReference,
    validFrom: parseCanonicalInstant(options.binding.validFrom),
    validUntil: parsed.validUntil,
  });
  if (binding.validFrom >= binding.validUntil) throw new Error("PUBLIC_STORE_BINDING_INVALID");
  const tx = options.transaction;
  const authorize = options.authorize;
  return Object.freeze({
    async resolve(input: Parameters<PublicStoreResolutionPort["resolve"]>[0]) {
      try {
        // Add the irrelevant locale only after checking the exact resolution shape.
        if (
          !input ||
          typeof input !== "object" ||
          Reflect.ownKeys(input).length !== 3 ||
          !["publicStoreReference", "evaluatedAt", "purpose"].every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            return descriptor && "value" in descriptor;
          })
        )
          return null;
        const request = parseGetPublicStoreRequest({ ...input, requestedLocale: "en-CA" });
        if (
          request.publicStoreReference !== binding.publicStoreReference ||
          request.evaluatedAt < binding.validFrom ||
          request.evaluatedAt >= binding.validUntil
        )
          return null;
        const purpose = Object.freeze({
          evaluatedAt: request.evaluatedAt,
          purpose: request.purpose,
        });
        if (!(await authorize(tx, binding, purpose))) return null;
        const owner = createPostgresMerchantOrganizationSource(tx, {
          brandReference: binding.brandReference,
          storeReference: binding.storeReference,
          observedAt: request.evaluatedAt,
        });
        const brand = await owner.getBrand(parsed.brandReference);
        const store = await owner.getStore(parsed.storeReference);
        if (!brand || !store || !(await authorize(tx, binding, purpose))) return null;
        return parsePublicStoreResolutionEvidence({
          publicStoreReference: binding.publicStoreReference,
          brandReference: brand.brandReference,
          storeReference: store.storeReference,
          brandLifecycle: brand.lifecycle,
          storeLifecycle: store.lifecycle,
          lookupEvidenceReference: binding.lookupEvidenceReference,
          validUntil: binding.validUntil,
        });
      } catch {
        return null;
      }
    },
  });
}
