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
  readRecipeStockShortage,
  StockReservationStoreError,
  type RecipeStockShortage,
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
  /**
   * WP-2423 (2026-10-16): staff reads only — when one cannot be made, also say which stocked
   * ingredients are short and how much is on hand, reserved and available. Never for customers.
   */
  explainShortage?: boolean;
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
          const shortages: readonly RecipeStockShortage[] =
            status === "Unavailable" && options.explainShortage === true
              ? await readRecipeStockShortage(
                  tx,
                  { ...scope, stockSiteReference, contributions },
                  input.observedAt,
                )
              : [];
          if ((await options.authorize(tx, input)) !== true) throw new Error("authority withdrawn");
          return Object.freeze({
            status,
            shortages,
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

/** WP-2423: one Cart line for {@link createCustomerRecipeInventoryCoverage}. */
export interface CustomerRecipeInventoryCoverageLine extends Omit<
  CustomerRecipeInventoryObservationInput,
  "observedAt"
> {
  readonly cartItemReference: string;
}
export interface CustomerRecipeInventoryCoverageInput {
  readonly lines: readonly CustomerRecipeInventoryCoverageLine[];
  readonly observedAt: string;
}

/**
 * WP-2423: whether the Store's current stock covers several Cart lines together, each line's
 * recipe demand planned as the reservation at submission plans it (per line, on the same running
 * availability), so two items using the same ingredient are counted against one stock. Read-only;
 * the caller authorizes the actual Cart and provides a dedicated read-only transaction.
 */
export function createCustomerRecipeInventoryCoverage(
  options: Omit<Parameters<typeof createCustomerRecipeInventoryObservation>[0], "authorize"> & {
    authorize(
      transaction: InventoryItemTransaction,
      input: CustomerRecipeInventoryCoverageInput,
    ): Promise<boolean>;
  },
) {
  const scope = Object.freeze({
    tenantReference: String(parseCatalogReference(options.scope.tenantReference)),
    brandReference: String(parseCatalogReference(options.scope.brandReference)),
    storeReference: String(parseCatalogReference(options.scope.storeReference)),
  });
  const stockSiteReference = String(parseCatalogReference(options.scope.stockSiteReference));
  return Object.freeze({
    async covers(value: CustomerRecipeInventoryCoverageInput): Promise<boolean> {
      try {
        const raw = readClosedRecord(value, ["lines", "observedAt"]);
        if (
          !Array.isArray(raw.lines) ||
          raw.lines.length > 100 ||
          Reflect.ownKeys(raw.lines).length !== raw.lines.length + 1
        )
          throw new Error("invalid lines");
        const lines: CustomerRecipeInventoryCoverageLine[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < raw.lines.length; i++) {
          const entry = Object.getOwnPropertyDescriptor(raw.lines, String(i));
          if (!entry || !("value" in entry) || !entry.enumerable) throw new Error("invalid line");
          const line = readClosedRecord(entry.value, [
            "cartItemReference",
            "sellableReference",
            "productVersionReference",
            "quantity",
            "selections",
          ]);
          if (
            !Number.isSafeInteger(line.quantity) ||
            Number(line.quantity) < 1 ||
            Number(line.quantity) > 999 ||
            !Array.isArray(line.selections) ||
            line.selections.length > 100
          )
            throw new Error("invalid line");
          const cartItemReference = String(parseCatalogReference(line.cartItemReference));
          if (seen.has(cartItemReference)) throw new Error("repeated line");
          seen.add(cartItemReference);
          lines.push(
            Object.freeze({
              cartItemReference,
              sellableReference: String(parseCatalogReference(line.sellableReference)),
              productVersionReference: String(parseCatalogReference(line.productVersionReference)),
              quantity: Number(line.quantity),
              selections: Object.freeze(
                (line.selections as unknown[]).map((selection) =>
                  parseRecipeOptionSelection(selection),
                ),
              ),
            }),
          );
        }
        const input = Object.freeze({
          lines: Object.freeze(lines),
          observedAt: String(parseCatalogInstant(raw.observedAt)),
        });
        if (input.lines.length === 0) return true;
        return await options.transactions.run(async (tx) => {
          if ((await options.authorize(tx, input)) !== true) throw new Error("unauthorized");
          const joined = {
            run: async <T>(work: (tx: InventoryItemTransaction) => Promise<T>) => work(tx),
          };
          const skus = createPostgresCurrentSkuStore(joined, {
            brandReference: scope.brandReference,
          });
          const recipes = createPostgresSaleRecipeDemandSource(joined, scope.brandReference);
          const contributions = [];
          for (const line of input.lines) {
            const sku = await skus.load({
              sellableReference: line.sellableReference,
              productVersionReference: line.productVersionReference,
              observedAt: input.observedAt,
            });
            // Not sellable as this version now: nothing of it can be made.
            if (sku === null || !sku.catalogEligible) return false;
            const recipe = await recipes.resolve({
              storeReference: scope.storeReference,
              skuReference: line.sellableReference,
              occurredAt: input.observedAt,
              saleUnitCode: sku.unitOfSale,
              unitQuantity: sku.unitQuantity,
              saleQuantity: line.quantity,
              selections: line.selections,
            });
            for (const item of recipe.requirements)
              contributions.push({
                itemReference: item.itemReference,
                configurationOperationReference: item.itemVersionReference,
                unitDimension: item.unitDimension,
                quantityNumerator: item.quantityNumerator,
                quantityDenominator: item.quantityDenominator,
                cartItemReference: line.cartItemReference,
              });
          }
          let covered = true;
          if (contributions.length > 0)
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
              covered = false;
            }
          if ((await options.authorize(tx, input)) !== true) throw new Error("authority withdrawn");
          return covered;
        });
      } catch {
        throw new CustomerRecipeInventoryObservationError();
      }
    },
  });
}
