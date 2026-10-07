import { describe, expect, it } from "vitest";
import {
  parseInventoryProductPublicationReferenceRequestV2,
  buildInventoryProductPublicationConfigurationReferenceSnapshotV2,
  buildInventoryProductPublicationSkuMappingReferenceSnapshotV2,
  matchInventoryProductPublicationSkuMappingReferenceGraphsV2 as match,
  matchInventorySkuMappingReferenceGraphs,
} from "../index.js";
import {
  mappingMatchId as id,
  mappingMatchAt as at,
  mappingMatchHash as hash,
  mappingMatchSource,
} from "./sku-mapping-reference-matches.fixture.js";
const legacy = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(4),
  catalogIntentDigest: hash,
};
const request = parseInventoryProductPublicationReferenceRequestV2({
  profile: "InventoryProductPublicationReferenceRequestV2",
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  actorKind: "User",
  operationReference: id(4),
  productReference: id(8),
  versionReference: id(9),
  originalIntentDigest: hash,
  replacementIntentDigest: hash,
  aggregateSnapshotDigest: hash,
  currentPublicationDigest: hash,
  observedAt: at,
  validUntil: "2026-09-29T12:00:05.000Z",
});
const target = {
  productReference: id(8),
  productVersionReference: id(9),
  skuReference: null,
  skuReferences: [id(10)],
  catalogConfigurationDigest: hash,
};
// Existing synthetic graph fixture is transported as raw owner rows; the V2
// production builder never calls a public Lifecycle/V1 parser.
function source(cleared = false) {
  const old = mappingMatchSource(legacy, hash, cleared),
    c = old.configuration;
  const items = c.items.map(
      ({ currentItemVersion: _v, currentOperationReference: _op, ...item }) => {
        void _v;
        void _op;
        return { ...item, precise: true };
      },
    ),
    versions = c.versions.map((v) => ({ ...v, itemVersion: String(v.itemVersion), precise: true })),
    operations = c.operations.map((o) => ({ ...o, itemVersion: String(o.itemVersion) }));
  const configuration = buildInventoryProductPublicationConfigurationReferenceSnapshotV2(
    {
      generation: c.generation,
      observedAt: at,
      counts: {
        items: String(items.length),
        versions: String(versions.length),
        operations: String(operations.length),
      },
      items,
      versions,
      operations,
    },
    request,
    at,
  );
  return buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
    {
      generation: old.generation,
      observedAt: at,
      count: String(old.mappings.length),
      mappings: old.mappings.map(
        ({ current: _current, sourceConfigurationState: _state, ...m }) => {
          void _current;
          void _state;
          return {
            ...m,
            mappingVersion: String(m.mappingVersion),
            sourceItemVersion: String(m.sourceItemVersion),
            precise: true,
          };
        },
      ),
    },
    configuration,
    request,
    at,
  );
}
describe("Inventory publication direct mapping matching", () => {
  it("keeps historical configuration, related Clear and unknown Item coverage without assigning stock/sale applicability", () => {
    const result = match({ request, source: source(true), targets: [target], now: at })[0];
    expect(result?.references[0]).toMatchObject({
      configurationMatch: "Matched",
      gaps: [],
      mapping: {
        sourceConfigurationOperationReference: id(7),
        sourceItemVersion: 1,
        current: false,
        sourceConfigurationState: "Historical",
      },
    });
    expect(result?.clears).toEqual([
      expect.objectContaining({
        action: "Clear",
        current: true,
        sourceItemVersion: 2,
        target: null,
      }),
    ]);
    expect(result?.unresolvedItemCoverage).toEqual([
      expect.objectContaining({
        itemReference: id(20),
        coverage: "NotRecorded",
        currentLink: "Unknown",
      }),
    ]);
    expect(result?.applicability).toBe("Unavailable");
    expect(result?.request).toEqual(request);
  });
  it("keeps each historical Product graph and reports different SKU, version and digest independently", () => {
    const results = match({
      request,
      source: source(),
      targets: [
        target,
        {
          ...target,
          productVersionReference: id(99),
          skuReferences: [id(98)],
          catalogConfigurationDigest: "sha256:" + "b".repeat(64),
        },
      ],
      now: at,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.references[0]?.configurationMatch).toBe("Matched");
    expect(results[1]?.references[0]?.gaps).toEqual([
      "ProductVersionNotInConfiguration",
      "SkuNotInConfiguration",
      "ConfigurationDigestChanged",
    ]);
    expect(results[1]?.references[0]?.mapping.target?.skuReference).toBe(id(10));
  });
  it("does not manufacture a matching tuple for a different selected SKU or Product", () => {
    const s = source();
    expect(
      match({ request, source: s, targets: [{ ...target, skuReference: id(91) }], now: at })[0]
        ?.references,
    ).toEqual([]);
    expect(() =>
      match({ request, source: s, targets: [{ ...target, productReference: id(92) }], now: at }),
    ).toThrow(expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }));
  });
  it("requires the original full binding and lease even for an empty match", () => {
    const s = source();
    for (const patch of [
      { replacementIntentDigest: "sha256:" + "b".repeat(64) },
      { aggregateSnapshotDigest: "sha256:" + "b".repeat(64) },
      { currentPublicationDigest: null },
      { operationReference: id(99) },
    ]) {
      expect(() =>
        match({ request: { ...request, ...patch }, source: s, targets: [target], now: at }),
      ).toThrow();
    }
    expect(() =>
      match({ request, source: s, targets: [target], now: request.validUntil }),
    ).toThrow();
    expect(() => match({ request, source: s, targets: [], now: at })).toThrow();
  });
  it("preserves legacy matching output and rejects cross-protocol source substitution", () => {
    const old = mappingMatchSource(legacy),
      v1 = matchInventorySkuMappingReferenceGraphs({
        request: legacy,
        source: old,
        targets: [target],
        now: at,
      })[0],
      v2 = match({ request, source: source(), targets: [target], now: at })[0];
    expect(v1?.references).toEqual(v2?.references);
    expect(v1?.unresolvedItemCoverage).toEqual(v2?.unresolvedItemCoverage);
    expect(() => match({ request, source: old, targets: [target], now: at })).toThrow();
  });
});
