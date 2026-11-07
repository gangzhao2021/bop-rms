import {
  bindCatalogProductValidationCandidate,
  bindCatalogProductValidationCandidateV2,
  productValidationCandidateFields,
  productValidationCandidateFieldsV2,
  type CatalogCurrentProductValidationCandidate,
  type CatalogProductValidationCandidate,
  type CatalogProductValidationCandidateV2,
} from "../../contracts/product-validation-candidate.js";
import {
  parseProductPublicationCommand,
  type ProductPublicationCommand,
} from "../../contracts/product-publication.js";
import { parseProductPublicationCommandV2 } from "../../contracts/product-publication-v2.js";
import { productEditorContentFields } from "../../application/product-editor-content-authority.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  deriveCatalogProductDraftBaseline,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
  type CatalogProductDraftBaseline,
} from "../../contracts/product-draft-baseline.js";
import {
  createPostgresProductLifecycleStore,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import type { ProductCategoryAssignmentAuthority } from "./product-category-assignment.js";
export interface ProductDraftBaselineSourceAuthority {
  /** Hold current scope/target/parent purpose, complete fields and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly productReference: string;
      readonly purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ";
      readonly permission: "catalog.manage";
      readonly action: "catalog.product.manage";
      readonly capability: "catalog.cat_product_edit";
      readonly requiredFields: typeof productDraftBaselineFields;
      readonly referencedFields: typeof productDraftBaselineReferencedFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Owning current read under existing Product barrier; no operation-history baseline inference. */
export function createPostgresProductDraftBaselineStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: ProductDraftBaselineSourceAuthority;
  readonly categoryAssignments?: ProductCategoryAssignmentAuthority;
  readonly clock: { now(): string };
  readonly maximumSkus: number;
  readonly maximumOptionBindings: number;
}) {
  let tenant: string, brand: string, actor: string;
  try {
    tenant = parseCatalogReference(options.tenantReference);
    brand = parseCatalogReference(options.brandReference);
    actor = parseCatalogReference(options.actorReference);
  } catch {
    return fail();
  }
  if (
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.clock?.now !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments?.holdUntilTransactionCompletes !== "function") ||
    [options.maximumSkus, options.maximumOptionBindings].some(
      (limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 10000,
    )
  )
    return fail();
  const holdCategory = options.categoryAssignments?.holdUntilTransactionCompletes.bind(
    options.categoryAssignments,
  );
  return Object.freeze({
    async loadBaseline(value: unknown): Promise<CatalogProductDraftBaseline | null> {
      const product = parseCatalogReference(value);
      try {
        const result = await options.transactions.run(async (tx) => {
          const hold = async () => {
            await options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                productReference: product,
                purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ",
                permission: "catalog.manage",
                action: "catalog.product.manage",
                capability: "catalog.cat_product_edit",
                requiredFields: productDraftBaselineFields,
                referencedFields: productDraftBaselineReferencedFields,
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          };
          await hold();
          await tx.query(
            "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
            [],
          );
          const reader = createPostgresProductLifecycleStore({
            brandReference: brand,
            transactions: { run: async (work) => work(tx) },
            authorize: async (actual, input) => {
              if (actual !== tx || input.productReference !== product || input.record !== undefined)
                return fail();
              await hold();
              return true;
            },
            ...(holdCategory === undefined
              ? {}
              : {
                  categoryAssignments: {
                    async holdUntilTransactionCompletes(actual, input) {
                      if (
                        actual !== tx ||
                        input.mode !== "Read" ||
                        input.aggregate.brandReference !== brand ||
                        input.aggregate.productReference !== product ||
                        input.aggregate.draft.categoryClassification === undefined
                      )
                        return fail();
                      if (!holdCategory) return fail();
                      await holdCategory(actual, input);
                    },
                  },
                }),
          });
          const current = await reader.load(product);
          if (current === null) return null;
          if (current.productReference !== product || current.brandReference !== brand)
            return fail();
          if (
            current.draft.skus.length > options.maximumSkus ||
            current.draft.optionBindings.length > options.maximumOptionBindings
          )
            return fail();
          const observedAt = options.clock.now();
          return deriveCatalogProductDraftBaseline(current, observedAt, options.clock.now());
        });
        if (result !== null) {
          const completed = parseCatalogInstant(options.clock.now()),
            asOf = result.projection.asOfUtc;
          if (asOf > completed || Date.parse(completed) - Date.parse(asOf) > 5000) return fail();
        }
        return result;
      } catch (error) {
        if (
          error instanceof CatalogError &&
          (error.code === "CATALOG_PERMISSION_DENIED" ||
            error.code === "CATALOG_DEPENDENCY_UNAVAILABLE")
        )
          throw error;
        return fail();
      }
    },
  });
}

interface CandidateAuthority<Fields extends readonly string[]> {
  /** Complete current fields/purpose and User Validate authority survive outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User";
      readonly productReference: string;
      readonly purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION";
      readonly permission: "catalog.manage";
      readonly owningAction: "catalog.product.validate";
      readonly requiredFields: Fields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
export type ProductValidationCandidateAuthority = CandidateAuthority<
  typeof productValidationCandidateFields
>;
export type ProductValidationCandidateAuthorityV2 = CandidateAuthority<
  typeof productValidationCandidateFieldsV2
>;
interface CandidateSourceOptions<Authority> {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: Authority;
  readonly categoryAssignments?: ProductCategoryAssignmentAuthority;
  readonly clock: { now(): string };
}
/** Owning current Draft for Validate, not a client snapshot or recorded result.
 * Reuses the lifecycle reader's exact SQL and held Brand/Product source fence. */
export function createPostgresProductValidationCandidateSource(
  options: CandidateSourceOptions<ProductValidationCandidateAuthority>,
) {
  return createCandidateSource(options, {
    parseCommand: parseProductPublicationCommand,
    bindCandidate: bindCatalogProductValidationCandidate,
    fields: productValidationCandidateFields,
  });
}
/** Closed V2 entry: full intent binding and explicit field authority, using the
 * same owning current SQL as V1 without dispatching a projected V1 command. */
export function createPostgresProductValidationCandidateSourceV2(
  options: CandidateSourceOptions<ProductValidationCandidateAuthorityV2>,
) {
  return createCandidateSource(options, {
    parseCommand: parseProductPublicationCommandV2,
    bindCandidate: bindCatalogProductValidationCandidateV2,
    fields: productValidationCandidateFieldsV2,
  });
}
function createCandidateSource<
  Command extends ProductPublicationCommand,
  Candidate extends CatalogProductValidationCandidate | CatalogProductValidationCandidateV2,
  Fields extends readonly string[],
>(
  options: CandidateSourceOptions<CandidateAuthority<Fields>>,
  protocol: {
    readonly parseCommand: (value: unknown) => Command;
    readonly bindCandidate: (
      command: Command,
      aggregate: unknown,
      observedAt: unknown,
    ) => Candidate;
    readonly fields: Fields;
  },
) {
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
    holdAuthority = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    now = options.clock.now.bind(options.clock),
    holdCategory = options.categoryAssignments?.holdUntilTransactionCompletes.bind(
      options.categoryAssignments,
    );
  return Object.freeze({
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User" as const,
    }),
    async withCurrentCandidate<T>(
      value: unknown,
      work: (
        source: Candidate & {
          readonly internalCodeCheck: CatalogCurrentProductValidationCandidate["internalCodeCheck"];
        },
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        const c = protocol.parseCommand(value);
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          c.tenantReference !== tenant ||
          c.brandReference !== brand ||
          c.actorReference !== actor ||
          typeof work !== "function"
        )
          return fail();
        const observedAt = parseCatalogInstant(now()),
          validUntil = new Date(Date.parse(observedAt) + 30000).toISOString();
        let latestObservedAt = observedAt;
        const check = () => {
          const current = parseCatalogInstant(now());
          if (current < latestObservedAt || current >= validUntil) return fail();
          latestObservedAt = current;
          return current;
        };
        let invocations = 0,
          finished = false,
          completed: T | undefined;
        const result = await run(async (tx) => {
          if (++invocations !== 1) return fail();
          const hold = async () => {
            const current = check();
            await holdAuthority(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                actorKind: "User" as const,
                productReference: c.productReference,
                purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION" as const,
                permission: "catalog.manage" as const,
                owningAction: "catalog.product.validate" as const,
                requiredFields: protocol.fields,
                observedAt: current,
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
          const categoryAuthority: ProductCategoryAssignmentAuthority | undefined =
            holdCategory === undefined
              ? undefined
              : {
                  async holdUntilTransactionCompletes(actual, input) {
                    if (
                      actual !== tx ||
                      input.mode !== "Read" ||
                      input.aggregate.productReference !== c.productReference ||
                      input.aggregate.brandReference !== brand ||
                      input.aggregate.draft.categoryClassification === undefined
                    )
                      return fail();
                    await hold();
                    await holdCategory(actual, input);
                    await hold();
                  },
                };
          const reader = createPostgresProductLifecycleStore({
            brandReference: brand,
            transactions: { run: async (callback) => callback(tx) },
            authorize: async (actual, input) => {
              if (
                actual !== tx ||
                input.productReference !== c.productReference ||
                input.record !== undefined
              )
                return fail();
              await hold();
              return true;
            },
            ...(categoryAuthority === undefined ? {} : { categoryAssignments: categoryAuthority }),
            editorContentAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                if (
                  actual !== tx ||
                  input.mode !== "Read" ||
                  input.aggregate.productReference !== c.productReference ||
                  input.aggregate.brandReference !== brand ||
                  input.requiredReferenceChecks.length !== 0 ||
                  input.requiredFields.length !== productEditorContentFields.length ||
                  input.requiredFields.some(
                    (field, index) => field !== productEditorContentFields.at(index),
                  )
                )
                  return fail();
                await hold();
              },
            },
          });
          const aggregate = await reader.load(parseCatalogReference(c.productReference));
          if (aggregate === null) return fail();
          const bound = protocol.bindCandidate(c, aggregate, observedAt);
          // reader.load holds CatalogProductSource for this Brand before any
          // code/Product lock. Reuse that existing fence, never reverse its order.
          const codeUnique = async () => {
            await hold();
            const result = await tx.query<{
              candidate_matches: boolean;
              internal_code_unique: boolean;
            }>(
              "SELECT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$3 AND internal_code=$2) AS candidate_matches,NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND internal_code=$2 AND product_id<>$3) AS internal_code_unique",
              [brand, aggregate.internalCode, aggregate.productReference],
            );
            await hold();
            const row = result.rows.at(0);
            if (
              result.rows.length !== 1 ||
              row?.candidate_matches !== true ||
              typeof row.internal_code_unique !== "boolean"
            )
              return fail();
            return row.internal_code_unique;
          };
          const unique = await codeUnique(),
            candidate = {
              ...bound,
              internalCodeCheck: Object.freeze({
                code: "InternalCode" as const,
                outcome: unique ? ("Pass" as const) : ("HardError" as const),
              }),
            };
          Object.freeze(candidate);
          await hold();
          const value = await work(candidate, tx);
          await hold();
          if ((await codeUnique()) !== unique) return fail();
          if (aggregate.draft.categoryClassification !== undefined) {
            if (!categoryAuthority) return fail();
            await categoryAuthority.holdUntilTransactionCompletes(tx, { mode: "Read", aggregate });
          }
          finished = true;
          completed = value;
          return value;
        });
        if (invocations !== 1 || !finished || !Object.is(result, completed)) return fail();
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
