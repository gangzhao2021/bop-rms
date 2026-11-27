import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { parsePublishingDigest } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseMenuCategoryBindings,
  type MenuCategoryBinding,
} from "../domain/menu-category-bindings.js";

export const menuCategorySourceFields = Object.freeze([
  "menuReference",
  "menuVersionReference",
  "sectionReference",
  "categoryReferences",
  "reviewLifecycle",
  "reviewCategoryCoverage",
] as const);
export type MenuCategoryReviewState =
  "Draft" | "InReview" | "Approved" | "Published" | "Archived" | "Superseded";
export interface MenuCategorySourceSnapshot {
  readonly brandReference: string;
  readonly consistency: "StatementSnapshot";
  readonly observedAt: string;
  readonly sourceDigest: string;
  readonly reviewCategoryCoverage: "Known" | "Unavailable";
  readonly menus: readonly {
    readonly menuReference: string;
    readonly aggregateVersion: number;
    readonly draftVersionReference: string;
    readonly draftCategoryBindings: readonly MenuCategoryBinding[];
    readonly reviewedSnapshots: readonly {
      readonly lifecycleReference: string;
      readonly menuVersionReference: string;
      readonly snapshotDigest: string;
      /** Null means no persisted publication lifecycle, not an invented Draft. */
      readonly lifecycle: MenuCategoryReviewState | null;
      readonly lifecycleVersion: number | null;
      readonly categoryBindings?: readonly MenuCategoryBinding[];
    }[];
  }[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function rows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10000) return fail();
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return fail();
  return value as number;
}
/** Parse only a complete single-statement owner result. This pure validator does
 * not authorize a caller or turn authored packets into current source evidence. */
export function buildMenuCategorySourceSnapshot(
  value: unknown,
  expectedBrand: string,
  now: string,
): MenuCategorySourceSnapshot {
  try {
    const brand = parseCatalogReference(expectedBrand),
      at = parseCatalogInstant(now);
    const raw = record(copyCategoryPersistenceValue(value), [
      "observedAt",
      "roots",
      "drafts",
      "sections",
      "bindings",
      "reviews",
      "revisions",
    ]);
    const observedAt = parseCatalogInstant(raw.observedAt);
    if (observedAt > at || Date.parse(at) - Date.parse(observedAt) > 5000) return fail();
    const roots = new Map<
      string,
      { aggregateVersion: number; createdAt: string; updatedAt: string }
    >();
    for (const item of rows(raw.roots)) {
      const root = record(item, [
        "menuReference",
        "brandReference",
        "aggregateVersion",
        "createdAt",
        "updatedAt",
        "precise",
      ]);
      const menu = parseCatalogReference(root.menuReference),
        createdAt = parseCatalogInstant(root.createdAt),
        updatedAt = parseCatalogInstant(root.updatedAt);
      if (
        root.brandReference !== brand ||
        root.precise !== true ||
        roots.has(menu) ||
        createdAt > updatedAt ||
        updatedAt > observedAt
      )
        return fail();
      roots.set(menu, { aggregateVersion: version(root.aggregateVersion), createdAt, updatedAt });
    }
    const drafts = new Map<string, string>(),
      versions = new Set<string>();
    for (const item of rows(raw.drafts)) {
      const row = record(item, [
        "menuReference",
        "brandReference",
        "menuVersionReference",
        "status",
        "createdAt",
        "updatedAt",
        "precise",
      ]);
      const menu = parseCatalogReference(row.menuReference),
        ref = parseCatalogReference(row.menuVersionReference),
        root = roots.get(menu);
      const createdAt = parseCatalogInstant(row.createdAt),
        updatedAt = parseCatalogInstant(row.updatedAt);
      if (
        !root ||
        row.brandReference !== brand ||
        row.status !== "Draft" ||
        row.precise !== true ||
        drafts.has(menu) ||
        versions.has(ref) ||
        createdAt > updatedAt ||
        updatedAt > root.updatedAt ||
        createdAt < root.createdAt
      )
        return fail();
      drafts.set(menu, ref);
      versions.add(ref);
    }
    if (drafts.size !== roots.size) return fail();
    const sections = new Map<string, { menu: string; references: string[] }>();
    for (const item of rows(raw.sections)) {
      const row = record(item, [
        "menuReference",
        "brandReference",
        "menuVersionReference",
        "sectionReference",
      ]);
      const menu = parseCatalogReference(row.menuReference),
        section = parseCatalogReference(row.sectionReference);
      if (
        row.brandReference !== brand ||
        drafts.get(menu) !== row.menuVersionReference ||
        sections.has(section)
      )
        return fail();
      sections.set(section, { menu, references: [] });
    }
    for (const item of rows(raw.bindings)) {
      const row = record(item, [
        "menuReference",
        "brandReference",
        "sectionReference",
        "categoryReference",
      ]);
      const section = sections.get(parseCatalogReference(row.sectionReference)),
        category = parseCatalogReference(row.categoryReference);
      if (
        !section ||
        row.brandReference !== brand ||
        section.menu !== row.menuReference ||
        section.references.includes(category)
      )
        return fail();
      section.references.push(category);
    }
    const revisions = new Map<
      string,
      {
        menu: string;
        version: string;
        digest: string;
        state: MenuCategoryReviewState;
        lifecycleVersion: number;
      }
    >();
    for (const item of rows(raw.revisions)) {
      const row = record(item, [
        "lifecycleReference",
        "menuReference",
        "brandReference",
        "menuVersionReference",
        "snapshotDigest",
        "state",
        "lifecycleVersion",
        "revisionCount",
        "firstVersion",
        "coherent",
      ]);
      const lifecycle = parseCatalogReference(row.lifecycleReference),
        menu = parseCatalogReference(row.menuReference),
        ref = parseCatalogReference(row.menuVersionReference);
      const lifecycleVersion = version(row.lifecycleVersion),
        snapshotDigest = parsePublishingDigest(row.snapshotDigest);
      const firstVersion = version(row.firstVersion);
      if (
        row.brandReference !== brand ||
        !roots.has(menu) ||
        revisions.has(lifecycle) ||
        row.coherent !== true ||
        firstVersion > lifecycleVersion ||
        row.revisionCount !== lifecycleVersion - firstVersion + 1 ||
        !["Draft", "InReview", "Approved", "Published", "Archived", "Superseded"].includes(
          row.state as string,
        )
      )
        return fail();
      revisions.set(lifecycle, {
        menu,
        version: ref,
        digest: snapshotDigest,
        state: row.state as MenuCategoryReviewState,
        lifecycleVersion,
      });
    }
    const reviews = new Map<
      string,
      MenuCategorySourceSnapshot["menus"][number]["reviewedSnapshots"][number][]
    >();
    const seen = new Set<string>();
    let known = true;
    for (const item of rows(raw.reviews)) {
      const row = record(item, [
        "lifecycleReference",
        "menuReference",
        "brandReference",
        "menuVersionReference",
        "snapshotDigest",
        "createdAt",
        "coherent",
        "sectionReferences",
        "hasCategoryBindings",
        "categoryBindings",
      ]);
      const lifecycleReference = parseCatalogReference(row.lifecycleReference),
        menu = parseCatalogReference(row.menuReference),
        menuVersionReference = parseCatalogReference(row.menuVersionReference);
      const snapshotDigest = parsePublishingDigest(row.snapshotDigest),
        createdAt = parseCatalogInstant(row.createdAt);
      const root = roots.get(menu),
        revision = revisions.get(lifecycleReference);
      if (
        !root ||
        drafts.get(menu) !== menuVersionReference ||
        seen.has(lifecycleReference) ||
        row.brandReference !== brand ||
        row.coherent !== true ||
        createdAt < root.createdAt ||
        createdAt > observedAt ||
        (revision &&
          (revision.menu !== menu ||
            revision.version !== menuVersionReference ||
            revision.digest !== snapshotDigest)) ||
        typeof row.hasCategoryBindings !== "boolean"
      )
        return fail();
      seen.add(lifecycleReference);
      const sectionReferences = rows(row.sectionReferences).map(parseCatalogReference);
      if (new Set(sectionReferences).size !== sectionReferences.length) return fail();
      if (!row.hasCategoryBindings && row.categoryBindings !== null) return fail();
      const categoryBindings = row.hasCategoryBindings
        ? parseMenuCategoryBindings(row.categoryBindings, sectionReferences)
        : undefined;
      if (categoryBindings === undefined) known = false;
      const values = reviews.get(menu) ?? [];
      values.push(
        Object.freeze({
          lifecycleReference,
          menuVersionReference,
          snapshotDigest,
          lifecycle: revision?.state ?? null,
          lifecycleVersion: revision?.lifecycleVersion ?? null,
          ...(categoryBindings === undefined ? {} : { categoryBindings }),
        }),
      );
      reviews.set(menu, values);
    }
    if ([...revisions.keys()].some((ref) => !seen.has(ref))) return fail();
    const menus = Object.freeze(
      [...roots.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([menuReference, root]) => {
          const draftVersionReference = drafts.get(menuReference);
          if (!draftVersionReference) return fail();
          const owned = [...sections.entries()].filter(([, row]) => row.menu === menuReference);
          const draftCategoryBindings = parseMenuCategoryBindings(
            owned.map(([sectionReference, row]) => ({
              sectionReference,
              categoryReferences: row.references,
            })),
            owned.map(([ref]) => parseCatalogReference(ref)),
          );
          return Object.freeze({
            menuReference,
            aggregateVersion: root.aggregateVersion,
            draftVersionReference,
            draftCategoryBindings,
            reviewedSnapshots: Object.freeze(
              (reviews.get(menuReference) ?? []).sort((a, b) =>
                a.lifecycleReference.localeCompare(b.lifecycleReference),
              ),
            ),
          });
        }),
    );
    return Object.freeze({
      brandReference: brand,
      consistency: "StatementSnapshot",
      observedAt,
      sourceDigest: digest({ brandReference: brand, menus }),
      reviewCategoryCoverage: known ? "Known" : "Unavailable",
      menus,
    });
  } catch {
    return fail();
  }
}

/** Closed public owner packet. Structure/checksum do not grant source authority. */
export function parseMenuCategorySourceSnapshot(
  value: unknown,
  expectedBrand: string,
  now: string,
): MenuCategorySourceSnapshot {
  try {
    const raw = record(copyCategoryPersistenceValue(value), [
      "brandReference",
      "consistency",
      "observedAt",
      "sourceDigest",
      "reviewCategoryCoverage",
      "menus",
    ]);
    const brand = parseCatalogReference(expectedBrand),
      observedAt = parseCatalogInstant(raw.observedAt),
      at = parseCatalogInstant(now);
    if (
      raw.brandReference !== brand ||
      raw.consistency !== "StatementSnapshot" ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const refs = new Set<string>(),
      versions = new Set<string>(),
      lifecycles = new Set<string>();
    let known = true;
    const menus = Object.freeze(
      rows(raw.menus)
        .map((item) => {
          const row = record(item, [
            "menuReference",
            "aggregateVersion",
            "draftVersionReference",
            "draftCategoryBindings",
            "reviewedSnapshots",
          ]);
          const menuReference = parseCatalogReference(row.menuReference),
            draftVersionReference = parseCatalogReference(row.draftVersionReference);
          if (refs.has(menuReference) || versions.has(draftVersionReference)) return fail();
          refs.add(menuReference);
          versions.add(draftVersionReference);
          const bindings = rows(row.draftCategoryBindings);
          const draftCategoryBindings = parseMenuCategoryBindings(
            bindings,
            bindings.map((binding) =>
              parseCatalogReference(
                record(binding, ["sectionReference", "categoryReferences"]).sectionReference,
              ),
            ),
          );
          const reviewedSnapshots = Object.freeze(
            rows(row.reviewedSnapshots)
              .map((item) => {
                const value = item as Record<string, unknown>;
                const present = Object.hasOwn(value, "categoryBindings");
                const review = record(value, [
                  "lifecycleReference",
                  "menuVersionReference",
                  "snapshotDigest",
                  "lifecycle",
                  "lifecycleVersion",
                  ...(present ? ["categoryBindings"] : []),
                ]);
                const lifecycleReference = parseCatalogReference(review.lifecycleReference),
                  menuVersionReference = parseCatalogReference(review.menuVersionReference);
                if (
                  lifecycles.has(lifecycleReference) ||
                  menuVersionReference !== draftVersionReference ||
                  (review.lifecycle === null
                    ? review.lifecycleVersion !== null
                    : ![
                        "Draft",
                        "InReview",
                        "Approved",
                        "Published",
                        "Archived",
                        "Superseded",
                      ].includes(review.lifecycle as string))
                )
                  return fail();
                lifecycles.add(lifecycleReference);
                const packet = present ? rows(review.categoryBindings) : undefined;
                if (!present) known = false;
                return Object.freeze({
                  lifecycleReference,
                  menuVersionReference,
                  snapshotDigest: parsePublishingDigest(review.snapshotDigest),
                  lifecycle: review.lifecycle as MenuCategoryReviewState | null,
                  lifecycleVersion:
                    review.lifecycle === null ? null : version(review.lifecycleVersion),
                  ...(packet === undefined
                    ? {}
                    : {
                        categoryBindings: parseMenuCategoryBindings(
                          packet,
                          packet.map((binding) =>
                            parseCatalogReference(
                              record(binding, ["sectionReference", "categoryReferences"])
                                .sectionReference,
                            ),
                          ),
                        ),
                      }),
                });
              })
              .sort((a, b) => a.lifecycleReference.localeCompare(b.lifecycleReference)),
          );
          return Object.freeze({
            menuReference,
            aggregateVersion: version(row.aggregateVersion),
            draftVersionReference,
            draftCategoryBindings,
            reviewedSnapshots,
          });
        })
        .sort((a, b) => a.menuReference.localeCompare(b.menuReference)),
    );
    if (
      raw.reviewCategoryCoverage !== (known ? "Known" : "Unavailable") ||
      raw.sourceDigest !== digest({ brandReference: brand, menus })
    )
      return fail();
    return Object.freeze({
      brandReference: brand,
      consistency: "StatementSnapshot",
      observedAt,
      sourceDigest: raw.sourceDigest as string,
      reviewCategoryCoverage: known ? "Known" : "Unavailable",
      menus,
    });
  } catch {
    return fail();
  }
}
