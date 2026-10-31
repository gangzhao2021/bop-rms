import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  createCurrentProductPublicationService,
  createPostgresProductPublicationSourceStore,
  type CurrentProductPublicationPorts,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  parseMerchantProductCommandScope,
  bindMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_PERMISSION_DENIED");
};
export function createMerchantProductPublicationQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly authority: Parameters<
    typeof createPostgresProductPublicationSourceStore
  >[0]["authority"];
  readonly eligibility: CurrentProductPublicationPorts["eligibility"];
}) {
  const resolve = createMerchantBrandScope(options.merchant),
    host = createMerchantCategoryTransactions(options.merchant.transactions);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    query: unknown;
    expectedScope: unknown;
  }) => {
    const expected = parseMerchantProductCommandScope(input.expectedScope);
    let query: Record<string, unknown>;
    try {
      query = readClosedRecord(input.query, [
        "productReference",
        "expectedAggregateVersion",
        "channelCode",
        "orderTypeCode",
      ]);
    } catch {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }
    const session = await options.authentication.authorize(input);
    return host.transactions.run(async (tx) => {
      const scope = await resolve(tx, input.sessionCookie, session.sessionReference),
        brandReference = scope.context.brand.brandReference;
      bindMerchantProductCommandScope(
        { brandReference, storeReference: scope.selectedStoreReference },
        expected,
      );
      const authorize = async () => {
        for (const action of [
          "catalog.manage",
          "catalog.product.manage",
          "catalog.product.history.read",
        ]) {
          const d = await scope.authorizeAction(action);
          if (d?.effect !== "Allow" || d.action !== action || d.scopeKind !== "Brand")
            return fail();
        }
      };
      await authorize();
      await host.registerBeforeCommit(tx, authorize);
      const snapshots = createPostgresProductPublicationSourceStore({
        tenantReference: scope.tenantReference,
        brandReference,
        actorReference: scope.actorReference,
        clock: { now: options.merchant.now },
        transactions: { run: (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes(_tx, request) {
            await authorize();
            await options.authority.holdUntilTransactionCompletes(tx, request);
          },
        },
      });
      const service = createCurrentProductPublicationService(
        { clock: { now: options.merchant.now }, snapshots, eligibility: options.eligibility },
        {
          tenantReference: scope.tenantReference,
          brandReference,
          storeReference: scope.selectedStoreReference,
        },
      );
      return service.withCurrentPublication(query, async (view) => {
        await authorize();
        return view;
      });
    });
  };
}
