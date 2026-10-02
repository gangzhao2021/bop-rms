import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  availabilityReferenceSourceFields,
  availabilityReferenceSourceMaximumRows,
  parseAvailabilityReferenceSourceRequest,
  buildAvailabilityReferenceSourceSnapshot,
  type AvailabilityReferenceSourceRequest,
  type AvailabilityReferenceSourceSnapshot,
} from "../../contracts/availability-reference-source.js";
export interface AvailabilityReferenceTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}
export interface AvailabilityReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: AvailabilityReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: AvailabilityReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: AvailabilityReferenceSourceRequest;
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof availabilityReferenceSourceFields;
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
const select = `SELECT jsonb_build_object('generation',(SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1),'rootCount',(SELECT count(*)::text FROM rms_catalog.availability_rule WHERE brand_id=$1),'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'rules',(SELECT COALESCE(jsonb_agg(value ORDER BY availability_rule_id),'[]'::jsonb) FROM (SELECT availability_rule_id,jsonb_build_object('ruleReference',availability_rule_id,'brandReference',brand_id,'sellableType',sellable_type,'sellableReference',COALESCE(product_id,sku_id,bundle_id),'storeReference',store_id,'aggregateVersion',aggregate_version,'lifecycle',lifecycle,'effectiveFrom',${utc("effective_from")},'effectiveUntil',${utc("effective_until")},'updatedAt',${utc("updated_at")},'precise',date_trunc('milliseconds',effective_from)=effective_from AND (effective_until IS NULL OR date_trunc('milliseconds',effective_until)=effective_until) AND date_trunc('milliseconds',updated_at)=updated_at) value FROM rms_catalog.availability_rule WHERE brand_id=$1 ORDER BY availability_rule_id LIMIT ${availabilityReferenceSourceMaximumRows + 1}) bounded)) source`;
/** Supported rule writers are fenced through caller COMMIT. Callback must not mutate
 * Availability rules; bind the runner to the caller UoW after the owning Product holder. */
export function createPostgresAvailabilityReferenceSourceStore(
  options: AvailabilityReferenceSourceOptions,
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: AvailabilityReferenceSourceRequest,
      work: (snapshot: AvailabilityReferenceSourceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseAvailabilityReferenceSourceRequest(input);
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
                requiredFields: availabilityReferenceSourceFields,
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
            "CatalogAvailabilityReferenceV1:" + brand,
          ]);
          const source = buildAvailabilityReferenceSourceSnapshot(
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
              "SELECT COALESCE((SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1),'0') AS generation",
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
