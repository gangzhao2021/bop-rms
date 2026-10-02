import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRecipeReference, parseRecipeDigest } from "../domain/recipe.js";
import { RecipeWorkflowError } from "../application/recipe-service.js";
import {
  parseRecipeReferenceSourceRequest,
  parseRecipeReferenceSourceSnapshot,
  type RecipeReferenceSourceRequest,
  type RecipeRootReference,
  type RecipeVersionReference,
  type RecipeBindingReference,
  type RecipeModifierReference,
  type RecipeReferenceSourceSnapshot,
} from "./recipe-reference-source.js";
export const recipeCatalogReferenceMatchMaximumRows = 10000;
export interface RecipeCatalogReferenceTarget {
  readonly mappingProfile: "KnownDraftBindings";
  readonly catalogConfigurationDigest: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly skuReference: string | null;
  readonly skuReferences: readonly string[];
  readonly bindings: readonly {
    readonly bindingReference: string;
    readonly enabledOptionReferences: readonly string[];
    readonly includedSkuReferences: readonly string[];
    readonly excludedSkuReferences: readonly string[];
  }[];
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[k] = d.value;
  }
  return r;
}
function items(v: unknown): unknown[] {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > 1000 ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return fail();
  return Array.from({ length: v.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function refs(v: unknown) {
  const result = items(v).map(parseRecipeReference);
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result.sort());
}
function target(value: unknown): RecipeCatalogReferenceTarget {
  const r = exact(value, [
    "mappingProfile",
    "catalogConfigurationDigest",
    "productReference",
    "versionReference",
    "skuReference",
    "skuReferences",
    "bindings",
  ]);
  if (r.mappingProfile !== "KnownDraftBindings") return fail();
  const skuReferences = refs(r.skuReferences);
  const bindings = items(r.bindings).map((v) => {
    const b = exact(v, [
        "bindingReference",
        "enabledOptionReferences",
        "includedSkuReferences",
        "excludedSkuReferences",
      ]),
      includedSkuReferences = refs(b.includedSkuReferences),
      excludedSkuReferences = refs(b.excludedSkuReferences);
    if (
      [...includedSkuReferences, ...excludedSkuReferences].some(
        (s) => !skuReferences.includes(s),
      ) ||
      includedSkuReferences.some((s) => excludedSkuReferences.includes(s))
    )
      return fail();
    return Object.freeze({
      bindingReference: parseRecipeReference(b.bindingReference),
      enabledOptionReferences: refs(b.enabledOptionReferences),
      includedSkuReferences,
      excludedSkuReferences,
    });
  });
  if (new Set(bindings.map((b) => b.bindingReference)).size !== bindings.length) return fail();
  return Object.freeze({
    mappingProfile: r.mappingProfile,
    catalogConfigurationDigest: parseRecipeDigest(r.catalogConfigurationDigest),
    productReference: parseRecipeReference(r.productReference),
    versionReference: parseRecipeReference(r.versionReference),
    skuReference: r.skuReference === null ? null : parseRecipeReference(r.skuReference),
    skuReferences,
    bindings: Object.freeze(
      bindings.sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
    ),
  });
}
type BindingGap = "BindingNotInConfiguration" | "SkuNotInConfiguration" | "SkuOutsideBindingScope";
type ModifierGap =
  "BindingNotInConfiguration" | "OptionNotEnabledInConfiguration" | "NoSelectedSkuInBindingScope";
export interface RecipeCatalogReferenceContext {
  readonly recipe: RecipeRootReference;
  readonly version: RecipeVersionReference;
  readonly isCurrentRecipeVersion: boolean;
  readonly bindings: readonly RecipeBindingReference[];
  readonly modifiers: readonly {
    readonly reference: RecipeModifierReference;
    readonly matchedSkuReferences: readonly string[];
  }[];
}
export interface RecipeCatalogUnresolvedContext {
  readonly recipe: RecipeRootReference;
  readonly version: RecipeVersionReference;
  readonly bindings: readonly {
    readonly reference: RecipeBindingReference;
    readonly reason: BindingGap;
  }[];
  readonly modifiers: readonly {
    readonly reference: RecipeModifierReference;
    readonly reason: ModifierGap;
  }[];
}
/** Recipe owns stored SKU/Option reference semantics. Catalog supplies a validated individual
 * Draft graph through this closed public target; this function supplies no authorization or sale eligibility. */
function matchGraph(
  request: RecipeReferenceSourceRequest,
  t: RecipeCatalogReferenceTarget,
  source: RecipeReferenceSourceSnapshot,
) {
  const recipes = new Map(source.recipes.map((r) => [r.recipeReference, r])),
    versions = new Map(source.versions.map((v) => [v.recipeVersionReference, v])),
    bindings = new Map(t.bindings.map((b) => [b.bindingReference, b]));
  const present = t.skuReference === null || t.skuReferences.includes(t.skuReference),
    selected = present ? (t.skuReference === null ? t.skuReferences : [t.skuReference]) : [];
  const selectedSet = new Set(selected),
    allSkus = new Set(t.skuReferences);
  const scopes = new Map<
    string,
    {
      included: ReadonlySet<string>;
      excluded: ReadonlySet<string>;
      options: ReadonlySet<string>;
      matched: readonly string[];
    }
  >();
  const scope = (b: RecipeCatalogReferenceTarget["bindings"][number]) => {
    let s = scopes.get(b.bindingReference);
    if (!s) {
      const included = new Set(b.includedSkuReferences),
        excluded = new Set(b.excludedSkuReferences);
      s = {
        included,
        excluded,
        options: new Set(b.enabledOptionReferences),
        matched: Object.freeze(
          selected.filter(
            (sku) => (included.size === 0 || included.has(sku)) && !excluded.has(sku),
          ),
        ),
      };
      scopes.set(b.bindingReference, s);
    }
    return s;
  };
  const applies = (b: RecipeCatalogReferenceTarget["bindings"][number], sku: string) => {
    const s = scope(b);
    return (s.included.size === 0 || s.included.has(sku)) && !s.excluded.has(sku);
  };
  const relatedPairs = new Set(
    source.bindings
      .filter((s) => s.optionBindingReference !== null && selectedSet.has(s.skuReference))
      .map((s) => s.recipeVersionReference + ":" + s.optionBindingReference),
  );
  interface Mutable {
    recipe: RecipeRootReference;
    version: RecipeVersionReference;
    bindings: RecipeBindingReference[];
    modifiers: { reference: RecipeModifierReference; matchedSkuReferences: readonly string[] }[];
  }
  interface Gap {
    recipe: RecipeRootReference;
    version: RecipeVersionReference;
    bindings: { reference: RecipeBindingReference; reason: BindingGap }[];
    modifiers: { reference: RecipeModifierReference; reason: ModifierGap }[];
  }
  const matched = new Map<string, Mutable>(),
    gaps = new Map<string, Gap>();
  const parents = (versionReference: string) => {
    const v = versions.get(versionReference),
      r = v && recipes.get(v.recipeReference);
    if (!v || !r) return fail();
    return { recipe: r, version: v };
  };
  const group = (v: string) => {
    let g = matched.get(v);
    if (!g) {
      g = { ...parents(v), bindings: [], modifiers: [] };
      matched.set(v, g);
    }
    return g;
  };
  const gap = (v: string) => {
    let g = gaps.get(v);
    if (!g) {
      g = { ...parents(v), bindings: [], modifiers: [] };
      gaps.set(v, g);
    }
    return g;
  };
  if (present) {
    for (const reference of source.bindings) {
      const b =
          reference.optionBindingReference === null
            ? undefined
            : bindings.get(reference.optionBindingReference),
        direct = selectedSet.has(reference.skuReference),
        relatedUnknownSku = t.skuReference === null && !!b && !allSkus.has(reference.skuReference);
      if (!direct && !relatedUnknownSku) continue;
      let reason: BindingGap | undefined;
      if (relatedUnknownSku) reason = "SkuNotInConfiguration";
      else if (reference.optionBindingReference !== null && !b)
        reason = "BindingNotInConfiguration";
      else if (b && !applies(b, reference.skuReference)) reason = "SkuOutsideBindingScope";
      if (reason)
        gap(reference.recipeVersionReference).bindings.push(Object.freeze({ reference, reason }));
      else group(reference.recipeVersionReference).bindings.push(reference);
    }
    for (const reference of source.modifiers) {
      const b = bindings.get(reference.bindingReference),
        related = relatedPairs.has(
          reference.recipeVersionReference + ":" + reference.bindingReference,
        );
      if (!b && !related) continue;
      const matchedSkuReferences = b ? scope(b).matched : Object.freeze([]);
      let reason: ModifierGap | undefined;
      if (!b) reason = "BindingNotInConfiguration";
      else if (!scope(b).options.has(reference.optionReference))
        reason = "OptionNotEnabledInConfiguration";
      else if (matchedSkuReferences.length === 0) reason = "NoSelectedSkuInBindingScope";
      if (reason)
        gap(reference.recipeVersionReference).modifiers.push(Object.freeze({ reference, reason }));
      else
        group(reference.recipeVersionReference).modifiers.push(
          Object.freeze({ reference, matchedSkuReferences }),
        );
    }
  }
  const references: readonly RecipeCatalogReferenceContext[] = Object.freeze(
    [...matched.values()]
      .sort((a, b) =>
        a.version.recipeVersionReference.localeCompare(b.version.recipeVersionReference),
      )
      .map((g) =>
        Object.freeze({
          ...g,
          isCurrentRecipeVersion:
            g.recipe.currentVersionReference === g.version.recipeVersionReference,
          bindings: Object.freeze(g.bindings),
          modifiers: Object.freeze(g.modifiers),
        }),
      ),
  );
  const unresolved: readonly RecipeCatalogUnresolvedContext[] = Object.freeze(
    [...gaps.values()]
      .sort((a, b) =>
        a.version.recipeVersionReference.localeCompare(b.version.recipeVersionReference),
      )
      .map((g) =>
        Object.freeze({
          ...g,
          bindings: Object.freeze(g.bindings),
          modifiers: Object.freeze(g.modifiers),
        }),
      ),
  );
  const expandedRows =
    references.reduce(
      (n, g) =>
        n +
        2 +
        g.bindings.length +
        g.modifiers.reduce((m, r) => m + 1 + r.matchedSkuReferences.length, 0),
      0,
    ) + unresolved.reduce((n, g) => n + 2 + g.bindings.length + g.modifiers.length, 0);
  if (expandedRows > recipeCatalogReferenceMatchMaximumRows) return fail();
  const body = {
    request,
    target: t,
    coverage: "KnownDraftBindingGraph" as const,
    recipeReferenceCoverage: "CompleteStoredGraph" as const,
    applicability: "Unavailable" as const,
    recipeResolution: "Unavailable" as const,
    targetMembership: present ? ("Present" as const) : ("Absent" as const),
    recipeSourceDigest: source.digest,
    recipeGeneration: source.generation,
    references,
    unresolved,
    expandedRows,
  };
  return Object.freeze({
    ...body,
    digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    observedAt: source.observedAt,
  });
}
/** Parse the complete owning source once; expanded output is bounded across every graph. */
export function matchRecipeCatalogReferenceGraphs(input: {
  readonly request: RecipeReferenceSourceRequest;
  readonly targets: unknown;
  readonly source: unknown;
  readonly now: string;
}) {
  try {
    const request = parseRecipeReferenceSourceRequest(input.request),
      source = parseRecipeReferenceSourceSnapshot(input.source, request, input.now);
    if (
      !Array.isArray(input.targets) ||
      Object.getPrototypeOf(input.targets) !== Array.prototype ||
      input.targets.length > 1001 ||
      Reflect.ownKeys(input.targets).length !== input.targets.length + 1
    )
      return fail();
    let rows = 0;
    return Object.freeze(
      Array.from({ length: input.targets.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(input.targets, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        const result = matchGraph(request, target(d.value), source);
        rows += result.expandedRows;
        if (rows > recipeCatalogReferenceMatchMaximumRows) return fail();
        return result;
      }),
    );
  } catch {
    return fail();
  }
}
export function matchRecipeCatalogReferences(input: {
  readonly request: RecipeReferenceSourceRequest;
  readonly target: unknown;
  readonly source: unknown;
  readonly now: string;
}) {
  const result = matchRecipeCatalogReferenceGraphs({ ...input, targets: [input.target] })[0];
  return result ?? fail();
}
