import {
  createBrand,
  createStore,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
} from "../../domain/brand-store.js";
import type { TenantOrganizationPort } from "../../application/ports/tenant-organization-port.js";
export interface MerchantOrganizationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const unavailable = (): never => {
  throw new Error("MERCHANT_ORGANIZATION_UNAVAILABLE");
};
function one(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return unavailable();
  return d.value[0] ?? null;
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return value.toISOString();
}
/** Internal owner read. Trusted selected scope is required; this is not Store discovery
 * or permission evidence. Caller resolves session, Membership and Permission separately. */
export function createPostgresMerchantOrganizationSource(
  tx: MerchantOrganizationTransaction,
  scope: { brandReference: string; storeReference: string; observedAt: string },
): Pick<TenantOrganizationPort, "getBrand" | "getStore"> {
  const brand = parseBrandReference(scope.brandReference),
    store = parseStoreReference(scope.storeReference);
  const observedAt = parseCanonicalInstant(scope.observedAt);
  async function setScope(storeReference: string) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      storeReference,
    ]);
  }
  return Object.freeze({
    async getBrand(reference) {
      try {
        if (reference !== brand) return unavailable();
        await setScope("");
        const row = one(
          await tx.query("SELECT * FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE", [brand]),
        );
        await setScope(store);
        if (!row) return null;
        if (row.brand_id !== brand) return unavailable();
        const result = createBrand({
          brandReference: row.brand_id,
          code: row.code,
          displayName: row.display_name,
          defaultLocale: row.default_locale,
          currencyCode: row.currency_code,
          lifecycle: row.lifecycle,
          version: row.version,
          createdAt: at(row.created_at),
          updatedAt: at(row.updated_at),
        });
        if (result.lifecycle !== "Active" || result.updatedAt > observedAt) return unavailable();
        return result;
      } catch {
        return unavailable();
      }
    },
    async getStore(reference) {
      try {
        if (reference !== store) return unavailable();
        await setScope(store);
        const row = one(
          await tx.query(
            "SELECT * FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2 FOR SHARE",
            [brand, store],
          ),
        );
        if (!row) return null;
        if (row.brand_id !== brand || row.store_id !== store) return unavailable();
        const result = createStore({
          storeReference: row.store_id,
          brandReference: row.brand_id,
          code: row.code,
          displayName: row.display_name,
          timeZone: row.time_zone,
          locale: row.locale,
          currencyCode: row.currency_code,
          lifecycle: row.lifecycle,
          version: row.version,
          createdAt: at(row.created_at),
          updatedAt: at(row.updated_at),
        });
        if (result.lifecycle !== "Active" || result.updatedAt > observedAt) return unavailable();
        return result;
      } catch {
        return unavailable();
      }
    },
  });
}
