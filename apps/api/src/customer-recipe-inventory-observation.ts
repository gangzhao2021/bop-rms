import { readClosedRecord } from "@bop/identity";
import {
  createPostgresCurrentSkuStore,
  parseCatalogReference,
  parseCatalogInstant,
} from "@rms/catalog";
import {
  createPostgresSaleRecipeDemandSource,
  parseRecipeOptionSelection,
  type RecipeOptionSelection,
} from "@rms/recipe";
import {
  createPostgresRecipeStockPlanSource,
  StockReservationStoreError,
  type InventoryItemTransaction,
  type InventoryItemTransactionRunner,
  type SubmissionExpiryCutoff,
} from "@rms/inventory";

export class CustomerRecipeInventoryObservationError extends Error {
  readonly code = "CUSTOMER_INVENTORY_OBSERVATION_UNAVAILABLE";
  constructor() {
    super("Inventory observation unavailable");
  }
}
export interface CustomerRecipeInventoryObservationInput {
  readonly sellableReference: string;
  readonly productVersionReference: string;
  readonly quantity: number;
  readonly selections: readonly RecipeOptionSelection[];
  readonly observedAt: string;
}

/** Internal composition for an explicitly selected quantity/options set.
 * Caller authorizes the actual customer selection and provides a dedicated
 * Repeatable Read/read-only transaction. No Cart/Quote/Workflow IDs are invented.
 */
export function createCustomerRecipeInventoryObservation(options: {
  scope: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    stockSiteReference: string;
  };
  transactions: InventoryItemTransactionRunner;
  authorize(
    transaction: InventoryItemTransaction,
    input: CustomerRecipeInventoryObservationInput,
  ): Promise<boolean>;
  resolveExpiryCutoff: SubmissionExpiryCutoff;
}) {
  const scope = Object.freeze({
    tenantReference: String(parseCatalogReference(options.scope.tenantReference)),
    brandReference: String(parseCatalogReference(options.scope.brandReference)),
    storeReference: String(parseCatalogReference(options.scope.storeReference)),
  });
  const stockSiteReference = String(parseCatalogReference(options.scope.stockSiteReference));
  return Object.freeze({
    async observe(value: CustomerRecipeInventoryObservationInput) {
      try {
        const raw = readClosedRecord(value, [
          "sellableReference",
          "productVersionReference",
          "quantity",
          "selections",
          "observedAt",
        ]);
        if (
          !Number.isSafeInteger(raw.quantity) ||
          Number(raw.quantity) < 1 ||
          Number(raw.quantity) > 999 ||
          !Array.isArray(raw.selections) ||
          raw.selections.length > 100 ||
          Reflect.ownKeys(raw.selections).length !== raw.selections.length + 1
        )
          throw new Error("invalid selection");
        const selections: RecipeOptionSelection[] = [];
        for (let i = 0; i < raw.selections.length; i++) {
          const entry = Object.getOwnPropertyDescriptor(raw.selections, String(i));
          if (!entry || !("value" in entry) || !entry.enumerable) throw new Error("invalid option");
          selections.push(parseRecipeOptionSelection(entry.value));
        }
        const input = Object.freeze({
          sellableReference: String(parseCatalogReference(raw.sellableReference)),
          productVersionReference: String(parseCatalogReference(raw.productVersionReference)),
          quantity: Number(raw.quantity),
          selections: Object.freeze(selections),
          observedAt: String(parseCatalogInstant(raw.observedAt)),
        });
        return await options.transactions.run(async (tx) => {
          if ((await options.authorize(tx, input)) !== true) throw new Error("unauthorized");
          const joined = {
            run: async <T>(work: (tx: InventoryItemTransaction) => Promise<T>) => work(tx),
          };
          const sku = await createPostgresCurrentSkuStore(joined, {
            brandReference: scope.brandReference,
          }).load({
            sellableReference: input.sellableReference,
            productVersionReference: input.productVersionReference,
            observedAt: input.observedAt,
          });
          if (sku === null || !sku.catalogEligible) throw new Error("SKU unavailable");
          const recipe = await createPostgresSaleRecipeDemandSource(
            joined,
            scope.brandReference,
          ).resolve({
            storeReference: scope.storeReference,
            skuReference: input.sellableReference,
            occurredAt: input.observedAt,
            saleUnitCode: sku.unitOfSale,
            unitQuantity: sku.unitQuantity,
            saleQuantity: input.quantity,
            selections: input.selections,
          });
          const contributions = recipe.requirements.map((item) => ({
            itemReference: item.itemReference,
            configurationOperationReference: item.itemVersionReference,
            unitDimension: item.unitDimension,
            quantityNumerator: item.quantityNumerator,
            quantityDenominator: item.quantityDenominator,
          }));
          let status: "Available" | "Unavailable" = "Available";
          try {
            await createPostgresRecipeStockPlanSource(joined, scope, {
              resolveExpiryCutoff: options.resolveExpiryCutoff,
            }).resolve({ ...scope, stockSiteReference, contributions }, input.observedAt);
          } catch (error) {
            if (
              !(error instanceof StockReservationStoreError) ||
              error.code !== "STOCK_RESERVATION_INSUFFICIENT"
            )
              throw error;
            status = "Unavailable";
          }
          if ((await options.authorize(tx, input)) !== true) throw new Error("authority withdrawn");
          return Object.freeze({
            status,
            ...scope,
            stockSiteReference,
            sellableReference: input.sellableReference,
            productVersionReference: input.productVersionReference,
            quantity: input.quantity,
            observedAt: input.observedAt,
          });
        });
      } catch {
        throw new CustomerRecipeInventoryObservationError();
      }
    },
  });
}
