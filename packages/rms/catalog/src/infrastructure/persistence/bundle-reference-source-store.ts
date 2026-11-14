import {
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  type CatalogProductWarningAcknowledgementReferenceRequest,
} from "../../contracts/product-warning-acknowledgement-reference-request.js";
import {
  productWarningAcknowledgementBundleReferenceSourceFields,
  buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
} from "../../contracts/bundle-reference-source.js";
import {
  parseCatalogProductPublicationReferenceRequestV2,
  type CatalogProductPublicationReferenceRequestV2,
} from "../../contracts/product-publication-reference-request-v2.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  bundleReferenceSourceFields,
  productPublicationBundleReferenceSourceFieldsV2,
  buildProductPublicationBundleReferenceSourceSnapshotV2,
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

export interface ProductPublicationBundleReferenceSourceOptionsV2 extends Omit<
  BundleReferenceSourceOptions,
  "authority"
> {
  readonly actorKind: "User" | "System";
  readonly registerBeforeCommit: (
    tx: BundleReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: BundleReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User" | "System";
        readonly request: CatalogProductPublicationReferenceRequestV2;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_BUNDLE_SOURCE_READ";
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productPublicationBundleReferenceSourceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Independent publication protocol over the same owning statement, generation
 * and writer barrier. Complete stored references do not establish sale eligibility. */
export interface ProductWarningAcknowledgementBundleReferenceSourceOptions extends Omit<
  BundleReferenceSourceOptions,
  "authority"
> {
  readonly actorKind: "User";
  readonly registerBeforeCommit: (
    tx: BundleReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: BundleReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User";
        readonly request: CatalogProductWarningAcknowledgementReferenceRequest;
        readonly purposeCode: "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_BUNDLE_SOURCE_READ";
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productWarningAcknowledgementBundleReferenceSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
export function createPostgresProductPublicationBundleReferenceSourceV2(
  options: ProductPublicationBundleReferenceSourceOptionsV2,
) {
  if (typeof options.authority?.holdUntilTransactionCompletes !== "function") return fail();
  const hold = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  return createBundleIntentReferenceSource(options, {
    parse: parseCatalogProductPublicationReferenceRequestV2,
    build: buildProductPublicationBundleReferenceSourceSnapshotV2,
    authorize: (tx, input) => {
      return hold(
        tx,
        Object.freeze({
          ...input,
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_BUNDLE_SOURCE_READ",
          requiredFields: productPublicationBundleReferenceSourceFieldsV2,
        }),
      );
    },
  });
}
export function createPostgresProductWarningAcknowledgementBundleReferenceSource(
  options: ProductWarningAcknowledgementBundleReferenceSourceOptions,
) {
  if (
    options.actorKind !== "User" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const hold = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  return createBundleIntentReferenceSource(options, {
    poisonInvalidRequest: true,
    parse: parseCatalogProductWarningAcknowledgementReferenceRequest,
    build: buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
    authorize: (tx, input) => {
      if (input.actorKind !== "User") return fail();
      return hold(
        tx,
        Object.freeze({
          ...input,
          actorKind: "User",
          purposeCode: "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_BUNDLE_SOURCE_READ",
          requiredFields: productWarningAcknowledgementBundleReferenceSourceFields,
        }),
      );
    },
  });
}

function createBundleIntentReferenceSource<
  Request extends
    | CatalogProductPublicationReferenceRequestV2
    | CatalogProductWarningAcknowledgementReferenceRequest,
  Snapshot extends { readonly generation: string },
>(
  options: Omit<ProductPublicationBundleReferenceSourceOptionsV2, "authority">,
  protocol: {
    readonly poisonInvalidRequest?: true;
    parse(value: unknown): Request;
    build(value: unknown, request: Request, now: string): Snapshot;
    authorize(
      tx: BundleReferenceTransaction,
      input: Omit<
        Parameters<
          ProductPublicationBundleReferenceSourceOptionsV2["authority"]["holdUntilTransactionCompletes"]
        >[1],
        "request" | "purposeCode" | "requiredFields"
      > & { readonly request: Request },
    ): Promise<void>;
  },
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof protocol.authorize !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    authority = protocol.authorize,
    register = options.registerBeforeCommit.bind(options),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const rejectEntry = async (): Promise<never> => {
    await run(async (tx) => {
      if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
      failed.add(tx);
      await register(
        tx,
        async () => fail(),
        () => {
          fail();
        },
      );
      return fail();
    });
    return fail();
  };
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: Request,
      work: (snapshot: Snapshot, tx: BundleReferenceTransaction) => Promise<T>,
    ): Promise<T> {
      let calls = 0,
        completed: { readonly value: T } | undefined,
        transaction: BundleReferenceTransaction | undefined,
        poisoned = false,
        finalCheck: (() => void) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        let request: Request;
        try {
          request = protocol.parse(input);
          if (
            typeof work !== "function" ||
            request.command.tenantReference !== tenant ||
            request.command.brandReference !== brand ||
            request.command.actorReference !== actor ||
            request.command.actorKind !== kind
          )
            return fail();
        } catch (error) {
          if (protocol.poisonInvalidRequest) return rejectEntry();
          throw error;
        }
        const result = await run(async (tx) => {
          if (++calls !== 1 || !tx || typeof tx !== "object" || typeof tx.query !== "function")
            return poison();
          transaction = tx;
          // A caught nested refusal must taint this actual enclosing transaction.
          if (active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          const originalQuery = tx.query,
            queryPort = originalQuery.bind(tx);
          let latest = request.observedAt,
            ready = false,
            guardCalls = 0,
            source: Snapshot | undefined;
          const check = () => {
            let at: string;
            try {
              at = parseCatalogInstant(now());
            } catch {
              return poison();
            }
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== originalQuery ||
              at < latest ||
              at >= request.validUntil
            )
              return poison();
            latest = at;
            return at;
          };
          const assertFinal = () => {
            if (!ready || !source) return poison();
            check();
          };
          finalCheck = assertFinal;
          const query: BundleReferenceTransaction["query"] = async <
            R extends Record<string, unknown>,
          >(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            const result = await queryPort<R>(sql, values);
            check();
            return result;
          };
          const authorize = async () => {
            const observedAt = check();
            if (
              (await authority(
                tx,
                Object.freeze({
                  tenantReference: tenant,
                  actorKind: kind,
                  request,
                  permission: "catalog.manage",
                  requiredScope: "FullBrandScope",
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          const context = () =>
            query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          const verifyGeneration = async () => {
            if (!source) return poison();
            await context();
            const current = row(
              await query(
                "SELECT COALESCE((SELECT generation::text FROM rms_catalog.bundle_reference_generation WHERE brand_id=$1),'0') AS generation",
                [brand],
              ),
              "generation",
            );
            if (current !== source.generation) return poison();
          };
          try {
            // Install before the first holder/read/clock check: a swallowed
            // early failure must still poison the enclosing transaction.
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1) return poison();
                    assertFinal();
                    await authorize();
                    await verifyGeneration();
                    assertFinal();
                  } catch (error) {
                    poisoned = true;
                    failed.add(tx);
                    throw error;
                  }
                },
                assertFinal,
              )) !== undefined
            )
              return poison();
            check();
            await authorize();
            if (
              row(
                await query("SELECT current_setting('transaction_isolation') AS isolation", []),
                "isolation",
              ) !== "read committed"
            )
              return poison();
            await context();
            await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "CatalogBundleReferenceV1:" + brand,
            ]);
            source = protocol.build(row(await query(select, [brand]), "source"), request, check());
            await authorize();
            const value = await work(source, tx);
            check();
            await authorize();
            await verifyGeneration();
            check();
            ready = true;
            completed = Object.freeze({ value });
            return completed;
          } catch (error) {
            poisoned = true;
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (
          poisoned ||
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !transaction ||
          failed.has(transaction) ||
          !finalCheck
        )
          return poison();
        finalCheck();
        return completed.value;
      } catch (error) {
        if (transaction) failed.add(transaction);
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
