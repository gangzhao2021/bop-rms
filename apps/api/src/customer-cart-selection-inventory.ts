import { AsyncLocalStorage } from "node:async_hooks";
import {
  CatalogError,
  createCatalogSelectionValidationService,
  createCurrentCatalogSelectionSource,
  createCurrentAvailabilityQueryService,
  createPostgresAvailabilityQueryStore,
  createPostgresCurrentSelectionFactsStore,
  type CurrentCatalogSelectionSnapshot,
  type createPostgresCatalogSelectionService,
} from "@rms/catalog";
import type { PickupCartItemOptions } from "@rms/ordering";
import { parseRecipeOptionSelection } from "@rms/recipe";
import {
  createCustomerRecipeInventoryCoverage,
  createCustomerRecipeInventoryObservation,
  type CustomerRecipeInventoryCoverageInput,
  type CustomerRecipeInventoryObservationInput,
} from "./customer-recipe-inventory-observation.js";
import {
  cartDisplayArguments,
  type CustomerCartPort,
  type CustomerCartPortResult,
} from "./customer-cart.js";

type Catalog = PickupCartItemOptions["catalog"];
type Context = Parameters<Catalog["validateSelection"]>[1];
type InventoryOptions = Parameters<typeof createCustomerRecipeInventoryObservation>[0];
export type CustomerCartSelectionInventoryOptions = Omit<InventoryOptions, "authorize"> & {
  authorize(
    transaction: Parameters<InventoryOptions["authorize"]>[0],
    input: CustomerRecipeInventoryObservationInput,
    context: Context,
  ): Promise<boolean>;
};

/** Each validation owns its snapshot and authorization context. Inventory is an
 * observation only; submission still owns final validation and reservation.
 */
export function createCustomerCartSelectionInventory(
  runner: Parameters<typeof createPostgresCatalogSelectionService>[0],
  scope: Parameters<typeof createPostgresCatalogSelectionService>[1],
  safety: Parameters<typeof createPostgresCatalogSelectionService>[2],
  inventory: CustomerCartSelectionInventoryOptions,
): Catalog {
  if (
    inventory.scope.brandReference !== scope.brandReference ||
    inventory.scope.storeReference !== scope.storeReference
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const ownerScope = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const snapshots = createCurrentCatalogSelectionSource(
    {
      facts: createPostgresCurrentSelectionFactsStore(runner, ownerScope),
      availability: createCurrentAvailabilityQueryService(
        {
          rules: createPostgresAvailabilityQueryStore(runner, ownerScope),
          killSwitch: safety.killSwitch,
          inventory: safety.inventory,
          clock: safety.clock,
        },
        ownerScope,
      ),
      clock: safety.clock,
    },
    scope,
  );
  return Object.freeze({
    async validateSelection(input, context) {
      const captured: { snapshot: CurrentCatalogSelectionSnapshot | null } = { snapshot: null };
      const result = await createCatalogSelectionValidationService({
        snapshots: {
          async resolveCurrent(request) {
            const snapshot = await snapshots.resolveCurrent(request);
            captured.snapshot = snapshot;
            return snapshot;
          },
        },
      }).validateSelection(input);
      if (result.status !== "Accepted") return result;
      const snapshot = captured.snapshot;
      if (snapshot === null) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      const selections = result.optionSelections.map((selected) => {
        const matches = snapshot.rules.filter((rule) =>
          rule.options.some((option) => option.optionReference === selected.optionReference),
        );
        const rule = matches[0];
        if (matches.length !== 1 || rule === undefined)
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        return parseRecipeOptionSelection({
          bindingReference: rule.bindingReference,
          optionReference: selected.optionReference,
          quantity: selected.quantity,
        });
      });
      const observer = createCustomerRecipeInventoryObservation({
        ...inventory,
        authorize: (tx, selection) => inventory.authorize(tx, selection, context),
      });
      const covers = async (quantity: number) =>
        (
          await observer.observe({
            sellableReference: result.sellableReference,
            productVersionReference: result.productVersionReference,
            quantity,
            selections,
            observedAt: result.validatedAt,
          })
        ).status === "Available";
      if (await covers(context.quantity)) return result;
      const shortage = selectionShortage.getStore();
      if (shortage !== undefined) shortage.available = await mostCovered(context.quantity, covers);
      return { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" };
    },
  });
}

/** WP-2423: how many the stock makes when it refused the quantity asked for a Cart item. */
const selectionShortage = new AsyncLocalStorage<{ available: number | null }>();

/** The largest quantity below `asked` the stock covers (0: none); null when that can't be read. */
async function mostCovered(
  asked: number,
  covers: (quantity: number) => Promise<boolean>,
): Promise<number | null> {
  try {
    let low = 0,
      high = asked - 1;
    // Stock demand grows with quantity, so the largest covered quantity is found by halving.
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (await covers(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  } catch {
    return null;
  }
}

/**
 * WP-2423: a Cart port whose add and quantity change, when refused because the Store's stock can't
 * make the quantity asked, say so (`ITEM_SHORT`) with how many it can make, so the guest is told
 * the count instead of "can't be ordered as selected".
 */
export function withCartItemStockShortage(port: CustomerCartPort): CustomerCartPort {
  const told = async (work: () => Promise<CustomerCartPortResult>) => {
    const shortage: { available: number | null } = { available: null };
    const result = await selectionShortage.run(shortage, work);
    return result.status === "SelectionInvalid" && shortage.available !== null
      ? ({
          status: "SelectionInvalid",
          issueCodes: ["ITEM_SHORT"],
          available: shortage.available,
        } as const)
      : result;
  };
  return Object.freeze({
    createCart: (input, locale) => port.createCart(input, ...cartDisplayArguments(locale)),
    getCurrentCart: (input, locale) => port.getCurrentCart(input, ...cartDisplayArguments(locale)),
    getCart: (input, locale) => port.getCart(input, ...cartDisplayArguments(locale)),
    addItem: (input, locale) => told(() => port.addItem(input, ...cartDisplayArguments(locale))),
    updateItem: (input, locale) =>
      told(() => port.updateItem(input, ...cartDisplayArguments(locale))),
    removeItem: (input, locale) => port.removeItem(input, ...cartDisplayArguments(locale)),
  } satisfies CustomerCartPort);
}

/** WP-2423: one Cart line for {@link createCustomerCartStockCoverage}. */
export interface CustomerCartStockLine {
  readonly cartItemReference: string;
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionSelections: readonly { optionReference: string; quantity: number }[];
}
export type CustomerCartStockCoverageOptions = Omit<
  Parameters<typeof createCustomerRecipeInventoryCoverage>[0],
  "authorize"
> & {
  authorize(
    transaction: Parameters<
      Parameters<typeof createCustomerRecipeInventoryCoverage>[0]["authorize"]
    >[0],
    input: CustomerRecipeInventoryCoverageInput,
  ): Promise<boolean>;
};

/**
 * WP-2423: Inventory's answer for Ordering's checkout whether the Store's stock covers a Cart's
 * lines together (two items sharing an ingredient count against one stock). Each item's current
 * product version and option bindings come from the Catalog's current selection snapshot; an item
 * the Catalog no longer offers (sold out for even one, or off the menu) is not covered. One
 * instance serves one checkout validation (snapshots are kept for its repeated questions).
 */
export function createCustomerCartStockCoverage(
  runner: Parameters<typeof createPostgresCatalogSelectionService>[0],
  scope: Parameters<typeof createPostgresCatalogSelectionService>[1],
  safety: Parameters<typeof createPostgresCatalogSelectionService>[2],
  inventory: CustomerCartStockCoverageOptions,
) {
  if (
    inventory.scope.brandReference !== scope.brandReference ||
    inventory.scope.storeReference !== scope.storeReference
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const ownerScope = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const snapshots = createCurrentCatalogSelectionSource(
    {
      facts: createPostgresCurrentSelectionFactsStore(runner, ownerScope),
      availability: createCurrentAvailabilityQueryService(
        {
          rules: createPostgresAvailabilityQueryStore(runner, ownerScope),
          killSwitch: safety.killSwitch,
          inventory: safety.inventory,
          clock: safety.clock,
        },
        ownerScope,
      ),
      clock: safety.clock,
    },
    scope,
  );
  const coverage = createCustomerRecipeInventoryCoverage(inventory);
  const current = new Map<string, Promise<CurrentCatalogSelectionSnapshot | null>>();
  const snapshotOf = (sellableReference: string, observedAt: string) => {
    const key = sellableReference + "@" + observedAt;
    let found = current.get(key);
    if (found === undefined) {
      found = snapshots.resolveCurrent({
        brandReference: scope.brandReference as never,
        storeReference: scope.storeReference as never,
        sourceChannel: scope.sourceChannel,
        orderType: scope.orderType,
        sellableReference: sellableReference as never,
        observedAt: observedAt as never,
      });
      current.set(key, found);
    }
    return found;
  };
  return Object.freeze({
    async covers(input: {
      readonly lines: readonly CustomerCartStockLine[];
      readonly observedAt: string;
    }): Promise<boolean> {
      const lines = [];
      for (const line of input.lines) {
        const snapshot = await snapshotOf(line.sellableReference, input.observedAt);
        if (snapshot === null) return false;
        const selections = line.optionSelections.map((selected) => {
          const matches = snapshot.rules.filter((rule) =>
            rule.options.some((option) => option.optionReference === selected.optionReference),
          );
          const rule = matches[0];
          if (matches.length !== 1 || rule === undefined)
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          return parseRecipeOptionSelection({
            bindingReference: rule.bindingReference,
            optionReference: selected.optionReference,
            quantity: selected.quantity,
          });
        });
        lines.push({
          cartItemReference: line.cartItemReference,
          sellableReference: line.sellableReference,
          productVersionReference: String(snapshot.productVersionReference),
          quantity: line.quantity,
          selections,
        });
      }
      return coverage.covers({ lines, observedAt: input.observedAt });
    },
  });
}
