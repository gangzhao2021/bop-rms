import { BrowserSessionError } from "@bop/identity";
import {
  CatalogError,
  createPostgresProductEditorSourceStore,
  createPostgresProductPublicationSourceStore,
  buildCatalogProductPublicationManagement,
  productPublicationSourceFields,
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

type SourceOptions = Parameters<typeof createPostgresProductEditorSourceStore>[0];
type Transaction = Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type EditorView = Parameters<
  Parameters<ReturnType<typeof createPostgresProductEditorSourceStore>["withCurrentSnapshot"]>[1]
>[0];
type View = ReturnType<typeof buildCatalogProductPublicationManagement>;
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
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
export function createMerchantProductPublicationManagementQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly contentAuthority: SourceOptions["authority"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly categoryPolicy?: MerchantProductCategoryPolicy;
  readonly holdScreenUntilCommit: (
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
      readonly historyFields: typeof productPublicationSourceFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}) {
  const merchant = { ...options.merchant },
    authentication = options.authentication?.authorize?.bind(options.authentication),
    contentAuthority = options.contentAuthority?.holdUntilTransactionCompletes?.bind(
      options.contentAuthority,
    ),
    holdScreen = options.holdScreenUntilCommit?.bind(options),
    historyAuthority = options.historyAuthority?.holdUntilTransactionCompletes?.bind(
      options.historyAuthority,
    ),
    categoryPolicy = options.categoryPolicy,
    now = merchant.now?.bind(options.merchant);
  if (
    typeof merchant.transactions?.run !== "function" ||
    typeof now !== "function" ||
    typeof authentication !== "function" ||
    typeof contentAuthority !== "function" ||
    typeof historyAuthority !== "function" ||
    typeof holdScreen !== "function"
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
    let query: ReturnType<typeof parseProductPublicationSourceRequest>;
    const expected = parseMerchantProductCommandScope(input.expectedScope);
    try {
      query = parseProductPublicationSourceRequest(input.query);
    } catch {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }
    try {
      const session = await authentication(input);
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
        let observation = "",
          deadline = 0,
          observedView: View | undefined,
          historyInput:
            Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined,
          contentInput:
            Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
        const authorize = async () => {
          for (const action of [
            "catalog.manage",
            "catalog.product.manage",
            "catalog.product.read",
            "catalog.sku.read",
            "catalog.product.history.read",
          ]) {
            const decision = await scope.authorizeAction(action);
            if (
              decision?.effect !== "Allow" ||
              decision.action !== action ||
              decision.scopeKind !== "Brand"
            )
              return denied();
          }
          await holdScreen(tx, {
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
            historyFields: productPublicationSourceFields,
            observedAt: parseCatalogInstant(now()),
          });
        };
        const check = () => {
          const at = parseCatalogInstant(now());
          if (!observation || at < observation || Date.parse(at) >= deadline) return fail();
        };
        await authorize();
        await host.registerBeforeCommit(tx, async () => {
          check();
          await authorize();
          if (!contentInput || !historyInput) return fail();
          await contentAuthority(tx, contentInput);
          await historyAuthority(tx, historyInput);
          check();
        });
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
        const publications = createPostgresProductPublicationSourceStore({
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
          return publications.withCurrentSnapshot(query, async (history) => {
            if (++historyCalls !== 1) return fail();
            const joined = buildCatalogProductPublicationManagement(
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
