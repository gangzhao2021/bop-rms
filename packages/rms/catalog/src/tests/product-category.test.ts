import { expect, it, vi } from "vitest";
import {
  parseProductCategoryClassification,
  validateProductCategoryClassification,
  parseCatalogReference,
  type ProductCategoryReferenceFact,
} from "../index.js";
const id = (n: number) =>
  parseCatalogReference(`018f4000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const value = () => ({ categoryReferences: [id(3), id(2)], primaryCategoryReference: id(3) });
const input = () => ({
  brandReference: id(1),
  categories: [2, 3].map((n) => ({
    categoryReference: id(n),
    brandReference: id(1),
    lifecycle: "Active" as const,
  })),
  policy: { allowedLifecycles: ["Active" as const] },
});
it("canonicalizes an unordered set without changing caller order", () => {
  const raw = value(),
    parsed = parseProductCategoryClassification(raw);
  expect(parsed.categoryReferences).toEqual([id(2), id(3)]);
  expect(raw.categoryReferences).toEqual([id(3), id(2)]);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.categoryReferences)).toBe(true);
});
it("explicit empty set differs from missing legacy value", () => {
  expect(
    parseProductCategoryClassification({ categoryReferences: [], primaryCategoryReference: null }),
  ).toEqual({ categoryReferences: [], primaryCategoryReference: null });
  for (const missing of [undefined, null, {}])
    expect(() => parseProductCategoryClassification(missing)).toThrow();
});
it.each([
  { categoryReferences: [id(2), id(2)], primaryCategoryReference: id(2) },
  { categoryReferences: [id(2)], primaryCategoryReference: id(3) },
  { categoryReferences: [], primaryCategoryReference: id(2) },
  { categoryReferences: ["INVALID"], primaryCategoryReference: null },
  { categoryReferences: "INVALID", primaryCategoryReference: null },
  { categoryReferences: [id(2)] },
  { primaryCategoryReference: null },
  { ...value(), categoryIds: [] },
  { ...value(), permission: "catalog.manage" },
])("rejects malformed/missing/duplicate/foreign primary classification %#", (raw) => {
  expect(() => parseProductCategoryClassification(raw)).toThrow();
});
it("rejects sparse, annotated and oversized arrays", () => {
  const annotated = Object.assign([id(2)], { safe: true });
  for (const refs of [new Array(2), annotated, new Array(10001).fill(id(2))])
    expect(() =>
      parseProductCategoryClassification({
        categoryReferences: refs,
        primaryCategoryReference: null,
      }),
    ).toThrow();
});
it("never executes field or array element accessors", () => {
  const getter = vi.fn(() => id(2)),
    raw = value();
  Object.defineProperty(raw, "primaryCategoryReference", { enumerable: true, get: getter });
  expect(() => parseProductCategoryClassification(raw)).toThrow();
  const refs = [id(2)];
  Object.defineProperty(refs, "0", { enumerable: true, get: getter });
  expect(() =>
    parseProductCategoryClassification({
      categoryReferences: refs,
      primaryCategoryReference: null,
    }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("validates explicit same-Brand current facts and owner lifecycle policy", () => {
  expect(validateProductCategoryClassification(value(), input()).primaryCategoryReference).toBe(
    id(3),
  );
});
it("Draft acceptance requires explicit Draft policy", () => {
  const scope = input(),
    categories: ProductCategoryReferenceFact[] = scope.categories.map((x) => ({
      ...x,
      lifecycle: "Draft",
    }));
  expect(() => validateProductCategoryClassification(value(), { ...scope, categories })).toThrow();
  expect(
    validateProductCategoryClassification(value(), {
      ...scope,
      categories,
      policy: { allowedLifecycles: ["Draft"] },
    }),
  ).toEqual(parseProductCategoryClassification(value()));
});
it.each(["Inactive", "Archived"] as const)("cannot assign %s category", (lifecycle) => {
  const scope = input();
  expect(() =>
    validateProductCategoryClassification(value(), {
      ...scope,
      categories: scope.categories.map((x) => ({ ...x, lifecycle })),
    }),
  ).toThrow();
});
it("missing Category fact is unavailable rather than an inferred assignment", () => {
  expect(() =>
    validateProductCategoryClassification(value(), { ...input(), categories: [] }),
  ).toThrowError(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});
it("rejects wrong Brand, duplicate facts and unsupported lifecycle policy", () => {
  const scope = input();
  const first = scope.categories[0];
  if (!first) throw new Error("synthetic Category fixture is incomplete");
  for (const categories of [[{ ...first, brandReference: id(9) }], [...scope.categories, first]])
    expect(() =>
      validateProductCategoryClassification(value(), { ...scope, categories }),
    ).toThrow();
  expect(() =>
    validateProductCategoryClassification(value(), {
      ...scope,
      policy: { allowedLifecycles: ["Archived"] },
    } as unknown as typeof scope),
  ).toThrow();
});
it("explicit deny-all policy rejects assignments but permits explicit empty value", () => {
  const scope = { ...input(), policy: { allowedLifecycles: [] } };
  expect(() => validateProductCategoryClassification(value(), scope)).toThrow();
  expect(
    validateProductCategoryClassification(
      { categoryReferences: [], primaryCategoryReference: null },
      scope,
    ).categoryReferences,
  ).toEqual([]);
});
it("source/policy descriptors cannot supply permission or execute accessors", () => {
  const scope = input(),
    getter = vi.fn(() => scope.categories);
  Object.defineProperty(scope, "categories", { enumerable: true, get: getter });
  expect(() => validateProductCategoryClassification(value(), scope)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("rejects lifecycle objects without executing conversions", () => {
  const scope = input(),
    convert = vi.fn(() => "Active");
  const categories = scope.categories.map((x) => ({ ...x, lifecycle: { toString: convert } }));
  expect(() =>
    validateProductCategoryClassification(value(), {
      ...scope,
      categories,
    } as unknown as typeof scope),
  ).toThrow();
  expect(convert).not.toHaveBeenCalled();
});
