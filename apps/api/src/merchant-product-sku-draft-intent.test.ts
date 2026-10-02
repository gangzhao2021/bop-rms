import { expect, it } from "vitest";
import { deriveProductDraftSkuMutationIntent } from "./merchant-product-write-authority.js";
import { parseProductAggregate, type ProductVersion } from "@rms/catalog";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "SKU_INTENT",
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
      localizedNames: { "en-CA": "Original" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      optionBindings: [],
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ORIGINAL",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Original SKU" },
          variantSelections: [
            { dimensionReference: id(10), valueReference: id(11) },
            { dimensionReference: id(12), valueReference: id(13) },
          ],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  });
  const change = (fields: Record<string, unknown>) => ({
    ...aggregate.draft,
    skus: aggregate.draft.skus.map((sku) => ({ ...sku, ...fields })),
  });
  return { aggregate, change };
}
it("Product-only edit and variant order do not fabricate SKU mutation", () => {
  const f = fixture();
  const draft = {
    ...f.aggregate.draft,
    localizedNames: { "en-CA": "Product changed" },
    skus: f.aggregate.draft.skus.map((sku) => ({
      ...sku,
      variantSelections: [...sku.variantSelections].reverse(),
    })),
  };
  expect(deriveProductDraftSkuMutationIntent(f.aggregate, draft)).toEqual({
    createdSkuReferences: [],
    updatedSkuReferences: [],
  });
});
it.each(["name", "variant"])("actual SKU %s change requires update for exact stable ID", (kind) => {
  const f = fixture();
  const changed =
    kind === "name"
      ? f.change({ localizedNames: { "en-CA": "Changed" } })
      : f.change({ variantSelections: [{ dimensionReference: id(10), valueReference: id(21) }] });
  expect(deriveProductDraftSkuMutationIntent(f.aggregate, changed)).toEqual({
    createdSkuReferences: [],
    updatedSkuReferences: [id(5)],
  });
});
it("new SKU and existing SKU edit have independent immutable targets", () => {
  const f = fixture();
  const sku = f.aggregate.draft.skus[0];
  if (!sku) throw new Error("Missing synthetic SKU");
  const draft = {
    ...f.change({ localizedNames: { "en-CA": "Changed" } }),
    skus: [
      { ...sku, localizedNames: { "en-CA": "Changed" } },
      { ...sku, skuReference: id(6), skuCode: "NEW", variantSelections: [] },
    ],
  };
  const intent = deriveProductDraftSkuMutationIntent(f.aggregate, draft);
  expect(intent).toEqual({ createdSkuReferences: [id(6)], updatedSkuReferences: [id(5)] });
  expect(Object.isFrozen(intent)).toBe(true);
  expect(Object.isFrozen(intent.createdSkuReferences)).toBe(true);
});
it("removing an existing Draft SKU still targets its update authority", () => {
  const f = fixture();
  expect(
    deriveProductDraftSkuMutationIntent(f.aggregate, { ...f.aggregate.draft, skus: [] }),
  ).toEqual({ createdSkuReferences: [], updatedSkuReferences: [id(5)] });
});
it.each([
  { lifecycle: "Active" },
  { skuCode: "OTHER" },
  { unitOfSale: "KG" },
  { unitQuantity: "2" },
  { brandReference: id(90) },
  { productReference: id(90) },
])("does not treat action/identity/scope changes as an ordinary edit %s", (fields) => {
  const f = fixture();
  expect(() => deriveProductDraftSkuMutationIntent(f.aggregate, f.change(fields))).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});
it("new SKU must be Draft, not a caller activation", () => {
  const f = fixture();
  expect(() =>
    deriveProductDraftSkuMutationIntent(
      f.aggregate,
      f.change({ skuReference: id(6), skuCode: "NEW", lifecycle: "Active" }),
    ),
  ).toThrow();
});
it("requires exact Draft version and closed body rather than permission assertions", () => {
  const f = fixture();
  for (const draft of [
    { ...f.aggregate.draft, versionReference: id(90) },
    { ...f.aggregate.draft, permission: "Allow" },
  ])
    expect(() => deriveProductDraftSkuMutationIntent(f.aggregate, draft)).toThrow();
});
it("server-owned creation metadata does not grant or invent a configuration change", () => {
  const f = fixture();
  expect(
    deriveProductDraftSkuMutationIntent(
      f.aggregate,
      f.change({
        createdAt: "2026-09-29T00:00:00.000Z",
        createdByActorReference: id(90),
      }) as ProductVersion,
    ),
  ).toEqual({ createdSkuReferences: [], updatedSkuReferences: [] });
});
