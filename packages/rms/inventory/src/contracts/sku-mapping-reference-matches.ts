import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { InventoryItemError, parseInventoryReference } from "../domain/inventory-item.js";
import {
  parseInventoryConfigurationReferenceRequest,
  inventoryConfigurationReferenceMaximumRows,
  type InventoryConfigurationReferenceRequest,
} from "./configuration-reference-source.js";
import { parseInventorySkuMappingReferenceSnapshot } from "./sku-mapping-reference-source.js";
/** Caller transports individually validated owning Catalog reference configurations.
 * Matching is reference metadata only; it provides neither a held source nor authority. */
export interface InventorySkuMappingReferenceTarget {
  readonly productReference: string;
  readonly productVersionReference: string;
  readonly skuReference: string | null;
  readonly skuReferences: readonly string[];
  readonly catalogConfigurationDigest: string;
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    return d?.enumerable && "value" in d ? d.value : fail();
  });
}
function target(value: unknown): InventorySkuMappingReferenceTarget {
  const r = exact(value, [
      "productReference",
      "productVersionReference",
      "skuReference",
      "skuReferences",
      "catalogConfigurationDigest",
    ]),
    skus = list(r.skuReferences, 1000).map(parseInventoryReference);
  if (
    new Set(skus).size !== skus.length ||
    typeof r.catalogConfigurationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(r.catalogConfigurationDigest)
  )
    return fail();
  return Object.freeze({
    productReference: parseInventoryReference(r.productReference),
    productVersionReference: parseInventoryReference(r.productVersionReference),
    skuReference: r.skuReference === null ? null : parseInventoryReference(r.skuReference),
    skuReferences: Object.freeze(skus.sort()),
    catalogConfigurationDigest: r.catalogConfigurationDigest,
  });
}
/** Complete stored Set tuples are kept independently for every target graph.
 * A current mapping can point to a historical Item configuration or an older Catalog
 * graph. Neither state is converted into active stock or sale applicability. */
export function matchInventorySkuMappingReferenceGraphs(input: {
  readonly request: InventoryConfigurationReferenceRequest;
  readonly targets: unknown;
  readonly source: unknown;
  readonly now: string;
}) {
  try {
    const request = parseInventoryConfigurationReferenceRequest(input.request),
      source = parseInventorySkuMappingReferenceSnapshot(input.source, request, input.now),
      targets = list(input.targets, 1000).map(target);
    if (targets.length === 0) return fail();
    let budget =
      source.mappings.length +
      source.configuration.items.length +
      source.configuration.versions.length +
      source.configuration.operations.length;
    const results = targets.map((t) => {
      budget += 1 + t.skuReferences.length;
      const related = source.mappings.filter(
        (m) =>
          m.target?.productReference === t.productReference &&
          (t.skuReference === null || m.target.skuReference === t.skuReference),
      );
      budget += related.length;
      if (budget > inventoryConfigurationReferenceMaximumRows) return fail();
      const references = Object.freeze(
        related.map((mapping) => {
          const tuple = mapping.target;
          if (!tuple) return fail();
          const gaps = Object.freeze([
            ...(tuple.productVersionReference === t.productVersionReference
              ? []
              : ["ProductVersionNotInConfiguration" as const]),
            ...(t.skuReferences.includes(tuple.skuReference)
              ? []
              : ["SkuNotInConfiguration" as const]),
            ...(tuple.catalogConfigurationDigest === t.catalogConfigurationDigest
              ? []
              : ["ConfigurationDigestChanged" as const]),
          ]);
          return Object.freeze({
            mapping,
            configurationMatch: gaps.length === 0 ? ("Matched" as const) : ("Unresolved" as const),
            gaps,
          });
        }),
      );
      // Clear has no Product tuple. Keep clears only for Items with an actual
      // related stored Set; never manufacture a relationship for unknown Items.
      const itemIds = new Set(related.map((m) => m.itemReference));
      const clears = Object.freeze(
        source.mappings.filter((m) => m.action === "Clear" && itemIds.has(m.itemReference)),
      );
      budget += clears.length;
      if (budget > inventoryConfigurationReferenceMaximumRows) return fail();
      const body = {
        request,
        target: t,
        coverage: "CompleteStoredDirectMappingReferences" as const,
        applicability: "Unavailable" as const,
        inventorySourceDigest: source.digest,
        inventoryGeneration: source.generation,
        references,
        clears,
        unresolvedItemCoverage: Object.freeze(
          source.items.filter((i) => i.coverage === "NotRecorded"),
        ),
      };
      budget += body.unresolvedItemCoverage.length;
      if (budget > inventoryConfigurationReferenceMaximumRows) return fail();
      return Object.freeze({
        ...body,
        digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
        observedAt: source.observedAt,
      });
    });
    return Object.freeze(results);
  } catch {
    return fail();
  }
}
