import { canonicalizeRfc8785 } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../domain/inventory-item.js";
import { calculateRecipeDemandQuantity } from "../domain/recipe-demand-quantity.js";
import { createInventoryRecipeItemSource } from "./recipe-item-source.js";
import type { InventoryItemPorts } from "./ports/inventory-item-ports.js";

export interface RecipeItemDemandContribution {
  readonly itemReference: string;
  readonly configurationOperationReference: string;
  readonly unitDimension: string;
  readonly quantityNumerator: string;
  readonly quantityDenominator: string;
}
function fail(): never {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
}
/** Observed per-item demand; contributions must already be converted to the pinned base unit. */
export function createInventoryRecipeDemandSource(
  repository: Pick<InventoryItemPorts["repository"], "load" | "resolveOperation">,
  scope: Readonly<{ tenantReference: string; brandReference: string }>,
) {
  const source = createInventoryRecipeItemSource(repository, scope);
  return Object.freeze({
    async resolve(contributions: readonly RecipeItemDemandContribution[], observedAtInput: string) {
      const observedAt = parseInventoryInstant(observedAtInput);
      if (
        !Array.isArray(contributions) ||
        contributions.length > 4096 ||
        Reflect.ownKeys(contributions).length !== contributions.length + 1
      )
        return fail();
      type Evidence = Awaited<ReturnType<typeof source.resolve>>;
      const evidenceCache = new Map<string, Evidence>();
      const groups = new Map<
        string,
        {
          evidence: Evidence;
          sources: Evidence[];
          indices: number[];
          quantities: { quantityNumerator: string; quantityDenominator: string }[];
        }
      >();
      for (let i = 0; i < contributions.length; i++) {
        const slot = Object.getOwnPropertyDescriptor(contributions, String(i));
        if (!slot?.enumerable || !("value" in slot)) return fail();
        const raw: unknown = slot.value;
        if (
          raw === null ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Object.prototype ||
          Reflect.ownKeys(raw).length !== 5
        )
          return fail();
        const fields: Record<string, unknown> = {};
        for (const field of [
          "itemReference",
          "configurationOperationReference",
          "unitDimension",
          "quantityNumerator",
          "quantityDenominator",
        ]) {
          const d = Object.getOwnPropertyDescriptor(raw, field);
          if (!d?.enumerable || !("value" in d)) return fail();
          fields[field] = d.value;
        }
        const itemReference = parseInventoryReference(fields.itemReference);
        const operation = parseInventoryReference(fields.configurationOperationReference);
        const key = itemReference + ":" + operation;
        let evidence = evidenceCache.get(key);
        if (!evidence) {
          evidence = await source.resolve({
            itemReference,
            configurationOperationReference: operation,
            observedAt,
          });
          evidenceCache.set(key, evidence);
        }
        if (
          fields.unitDimension !== evidence.baseUnit.dimension ||
          typeof fields.quantityNumerator !== "string" ||
          typeof fields.quantityDenominator !== "string"
        )
          return fail();
        let group = groups.get(itemReference);
        if (!group) {
          group = { evidence, sources: [], indices: [], quantities: [] };
          groups.set(itemReference, group);
        }
        if (
          group.evidence.currentItemVersion !== evidence.currentItemVersion ||
          canonicalizeRfc8785(group.evidence.baseUnit) !== canonicalizeRfc8785(evidence.baseUnit)
        )
          return fail();
        if (!group.sources.some((s) => s.sourceVersionReference === operation))
          group.sources.push(evidence);
        group.indices.push(i);
        group.quantities.push({
          quantityNumerator: fields.quantityNumerator,
          quantityDenominator: fields.quantityDenominator,
        });
      }
      return Object.freeze(
        [...groups.entries()].map(([itemReference, group]) =>
          Object.freeze({
            itemReference,
            currentItemVersion: group.evidence.currentItemVersion,
            trackingPolicy: group.evidence.trackingPolicy,
            observedAt,
            sources: Object.freeze(group.sources),
            contributionIndices: Object.freeze(group.indices),
            ...calculateRecipeDemandQuantity({
              unit: group.evidence.baseUnit,
              quantities: group.quantities,
            }),
          }),
        ),
      );
    },
  });
}
