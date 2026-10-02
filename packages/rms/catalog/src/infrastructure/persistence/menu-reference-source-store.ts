import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  menuReferenceSourceFields,
  menuReferenceSourceMaximumRows,
  parseMenuReferenceSourceRequest,
  buildMenuReferenceSourceSnapshot,
  type MenuReferenceSourceRequest,
  type MenuReferenceSourceSnapshot,
} from "../../contracts/menu-reference-source.js";
export interface MenuReferenceTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}
export interface MenuReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: MenuReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MenuReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: MenuReferenceSourceRequest;
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof menuReferenceSourceFields;
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
const sourceLimit = menuReferenceSourceMaximumRows + 1;
const safeArray = (sql: string) =>
  `CASE WHEN jsonb_typeof(${sql})='array' THEN ${sql} ELSE '[]'::jsonb END`;
const placementFrom = `rms_catalog.menu_review_content c CROSS JOIN LATERAL jsonb_array_elements(${safeArray("c.snapshot_json#>'{content,sections}'")}) section CROSS JOIN LATERAL jsonb_array_elements(${safeArray("section->'sellables'")}) placement`;
const bounded = (columns: string, from: string, order: string) =>
  `(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object(${columns}) value FROM ${from} WHERE c.brand_id=$1 ORDER BY ${order} LIMIT ${sourceLimit}) bounded)`;
const select = `SELECT jsonb_build_object(
 'generation',(SELECT generation::text FROM rms_catalog.menu_reference_generation WHERE brand_id=$1),
 'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
 'counts',jsonb_build_object('reviews',(SELECT count(*)::text FROM rms_catalog.menu_review_content WHERE brand_id=$1),'placements',(SELECT count(*)::text FROM ${placementFrom} WHERE c.brand_id=$1),'revisions',(SELECT count(*)::text FROM rms_catalog.menu_publication_revision WHERE brand_id=$1),'releases',(SELECT count(*)::text FROM rms_catalog.menu_publication_release WHERE brand_id=$1),'periods',(SELECT count(*)::text FROM rms_catalog.menu_release_effective_period WHERE brand_id=$1)),
 'reviews',${bounded("'reviewReference',c.lifecycle_id,'brandReference',c.brand_id,'menuReference',c.menu_id,'menuVersionReference',c.menu_version_id,'snapshotDigest',c.snapshot_digest,'createdAt',c.snapshot_json->>'createdAt','precise',jsonb_typeof(c.snapshot_json#>'{content,sections}')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(" + safeArray("c.snapshot_json#>'{content,sections}'") + ") section WHERE jsonb_typeof(section->'sellables') IS DISTINCT FROM 'array')", "rms_catalog.menu_review_content c", "c.lifecycle_id")},
 'placements',${bounded("'reviewReference',c.lifecycle_id,'sectionReference',section->'sectionReference','placementReference',placement->'placementReference','skuReference',placement->'sellableReference','productVersionReference',placement->'productVersionReference'", placementFrom, "c.lifecycle_id,placement->>'placementReference'")},
 'revisions',${bounded("'reviewReference',c.lifecycle_id,'brandReference',c.brand_id,'menuReference',c.menu_id,'menuVersionReference',c.menu_version_id,'snapshotDigest',c.snapshot_digest,'lifecycleVersion',c.lifecycle_version,'state',c.state,'changedAt'," + utc("c.changed_at") + ",'precise',date_trunc('milliseconds',c.changed_at)=c.changed_at AND c.changed_at<=statement_timestamp()", "rms_catalog.menu_publication_revision c", "c.lifecycle_id,c.lifecycle_version")},
 'releases',${bounded("'releaseReference',c.release_id,'reviewReference',c.lifecycle_id,'brandReference',c.brand_id,'menuReference',c.menu_id,'menuVersionReference',c.menu_version_id,'snapshotDigest',c.snapshot_digest,'lifecycleVersion',c.lifecycle_version,'releaseSequence',c.release_sequence,'previousReleaseReference',c.previous_release_id,'releaseKind',c.release_kind,'createdAt'," + utc("c.created_at") + ",'precise',date_trunc('milliseconds',c.created_at)=c.created_at AND c.created_at<=statement_timestamp()", "rms_catalog.menu_publication_release c", "c.release_id")},
 'periods',${bounded("'timingReference',c.timing_version_id,'releaseReference',c.release_id,'brandReference',c.brand_id,'menuReference',c.menu_id,'timeZone',c.time_zone,'effectiveFrom'," + utc("c.effective_from") + ",'effectiveUntil'," + utc("c.effective_until") + ",'periodDigest',c.period_digest,'createdAt'," + utc("c.created_at") + ",'precise',date_trunc('milliseconds',c.created_at)=c.created_at AND c.created_at<=statement_timestamp() AND date_trunc('milliseconds',c.effective_from)=c.effective_from AND (c.effective_until IS NULL OR date_trunc('milliseconds',c.effective_until)=c.effective_until)", "rms_catalog.menu_release_effective_period c", "c.timing_version_id")}) source`;
/** Supported Menu writers are fenced through caller COMMIT. Callback must not mutate
 * Menu sources or acquire per-Menu publication writer locks; bind the runner to the caller UoW after the owning Product holder. */
export function createPostgresMenuReferenceSourceStore(options: MenuReferenceSourceOptions) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: MenuReferenceSourceRequest,
      work: (snapshot: MenuReferenceSourceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseMenuReferenceSourceRequest(input);
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
                requiredFields: menuReferenceSourceFields,
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
            "CatalogMenuReferenceV1:" + brand,
          ]);
          const source = buildMenuReferenceSourceSnapshot(
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
              "SELECT COALESCE((SELECT generation::text FROM rms_catalog.menu_reference_generation WHERE brand_id=$1),'0') AS generation",
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
