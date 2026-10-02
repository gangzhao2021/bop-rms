import { describe, it, expect } from "vitest";
import { matchInventorySkuMappingReferenceGraphs as match } from "../index.js";
import {
  mappingMatchId as id,
  mappingMatchAt as at,
  mappingMatchHash as hash,
  mappingMatchSource as source,
} from "./sku-mapping-reference-matches.fixture.js";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(4),
  catalogIntentDigest: hash,
};
const target = {
  productReference: id(8),
  productVersionReference: id(9),
  skuReference: null,
  skuReferences: [id(10)],
  catalogConfigurationDigest: hash,
};
const run = (targets: unknown = [target], s: unknown = source(request), now = at) =>
  match({ request, targets, source: s, now });
const failed = expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" });
describe("Inventory direct mapping reference matching", () => {
  it("keeps current mapping to historical Item configuration separate from applicability", () => {
    const result = run()[0];
    expect(result?.references[0]).toMatchObject({
      configurationMatch: "Matched",
      gaps: [],
      mapping: { current: true, sourceConfigurationState: "Historical", sourceItemVersion: 1 },
    });
    expect(result?.applicability).toBe("Unavailable");
    expect(result?.unresolvedItemCoverage).toEqual([
      expect.objectContaining({
        itemReference: id(20),
        coverage: "NotRecorded",
        currentLink: "Unknown",
      }),
    ]);
  });
  it("preserves related Clear history without making unrecorded Items related", () => {
    const result = run([target], source(request, hash, true))[0];
    expect(result?.references[0]?.mapping.current).toBe(false);
    expect(result?.clears[0]).toMatchObject({ current: true, action: "Clear", target: null });
    expect(result?.clears).toHaveLength(1);
  });
  it("keeps version, SKU and configuration mismatches independently", () => {
    expect(
      run([
        {
          ...target,
          productVersionReference: id(19),
          skuReferences: [id(11)],
          catalogConfigurationDigest: "sha256:" + "b".repeat(64),
        },
      ])[0]?.references[0]?.gaps,
    ).toEqual([
      "ProductVersionNotInConfiguration",
      "SkuNotInConfiguration",
      "ConfigurationDigestChanged",
    ]);
  });
  it("filters independent Product and selected SKU scopes", () => {
    const results = run([
      { ...target, productReference: id(99) },
      { ...target, skuReference: id(11) },
    ]);
    expect(results.every((r) => r.references.length === 0 && r.clears.length === 0)).toBe(true);
  });
  it("matches each graph independently and keeps absent selected SKU unresolved", () => {
    const results = run([target, { ...target, skuReference: id(10), skuReferences: [] }]);
    expect(results[0]?.references[0]?.gaps).toEqual([]);
    expect(results[1]?.references[0]?.gaps).toEqual(["SkuNotInConfiguration"]);
  });
  it("does not invoke target accessors", () => {
    let calls = 0;
    const t = { ...target };
    Object.defineProperty(t, "skuReferences", {
      enumerable: true,
      get() {
        calls++;
        return [id(10)];
      },
    });
    expect(() => run([t])).toThrow(failed);
    expect(calls).toBe(0);
  });
  it.each(
    [
      [],
      [{ ...target, extra: true }],
      [{ ...target, skuReferences: [id(10), id(10)] }],
      [{ ...target, catalogConfigurationDigest: "invalid" }],
      Array(1001).fill(target),
    ].map((targets) => ({ targets })),
  )("refuses invalid target batch %#", ({ targets }) => expect(() => run(targets)).toThrow(failed));
  it("refuses stale, substituted scope and altered source identity", () => {
    expect(() => run([target], source(request), "2026-09-29T12:00:06.000Z")).toThrow(failed);
    expect(() => run([target], { ...source(request), digest: hash })).toThrow(failed);
    expect(() => run([target], source({ ...request, tenantReference: id(99) }))).toThrow(failed);
  });
  it("bounds aggregate output amplification across graphs", () =>
    expect(() =>
      run(
        Array(1000).fill({
          ...target,
          skuReferences: Array.from({ length: 20 }, (_, i) => id(100 + i)),
        }),
      ),
    ).toThrow(failed));
  it("stable identity excludes fresh observation time", () => {
    const later = "2026-09-29T12:00:01.000Z",
      a = run()[0],
      b = run([target], source(request, hash, false, later), later)[0];
    expect(a?.digest).toBe(b?.digest);
    expect(Object.isFrozen(a?.references)).toBe(true);
  });
});
