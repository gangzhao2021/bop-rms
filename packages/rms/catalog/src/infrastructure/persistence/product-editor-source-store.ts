import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import { parseProductPublicationSourceRequest } from "../../contracts/product-publication-source.js";
import {
  buildCatalogProductEditorSnapshot,
  productEditorSnapshotFields,
  type CatalogProductEditorSnapshot,
} from "../../contracts/product-editor-snapshot.js";
import {
  createPostgresProductLifecycleStore,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import type { ProductCategoryAssignmentAuthority } from "./product-category-assignment.js";

export interface ProductEditorSourceAuthority {
  /** Current read purpose, complete fields and actor scope remain held through
   * outer COMMIT. This interface does not create a policy or provider. */
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly productReference: string;
      readonly purposeCode: "CATALOG_PRODUCT_EDITOR_READ";
      readonly permission: "catalog.manage";
      readonly owningAction: "catalog.product.manage";
      readonly requiredFields: typeof productEditorSnapshotFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export function createPostgresProductEditorSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: ProductEditorSourceAuthority;
  readonly categoryAssignments?: ProductCategoryAssignmentAuthority;
  readonly clock: { now(): string };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.clock?.now !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const run = options.transactions.run.bind(options.transactions),
    now = options.clock.now.bind(options.clock),
    authority = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    categories =
      options.categoryAssignments === undefined
        ? undefined
        : {
            holdUntilTransactionCompletes:
              options.categoryAssignments.holdUntilTransactionCompletes.bind(
                options.categoryAssignments,
              ),
          };
  return Object.freeze({
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User" as const,
    }),
    async withCurrentSnapshot<T>(
      value: unknown,
      work: (source: CatalogProductEditorSnapshot, tx: ProductLifecycleTransaction) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseProductPublicationSourceRequest(value),
          observedAt = parseCatalogInstant(now()),
          validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
        let calls = 0,
          finished = false,
          completed: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (at < observedAt || at >= validUntil) return fail();
        };
        const result = await run(async (tx) => {
          if (++calls !== 1) return fail();
          const hold = async () => {
            check();
            await authority(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                actorKind: "User" as const,
                productReference: request.productReference,
                purposeCode: "CATALOG_PRODUCT_EDITOR_READ" as const,
                permission: "catalog.manage" as const,
                owningAction: "catalog.product.manage" as const,
                requiredFields: productEditorSnapshotFields,
                observedAt: parseCatalogInstant(now()),
              }),
            );
            check();
          };
          await hold();
          const isolation = await tx.query<{ isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation",
            [],
          );
          if (isolation.rows.length !== 1 || isolation.rows.at(0)?.isolation !== "read committed")
            return fail();
          await tx.query(
            "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true),set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const reader = createPostgresProductLifecycleStore({
            brandReference: brand,
            transactions: { run: (callback) => callback(tx) },
            authorize: async (actual, input) => {
              if (
                actual !== tx ||
                input.productReference !== request.productReference ||
                input.record !== undefined
              )
                return fail();
              await hold();
              return true;
            },
            ...(categories === undefined ? {} : { categoryAssignments: categories }),
            editorContentAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                if (
                  actual !== tx ||
                  input.mode !== "Read" ||
                  input.aggregate.productReference !== request.productReference ||
                  input.aggregate.brandReference !== brand ||
                  input.requiredReferenceChecks.length !== 0
                )
                  return fail();
                await hold();
              },
            },
          });
          const aggregate = await reader.load(parseCatalogReference(request.productReference));
          if (aggregate === null) return fail();
          const snapshot = buildCatalogProductEditorSnapshot(
            aggregate,
            { tenantReference: tenant, brandReference: brand },
            request,
            observedAt,
          );
          await hold();
          const result = await work(snapshot, tx);
          await hold();
          finished = true;
          completed = result;
          return result;
        });
        if (calls !== 1 || !finished || !Object.is(result, completed)) return fail();
        check();
        return result;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
