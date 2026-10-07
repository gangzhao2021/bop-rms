import { BrowserSessionError } from "@bop/identity";
import {
  CatalogError,
  createPostgresProductEditorSourceStore,
  createPostgresProductPublicationSourceStoreV2,
  buildCatalogProductPublicationManagementV2,
  productPublicationSourceFieldsV2,
  parseCatalogInstant,
  parseProductPublicationSourceRequest,
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
type EditorView = Parameters<
  Parameters<ReturnType<typeof createPostgresProductEditorSourceStore>["withCurrentSnapshot"]>[1]
>[0];
type View = ReturnType<typeof buildCatalogProductPublicationManagementV2>;
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const denied = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};

/** Private transport composition over both owning current editor/publication sources.
 * Screen, field and purpose holders are independent authorities, never DTO facts.
 * Their leases and navigation permission must remain held through outer COMMIT.
 */
export function createMerchantProductPublicationManagementQueryV2(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly currentRuntime?: true;
  readonly contentAuthority?: SourceOptions["authority"];
  readonly historyAuthority?: HistoryOptions["authority"];
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
      readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_MANAGEMENT";
      readonly requiredFields: typeof productEditorSnapshotFields;
      readonly historyFields: typeof productPublicationSourceFieldsV2;
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
    suppliedHistoryAuthority = options.historyAuthority?.holdUntilTransactionCompletes?.bind(
      options.historyAuthority,
    ),
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
        options.historyAuthority !== undefined ||
        options.holdScreenUntilCommit !== undefined
      : typeof suppliedContentAuthority !== "function" ||
        typeof suppliedHistoryAuthority !== "function" ||
        typeof suppliedScreen !== "function")
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
    const expected = parseMerchantProductCommandScope(input.expectedScope);
    try {
      query = parseProductPublicationSourceRequest(input.query);
    } catch {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }
    try {
      const session = await authentication(input);
      if (currentRuntime) originalValidUntil = new Date(Date.parse(now()) + 5000).toISOString();
      let transactionCalls = 0,
        sourceCalls = 0,
        historyCalls = 0,
        completed: { readonly view: View } | undefined;
      const result = await host.transactions.run(async (tx) => {
        if (++transactionCalls !== 1) return fail();
        const scope = await resolve(tx, input.sessionCookie, session.sessionReference),
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
              sessionCookie: input.sessionCookie,
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
            fail(),
          historyAuthority =
            runtime?.historyAuthority.holdUntilTransactionCompletes ??
            suppliedHistoryAuthority ??
            fail();
        let observation = "",
          deadline = 0,
          observedView: View | undefined,
          historyInput:
            Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined,
          contentInput:
            Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
        const authorize = async () => {
          const actions = [
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.sku.read",
            "catalog.product.history.read",
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
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_MANAGEMENT",
            requiredFields: productEditorSnapshotFields,
            historyFields: productPublicationSourceFieldsV2,
            observedAt: parseCatalogInstant(now()),
          });
          now();
        };
        const check = () => {
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
            if (!contentInput || !historyInput) return fail();
            await contentAuthority(tx, contentInput);
            await historyAuthority(tx, historyInput);
            check();
          },
          check,
        );
        await authorize();
        const categoryAssignments = createMerchantProductCategoryAssignments({
          transaction: tx,
          tenantReference: scope.tenantReference,
          brandReference,
          actorReference: scope.actorReference,
          now,
          policy: categoryPolicy,
          registerBeforeCommit: host.registerBeforeCommit,
        });
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
        const publications = createPostgresProductPublicationSourceStoreV2({
          tenantReference: scope.tenantReference,
          brandReference,
          actorReference: scope.actorReference,
          actorKind: "User",
          clock: { now },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return fail();
              await authorize();
              historyInput = request;
              await historyAuthority(tx, request);
            },
          },
        });
        const view = await source.withCurrentSnapshot(query, async (editor: EditorView, actual) => {
          if (
            ++sourceCalls !== 1 ||
            actual !== tx ||
            editor.tenantReference !== scope.tenantReference ||
            editor.brandReference !== String(brandReference) ||
            editor.productReference !== query.productReference ||
            editor.aggregateVersion !== query.expectedAggregateVersion
          )
            return fail();
          return publications.withCurrentCoverage(query, async (history, historyTransaction) => {
            if (++historyCalls !== 1 || historyTransaction !== tx) return fail();
            const joined = buildCatalogProductPublicationManagementV2(
              editor,
              history,
              {
                tenantReference: scope.tenantReference,
                brandReference,
                storeReference: scope.selectedStoreReference,
              },
              query,
              now(),
            );
            observedView = joined;
            observation = joined.observedAt;
            deadline = Date.parse(joined.validUntil);
            check();
            return joined;
          });
        });
        if (sourceCalls !== 1 || historyCalls !== 1 || view !== observedView) return fail();
        check();
        completed = Object.freeze({ view });
        return completed;
      });
      if (
        transactionCalls !== 1 ||
        sourceCalls !== 1 ||
        historyCalls !== 1 ||
        !completed ||
        result !== completed
      )
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
