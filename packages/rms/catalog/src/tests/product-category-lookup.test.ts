import { it, expect, vi } from "vitest";
import {
  parseCatalogReference,
  parseCategoryAggregate,
  categorySourceDigest,
  deriveCatalogProductCategoryLookup,
  parseCatalogProductCategoryLookup,
  type CategorySourceSnapshot,
} from "../index.js";
const id = (n: number) =>
    parseCatalogReference("01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = "2026-09-28T12:00:00.000Z",
  brand = id(1);
function source(): CategorySourceSnapshot {
  const categories = (["Draft", "Active", "Inactive", "Archived"] as const).map((lifecycle, n) =>
    parseCategoryAggregate({
      categoryReference: id(10 + n),
      brandReference: brand,
      internalCode: ["CAT_2", "CAT-2", "INACTIVE", "ARCHIVED"][n],
      lifecycle,
      aggregateVersion: 1,
      defaultLocale: "en-CA",
      localizedNames: {
        "en-CA": "Synthetic " + n,
        ...(n === 1 ? { "fr-CA": "Choix synthétique" } : {}),
      },
      localizedDescriptions: {},
      parentCategoryReference: null,
      level: 1,
      sortOrder: n,
      storeReferences: [],
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(2),
    }),
  );
  const core = { brandReference: brand, sourceRevision: "4", categories };
  return { ...core, observedAt: at, sourceDigest: categorySourceDigest(core) };
}
const make = (policy: unknown = { allowedLifecycles: ["Draft", "Active"] }) =>
  deriveCatalogProductCategoryLookup(source(), "CAT-PRODUCT-CREATE", "fr-CA", policy, at);
it("derives current Brand choices with explicit policy, fallback and minimal public fields", () => {
  const view = make();
  expect(view.items.map((item) => item.internalCode)).toEqual(["CAT-2", "CAT_2"]);
  expect(view.items[0]).toMatchObject({
    name: "Choix synthétique",
    nameLocale: "fr-CA",
    localeFallback: false,
  });
  expect(view.items[1]).toMatchObject({ nameLocale: "en-CA", localeFallback: true });
  expect(view.projection.partial).toBe(true);
  expect(Object.isFrozen(view.items[0])).toBe(true);
  expect(JSON.stringify(view)).not.toContain(id(2));
  expect(JSON.stringify(view)).not.toContain("storeReferences");
  expect(JSON.stringify(view)).not.toContain("productCount");
  expect(JSON.stringify(view)).not.toContain("menuUse");
});
it("distinguishes known policy-empty choices from missing policy", () => {
  expect(make({ allowedLifecycles: [] }).items).toEqual([]);
  expect(() =>
    deriveCatalogProductCategoryLookup(source(), "CAT-PRODUCT-EDIT", "en-CA", undefined, at),
  ).toThrow();
  expect(make({ allowedLifecycles: ["Active"] }).items.map((item) => item.lifecycle)).toEqual([
    "Active",
  ]);
});
it.each([
  null,
  {},
  { allowedLifecycles: ["Archived"] },
  { allowedLifecycles: ["Draft", "Draft"] },
  { allowedLifecycles: ["Active"], permission: "Allow" },
])("rejects unsupported policy %#", (policy) => {
  expect(() => make(policy)).toThrow();
});
it.each(["digest", "future", "stale", "foreign", "hidden-graph", "sparse"])(
  "rejects incomplete or stale source %s before filtering",
  (kind) => {
    const data = source() as unknown as {
      sourceDigest: string;
      observedAt: string;
      categories: Record<string, unknown>[];
    };
    if (kind === "digest") data.sourceDigest = "sha256:" + "a".repeat(64);
    if (kind === "future") data.observedAt = "2026-09-28T12:00:00.001Z";
    const completed = kind === "stale" ? "2026-09-28T12:00:05.001Z" : at;
    if (kind === "foreign")
      data.categories = data.categories.map((node, n) =>
        n === 3 ? { ...node, brandReference: id(99) } : node,
      );
    if (kind === "hidden-graph")
      data.categories = data.categories.map((node, n) =>
        n === 3 ? { ...node, parentCategoryReference: id(99), level: 2 } : node,
      );
    if (kind === "sparse") data.categories = new Array(1);
    expect(() =>
      deriveCatalogProductCategoryLookup(
        data as unknown as CategorySourceSnapshot,
        "CAT-PRODUCT-EDIT",
        "en-CA",
        { allowedLifecycles: ["Active"] },
        completed,
      ),
    ).toThrow();
  },
);
it.each([
  "parent",
  "extra",
  "duplicate",
  "lifecycle",
  "policy",
  "fallback",
  "digest",
  "time",
  "order",
])("rejects closed lookup DTO drift %s", (kind) => {
  const data = JSON.parse(JSON.stringify(make()));
  if (kind === "parent") data.parentScreenId = "CAT-CATEGORY-TREE";
  if (kind === "extra") data.permission = "Allow";
  if (kind === "duplicate") data.items.push(data.items[0]);
  if (kind === "lifecycle") data.items[0].lifecycle = "Archived";
  if (kind === "policy") data.policy.allowedLifecycles = [];
  if (kind === "fallback") data.items[0].localeFallback = true;
  if (kind === "digest") data.source.digest = "wrong";
  if (kind === "time") data.source.asOfUtc = "2026-09-28T12:00:00.001Z";
  if (kind === "order") data.items.reverse();
  expect(() => parseCatalogProductCategoryLookup(data)).toThrow();
});
it("never executes source or policy accessors", () => {
  const data = { ...source() },
    getter = vi.fn(() => "sha256:" + "a".repeat(64));
  Object.defineProperty(data, "sourceDigest", { get: getter, enumerable: true });
  expect(() =>
    deriveCatalogProductCategoryLookup(
      data,
      "CAT-PRODUCT-CREATE",
      "en-CA",
      { allowedLifecycles: ["Active"] },
      at,
    ),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
