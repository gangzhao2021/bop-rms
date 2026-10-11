import {
  createPostgresCurrentSelectionFactsStore,
  parseCatalogInstant,
  parseCatalogReference,
  publishedDefaultOptionSelections,
  type CurrentAvailabilityQueryInput,
  type PublishedDefaultOptionSelection,
} from "@rms/catalog";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
  SubmissionExpiryCutoff,
} from "@rms/inventory";
import { parseRecipeOptionSelection } from "@rms/recipe";
import { createCustomerRecipeInventoryObservation } from "./customer-recipe-inventory-observation.js";

/** How long a stock observation stays valid; the menu and cart read it again after that. */
export const customerInventoryEvidenceValidityMilliseconds = 60_000;
/**
 * Most items observed in one menu read. Each costs a few owner reads (SKU, Recipe demand, stock
 * candidates per stocked ingredient) in the one shared transaction; items past the bound are left
 * unobserved (shown available; add-to-cart still checks the exact selection against stock).
 */
export const customerMenuInventoryMaximumItems = 200;

/** One item as normally ordered: its published product version and default option choices. */
export interface CustomerMenuInventoryItem {
  readonly sellableReference: string;
  readonly productVersionReference: string;
  readonly defaultOptionSelections: readonly PublishedDefaultOptionSelection[];
}

/** Catalog's Inventory safety evidence for one item at the Store. */
export interface CustomerInventoryEvidence {
  readonly kind: "Inventory";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sellableReference: string;
  /** Unavailable: one of the item as normally ordered cannot be made from current stock. */
  readonly status: "Available" | "Unavailable" | "Indeterminate";
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly reasonCode: "STOCK_AVAILABLE" | "STOCK_DEPLETED" | "STOCK_UNOBSERVED";
}

export interface CustomerInventoryEvidenceSource {
  /**
   * Observes each item in the caller's read-only (Repeatable Read) transaction, never writing a
   * rule or holding stock. An item whose stock cannot be observed (no Recipe, missing SKU, read
   * failure) is Indeterminate, which never marks it sold out on the menu.
   */
  observe(
    transaction: InventoryItemTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly observedAt: string;
      readonly items: readonly CustomerMenuInventoryItem[];
    },
  ): Promise<ReadonlyMap<string, CustomerInventoryEvidence>>;
}

/**
 * WP-2423 Q12: automatic sold-out, computed on read. Whether one of each item, with its default
 * choices, can be made from the Store's current stock — the same SKU → Recipe demand → stock plan
 * read add-to-cart uses for the customer's exact selection. Nothing is stored: when stock is
 * received or a hold is released the item is available again on the next read.
 */
export function createCustomerInventoryEvidence(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly stockSiteReference: string;
  };
  readonly resolveExpiryCutoff: SubmissionExpiryCutoff;
  readonly validityMilliseconds?: number;
  readonly maximumItems?: number;
}): CustomerInventoryEvidenceSource {
  const scope = Object.freeze({
    tenantReference: String(parseCatalogReference(options.scope.tenantReference)),
    brandReference: String(parseCatalogReference(options.scope.brandReference)),
    storeReference: String(parseCatalogReference(options.scope.storeReference)),
    stockSiteReference: String(parseCatalogReference(options.scope.stockSiteReference)),
  });
  const validity = options.validityMilliseconds ?? customerInventoryEvidenceValidityMilliseconds;
  const maximum = options.maximumItems ?? customerMenuInventoryMaximumItems;
  const source: CustomerInventoryEvidenceSource = {
    async observe(transaction, input) {
      const observedAt = String(parseCatalogInstant(input.observedAt));
      const expiresAt = new Date(Date.parse(observedAt) + validity).toISOString();
      const evidence = (
        sellableReference: string,
        status: CustomerInventoryEvidence["status"],
      ): CustomerInventoryEvidence =>
        Object.freeze({
          kind: "Inventory" as const,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          sellableReference,
          status,
          observedAt,
          expiresAt,
          reasonCode:
            status === "Available"
              ? ("STOCK_AVAILABLE" as const)
              : status === "Unavailable"
                ? ("STOCK_DEPLETED" as const)
                : ("STOCK_UNOBSERVED" as const),
        });
      const result = new Map<string, CustomerInventoryEvidence>();
      if (
        input.brandReference !== scope.brandReference ||
        input.storeReference !== scope.storeReference
      )
        return result;
      // The menu read already resolved the public Store; the observation returns only a status for
      // a published item, so the public read is authorized by that Store scope alone.
      const observation = createCustomerRecipeInventoryObservation({
        scope,
        transactions: { run: async (work) => work(transaction) },
        authorize: async () => true,
        resolveExpiryCutoff: options.resolveExpiryCutoff,
      });
      let observed = 0;
      for (const item of input.items) {
        if (result.has(item.sellableReference)) continue;
        if (observed >= maximum) {
          result.set(item.sellableReference, evidence(item.sellableReference, "Indeterminate"));
          continue;
        }
        observed++;
        try {
          const found = await observation.observe({
            sellableReference: item.sellableReference,
            productVersionReference: item.productVersionReference,
            quantity: 1,
            selections: item.defaultOptionSelections.map((selection) =>
              parseRecipeOptionSelection({
                bindingReference: selection.bindingReference,
                optionReference: selection.optionReference,
                quantity: selection.quantity,
              }),
            ),
            observedAt,
          });
          result.set(item.sellableReference, evidence(item.sellableReference, found.status));
        } catch {
          // No Recipe, an ineligible SKU or a failed read: unknown, never shown as sold out.
          result.set(item.sellableReference, evidence(item.sellableReference, "Indeterminate"));
        }
      }
      return result;
    },
  };
  return Object.freeze(source);
}

/**
 * Catalog's Inventory safety port for add-to-cart, Quote and checkout: the same observation as the
 * menu for the item as normally ordered on the published menu, so the menu, cart and checkout agree.
 * The exact selection and quantity are still checked against stock separately.
 */
export function createCustomerCatalogInventoryPort(options: {
  readonly evidence: CustomerInventoryEvidenceSource;
  /** Repeatable Read, read-only transactions scoped to the Store. */
  readonly transactions: InventoryItemTransactionRunner;
  readonly menuReference: string;
  readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web";
}) {
  return Object.freeze({
    async loadEvidence(request: CurrentAvailabilityQueryInput) {
      const orderType = request.orderTypeCode === "DINE_IN" ? "DineIn" : "Pickup";
      return options.transactions.run(async (tx) => {
        const scope = {
          brandReference: request.brandReference,
          storeReference: request.storeReference,
        };
        let item: CustomerMenuInventoryItem | null = null;
        try {
          const facts = await createPostgresCurrentSelectionFactsStore(
            { run: async (work) => work(tx as never) },
            scope,
          ).load({
            ...scope,
            sourceChannel: options.sourceChannel,
            orderType,
            sellableReference: request.sellableReference,
            observedAt: request.observedAt,
            menuReference: options.menuReference,
            channelCode: request.channelCode,
            orderTypeCode: request.orderTypeCode,
          });
          if (facts !== null)
            item = {
              sellableReference: request.sellableReference,
              productVersionReference: facts.published.productVersionReference,
              defaultOptionSelections: publishedDefaultOptionSelections(
                facts.published.optionRules ?? [],
                request.channelCode,
              ),
            };
        } catch {
          item = null;
        }
        if (item === null)
          // Not on the current published menu: stock unknown (Catalog refuses the item anyway).
          return Object.freeze({
            kind: "Inventory" as const,
            ...scope,
            sellableReference: request.sellableReference,
            status: "Indeterminate" as const,
            observedAt: request.observedAt,
            expiresAt: new Date(
              Date.parse(request.observedAt) + customerInventoryEvidenceValidityMilliseconds,
            ).toISOString(),
            reasonCode: "STOCK_UNOBSERVED" as const,
          });
        const observed = await options.evidence.observe(tx, {
          ...scope,
          observedAt: request.observedAt,
          items: [item],
        });
        return observed.get(request.sellableReference) ?? null;
      });
    },
  });
}
