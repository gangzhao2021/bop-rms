import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  createPostgresMenuDraftSource,
  parseCatalogReference,
  parseCatalogInstant,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
/** Current owner configuration for an authorized editor; never publication approval. */
export function createMerchantMenuDraftQuery(options: {
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  return async (request: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    let menu: string;
    try {
      menu = parseCatalogReference(
        readClosedRecord(request.command, ["menuReference"]).menuReference,
      );
    } catch {
      return fail("CATALOG_INPUT_INVALID");
    }
    return options.merchant.transactions.run(async (identityTransaction) => {
      const transaction: ProductLifecycleTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await identityTransaction.query(sql, values);
          if (!result || typeof result !== "object") return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      const allowed = async () => {
        const decision = await scope.authorizeAction("catalog.menu.manage");
        return (
          decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === "catalog.menu.manage"
        );
      };
      if (!(await allowed())) return fail("CATALOG_PERMISSION_DENIED");
      const source = createPostgresMenuDraftSource({
        brandReference: scope.context.brand.brandReference,
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, reference) => reference === menu && (await allowed()),
      });
      const result = await source.load(menu, parseCatalogInstant(options.merchant.now()));
      if (!(await allowed())) return fail("CATALOG_PERMISSION_DENIED");
      if (!result) return fail("CATALOG_UNAVAILABLE");
      return { status: "Found" as const, ...result };
    });
  };
}
