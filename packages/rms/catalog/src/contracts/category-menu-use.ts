import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import {
  copyCategoryPersistenceValue,
  validateCategoryTreeSnapshot,
} from "./category-persistence.js";
import {
  categorySourceDigest,
  categorySourceRevision,
  type CategorySourceSnapshot,
} from "./category-source.js";
import {
  parseMenuCategorySourceSnapshot,
  type MenuCategorySourceSnapshot,
} from "./menu-category-source.js";
import { productListRecord, productListInteger } from "./product-list.js";
export const categoryMenuReviewStates = Object.freeze([
  "NoPersistedLifecycle",
  "Draft",
  "InReview",
  "Approved",
  "Published",
  "Archived",
  "Superseded",
] as const);
export type CategoryMenuMeasure =
  { readonly status: "Unavailable" } | { readonly status: "Known"; readonly menuCount: number };
export type CategoryMenuUse =
  | { readonly status: "Unavailable" }
  | {
      readonly status: "Known" | "Partial";
      readonly draftMenuCount: number;
      readonly reviewed: {
        readonly total: CategoryMenuMeasure;
        readonly byLifecycle: Readonly<
          Record<(typeof categoryMenuReviewStates)[number], CategoryMenuMeasure>
        >;
      };
    };
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export function parseCategoryMenuUse(
  value: unknown,
  coverage?: "Known" | "Unavailable",
): CategoryMenuUse {
  try {
    const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
    if (coverage === undefined) {
      if (productListRecord(raw, ["status"]).status !== "Unavailable") return fail();
      return Object.freeze({ status: "Unavailable" });
    }
    const row = productListRecord(raw, ["status", "draftMenuCount", "reviewed"]),
      draftMenuCount = productListInteger(row.draftMenuCount);
    if (draftMenuCount > 10000 || row.status !== (coverage === "Known" ? "Known" : "Partial"))
      return fail();
    const measure = (value: unknown): CategoryMenuMeasure => {
      const packet = value as Record<string, unknown>;
      if (packet?.status === "Unavailable") {
        if (coverage === "Known") return fail();
        productListRecord(packet, ["status"]);
        return Object.freeze({ status: "Unavailable" });
      }
      const parsed = productListRecord(packet, ["status", "menuCount"]),
        menuCount = productListInteger(parsed.menuCount);
      if (parsed.status !== "Known" || menuCount > 10000) return fail();
      return Object.freeze({ status: "Known", menuCount });
    };
    const reviewed = productListRecord(row.reviewed, ["total", "byLifecycle"]),
      total = measure(reviewed.total);
    const groups = productListRecord(reviewed.byLifecycle, categoryMenuReviewStates);
    const byLifecycle = Object.freeze(
      Object.fromEntries(categoryMenuReviewStates.map((state) => [state, measure(groups[state])])),
    ) as Readonly<Record<(typeof categoryMenuReviewStates)[number], CategoryMenuMeasure>>;
    const partial = Object.values(byLifecycle).some((packet) => packet.status === "Unavailable");
    if ((total.status === "Unavailable") !== partial || (coverage === "Unavailable") !== partial)
      return fail();
    if (total.status === "Known") {
      const counts = Object.values(byLifecycle).map((packet) =>
        packet.status === "Known" ? packet.menuCount : fail(),
      );
      if (
        counts.some((n) => n > total.menuCount) ||
        counts.reduce((a, b) => a + b, 0) < total.menuCount
      )
        return fail();
    }
    return Object.freeze({
      status: partial ? "Partial" : "Known",
      draftMenuCount,
      reviewed: Object.freeze({ total, byLifecycle }),
    });
  } catch {
    return fail();
  }
}
/** Counts references, not publication approval or effective Store applicability.
 * This intentionally leaves generic Empty/Used policy to its accepted definition. */
export function deriveCategoryMenuUse(
  menuValue: MenuCategorySourceSnapshot,
  categoryValue: CategorySourceSnapshot,
) {
  const raw = productListRecord(copyCategoryPersistenceValue(categoryValue), [
    "brandReference",
    "sourceRevision",
    "observedAt",
    "categories",
    "sourceDigest",
  ]);
  const brand = parseCatalogReference(raw.brandReference),
    at = parseCatalogInstant(raw.observedAt),
    revision = categorySourceRevision(raw.sourceRevision);
  const categories = validateCategoryTreeSnapshot(raw.categories, brand, 10000);
  if (
    raw.sourceDigest !==
      categorySourceDigest({ brandReference: brand, sourceRevision: revision, categories }) ||
    categories.some((node) => node.updatedAt > at)
  )
    return fail();
  const menu = parseMenuCategorySourceSnapshot(menuValue, brand, at),
    refs = new Set(categories.map((node) => node.categoryReference));
  const measures = new Map<
    string,
    { draft: Set<string>; reviewed: Set<string>; groups: Map<string, Set<string>> }
  >(
    categories.map((node) => [
      node.categoryReference,
      {
        draft: new Set<string>(),
        reviewed: new Set<string>(),
        groups: new Map<string, Set<string>>(),
      },
    ]),
  );
  const unknownStates = new Set<string>();
  for (const item of menu.menus) {
    const draftRefs = new Set(
      item.draftCategoryBindings.flatMap((binding) => binding.categoryReferences),
    );
    for (const ref of draftRefs) {
      if (!refs.has(ref)) return fail();
      measures.get(ref)?.draft.add(item.menuReference);
    }
    for (const review of item.reviewedSnapshots) {
      if (!review.categoryBindings) {
        unknownStates.add(review.lifecycle ?? "NoPersistedLifecycle");
        continue;
      }
      for (const ref of new Set(
        review.categoryBindings.flatMap((binding) => binding.categoryReferences),
      )) {
        const measure = measures.get(ref);
        if (!measure) return fail();
        measure.reviewed.add(item.menuReference);
        const key = review.lifecycle ?? "NoPersistedLifecycle",
          set = measure.groups.get(key) ?? new Set<string>();
        set.add(item.menuReference);
        measure.groups.set(key, set);
      }
    }
  }
  return Object.freeze({
    source: Object.freeze({
      digest: menu.sourceDigest,
      asOfUtc: menu.observedAt,
      consistency: "StatementSnapshot" as const,
      reviewCategoryCoverage: menu.reviewCategoryCoverage,
    }),
    categories: Object.freeze(
      categories.map((node) => {
        const measure = measures.get(node.categoryReference);
        if (!measure) return fail();
        return Object.freeze({
          categoryReference: node.categoryReference,
          menuUse: parseCategoryMenuUse(
            {
              status: menu.reviewCategoryCoverage === "Known" ? "Known" : "Partial",
              draftMenuCount: measure.draft.size,
              reviewed: {
                total:
                  menu.reviewCategoryCoverage === "Known"
                    ? { status: "Known", menuCount: measure.reviewed.size }
                    : { status: "Unavailable" },
                byLifecycle: Object.fromEntries(
                  categoryMenuReviewStates.map((key) => [
                    key,
                    unknownStates.has(key)
                      ? { status: "Unavailable" }
                      : { status: "Known", menuCount: measure.groups.get(key)?.size ?? 0 },
                  ]),
                ),
              },
            },
            menu.reviewCategoryCoverage,
          ),
        });
      }),
    ),
  });
}
