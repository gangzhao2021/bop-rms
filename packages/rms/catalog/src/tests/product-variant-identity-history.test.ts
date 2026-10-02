import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import {
  buildProductVariantIdentityHistory,
  parseProductVariantIdentityHistorySnapshot,
  assertProductVariantIdentityHistory,
} from "../contracts/product-variant-identity-history.js";
const id = (n: number) => `019a2421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-30T03:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function candidate(full = true) {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "VARIANT_HISTORY",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic" },
          variantSelections: [{ dimensionReference: id(6), valueReference: id(7) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      ...(full
        ? {
            editorContent: {
              profile: "CatalogProductEditorContentV1",
              localizedShortDescriptions: {},
              localizedDescriptions: { "en-CA": "Private synthetic note omitted from source" },
              preparationNotes: {},
              tagReferences: [],
              attributeValues: [],
              media: [],
              variantDimensions: [
                {
                  dimensionReference: id(6),
                  code: "SIZE",
                  localizedNames: { "en-CA": "Size" },
                  sortOrder: 0,
                  selectionRequirement: "Required",
                  values: [
                    {
                      valueReference: id(7),
                      code: "SMALL",
                      localizedNames: { "en-CA": "Small" },
                      sortOrder: 0,
                      attributeReference: null,
                      mediaReference: null,
                    },
                  ],
                },
              ],
              variantCombinations: [
                {
                  selections: [{ dimensionReference: id(6), valueReference: id(7) }],
                  disposition: "Valid",
                  skuReference: id(5),
                },
              ],
              optionRules: [],
              allergenReferences: [],
              nutritionProfile: null,
            },
          }
        : {}),
    },
  });
}
function fixture(full = true) {
  const aggregate = candidate(full),
    request = {
      productReference: id(1),
      expectedAggregateVersion: 1,
      originalIntentDigest: hash("actual candidate intent"),
    };
  const source = {
    aggregateVersion: 1,
    observedAt: at,
    history: [
      { aggregate, operationReference: id(9), snapshotDigest: hash(aggregate), coherent: true },
    ],
  };
  return { aggregate, request, source };
}
it("derives complete minimal used identities without content prose or sale eligibility", () => {
  const f = fixture(),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  expect(snapshot.used).toEqual([
    { dimensionReference: id(6), dimensionCode: "SIZE", valueReference: id(7), valueCode: "SMALL" },
  ]);
  expect(snapshot.eligibility).toBe("NotEvaluated");
  expect(JSON.stringify(snapshot)).not.toContain("Private synthetic");
  expect(parseProductVariantIdentityHistorySnapshot(snapshot)).toEqual(snapshot);
  expect(() => assertProductVariantIdentityHistory(f.aggregate, snapshot)).not.toThrow();
});
it("retains legacy SKU identities with unknown codes, without inventing definitions", () => {
  const f = fixture(false),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  expect(snapshot.used[0]?.dimensionCode).toBeNull();
  expect(snapshot.used[0]?.valueCode).toBeNull();
  expect(() => assertProductVariantIdentityHistory(candidate(), snapshot)).not.toThrow();
});
it.each(["dimension", "value", "remove"])(
  "refuses historical %s reinterpretation or removal",
  (kind) => {
    const f = fixture(),
      snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request),
      changed = structuredClone(f.aggregate);
    if (!changed.draft.editorContent) throw new Error("Missing fixture content");
    if (kind === "remove") {
      Object.assign(changed.draft.editorContent, {
        variantDimensions: [],
        variantCombinations: [],
      });
      Object.assign(changed.draft.skus[0] ?? {}, { variantSelections: [] });
    } else {
      const d = changed.draft.editorContent.variantDimensions[0];
      if (!d) throw new Error("Missing fixture dimension");
      if (kind === "dimension") Object.assign(d, { code: "NEW_CODE" });
      else Object.assign(d.values[0] ?? {}, { code: "NEW_CODE" });
    }
    expect(() => assertProductVariantIdentityHistory(changed, snapshot)).toThrow();
  },
);
it.each(["gap", "digest", "coherence", "brand", "future", "duplicate"])(
  "refuses %s in committed history",
  (kind) => {
    const f = fixture(),
      source = structuredClone(f.source),
      row = source.history[0];
    if (!row) throw new Error("Missing fixture history");
    if (kind === "gap") source.history = [];
    if (kind === "digest") row.snapshotDigest = hash("tampered");
    if (kind === "coherence") row.coherent = false;
    if (kind === "brand") {
      Object.assign(row.aggregate, { brandReference: id(99) });
      row.snapshotDigest = hash(row.aggregate);
    }
    if (kind === "future") source.observedAt = "2026-09-29T00:00:00.000Z";
    if (kind === "duplicate") source.history.push(row);
    expect(() => buildProductVariantIdentityHistory(source, id(2), f.request)).toThrow();
  },
);
it("refuses unbound candidate Brand/Product/root and snapshot digest changes", () => {
  const f = fixture(),
    snapshot = buildProductVariantIdentityHistory(f.source, id(2), f.request);
  for (const patch of [
    { productReference: id(99) },
    { brandReference: id(99) },
    { aggregateVersion: 4 },
  ])
    expect(() =>
      assertProductVariantIdentityHistory({ ...f.aggregate, ...patch }, snapshot),
    ).toThrow();
  expect(() =>
    parseProductVariantIdentityHistorySnapshot({
      ...snapshot,
      originalIntentDigest: hash("other intent"),
    }),
  ).toThrow();
});
it("does not invoke historical aggregate accessors", () => {
  const f = fixture(),
    getter = vi.fn(() => f.aggregate),
    row = { ...f.source.history[0] };
  Object.defineProperty(row, "aggregate", { enumerable: true, get: getter });
  expect(() =>
    buildProductVariantIdentityHistory({ ...f.source, history: [row] }, id(2), f.request),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("preserves earlier usage even after the current SKU stops selecting it", () => {
  const f = fixture(),
    changed = structuredClone(f.aggregate);
  if (!changed.draft.editorContent) throw new Error("Missing fixture content");
  Object.assign(changed, { aggregateVersion: 2 });
  Object.assign(changed.draft.editorContent, { variantDimensions: [], variantCombinations: [] });
  Object.assign(changed.draft.skus[0] ?? {}, { variantSelections: [] });
  const source = {
    ...f.source,
    aggregateVersion: 2,
    history: [
      ...f.source.history,
      {
        aggregate: changed,
        operationReference: id(10),
        snapshotDigest: hash(changed),
        coherent: true,
      },
    ],
  };
  const snapshot = buildProductVariantIdentityHistory(source, id(2), {
    ...f.request,
    expectedAggregateVersion: 2,
  });
  expect(snapshot.used).toHaveLength(1);
  expect(() => assertProductVariantIdentityHistory(changed, snapshot)).toThrow();
});
it("refuses historical dimension code reuse on a different used value", () => {
  const f = fixture(),
    changed = structuredClone(f.aggregate);
  const d = changed.draft.editorContent?.variantDimensions[0],
    c = changed.draft.editorContent?.variantCombinations[0];
  if (!d || !c) throw new Error("Missing fixture mapping");
  Object.assign(changed, { aggregateVersion: 2 });
  Object.assign(d, { code: "REINTERPRETED" });
  Object.assign(d.values[0] ?? {}, { valueReference: id(8) });
  Object.assign(c, { selections: [{ dimensionReference: id(6), valueReference: id(8) }] });
  Object.assign(changed.draft.skus[0] ?? {}, {
    variantSelections: [{ dimensionReference: id(6), valueReference: id(8) }],
  });
  const source = {
    ...f.source,
    aggregateVersion: 2,
    history: [
      ...f.source.history,
      {
        aggregate: changed,
        operationReference: id(10),
        snapshotDigest: hash(changed),
        coherent: true,
      },
    ],
  };
  expect(() =>
    buildProductVariantIdentityHistory(source, id(2), {
      ...f.request,
      expectedAggregateVersion: 2,
    }),
  ).toThrow();
});
