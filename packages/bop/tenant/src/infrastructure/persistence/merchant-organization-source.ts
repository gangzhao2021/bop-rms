import { readClosedRecord } from "@bop/identity";
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

/** Actual Active Brand identity without a selected Store. The Brand is the
 * Tenant identity for this path; rows do not prove Membership or permission. */
export function createPostgresCurrentBrandOrganizationSource(
  tx: MerchantOrganizationTransaction,
  input: { readonly brandReference: string; readonly observedAt: string },
): Pick<TenantOrganizationPort, "getBrand"> {
  return brandOrganizationSource(tx, input, false);
}

/** Actual administrative Brand identity, retaining its recorded lifecycle.
 * This source supplies no Membership, permission or Store authority. */
export function createPostgresBrandAdministrationOrganizationSource(
  tx: MerchantOrganizationTransaction,
  input: { readonly brandReference: string; readonly observedAt: string },
): Pick<TenantOrganizationPort, "getBrand"> {
  return brandOrganizationSource(tx, input, true);
}

function brandOrganizationSource(
  tx: MerchantOrganizationTransaction,
  input: { readonly brandReference: string; readonly observedAt: string },
  administrative: boolean,
): Pick<TenantOrganizationPort, "getBrand"> {
  const scope = readClosedRecord(input, ["brandReference", "observedAt"]);
  const brand = parseBrandReference(scope.brandReference);
  const observedAt = parseCanonicalInstant(scope.observedAt);
  const original = tx.query;
  let failed = false,
    active = false;
  const check = () => {
    if (failed || tx.query !== original || typeof original !== "function") return unavailable();
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const value = await original.call(tx, sql, values);
    check();
    return value;
  };
  return Object.freeze({
    async getBrand(reference) {
      try {
        if (active || reference !== brand) return unavailable();
        active = true;
        await query(
          administrative
            ? "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)"
            : "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [brand],
        );
        const response = await query(
          `SELECT brand_id,code,display_name,default_locale,currency_code,lifecycle,version,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
            created_at=date_trunc('milliseconds',created_at)
              AND updated_at=date_trunc('milliseconds',updated_at) AS precise
            FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE`,
          [brand],
        );
        const rows =
          response && typeof response === "object"
            ? Object.getOwnPropertyDescriptor(response, "rows")
            : undefined;
        if (
          !rows ||
          !("value" in rows) ||
          !Array.isArray(rows.value) ||
          Object.getPrototypeOf(rows.value) !== Array.prototype ||
          rows.value.length > 1 ||
          Reflect.ownKeys(rows.value).length !== rows.value.length + 1
        )
          return unavailable();
        if (rows.value.length === 0) return null;
        const entry = Object.getOwnPropertyDescriptor(rows.value, "0");
        if (!entry?.enumerable || !("value" in entry)) return unavailable();
        const row = readClosedRecord(entry.value, [
          "brand_id",
          "code",
          "display_name",
          "default_locale",
          "currency_code",
          "lifecycle",
          "version",
          "created_at",
          "updated_at",
          "precise",
        ]);
        if (row.brand_id !== brand || row.precise !== true) return unavailable();
        const result = createBrand({
          brandReference: row.brand_id,
          code: row.code,
          displayName: row.display_name,
          defaultLocale: row.default_locale,
          currencyCode: row.currency_code,
          lifecycle: row.lifecycle,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        if ((!administrative && result.lifecycle !== "Active") || result.updatedAt > observedAt)
          return unavailable();
        check();
        return result;
      } catch {
        failed = true;
        return unavailable();
      } finally {
        active = false;
      }
    },
  });
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
