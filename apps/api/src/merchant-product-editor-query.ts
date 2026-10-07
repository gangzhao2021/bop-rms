import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  createPostgresProductEditorSourceStore,
  parseCatalogInstant,
  parseProductAggregate,
  parseProductPublicationSourceRequest,
  productCategoryAssignmentFields,
  productEditorSnapshotFields,
} from "@rms/catalog";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { createMerchantProductPublicationRuntimeReadAuthority } from "./merchant-product-publication-runtime-read-authority.js";

type SourceOptions = Parameters<typeof createPostgresProductEditorSourceStore>[0];
type Transaction = Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type View = Parameters<
  Parameters<ReturnType<typeof createPostgresProductEditorSourceStore>["withCurrentSnapshot"]>[1]
>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const denied = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};
const exactFields = (value: unknown, fields: readonly string[]) =>
  Array.isArray(value) &&
  value.length === fields.length &&
  fields.every((field, index) => value[index] === field);

/** Private transport composition over the owning complete current editor source.
 * Screen, field and purpose holders are independent authorities, never DTO facts.
 * Their leases and navigation permission must remain held through outer COMMIT.
 */
export function createMerchantProductEditorQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly currentRuntime?: true;
  readonly contentAuthority?: SourceOptions["authority"];
  readonly categoryPolicy?: MerchantProductCategoryPolicy;
  readonly holdScreenUntilCommit?: (
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly sessionReference: string;
      readonly productReference: string;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly purposeCode: "CATALOG_PRODUCT_EDITOR_READ";
      readonly requiredFields: typeof productEditorSnapshotFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}) {
  const merchant = { ...options.merchant },
    authentication = options.authentication?.authorize?.bind(options.authentication),
    suppliedContentAuthority = options.contentAuthority?.holdUntilTransactionCompletes?.bind(
      options.contentAuthority,
    ),
    suppliedScreen = options.holdScreenUntilCommit?.bind(options),
    categoryPolicy = options.categoryPolicy,
    currentRuntime = options.currentRuntime === true,
    clock = merchant.now?.bind(options.merchant);
  if (
    typeof merchant.transactions?.run !== "function" ||
    typeof clock !== "function" ||
    typeof authentication !== "function" ||
    (options.currentRuntime !== undefined && options.currentRuntime !== true) ||
    (currentRuntime
      ? options.contentAuthority !== undefined ||
        options.holdScreenUntilCommit !== undefined ||
        options.categoryPolicy !== undefined
      : typeof suppliedContentAuthority !== "function" || typeof suppliedScreen !== "function")
  )
    return fail();
  const resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({
      run: merchant.transactions.run.bind(merchant.transactions),
    });
  return async (input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly query: unknown;
    readonly expectedScope: unknown;
  }): Promise<View> => {
    let lastAt = "",
      clockFailed = false,
      originalValidUntil: string | undefined;
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (
          clockFailed ||
          (lastAt && at < lastAt) ||
          (originalValidUntil && at >= originalValidUntil)
        )
          return fail();
        lastAt = at;
        return at;
      } catch {
        clockFailed = true;
        return fail();
      }
    };
    let query: ReturnType<typeof parseProductPublicationSourceRequest>;
    const expected = parseMerchantProductCommandScope(input.expectedScope),
      authenticationInput = { sessionCookie: input.sessionCookie, csrf: input.csrf };
    try {
      query = parseProductPublicationSourceRequest(input.query);
    } catch {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }
    try {
      const session = await authentication(authenticationInput);
      if (currentRuntime) originalValidUntil = new Date(Date.parse(now()) + 5000).toISOString();
      let transactionCalls = 0,
        sourceCalls = 0,
        completed: { readonly view: View } | undefined;
      const result = await host.transactions.run(async (tx) => {
        if (++transactionCalls !== 1) return fail();
        const scope = await resolve(
            tx,
            authenticationInput.sessionCookie,
            session.sessionReference,
          ),
          brandReference = scope.context.brand.brandReference;
        bindMerchantProductCommandScope(
          { brandReference, storeReference: scope.selectedStoreReference },
          expected,
        );
        const bridge = currentRuntime
          ? createMerchantProductCurrentAuthorization({
              merchant,
              transaction: tx,
              scope,
              sessionCookie: authenticationInput.sessionCookie,
              sessionReference: session.sessionReference,
              clock: { now },
              originalValidUntil: originalValidUntil ?? fail(),
            })
          : undefined;
        const runtimeHost = bridge
          ? {
              transaction: tx,
              tenantReference: scope.tenantReference,
              brandReference,
              storeReference: scope.selectedStoreReference,
              actorReference: scope.actorReference,
              clock: { now },
              originalValidUntil: originalValidUntil ?? fail(),
              currentAuthorization: bridge,
              registerBeforeCommit: host.registerBeforeCommit,
            }
          : undefined;
        const runtime = runtimeHost
          ? createMerchantProductPublicationRuntimeReadAuthority({
              ...runtimeHost,
              query: { kind: "Management", request: query },
            })
          : undefined;
        const capability = runtimeHost
          ? createMerchantProductStoreCapabilityGuard(runtimeHost)
          : undefined;
        const contentAuthority =
          runtime?.contentAuthority.holdUntilTransactionCompletes ??
          suppliedContentAuthority ??
          fail();
        let observation = "",
          deadline = 0,
          categoryFailed = false,
          categoryActive = false,
          categoryAggregate: ReturnType<typeof parseProductAggregate> | undefined,
          observedView: View | undefined,
          contentInput:
            Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
        const authorize = async () => {
          const actions = [
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.sku.read",
          ];
          if (bridge && capability) {
            await bridge.authorizeActions(actions);
            await capability.holdUntilCommit();
            bridge.assertCurrent();
            return;
          }
          for (const action of actions) {
            const decision = await scope.authorizeAction(action);
            if (
              decision?.effect !== "Allow" ||
              decision.action !== action ||
              decision.scopeKind !== "Brand"
            )
              return denied();
          }
          await (suppliedScreen ?? fail())(tx, {
            tenantReference: scope.tenantReference,
            brandReference,
            storeReference: scope.selectedStoreReference,
            actorReference: scope.actorReference,
            sessionReference: session.sessionReference,
            productReference: query.productReference,
            screenId: "CAT-PRODUCT-EDIT",
            capability: "catalog.cat_product_edit",
            permission: "catalog.manage",
            purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
            requiredFields: productEditorSnapshotFields,
            observedAt: parseCatalogInstant(now()),
          });
          now();
        };
        const check = () => {
          if (categoryFailed || categoryActive) return fail();
          bridge?.assertCurrent();
          runtime?.assertCurrent();
          const at = parseCatalogInstant(now());
          if (!observation || at < observation || Date.parse(at) >= deadline) return fail();
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            check();
            await authorize();
            if (!contentInput) return fail();
            await contentAuthority(tx, contentInput);
            check();
          },
          check,
        );
        await authorize();
        const accessPolicy: MerchantProductCategoryPolicy | undefined = bridge
          ? async (actual, value) => {
              try {
                const input = readClosedRecord(copyCategoryPersistenceValue(value), [
                  "tenantReference",
                  "brandReference",
                  "actorReference",
                  "productReference",
                  "productVersionReference",
                  "purposeCode",
                  "permission",
                  "referencedPermission",
                  "requiredFields",
                  "referencedFields",
                  "observedAt",
                ]);
                const at = parseCatalogInstant(input.observedAt);
                if (
                  categoryFailed ||
                  actual !== tx ||
                  !categoryAggregate ||
                  input.tenantReference !== scope.tenantReference ||
                  input.brandReference !== brandReference ||
                  input.actorReference !== scope.actorReference ||
                  input.productReference !== query.productReference ||
                  input.productVersionReference !== categoryAggregate.draft.versionReference ||
                  input.purposeCode !== "CATALOG_PRODUCT_CATEGORY_ACCESS" ||
                  input.permission !== "catalog.product.manage" ||
                  input.referencedPermission !== "catalog.manage" ||
                  !exactFields(input.requiredFields, productCategoryAssignmentFields) ||
                  !exactFields(input.referencedFields, [
                    "categoryReference",
                    "brandReference",
                    "lifecycle",
                  ]) ||
                  at >= (originalValidUntil ?? fail()) ||
                  Date.parse(at) < Date.parse(originalValidUntil ?? fail()) - 5000 ||
                  at > now()
                )
                  return fail();
                await authorize();
                bridge.assertCurrent();
                now();
                // Read only authorizes the recorded assignment metadata. It grants
                // no lifecycle for a new assignment and never admits MUTATION.
                return Object.freeze({ allowedLifecycles: Object.freeze([]) });
              } catch (error) {
                categoryFailed = true;
                throw error;
              }
            }
          : categoryPolicy;
        const categoryDelegate = createMerchantProductCategoryAssignments({
          transaction: tx,
          tenantReference: scope.tenantReference,
          brandReference,
          actorReference: scope.actorReference,
          now,
          policy: accessPolicy,
          registerBeforeCommit: host.registerBeforeCommit,
        });
        const categoryAssignments: SourceOptions["categoryAssignments"] =
          bridge && categoryDelegate
            ? Object.freeze<NonNullable<SourceOptions["categoryAssignments"]>>({
                async holdUntilTransactionCompletes(actual, value) {
                  try {
                    if (categoryFailed || categoryActive || actual !== tx) return fail();
                    categoryActive = true;
                    const input = readClosedRecord(copyCategoryPersistenceValue(value), [
                        "mode",
                        "aggregate",
                      ]),
                      aggregate = parseProductAggregate(input.aggregate);
                    if (
                      input.mode !== "Read" ||
                      String(aggregate.brandReference) !== String(brandReference) ||
                      aggregate.productReference !== query.productReference ||
                      aggregate.aggregateVersion !== query.expectedAggregateVersion ||
                      aggregate.draft.categoryClassification === undefined ||
                      (categoryAggregate !== undefined &&
                        JSON.stringify(aggregate) !== JSON.stringify(categoryAggregate))
                    )
                      return fail();
                    categoryAggregate = aggregate;
                    await categoryDelegate.holdUntilTransactionCompletes(actual, {
                      mode: "Read",
                      aggregate,
                    });
                    now();
                  } catch (error) {
                    categoryFailed = true;
                    throw error;
                  } finally {
                    categoryActive = false;
                  }
                },
              })
            : categoryDelegate;
        const source = createPostgresProductEditorSourceStore({
          tenantReference: scope.tenantReference,
          brandReference,
          actorReference: scope.actorReference,
          clock: { now },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return fail();
              await authorize();
              contentInput = request;
              await contentAuthority(tx, request);
            },
          },
          ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
        });
        const view = await source.withCurrentSnapshot(query, async (view, actual) => {
          if (
            ++sourceCalls !== 1 ||
            actual !== tx ||
            view.tenantReference !== scope.tenantReference ||
            view.brandReference !== String(brandReference) ||
            view.productReference !== query.productReference ||
            view.aggregateVersion !== query.expectedAggregateVersion ||
            (bridge &&
              view.aggregate?.draft.categoryClassification !== undefined &&
              !categoryAggregate) ||
            (categoryAggregate !== undefined &&
              JSON.stringify(view.aggregate) !== JSON.stringify(categoryAggregate))
          )
            return fail();
          observedView = view;
          observation = parseCatalogInstant(view.observedAt);
          deadline = Date.parse(observation) + 5000;
          if (view.validUntil !== new Date(deadline).toISOString()) return fail();
          check();
          return view;
        });
        if (sourceCalls !== 1 || view !== observedView) return fail();
        check();
        completed = Object.freeze({ view });
        return completed;
      });
      if (transactionCalls !== 1 || sourceCalls !== 1 || !completed || result !== completed)
        return fail();
      const at = parseCatalogInstant(now());
      if (at < completed.view.observedAt || at >= completed.view.validUntil) return fail();
      return completed.view;
    } catch (error) {
      if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED")
        return denied();
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  };
}
