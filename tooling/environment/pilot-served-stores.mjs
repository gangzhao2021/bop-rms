import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { planPilotConnections } from "./pilot-connection-budget.mjs";
/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Stores this installation serves, as Tenant/Brand/Store
 * scopes, the installation's own Store first. DEC-MULTI-MERCHANT-ONE-INSTALLATION: each is of its own
 * Tenant and Brand. `resources.servedStores` lists the other Stores (absent: a single-Store
 * installation, as before). Never derived from a request.
 */
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function servedStoresOf(resources) {
  const others = resources.servedStores ?? [];
  if (!Array.isArray(others) || others.length > 99)
    throw new Error("INTERNAL_SERVED_STORES_INVALID");
  const stores = [servedScopeOf(resources), ...others];
  if (
    stores.some((store) =>
      [store?.tenantReference, store?.brandReference, store?.storeReference].some(
        (value) => typeof value !== "string" || !referencePattern.test(value),
      ),
    ) ||
    new Set(stores.map((store) => store.storeReference)).size !== stores.length
  )
    throw new Error("INTERNAL_SERVED_STORES_INVALID");
  return Object.freeze(
    stores.map(({ tenantReference, brandReference, storeReference }) =>
      Object.freeze({ tenantReference, brandReference, storeReference }),
    ),
  );
}
/** This composition's own Store as a Tenant/Brand/Store scope. */
export function servedScopeOf(resources) {
  return {
    tenantReference: resources.publicProfile?.binding?.tenantReference,
    brandReference: resources.scope?.brandReference,
    storeReference: resources.scope?.storeReference,
  };
}
/** The served Store this selection names, or null (a Store this installation does not serve). */
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

/**
 * The Store a staff member works in: the one named, or without a name the first served Store where
 * they are associated, so a person of another merchant signs in to their own merchant's Store.
 * WP-2423 item 10: without a name, a Store BOP paused or closed (`isOpen` false) is passed over for
 * the next one they work in, so closing one location never locks its owner out of the others. Only
 * when every Store they work in is closed is the first of them chosen, and its selection says so.
 */
export function createServedStoreTarget({ served, validateAssociation, isOpen, now }) {
  return async (tx, authenticated, reference) => {
    const candidates =
      reference === undefined
        ? served
        : served.filter((store) => store.storeReference === reference);
    let closed = null;
    for (const store of candidates) {
      const at = now();
      if (!(await validateAssociation(tx, authenticated, store, at))) continue;
      if (reference !== undefined || isOpen === undefined || (await isOpen(tx, store, at)))
        return store;
      closed ??= store;
    }
    if (closed !== null) return closed;
    throw new Error("INTERNAL_MERCHANT_SCOPE_DENIED");
  };
}

/**
 * Whether the Store and its Brand are Active, by their owner's read (@bop/tenant), in the caller's
 * transaction; the caller's own Store scope is put back after. A read that fails throws as itself.
 */
export async function servedStoreIsOpen(tx, store, at) {
  const [prior] = (
    await tx.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )
  ).rows;
  // Loaded here, not at the top: pilot-ops imports this file, and its maintenance command runs under
  // plain node (runbook "Planned updates"), which cannot load the TypeScript source.
  const { createPostgresMerchantOrganizationSource } =
    await import("../../packages/bop/tenant/src/index.ts");
  const organizations = createPostgresMerchantOrganizationSource(tx, {
    brandReference: store.brandReference,
    storeReference: store.storeReference,
    observedAt: at,
  });
  let open;
  try {
    open =
      (await organizations.getBrand(store.brandReference)) !== null &&
      (await organizations.getStore(store.storeReference)) !== null;
  } catch (error) {
    if (error?.message !== "MERCHANT_ORGANIZATION_NOT_ACTIVE_DENIED") throw error;
    open = false;
  }
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    prior?.brand ?? "",
    prior?.store ?? "",
  ]);
  return open;
}

/**
 * `stores.json` in the installation directory: {"schemaVersion":1,"stores":["stores/<name>",…]},
 * each a Store runtime directory below this one. Absent: this installation serves one Store.
 */
export async function loadServedStoreDirectories(directory) {
  let text;
  try {
    text = await readFile(path.join(directory, "stores.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw Error("PILOT_HTTPS_STORES_INVALID", { cause: error });
  }
  const value = JSON.parse(text);
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "schemaVersion,stores" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.stores) ||
    value.stores.length > 99 ||
    new Set(value.stores).size !== value.stores.length ||
    value.stores.some(
      (entry) => typeof entry !== "string" || !/^stores\/[a-z0-9][a-z0-9-]{0,62}$/u.test(entry),
    )
  )
    throw Error("PILOT_HTTPS_STORES_INVALID");
  return Object.freeze([...value.stores]);
}

/**
 * WP-2423 (2026-11-02): which Stores can be served within the role's connections, and the rest.
 * The installation's Store always runs; a Store that doesn't fit is named and not started, and the
 * others keep their service (one bad Store never stops the others, 2026-10-31).
 */
export function admitServedStores(relatives, limit) {
  if (limit === null) return Object.freeze({ admitted: relatives, refused: Object.freeze([]) });
  const { admittedStores } = planPilotConnections({ storeCount: 1 + relatives.length, limit });
  const others = Math.max(admittedStores - 1, 0);
  return Object.freeze({
    admitted: Object.freeze(relatives.slice(0, others)),
    refused: Object.freeze(relatives.slice(others)),
  });
}
export const PILOT_CONNECTION_BUDGET_EXCEEDED = "PILOT_CONNECTION_BUDGET_EXCEEDED";
/** One line per refused Store, with what would admit it. Names and numbers only. */
export function reportConnectionBudget(
  refused,
  limit,
  write = (line) => process.stderr.write(line),
) {
  for (const store of refused)
    write(
      JSON.stringify({
        level: 50,
        event: PILOT_CONNECTION_BUDGET_EXCEEDED,
        store,
        roleLimit: limit,
      }) + "\n",
    );
}
