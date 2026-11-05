import { readClosedRecord } from "@bop/identity";
import { listBrandSkuChoices } from "@rms/catalog";
import { loadDiningTeaChargeSetting } from "@rms/dining";
import {
  changeKitchenNotPreparedProduct,
  KitchenNotPreparedError,
  loadKitchenNotPreparedProducts,
} from "@rms/kitchen";
import { listDeclaredChargeSkus } from "@rms/recipe";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantKitchenNotPreparedErrorCode =
  | "KITCHEN_NOT_PREPARED_INPUT_INVALID"
  | "KITCHEN_NOT_PREPARED_PERMISSION_DENIED"
  /** Another change of the dish's mark came first: read it again. */
  | "KITCHEN_NOT_PREPARED_CHANGED"
  | "KITCHEN_NOT_PREPARED_UNAVAILABLE";
export class MerchantKitchenNotPreparedError extends Error {
  constructor(readonly code: MerchantKitchenNotPreparedErrorCode) {
    super("kitchen not prepared " + code);
    this.name = "MerchantKitchenNotPreparedError";
  }
}
const fail = (code: MerchantKitchenNotPreparedErrorCode): never => {
  throw new MerchantKitchenNotPreparedError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value)
    ? value
    : fail("KITCHEN_NOT_PREPARED_INPUT_INVALID");

export interface MerchantKitchenNotPreparedResult {
  readonly products: readonly {
    readonly productReference: string;
    /** What the kitchen does with the dish now: the Store's mark, or with none its default. */
    readonly notPrepared: boolean;
    readonly version: number;
    /** The Store decided this itself; otherwise it follows the dish's default (item 8a). */
    readonly decided: boolean;
    /** With no mark, the kitchen would not prepare it: a declared charge, or the tea item. */
    readonly notPreparedByDefault: boolean;
  }[];
}

/**
 * WP-2423 item 8a: the dishes the kitchen does not prepare unless the Store marks them: every size is
 * declared a charge, or is the Store's tea item (as a round reaching the kitchen decides per size).
 */
export async function dishesNotPreparedByDefault(
  tx: unknown,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  products: readonly string[],
): Promise<ReadonlySet<string>> {
  if (products.length === 0) return new Set();
  const query = tx as {
    query(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  };
  const wanted = new Set(products);
  const sizes = (await listBrandSkuChoices(query, scope)).filter(
    (sku) => sku.active && wanted.has(sku.productReference),
  );
  // Catalog's read leaves the transaction with no Store; Recipe's and Dining's read the Store's.
  await query.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const charges = await listDeclaredChargeSkus(
    query,
    scope,
    sizes.map((sku) => sku.skuReference),
  );
  const tea = (await loadDiningTeaChargeSetting(tx as never, scope)).teaSellableReference;
  const isDefault = (sku: string) => charges.has(sku) || sku === tea;
  return new Set(
    products.filter((product) => {
      const own = sizes.filter((sku) => sku.productReference === product);
      return own.length > 0 && own.every((sku) => isDefault(sku.skuReference));
    }),
  );
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): on
 * the menu, a dish the kitchen does not prepare (a bottled drink, the per-head tea) never reaches
 * the kitchen board and counts as served once ordered. "Read" answers the marks of the dishes
 * shown (`catalog.product.read`); "Change" sets or clears one dish's mark against the version the
 * editor saw (`catalog.product.manage`, as editing the dish). Rounds already sent keep what the
 * kitchen decided for them.
 */
export function createMerchantKitchenNotPrepared(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantKitchenNotPreparedResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command:
      | { action: "Read"; products: string[] }
      | {
          action: "Change";
          productReference: string;
          operationReference: string;
          expectedVersion: number;
          notPrepared: boolean;
        };
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") {
        const raw = readClosedRecord(input.command, ["action", "productReferences"]);
        if (!Array.isArray(raw.productReferences) || raw.productReferences.length > 500)
          return fail("KITCHEN_NOT_PREPARED_INPUT_INVALID");
        command = { action, products: raw.productReferences.map(ref) };
      } else {
        const raw = readClosedRecord(input.command, [
          "action",
          "productReference",
          "operationReference",
          "expectedVersion",
          "notPrepared",
        ]);
        if (
          raw.action !== "Change" ||
          typeof raw.notPrepared !== "boolean" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("KITCHEN_NOT_PREPARED_INPUT_INVALID");
        command = {
          action: "Change",
          productReference: ref(raw.productReference),
          operationReference: ref(raw.operationReference),
          expectedVersion: Number(raw.expectedVersion),
          notPrepared: raw.notPrepared,
        };
      }
    } catch (error) {
      if (error instanceof MerchantKitchenNotPreparedError) throw error;
      return fail("KITCHEN_NOT_PREPARED_INPUT_INVALID");
    }
    const permission =
      command.action === "Read" ? "catalog.product.read" : "catalog.product.manage";
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                permission,
                authenticated.sessionReference,
              ).catch(() => fail("KITCHEN_NOT_PREPARED_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("KITCHEN_NOT_PREPARED_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("KITCHEN_NOT_PREPARED_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadKitchenNotPreparedProducts>[0];
            if (command.action === "Change")
              await changeKitchenNotPreparedProduct(runner, scope, {
                productReference: command.productReference,
                operationReference: command.operationReference,
                expectedVersion: command.expectedVersion,
                notPrepared: command.notPrepared,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            const products =
              command.action === "Read" ? command.products : [command.productReference];
            const marks = await loadKitchenNotPreparedProducts(runner, scope, products);
            const byDefault = await dishesNotPreparedByDefault(tx, scope, products);
            return Object.freeze({
              products: Object.freeze(
                products.map((productReference) => {
                  const mark = marks.get(productReference);
                  const notPreparedByDefault = byDefault.has(productReference);
                  return Object.freeze({
                    productReference,
                    notPrepared: mark?.notPrepared ?? notPreparedByDefault,
                    version: mark?.version ?? 0,
                    decided: mark !== undefined,
                    notPreparedByDefault,
                  });
                }),
              ),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantKitchenNotPreparedError) throw error;
      if (error instanceof KitchenNotPreparedError && error.code === "KITCHEN_NOT_PREPARED_CHANGED")
        throw new MerchantKitchenNotPreparedError("KITCHEN_NOT_PREPARED_CHANGED");
      throw new MerchantKitchenNotPreparedError("KITCHEN_NOT_PREPARED_UNAVAILABLE");
    }
  };
}
