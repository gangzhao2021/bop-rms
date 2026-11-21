import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { parseCatalogProductPublicationContent } from "../../contracts/product-publication-content.js";
import {
  buildProductTaxCoverageSource,
  productTaxCoverageSourceFields,
  productTaxCoverageSourceMaximumRoots,
  type ProductTaxCoverageSource,
  type ProductTaxCoverageEntry,
} from "../../contracts/product-tax-coverage-source.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import { loadProductRetirementCoverage } from "./product-scope-retirement-store.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
export interface ProductTaxCoverageSourceStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly transaction: ProductLifecycleTransaction;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: Readonly<{
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
        actorKind: "User";
        permission: "catalog.manage";
        owningActions: readonly [
          "catalog.product.read",
          "catalog.product.history.read",
          "catalog.sku.read",
        ];
        purposeCode: "CATALOG_PRODUCT_TAX_COVERAGE_READ";
        requiredFields: typeof productTaxCoverageSourceFields;
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<{ readonly validUntil: string }>;
  };
}
/** Complete Brand authoring/recorded inputs. Store applicability and sellability are not evaluated. */
export function createPostgresProductTaxCoverageSourceStore(
  options: ProductTaxCoverageSourceStoreOptions,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    store = parseCatalogReference(options.storeReference),
    actor = parseCatalogReference(options.actorReference);
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit;
  const origin = String(parseCatalogInstant(options.originalObservedAt)),
    originalUntil = String(parseCatalogInstant(options.originalValidUntil));
  let deadline = originalUntil,
    latest = origin,
    failed = false,
    active = false,
    registered = false,
    guardCalls = 0,
    finalCalls = 0,
    done = false;
  let phase: "Work" | "Checks" | "Final" = "Work",
    baseline: string | undefined;
  const fail = (
    code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new CatalogError(code);
  };
  if (
    [queryPort, nowPort, holdPort, registerPort].some((p) => typeof p !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  function unchanged() {
    return (
      options.transaction === tx &&
      tx.query === queryPort &&
      options.clock === clock &&
      clock.now === nowPort &&
      options.authority === authority &&
      authority.holdUntilTransactionCompletes === holdPort &&
      options.registerBeforeCommit === registerPort &&
      options.tenantReference === tenant &&
      options.brandReference === brand &&
      options.storeReference === store &&
      options.actorReference === actor &&
      options.originalObservedAt === origin &&
      options.originalValidUntil === originalUntil
    );
  }
  function check() {
    if (failed || !unchanged()) return fail();
    const at = String(parseCatalogInstant(nowPort.call(clock)));
    if (!unchanged() || at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  }
  async function query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
    const remain = String(Math.max(1, Date.parse(deadline) - Date.parse(check())));
    await tx.query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [remain],
    );
    check();
    const result = await tx.query<Row>(sql, values);
    check();
    return result;
  }
  // Private SQL kernel wrapper only; authority and registration always receive the actual host tx.
  const kernelTx: ProductLifecycleTransaction = { query };
  async function authorize() {
    const raw = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        actorReference: actor,
        actorKind: "User" as const,
        permission: "catalog.manage" as const,
        owningActions: Object.freeze([
          "catalog.product.read",
          "catalog.product.history.read",
          "catalog.sku.read",
        ] as const),
        purposeCode: "CATALOG_PRODUCT_TAX_COVERAGE_READ" as const,
        requiredFields: productTaxCoverageSourceFields,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    const parsed = copyCategoryPersistenceValue(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !Object.hasOwn(parsed, "validUntil")
    )
      return fail();
    const until = String(
      parseCatalogInstant(Object.getOwnPropertyDescriptor(parsed, "validUntil")?.value),
    );
    if (until < deadline) deadline = until;
    check();
  }
  async function load(): Promise<ProductTaxCoverageSource> {
    await authorize();
    await query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [tenant, brand],
    );
    const isolation = await query<{ isolation: string }>(
      "SELECT current_setting('transaction_isolation') AS isolation",
      [],
    );
    if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== "read committed")
      return fail();
    await holdProductSourceBarrier(kernelTx, brand);
    const loadObservedAt = check();
    const roots = await query<{
      product_id: string;
      aggregate_version: number;
      lifecycle: string;
      has_history: boolean;
    }>(
      `SELECT p.product_id::text,p.aggregate_version,p.lifecycle,EXISTS(SELECT 1 FROM rms_catalog.product_publication_revision r WHERE r.tenant_id=$1 AND r.brand_id=p.brand_id AND r.product_id=p.product_id) has_history FROM rms_catalog.product p WHERE p.brand_id=$2 ORDER BY p.product_id LIMIT ${productTaxCoverageSourceMaximumRoots + 1}`,
      [tenant, brand],
    );
    if (roots.rows.length > productTaxCoverageSourceMaximumRoots) return fail();
    const entries: ProductTaxCoverageEntry[] = [];
    for (const root of roots.rows) {
      const product = parseCatalogReference(root.product_id);
      if (typeof root.has_history !== "boolean") return fail();
      const rows = await query<{ snapshot: unknown; precise: boolean }>(productSnapshotSelectSql, [
        brand,
        product,
      ]);
      if (rows.rows.length !== 1) return fail();
      const row = rows.rows[0];
      if (!row) return fail();
      const rawAggregate = copyCategoryPersistenceValue(row.snapshot);
      const aggregate = parseProductAggregate(rawAggregate);
      if (canonicalizeRfc8785(rawAggregate) !== canonicalizeRfc8785(aggregate)) return fail();
      if (
        row &&
        (!row.precise ||
          !aggregate ||
          aggregate.productReference !== product ||
          aggregate.brandReference !== brand ||
          aggregate.aggregateVersion !== root.aggregate_version ||
          aggregate.lifecycle !== root.lifecycle)
      )
        return fail();
      const coverage = root.has_history
        ? await loadProductRetirementCoverage(kernelTx, {
            tenantReference: tenant,
            brandReference: brand,
            productReference: product,
            expectedAggregateVersion: root.aggregate_version,
            observedAt: loadObservedAt,
          })
        : null;
      // The roster's own EXISTS proof must agree with the complete history read.
      // An empty returned history cannot erase a recorded publication revision.
      if (root.has_history && coverage?.history.length === 0) return fail();
      const sealed = coverage
        ? await query<{ snapshot_json: unknown }>(
            "SELECT snapshot_json FROM rms_catalog.product_publication_content WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY product_version_id LIMIT 1001",
            [tenant, brand, product],
          )
        : { rows: [] };
      if (sealed.rows.length > 1000) return fail();
      const published = sealed.rows.map((row) => {
        const content = parseCatalogProductPublicationContent(
          copyCategoryPersistenceValue(row.snapshot_json),
        );
        if (
          content.tenantReference !== tenant ||
          content.brandReference !== brand ||
          content.productReference !== product ||
          !coverage?.history.some(
            (h) =>
              h.publication.versionReference === content.versionReference &&
              h.publication.contentDigest === content.contentDigest &&
              (h.publication.state === "Published" || h.publication.state === "Superseded"),
          )
        )
          return fail();
        return Object.freeze({
          versionReference: content.versionReference,
          sourceDigest: content.contentDigest,
          taxClassificationReference: content.sourceDraft.taxClassificationReference,
          skus: Object.freeze(
            content.sourceDraft.skus.map((s) =>
              Object.freeze({ skuReference: s.skuReference, lifecycle: s.lifecycle }),
            ),
          ),
        });
      });
      entries.push(
        Object.freeze({
          productReference: product,
          aggregateVersion: root.aggregate_version,
          productLifecycle: aggregate.lifecycle,
          draft: aggregate
            ? Object.freeze({
                versionReference: aggregate.draft.versionReference,
                sourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate)),
                taxClassificationReference: aggregate.draft.taxClassificationReference,
                skus: Object.freeze(
                  aggregate.draft.skus.map((s) =>
                    Object.freeze({ skuReference: s.skuReference, lifecycle: s.lifecycle }),
                  ),
                ),
              })
            : null,
          published: Object.freeze(published),
          publicationCoverage: coverage,
        }),
      );
      check();
    }
    await authorize();
    const missingClassifications = entries.flatMap((e) => [
      ...(e.draft && e.draft.taxClassificationReference === null
        ? [
            {
              productReference: e.productReference,
              versionReference: e.draft.versionReference,
              basis: "SavedDraftPreparation" as const,
            },
          ]
        : []),
      ...e.published
        .filter((p) => p.taxClassificationReference === null)
        .map((p) => ({
          productReference: e.productReference,
          versionReference: p.versionReference,
          basis: "RecordedPublishedGraphInputs" as const,
        })),
    ]);
    return buildProductTaxCoverageSource({
      profile: "ProductTaxCoverageSourceV1",
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      actorReference: actor,
      entries,
      completeness: missingClassifications.length ? "Incomplete" : "CompleteRecordedInputs",
      missingClassifications,
      observedAt: loadObservedAt,
      validUntil: deadline,
      sourceQualification: "NotEvaluated",
      sellability: "NotEvaluated",
    });
  }
  // Re-observation may advance, but complete roster and every immutable graph fact must stay identical.
  const identity = (source: ProductTaxCoverageSource) => source.sourceDigest;
  return Object.freeze({
    async readCurrent() {
      if (active || phase !== "Work") return fail();
      active = true;
      try {
        check();
        if (!registered) {
          registered = true;
          const result = await registerPort(
            tx,
            async () => {
              if (phase !== "Work" || active || ++guardCalls !== 1 || baseline === undefined)
                return fail();
              phase = "Checks";
              active = true;
              try {
                if (identity(await load()) !== baseline) return fail();
                check();
                done = true;
              } catch (error) {
                failed = true;
                if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
                  throw error;
                return fail();
              } finally {
                active = false;
              }
            },
            () => {
              if (phase !== "Checks" || active || !done || ++finalCalls !== 1) return fail();
              check();
              phase = "Final";
            },
          );
          if (result !== undefined) return fail();
          check();
        }
        const source = await load(),
          signature = identity(source);
        if (baseline !== undefined && baseline !== signature) return fail();
        baseline = signature;
        check();
        return source;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      } finally {
        active = false;
      }
    },
    assertFinalized(actual: ProductLifecycleTransaction) {
      if (
        actual !== tx ||
        phase !== "Final" ||
        active ||
        !done ||
        guardCalls !== 1 ||
        finalCalls !== 1
      )
        return fail();
      check();
      return deadline;
    },
  });
}
