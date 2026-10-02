import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  bundleReferenceSourceFields,
  bundleReferenceSourceMaximumRows,
  parseBundleReferenceSourceRequest,
  buildBundleReferenceSourceSnapshot,
  type BundleReferenceSourceRequest,
  type BundleReferenceSourceSnapshot,
} from "../../contracts/bundle-reference-source.js";
export interface BundleReferenceTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}
export interface BundleReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: BundleReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: BundleReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: BundleReferenceSourceRequest;
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof bundleReferenceSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function row(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  if (!Array.isArray(rows) || rows.length !== 1) return fail();
  const entry = Object.getOwnPropertyDescriptor(rows, "0")?.value;
  if (
    !entry ||
    Object.getPrototypeOf(entry) !== Object.prototype ||
    Reflect.ownKeys(entry).length !== 1
  )
    return fail();
  const d = Object.getOwnPropertyDescriptor(entry, key);
  if (!d?.enumerable || !("value" in d)) return fail();
  return d.value;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT jsonb_build_object(
 'generation',(SELECT generation::text FROM rms_catalog.bundle_reference_generation WHERE brand_id=$1),
 'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
 'counts',jsonb_build_object('bundles',(SELECT count(*)::text FROM rms_catalog.bundle WHERE brand_id=$1),'versions',(SELECT count(*)::text FROM rms_catalog.bundle_version WHERE brand_id=$1),'groups',(SELECT count(*)::text FROM rms_catalog.bundle_component_group WHERE brand_id=$1),'members',(SELECT count(*)::text FROM rms_catalog.bundle_component_sellable WHERE brand_id=$1)),
 'bundles',(SELECT COALESCE(jsonb_agg(value ORDER BY bundle_id),'[]'::jsonb) FROM (SELECT bundle_id,jsonb_build_object('bundleReference',bundle_id,'brandReference',brand_id,'aggregateVersion',aggregate_version,'lifecycle',lifecycle,'currentVersionReference',current_version_id,'updatedAt',${utc("updated_at")},'precise',date_trunc('milliseconds',updated_at)=updated_at AND updated_at<=statement_timestamp()) value FROM rms_catalog.bundle WHERE brand_id=$1 ORDER BY bundle_id LIMIT ${bundleReferenceSourceMaximumRows + 1}) bounded),
 'versions',(SELECT COALESCE(jsonb_agg(value ORDER BY bundle_version_id),'[]'::jsonb) FROM (SELECT bundle_version_id,jsonb_build_object('bundleVersionReference',bundle_version_id,'bundleReference',bundle_id,'brandReference',brand_id,'versionStatus',status,'versionUpdatedAt',${utc("updated_at")},'publishedAt',${utc("published_at")},'validationDigest',validation_digest,'precise',date_trunc('milliseconds',created_at)=created_at AND date_trunc('milliseconds',updated_at)=updated_at AND updated_at<=statement_timestamp() AND (published_at IS NULL OR date_trunc('milliseconds',published_at)=published_at)) value FROM rms_catalog.bundle_version WHERE brand_id=$1 ORDER BY bundle_version_id LIMIT ${bundleReferenceSourceMaximumRows + 1}) bounded),
 'groups',(SELECT COALESCE(jsonb_agg(value ORDER BY group_id),'[]'::jsonb) FROM (SELECT group_id,jsonb_build_object('groupReference',group_id,'bundleVersionReference',bundle_version_id,'bundleReference',bundle_id,'brandReference',brand_id) value FROM rms_catalog.bundle_component_group WHERE brand_id=$1 ORDER BY group_id LIMIT ${bundleReferenceSourceMaximumRows + 1}) bounded),
 'members',(SELECT COALESCE(jsonb_agg(value ORDER BY group_id,sellable_id),'[]'::jsonb) FROM (SELECT group_id,sellable_id,jsonb_build_object('groupReference',group_id,'bundleVersionReference',bundle_version_id,'bundleReference',bundle_id,'brandReference',brand_id,'sellableType',sellable_type,'sellableReference',sellable_id) value FROM rms_catalog.bundle_component_sellable WHERE brand_id=$1 ORDER BY group_id,sellable_id LIMIT ${bundleReferenceSourceMaximumRows + 1}) bounded)) source`;
/** Supported Bundle writers are fenced through caller COMMIT. Callback must not mutate
 * Bundle source graphs; bind the runner to the caller UoW after the owning Product holder. */
export function createPostgresBundleReferenceSourceStore(options: BundleReferenceSourceOptions) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: BundleReferenceSourceRequest,
      work: (snapshot: BundleReferenceSourceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseBundleReferenceSourceRequest(input);
        if (request.brandReference !== brand || request.actorReference !== actor) return fail();
        let calls = 0,
          completed: { readonly value: T } | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                permission: "catalog.manage",
                requiredScope: "FullBrandScope",
                requiredFields: bundleReferenceSourceFields,
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          await authorize();
          if (
            row(
              await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
              "isolation",
            ) !== "read committed"
          )
            return fail();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [brand],
          );
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
            "CatalogBundleReferenceV1:" + brand,
          ]);
          const source = buildBundleReferenceSourceSnapshot(
            row(await tx.query(select, [brand]), "source"),
            request,
            options.clock.now(),
          );
          await authorize();
          completed = Object.freeze({ value: await work(source) });
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brand],
          );
          const current = row(
            await tx.query(
              "SELECT COALESCE((SELECT generation::text FROM rms_catalog.bundle_reference_generation WHERE brand_id=$1),'0') AS generation",
              [brand],
            ),
            "generation",
          );
          if (current !== source.generation) return fail();
          const at = parseCatalogInstant(options.clock.now());
          if (at < source.observedAt || Date.parse(at) - Date.parse(source.observedAt) > 5000)
            return fail();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
