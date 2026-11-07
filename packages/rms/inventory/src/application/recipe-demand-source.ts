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

export type RecipeLineDemandContribution = RecipeItemDemandContribution & {
  readonly cartItemReference: string;
};
const micro = (value: string) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
};
const decimalOf = (value: bigint) => {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return (value / 1_000_000n).toString() + (fraction ? "." + fraction : "");
};

/**
 * WP-2423 per-line demand: each Order line is resolved and rounded on its own, so what one line
 * reserves is exactly what that line later consumes. Item totals are the sum of the rounded line
 * quantities, keeping reservation totals, final validation and consumption equal.
 */
export function createInventoryRecipeLineDemandSource(
  repository: Pick<InventoryItemPorts["repository"], "load" | "resolveOperation">,
  scope: Readonly<{ tenantReference: string; brandReference: string }>,
) {
  const source = createInventoryRecipeDemandSource(repository, scope);
  return Object.freeze({
    async resolve(contributions: readonly RecipeLineDemandContribution[], observedAt: string) {
      if (
        !Array.isArray(contributions) ||
        contributions.length > 4096 ||
        Reflect.ownKeys(contributions).length !== contributions.length + 1
      )
        return fail();
      const byLine = new Map<
        string,
        { indices: number[]; parts: RecipeItemDemandContribution[] }
      >();
      for (let i = 0; i < contributions.length; i++) {
        const c = contributions[i];
        if (!c || typeof c.cartItemReference !== "string") return fail();
        const line = parseInventoryReference(c.cartItemReference);
        let group = byLine.get(line);
        if (!group) {
          group = { indices: [], parts: [] };
          byLine.set(line, group);
        }
        group.indices.push(i);
        group.parts.push(
          Object.freeze({
            itemReference: c.itemReference,
            configurationOperationReference: c.configurationOperationReference,
            unitDimension: c.unitDimension,
            quantityNumerator: c.quantityNumerator,
            quantityDenominator: c.quantityDenominator,
          }),
        );
      }
      const lines = [];
      for (const cartItemReference of [...byLine.keys()].sort()) {
        const group = byLine.get(cartItemReference);
        if (!group) return fail();
        const requirements = (await source.resolve(group.parts, observedAt)).map((r) =>
          Object.freeze({
            ...r,
            contributionIndices: Object.freeze(
              r.contributionIndices.map((index) => {
                const original = group.indices[index];
                return original === undefined ? fail() : original;
              }),
            ),
          }),
        );
        lines.push(Object.freeze({ cartItemReference, requirements: Object.freeze(requirements) }));
      }
      type Requirement = (typeof lines)[number]["requirements"][number];
      const totals = new Map<string, Requirement>();
      for (const line of lines)
        for (const r of line.requirements) {
          const prior = totals.get(r.itemReference);
          if (!prior) {
            totals.set(r.itemReference, r);
            continue;
          }
          if (
            prior.currentItemVersion !== r.currentItemVersion ||
            canonicalizeRfc8785(prior.unit) !== canonicalizeRfc8785(r.unit) ||
            canonicalizeRfc8785(prior.trackingPolicy) !== canonicalizeRfc8785(r.trackingPolicy)
          )
            return fail();
          const n1 = BigInt(prior.exactMicrounitsNumerator),
            d1 = BigInt(prior.exactMicrounitsDenominator),
            n2 = BigInt(r.exactMicrounitsNumerator),
            d2 = BigInt(r.exactMicrounitsDenominator);
          totals.set(
            r.itemReference,
            Object.freeze({
              ...prior,
              sources: Object.freeze([
                ...prior.sources,
                ...r.sources.filter(
                  (s) =>
                    !prior.sources.some(
                      (p) => p.sourceVersionReference === s.sourceVersionReference,
                    ),
                ),
              ]),
              contributionIndices: Object.freeze(
                [...prior.contributionIndices, ...r.contributionIndices].sort((a, b) => a - b),
              ),
              quantity: decimalOf(micro(prior.quantity) + micro(r.quantity)),
              exactMicrounitsNumerator: (n1 * d2 + n2 * d1).toString(),
              exactMicrounitsDenominator: (d1 * d2).toString(),
              roundingApplied: prior.roundingApplied || r.roundingApplied,
            }),
          );
        }
      return Object.freeze({
        lines: Object.freeze(lines),
        requirements: Object.freeze([...totals.values()]),
      });
    },
  });
}
