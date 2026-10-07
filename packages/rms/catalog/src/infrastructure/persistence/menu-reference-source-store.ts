import {
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  type CatalogProductWarningAcknowledgementReferenceRequest,
} from "../../contracts/product-warning-acknowledgement-reference-request.js";
import {
  productWarningAcknowledgementMenuReferenceSourceFields,
  buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
} from "../../contracts/menu-reference-source.js";
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
  menuReferenceSourceFields,
  productPublicationMenuReferenceSourceFieldsV2,
  buildProductPublicationMenuReferenceSourceSnapshotV2,
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

export interface ProductPublicationMenuReferenceSourceOptionsV2 extends Omit<
  MenuReferenceSourceOptions,
  "authority"
> {
  readonly actorKind: "User" | "System";
  readonly registerBeforeCommit: (
    tx: MenuReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MenuReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User" | "System";
        readonly request: CatalogProductPublicationReferenceRequestV2;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_MENU_SOURCE_READ";
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productPublicationMenuReferenceSourceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Independent publication protocol over the same owning statement, generation
 * and writer barrier. Complete stored references do not establish sale eligibility. */
export interface ProductWarningAcknowledgementMenuReferenceSourceOptions extends Omit<
  MenuReferenceSourceOptions,
  "authority"
> {
  readonly actorKind: "User";
  readonly registerBeforeCommit: (
    tx: MenuReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MenuReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User";
        readonly request: CatalogProductWarningAcknowledgementReferenceRequest;
        readonly purposeCode: "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_MENU_SOURCE_READ";
        readonly permission: "catalog.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productWarningAcknowledgementMenuReferenceSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
export function createPostgresProductPublicationMenuReferenceSourceV2(
  options: ProductPublicationMenuReferenceSourceOptionsV2,
) {
  if (typeof options.authority?.holdUntilTransactionCompletes !== "function") return fail();
  const hold = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  return createMenuIntentReferenceSource(options, {
    parse: parseCatalogProductPublicationReferenceRequestV2,
    build: buildProductPublicationMenuReferenceSourceSnapshotV2,
    authorize: (tx, input) => {
      return hold(
        tx,
        Object.freeze({
          ...input,
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_MENU_SOURCE_READ",
          requiredFields: productPublicationMenuReferenceSourceFieldsV2,
        }),
      );
    },
  });
}
export function createPostgresProductWarningAcknowledgementMenuReferenceSource(
  options: ProductWarningAcknowledgementMenuReferenceSourceOptions,
) {
  if (
    options.actorKind !== "User" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const hold = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  return createMenuIntentReferenceSource(options, {
    poisonInvalidRequest: true,
    parse: parseCatalogProductWarningAcknowledgementReferenceRequest,
    build: buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
    authorize: (tx, input) => {
      if (input.actorKind !== "User") return fail();
      return hold(
        tx,
        Object.freeze({
          ...input,
          actorKind: "User",
          purposeCode: "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_MENU_SOURCE_READ",
          requiredFields: productWarningAcknowledgementMenuReferenceSourceFields,
        }),
      );
    },
  });
}

function createMenuIntentReferenceSource<
  Request extends
    | CatalogProductPublicationReferenceRequestV2
    | CatalogProductWarningAcknowledgementReferenceRequest,
  Snapshot extends { readonly generation: string },
>(
  options: Omit<ProductPublicationMenuReferenceSourceOptionsV2, "authority">,
  protocol: {
    readonly poisonInvalidRequest?: true;
    parse(value: unknown): Request;
    build(value: unknown, request: Request, now: string): Snapshot;
    authorize(
      tx: MenuReferenceTransaction,
      input: Omit<
        Parameters<
          ProductPublicationMenuReferenceSourceOptionsV2["authority"]["holdUntilTransactionCompletes"]
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
      work: (snapshot: Snapshot, tx: MenuReferenceTransaction) => Promise<T>,
    ): Promise<T> {
      let calls = 0,
        completed: { readonly value: T } | undefined,
        transaction: MenuReferenceTransaction | undefined,
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
          const query: MenuReferenceTransaction["query"] = async <
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
                "SELECT COALESCE((SELECT generation::text FROM rms_catalog.menu_reference_generation WHERE brand_id=$1),'0') AS generation",
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
              "CatalogMenuReferenceV1:" + brand,
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
