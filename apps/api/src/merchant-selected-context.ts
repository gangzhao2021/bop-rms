import {
  createPostgresBrowserSessionSelectionStore,
  parseCanonicalInstant,
  type AuthenticationSession,
} from "@bop/identity";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
  parseBrandReference,
  parseStoreReference,
} from "@bop/tenant";
type SelectionTransaction = Parameters<
  ReturnType<typeof createPostgresBrowserSessionSelectionStore>["read"]
>[0];

/** The current Tenant association validator is mandatory; persisted choice is not a grant. */
export function createMerchantSelectedContext(options: {
  now(): string;
  validateSelection: Parameters<typeof createPostgresBrowserSessionSelectionStore>[0]["validate"];
}) {
  const selections = createPostgresBrowserSessionSelectionStore({
    validate: options.validateSelection,
  });
  return async (tx: SelectionTransaction, session: AuthenticationSession) => {
    try {
      const observedAt = parseCanonicalInstant(options.now());
      const selected = await selections.read(tx, session, observedAt);
      if (!selected) throw new Error("unbound");
      const organizations = createPostgresMerchantOrganizationSource(tx, {
        ...selected,
        observedAt,
      });
      const brand = await organizations.getBrand(parseBrandReference(selected.brandReference));
      const store = await organizations.getStore(parseStoreReference(selected.storeReference));
      if (!brand || !store) throw new Error("unavailable");
      return Object.freeze({
        tenantReference: selected.tenantReference,
        context: createTenantContext(session.actor, brand, store, observedAt),
      });
    } catch {
      throw new Error("MERCHANT_SELECTED_CONTEXT_UNAVAILABLE");
    }
  };
}
