import { createHash } from "node:crypto";
import { parseBrandReference } from "../../domain/brand-store.js";
import {
  maximumTenantStoreReferences,
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
  parseTenantStoreLabelReferenceSnapshot,
  type TenantStoreLabelReferenceSnapshot,
  type TenantStoreReferenceRequest,
  type TenantStoreReferenceSnapshot,
} from "../../contracts/store-reference-source.js";
export interface TenantStoreReferenceTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const unavailable = (): never => {
  throw new Error("TENANT_STORE_REFERENCE_UNAVAILABLE");
};
function rows(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > maximum)
    return unavailable();
  return d.value as Record<string, unknown>[];
}
/** Consistency fingerprint of the closed V1 metadata, never authorization evidence. */
export function tenantStoreReferenceDigest(input: TenantStoreReferenceSnapshot): string {
  const snapshot = parseTenantStoreReferenceSnapshot(input);
  return "sha256:" + createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
export interface TenantStoreReferenceSourceOptions {
  readonly brandReference: string;
  readonly transactions: {
    /** Own a READ COMMITTED transaction through COMMIT; no callback may commit independently. */
    run<T>(work: (tx: TenantStoreReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    /** Hold actual session, Membership, Phase, Brand scope and complete unmasked
     * field/permission coverage through work including its transaction COMMIT.
     * An accessible subset of Stores is insufficient. No default authority. */
    withCurrentBrandReferenceRead<T>(
      request: TenantStoreReferenceRequest,
      work: () => Promise<T>,
    ): Promise<T>;
    isCurrent(
      tx: TenantStoreReferenceTransaction,
      request: TenantStoreReferenceRequest,
    ): Promise<boolean>;
  };
}
/** Complete registered identities; association eligibility/tax coverage are separate.
 * Advisory read fence is the same transaction-scoped key used by both owner root
 * triggers. It needs no projection write privilege or private Store enumeration. */
export function createPostgresTenantStoreReferenceSource(
  options: TenantStoreReferenceSourceOptions,
) {
  const brand = parseBrandReference(options.brandReference);
  async function heldSnapshot<T>(
    tx: TenantStoreReferenceTransaction,
    request: TenantStoreReferenceRequest,
    work: (snapshot: TenantStoreReferenceSnapshot) => Promise<T>,
  ): Promise<T> {
    const authorize = async () => {
      if ((await options.authority.isCurrent(tx, request)) !== true) return unavailable();
    };
    const isolation = rows(await tx.query("SHOW transaction_isolation", []), 1)[0];
    if (isolation?.transaction_isolation !== "read committed") return unavailable();
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
      "TenantStoreReferenceV1:" + brand,
    ]);
    const brandRows = rows(
      await tx.query(
        `SELECT brand_id,lifecycle,version::text,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
            updated_at=date_trunc('milliseconds',updated_at) AS precise
            FROM bop_tenant.brand WHERE brand_id=$1`,
        [brand],
      ),
      1,
    );
    const currentBrand = brandRows[0];
    if (
      !currentBrand ||
      currentBrand.brand_id !== brand ||
      currentBrand.precise !== true ||
      typeof currentBrand.updated_at !== "string" ||
      currentBrand.updated_at > request.observedAt
    )
      return unavailable();
    const headRows = rows(
      await tx.query(
        "SELECT brand_id,generation::text,reference_count::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
        [brand],
      ),
      1,
    );
    const head = headRows[0];
    if (!head || head.brand_id !== brand) return unavailable();
    const references = rows(
      await tx.query(
        `SELECT brand_id,store_id,lifecycle,version::text,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
            created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise
            FROM bop_tenant.store_reference_projection WHERE brand_id=$1 ORDER BY store_id LIMIT $2`,
        [brand, maximumTenantStoreReferences + 1],
      ),
      maximumTenantStoreReferences,
    );
    const snapshot = parseTenantStoreReferenceSnapshot({
      profile: "TenantStoreReferenceV1",
      brandReference: brand,
      brandLifecycle: currentBrand.lifecycle,
      brandVersion: currentBrand.version,
      generation: head.generation,
      referenceCount: head.reference_count,
      originalIntentDigest: request.originalIntentDigest,
      observedAt: request.observedAt,
      references: references.map((r) => {
        if (r.brand_id !== brand || r.precise !== true) return unavailable();
        return {
          storeReference: r.store_id,
          lifecycle: r.lifecycle,
          version: r.version,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      }),
    });
    await authorize();
    const result = await work(snapshot);
    await authorize();
    const finalHead = rows(
      await tx.query(
        "SELECT brand_id,generation::text,reference_count::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
        [brand],
      ),
      1,
    )[0];
    if (
      !finalHead ||
      finalHead.brand_id !== brand ||
      finalHead.generation !== snapshot.generation ||
      finalHead.reference_count !== snapshot.referenceCount
    )
      return unavailable();
    return result;
  }
  return Object.freeze({
    async withCurrentLabelSnapshot<T>(
      input: TenantStoreReferenceRequest,
      work: (snapshot: TenantStoreLabelReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseTenantStoreReferenceRequest(input);
        if (request.brandReference !== brand) return unavailable();
        return await options.authority.withCurrentBrandReferenceRead(request, () =>
          options.transactions.run(async (tx) => {
            const queryPort = tx.query;
            let poisoned = false;
            const check = () => {
              if (poisoned || tx.query !== queryPort) {
                poisoned = true;
                return unavailable();
              }
            };
            const result = await heldSnapshot(tx, request, async (metadata) => {
              const readLabels = async () => {
                check();
                const response = await queryPort.call(
                  tx,
                  `SELECT brand_id,store_id,lifecycle,version::text,
                to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
                created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) AS precise,
                code,display_name FROM bop_tenant.store_reference_projection WHERE brand_id=$1 ORDER BY store_id LIMIT $2`,
                  [brand, maximumTenantStoreReferences + 1],
                );
                check();
                const rowDescriptor =
                  response && typeof response === "object"
                    ? Object.getOwnPropertyDescriptor(response, "rows")
                    : undefined;
                if (
                  !rowDescriptor ||
                  !("value" in rowDescriptor) ||
                  !Array.isArray(rowDescriptor.value) ||
                  Object.getPrototypeOf(rowDescriptor.value) !== Array.prototype ||
                  rowDescriptor.value.length > maximumTenantStoreReferences ||
                  Reflect.ownKeys(rowDescriptor.value).length !== rowDescriptor.value.length + 1
                )
                  return unavailable();
                const rawRows: unknown[] = rowDescriptor.value;
                const projected = Array.from({ length: rawRows.length }, (_, i) => {
                  const d = Object.getOwnPropertyDescriptor(rawRows, String(i));
                  if (!d?.enumerable || !("value" in d)) return unavailable();
                  return d.value;
                });
                const labels = parseTenantStoreLabelReferenceSnapshot({
                  ...metadata,
                  profile: "TenantStoreLabelReferenceV1",
                  references: projected.map((value) => {
                    const keys = [
                      "brand_id",
                      "store_id",
                      "lifecycle",
                      "version",
                      "created_at",
                      "updated_at",
                      "precise",
                      "code",
                      "display_name",
                    ];
                    if (
                      !value ||
                      Object.getPrototypeOf(value) !== Object.prototype ||
                      Reflect.ownKeys(value).length !== keys.length
                    )
                      return unavailable();
                    const r: Record<string, unknown> = {};
                    for (const key of keys) {
                      const d = Object.getOwnPropertyDescriptor(value, key);
                      if (!d?.enumerable || !("value" in d)) return unavailable();
                      r[key] = d.value;
                    }
                    if (r.brand_id !== brand || r.precise !== true) return unavailable();
                    return {
                      storeReference: r.store_id,
                      lifecycle: r.lifecycle,
                      version: r.version,
                      createdAt: r.created_at,
                      updatedAt: r.updated_at,
                      code: r.code,
                      displayName: r.display_name,
                    };
                  }),
                });
                const old = parseTenantStoreReferenceSnapshot({
                  ...labels,
                  profile: "TenantStoreReferenceV1",
                  references: labels.references.map(({ code, displayName, ...reference }) => {
                    void code;
                    void displayName;
                    return reference;
                  }),
                });
                if (JSON.stringify(old) !== JSON.stringify(metadata)) return unavailable();
                return labels;
              };
              const labels = await readLabels(),
                fingerprint = JSON.stringify(labels);
              const result = await work(labels);
              check();
              if (JSON.stringify(await readLabels()) !== fingerprint) return unavailable();
              check();
              return result;
            });
            check();
            return result;
          }),
        );
      } catch {
        return unavailable();
      }
    },
    async withCurrentSnapshot<T>(
      input: TenantStoreReferenceRequest,
      work: (snapshot: TenantStoreReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseTenantStoreReferenceRequest(input);
        if (request.brandReference !== brand) return unavailable();
        return await options.authority.withCurrentBrandReferenceRead(request, () =>
          options.transactions.run((tx) => heldSnapshot(tx, request, work)),
        );
      } catch {
        return unavailable();
      }
    },
  });
}
