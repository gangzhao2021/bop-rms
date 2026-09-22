import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  parseCartAggregate,
  parseOrderCatalogLineSnapshot,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import { createPostgresSubmissionRecipeDemandSource } from "@rms/recipe";
import {
  parseSubmissionInventoryFinalValidation,
  type InventoryItemTransaction,
  type RecipeItemDemandContribution,
  type SubmissionInventoryFinalValidation,
} from "@rms/inventory";

export class CustomerInventorySourceError extends Error {
  readonly code = "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE";
  constructor() {
    super("Inventory submission source is unavailable");
    this.name = "CustomerInventorySourceError";
  }
}
function fail(): never {
  throw new CustomerInventorySourceError();
}
/** Caller authorizes Ordering source and owns the transaction through final submission commit. */
export function createCustomerSubmissionInventorySource(
  transaction: InventoryItemTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  const recipe = createPostgresSubmissionRecipeDemandSource(
    { run: async (work) => work(transaction) },
    brand,
  );
  return Object.freeze({
    async resolve(
      input: Readonly<{ cart: unknown; lines: readonly unknown[]; observedAt: string }>,
    ) {
      try {
        const at = parseOrderingInstant(input.observedAt);
        const cart = parseCartAggregate(input.cart);
        if (
          cart.brandReference !== brand ||
          cart.storeReference !== store ||
          cart.updatedAt > at ||
          cart.items.length === 0 ||
          cart.lifecycle?.status !== "Active" ||
          cart.lifecycle.idleExpiresAt <= at ||
          cart.lifecycle.absoluteExpiresAt <= at ||
          !Array.isArray(input.lines) ||
          input.lines.length !== cart.items.length ||
          Reflect.ownKeys(input.lines).length !== input.lines.length + 1
        )
          return fail();
        const lines = new Map<string, ReturnType<typeof parseOrderCatalogLineSnapshot>>();
        for (let i = 0; i < input.lines.length; i++) {
          const slot = Object.getOwnPropertyDescriptor(input.lines, String(i));
          if (!slot?.enumerable || !("value" in slot)) return fail();
          const raw = readClosedRecord(
            slot.value,
            ["cartItemReference", "catalog", "pricing"],
            "ACTOR_SHAPE_INVALID",
          );
          const reference = parseOrderingReference(raw.cartItemReference);
          if (lines.has(reference)) return fail();
          lines.set(reference, parseOrderCatalogLineSnapshot(raw.catalog));
        }
        const contributions: RecipeItemDemandContribution[] = [];
        const evidence = [];
        for (const item of [...cart.items].sort((a, b) =>
          a.cartItemReference.localeCompare(b.cartItemReference),
        )) {
          const catalog = lines.get(item.cartItemReference);
          if (
            !catalog ||
            catalog.brandReference !== brand ||
            catalog.storeReference !== store ||
            catalog.sellableReference !== item.sellableReference ||
            catalog.skuReference !== item.sellableReference ||
            catalog.capturedAt > at ||
            catalog.options.length !== item.optionSelections.length ||
            catalog.menuVersionReference !== item.catalogSelectionEvidence?.menuVersionReference ||
            catalog.productVersionReference !==
              item.catalogSelectionEvidence.productVersionReference ||
            item.optionSelections.some(
              (selected) =>
                !catalog.options.some(
                  (option) =>
                    option.optionReference === selected.optionReference &&
                    option.quantity === selected.quantity,
                ),
            ) ||
            catalog.options.some(
              (option) =>
                !item.catalogSelectionEvidence?.ruleEvidence.some(
                  (rule) =>
                    rule.bindingReference === option.bindingReference &&
                    rule.optionSetVersionReference === option.optionSetVersionReference,
                ),
            )
          )
            return fail();
          const demand = await recipe.resolve({
            storeReference: store,
            skuReference: catalog.skuReference,
            occurredAt: at,
            saleUnitCode: catalog.unitOfSale,
            unitQuantity: catalog.unitQuantity,
            saleQuantity: item.quantity,
            selections: catalog.options.map((option) => ({
              bindingReference: option.bindingReference,
              optionReference: option.optionReference,
              quantity: option.quantity,
            })),
          });
          for (const requirement of demand.requirements) {
            if (contributions.length >= 4096) return fail();
            contributions.push(
              Object.freeze({
                itemReference: requirement.itemReference,
                configurationOperationReference: requirement.itemVersionReference,
                unitDimension: requirement.unitDimension,
                quantityNumerator: requirement.quantityNumerator,
                quantityDenominator: requirement.quantityDenominator,
              }),
            );
          }
          evidence.push(
            Object.freeze({
              cartItemReference: item.cartItemReference,
              skuReference: catalog.skuReference,
              quantity: item.quantity,
              unitOfSale: catalog.unitOfSale,
              unitQuantity: catalog.unitQuantity,
              catalogSnapshotReference: catalog.snapshotReference,
              catalogSnapshotDigest: catalog.snapshotDigest,
              recipeBindingReference: demand.bindingReference,
              recipeVersionReference: demand.snapshot.versionReference,
              recipeSnapshotDigest: demand.snapshot.snapshotDigest,
              graph: Object.freeze(
                demand.graph.map((node) =>
                  Object.freeze({
                    recipeReference: node.recipeReference,
                    versionReference: node.versionReference,
                    snapshotDigest: node.snapshotDigest,
                  }),
                ),
              ),
              appliedRules: demand.appliedRules,
            }),
          );
        }
        const source = Object.freeze({
          brandReference: brand,
          storeReference: store,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          observedAt: at,
          lines: Object.freeze(evidence),
          contributions: Object.freeze(contributions),
        });
        return Object.freeze({
          ...source,
          sourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
        });
      } catch {
        return fail();
      }
    },
  });
}

/**
 * Source adapter for the Inventory final writer. Caller supplies the actual locked Order Cart/lines
 * and independently validated Workflow/disposition record; this adapter re-resolves Recipe facts.
 * It does not authorize Workflow timing or a request-supplied Cart.
 */
export function createCustomerSubmissionFinalInventoryRecipeSource(
  transaction: InventoryItemTransaction,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  ordering: Readonly<{ cart: unknown; lines: readonly unknown[] }>,
) {
  const tenant = String(parseOrderingReference(scope.tenantReference));
  const recipe = createCustomerSubmissionInventorySource(transaction, scope);
  return Object.freeze({
    async resolve(proposal: SubmissionInventoryFinalValidation) {
      try {
        const record = parseSubmissionInventoryFinalValidation(proposal);
        if (
          record.tenantReference !== tenant ||
          record.brandReference !== scope.brandReference ||
          record.storeReference !== scope.storeReference
        )
          return fail();
        const source = await recipe.resolve({ ...ordering, observedAt: record.observedAt });
        if (
          String(source.cartReference) !== String(record.cartReference) ||
          source.cartVersion !== record.cartVersion
        )
          return fail();
        return Object.freeze({ record, contributions: source.contributions });
      } catch {
        return fail();
      }
    },
  });
}
