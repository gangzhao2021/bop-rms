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
  createCustomerRecipeInventoryObservation,
  type CustomerRecipeInventoryObservationInput,
} from "./customer-recipe-inventory-observation.js";

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
      const observation = await createCustomerRecipeInventoryObservation({
        ...inventory,
        authorize: (tx, selection) => inventory.authorize(tx, selection, context),
      }).observe({
        sellableReference: result.sellableReference,
        productVersionReference: result.productVersionReference,
        quantity: context.quantity,
        selections,
        observedAt: result.validatedAt,
      });
      return observation.status === "Available"
        ? result
        : { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" };
    },
  });
}
