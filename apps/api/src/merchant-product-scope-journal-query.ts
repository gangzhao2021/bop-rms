import {
  CatalogError,
  createPostgresProductPublicationSourceStore,
  parseCatalogInstant,
  parseProductPublicationSourceRequest,
  productPublicationSourceFields,
  productScopeJournalManagementFields,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type SourceOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type Transaction = Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[0];
type JournalAuthority = NonNullable<SourceOptions["scopeJournalAuthority"]>;
type View = Parameters<
  Parameters<
    ReturnType<typeof createPostgresProductPublicationSourceStore>["withCurrentScopeJournals"]
  >[1]
>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const denied = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};

/** Private transport composition over the owning history/journal source. Screen,
 * field and purpose holders are separate current authorities, never DTO facts.
 * Their leases and navigation permission must remain held through outer COMMIT.
 */
export function createMerchantProductScopeJournalQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly historyAuthority: SourceOptions["authority"];
  readonly journalAuthority: JournalAuthority;
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
      readonly purposeCode: "CATALOG_PRODUCT_SCOPE_JOURNAL";
      readonly historyFields: typeof productPublicationSourceFields;
      readonly journalFields: typeof productScopeJournalManagementFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
}) {
  const merchant = { ...options.merchant },
    authentication = options.authentication,
    historyAuthority = options.historyAuthority,
    journalAuthority = options.journalAuthority,
    holdScreen = options.holdScreenUntilCommit,
    now = merchant.now;
  if (
    typeof now !== "function" ||
    typeof authentication?.authorize !== "function" ||
    typeof historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof journalAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof holdScreen !== "function"
  )
    return fail();
  const resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions(merchant.transactions);
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
      const session = await authentication.authorize(input);
      let transactionCalls = 0,
        sourceCalls = 0,
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
            Parameters<SourceOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined,
          journalInput:
            Parameters<JournalAuthority["holdUntilTransactionCompletes"]>[1] | undefined;
        const authorize = async () => {
          for (const action of [
            "catalog.manage",
            "catalog.product.manage",
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
            purposeCode: "CATALOG_PRODUCT_SCOPE_JOURNAL",
            historyFields: productPublicationSourceFields,
            journalFields: productScopeJournalManagementFields,
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
          if (!historyInput || !journalInput) return fail();
          await historyAuthority.holdUntilTransactionCompletes(tx, historyInput);
          await journalAuthority.holdUntilTransactionCompletes(tx, journalInput);
          check();
        });
        const source = createPostgresProductPublicationSourceStore({
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
              await historyAuthority.holdUntilTransactionCompletes(tx, request);
            },
          },
          scopeJournalAuthority: {
            async holdUntilTransactionCompletes(actual, request) {
              if (actual !== tx) return fail();
              await authorize();
              journalInput = request;
              await journalAuthority.holdUntilTransactionCompletes(tx, request);
            },
          },
        });
        const view = await source.withCurrentScopeJournals(query, async (view, actual) => {
          if (
            ++sourceCalls !== 1 ||
            actual !== tx ||
            view.tenantReference !== scope.tenantReference ||
            view.brandReference !== brandReference ||
            view.productReference !== query.productReference ||
            view.aggregateVersion !== query.expectedAggregateVersion
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
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  };
}
