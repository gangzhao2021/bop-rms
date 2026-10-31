/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Stores this installation serves, as Tenant/Brand/Store
 * scopes, the installation's own Store first. Every Store is of the installation's Tenant and Brand.
 * `resources.servedStoreReferences` lists the other Stores (absent: a single-Store installation, as
 * before). Never derived from a request.
 */
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function servedStoresOf(resources) {
  const tenantReference = resources.publicProfile?.binding?.tenantReference,
    brandReference = resources.scope?.brandReference,
    primary = resources.scope?.storeReference;
  const others = resources.servedStoreReferences ?? [];
  const references = [primary, ...others];
  if (
    !Array.isArray(others) ||
    others.length > 99 ||
    [tenantReference, brandReference, ...references].some(
      (value) => typeof value !== "string" || !referencePattern.test(value),
    ) ||
    new Set(references).size !== references.length
  )
    throw new Error("INTERNAL_SERVED_STORES_INVALID");
  return Object.freeze(
    references.map((storeReference) =>
      Object.freeze({ tenantReference, brandReference, storeReference }),
    ),
  );
}
/** The served Store this selection names, or null (another Tenant, Brand or an unserved Store). */
export function servedStoreFor(resources, selected) {
  return (
    servedStoresOf(resources).find(
      (store) =>
        selected?.tenantReference === store.tenantReference &&
        selected?.brandReference === store.brandReference &&
        selected?.storeReference === store.storeReference,
    ) ?? null
  );
}
