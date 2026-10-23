import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseRecipeDigest, parseRecipeReference } from "../../domain/recipe.js";
import {
  preparationObject,
  preparationInstant,
} from "../../domain/recipe-preparation-publication.js";
import {
  resolveRecipePreparation,
  createRecipePreparationDisplay,
} from "../../domain/recipe-preparation-content.js";
import type { createPostgresRecipePreparationContentStore } from "./recipe-preparation-content-store.js";
import {
  createRecipeSnapshot,
  type IngredientRequirement,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import {
  applyRecipeIngredientModifiers,
  parseRecipeOptionSelection,
  calculateConfiguredRecipeInventoryDemand,
  type RecipeModifierRule,
  type RecipeOptionSelection,
} from "../../domain/recipe-modifier.js";
import { createPostgresRecipeModifierSource } from "./recipe-modifier-store.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { createPostgresBaseRecipeSource } from "./recipe-binding-store.js";
import type { RecipeTransaction, RecipeTransactionRunner } from "./recipe-query-store.js";
function fail(): never {
  throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
}
/** One published SubRecipe version a requirement pins, current and created by `occurredAt`. */
function subRecipeLoader(tx: RecipeTransaction, brandReference: string, occurredAt: string) {
  return async (requirement: IngredientRequirement) => {
    const result = await tx.query(
      "SELECT v.snapshot_json AS snapshot,c.lifecycle AS current_lifecycle FROM rms_recipe.recipe_version v JOIN rms_recipe.recipe r ON r.recipe_id=v.recipe_id AND r.brand_id=v.brand_id LEFT JOIN rms_recipe.recipe_version c ON c.recipe_version_id=r.current_version_id AND c.recipe_id=r.recipe_id AND c.brand_id=r.brand_id WHERE v.brand_id=$1 AND v.recipe_id=$2 AND v.recipe_version_id=$3",
      [brandReference, requirement.sourceReference, requirement.sourceVersionReference],
    );
    if (result === null || typeof result !== "object") return fail();
    const d = Object.getOwnPropertyDescriptor(result, "rows");
    if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length !== 1) return fail();
    const row = d.value[0];
    if (row === null || typeof row !== "object" || row.current_lifecycle !== "Published")
      return fail();
    const snapshot = createRecipeSnapshot(row.snapshot);
    if (
      snapshot.recipeReference !== requirement.sourceReference ||
      snapshot.versionReference !== requirement.sourceVersionReference ||
      snapshot.brandReference !== brandReference ||
      snapshot.lifecycle !== "Published" ||
      snapshot.createdAt > occurredAt
    )
      return fail();
    return snapshot;
  };
}
/** Published SubRecipes reachable from a configured recipe, in discovery order. */
async function loadSubRecipeGraph(
  root: RecipeSnapshot,
  load: (requirement: IngredientRequirement) => Promise<RecipeSnapshot>,
) {
  const loaded = new Map<string, RecipeSnapshot>();
  const queue = [{ snapshot: root, depth: 0 }];
  const seen = new Set([root.versionReference]);
  for (const entry of queue) {
    if (!entry || entry.depth > 16) return fail();
    for (const requirement of entry.snapshot.ingredients) {
      if (requirement.sourceKind !== "SubRecipe" || seen.has(requirement.sourceVersionReference))
        continue;
      if (seen.size >= 256) return fail();
      const snapshot = await load(requirement);
      loaded.set(snapshot.versionReference, snapshot);
      seen.add(snapshot.versionReference);
      queue.push({ snapshot, depth: entry.depth + 1 });
    }
  }
  return Object.freeze([...loaded.values()]);
}
/** Base Recipe theoretical demand; selected Option modifiers and Inventory eligibility remain separate. */
function createDemandSource(runner: RecipeTransactionRunner, brand: string) {
  return Object.freeze({
    async resolve(
      input: Readonly<{
        storeReference: string;
        skuReference: string;
        occurredAt: string;
        requestedYieldMicrounits: string;
        selections: readonly RecipeOptionSelection[];
      }>,
    ) {
      try {
        return await runner.run(async (tx) => {
          const base = await createPostgresBaseRecipeSource(
            { run: async (work) => work(tx) },
            brand,
          ).resolve({
            storeReference: input.storeReference,
            skuReference: input.skuReference,
            occurredAt: input.occurredAt,
          });
          const rules = await createPostgresRecipeModifierSource({
            run: async (work) => work(tx),
          }).resolve(base.snapshot, input.selections, input.occurredAt);
          const configured = applyRecipeIngredientModifiers(base.snapshot, input.selections, rules);
          const graph = await loadSubRecipeGraph(
            createRecipeSnapshot({ ...base.snapshot, ingredients: configured.ingredients }),
            subRecipeLoader(tx, base.brandReference, input.occurredAt),
          );
          const demand = calculateConfiguredRecipeInventoryDemand(
            base.snapshot,
            graph,
            input.selections,
            rules,
            input.requestedYieldMicrounits,
          );
          return Object.freeze({
            ...base,
            requestedYieldMicrounits: input.requestedYieldMicrounits,
            graph,
            requirements: demand.requirements,
            appliedRules: demand.appliedRules,
          });
        });
      } catch {
        return fail();
      }
    },
  });
}

/** Current configured demand including SubRecipes introduced by selected options. */
export const createPostgresConfiguredRecipeDemandSource = createDemandSource;

/** Compatibility source for an explicitly unconfigured base recipe. */
export function createPostgresBaseRecipeDemandSource(
  runner: RecipeTransactionRunner,
  brand: string,
) {
  const source = createDemandSource(runner, brand);
  return Object.freeze({
    resolve(
      input: Readonly<{
        storeReference: string;
        skuReference: string;
        occurredAt: string;
        requestedYieldMicrounits: string;
      }>,
    ) {
      return source.resolve({ ...input, selections: [] });
    },
  });
}

/**
 * Submission-only current evidence. Keep the outer transaction open until the dependent write commits.
 * SHARE locks fence configuration inserts as well as updates; ordinary observers remain unlocked.
 */
function createSaleRecipeDemandSource(
  runner: RecipeTransactionRunner,
  brand: string,
  submission: boolean,
) {
  return Object.freeze({
    async resolve(
      input: Readonly<{
        storeReference: string;
        skuReference: string;
        occurredAt: string;
        saleUnitCode: string;
        unitQuantity: string;
        saleQuantity: number;
        selections: readonly RecipeOptionSelection[];
      }>,
    ) {
      if (
        !Number.isSafeInteger(input.saleQuantity) ||
        input.saleQuantity < 1 ||
        input.saleQuantity > 999 ||
        typeof input.saleUnitCode !== "string"
      )
        return fail();
      if (
        typeof input.unitQuantity !== "string" ||
        !/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,6})?$/u.test(input.unitQuantity)
      )
        return fail();
      const [whole, fraction = ""] = input.unitQuantity.split(".");
      const unitMicrounits = BigInt(whole + fraction.padEnd(6, "0"));
      if (unitMicrounits === 0n) return fail();
      return runner
        .run(async (tx) => {
          if (submission)
            await tx.query(
              "LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version IN SHARE MODE",
              [],
            );
          const demand = await createDemandSource({ run: async (work) => work(tx) }, brand).resolve(
            {
              storeReference: input.storeReference,
              skuReference: input.skuReference,
              occurredAt: input.occurredAt,
              selections: input.selections,
              requestedYieldMicrounits: (BigInt(input.saleQuantity) * unitMicrounits).toString(),
            },
          );
          if (
            demand.snapshot.yieldDimension !== "Count" ||
            demand.snapshot.yieldUnitCode !== input.saleUnitCode
          )
            return fail();
          return Object.freeze({
            ...demand,
            saleUnitCode: input.saleUnitCode,
            unitQuantity: input.unitQuantity,
            saleQuantity: input.saleQuantity,
          });
        })
        .catch(() => fail());
    },
  });
}

/** Caller retains locks until submission commits. */
export function createPostgresSubmissionRecipeDemandSource(
  runner: RecipeTransactionRunner,
  brand: string,
) {
  return createSaleRecipeDemandSource(runner, brand, true);
}

/** Unlocked sale quantity/option demand observation. Caller owns a coherent
 * read transaction; this result never reserves stock or authorizes submission.
 */
export function createPostgresSaleRecipeDemandSource(
  runner: RecipeTransactionRunner,
  brand: string,
) {
  return createSaleRecipeDemandSource(runner, brand, false);
}

export interface ConfiguredRecipePreparationInput {
  readonly actorType: "System";
  readonly actorReference: null;
  readonly action: "ResolveConfiguredRecipePreparation";
  readonly purpose: "CreateKitchenWork";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly skuReference: string;
  readonly effectiveAt: string;
  readonly selectedOptions: readonly Readonly<{ optionReference: string; quantity: number }>[];
}

/** Owner composition; the caller retains this transaction until dependent Kitchen writes finish. */
export function createPostgresConfiguredRecipePreparationSource(options: {
  readonly brandReference: string;
  readonly sha256: (value: string) => string;
  readonly content: Pick<ReturnType<typeof createPostgresRecipePreparationContentStore>, "resolve">;
  readonly authorize: (
    tx: ConsumerTransaction,
    input: ConfiguredRecipePreparationInput,
  ) => Promise<boolean>;
}) {
  const brand = parseRecipeReference(options.brandReference);
  return Object.freeze({
    async resolve(tx: ConsumerTransaction, input: ConfiguredRecipePreparationInput) {
      try {
        const raw = preparationObject(input, [
          "actorType",
          "actorReference",
          "action",
          "purpose",
          "brandReference",
          "storeReference",
          "skuReference",
          "effectiveAt",
          "selectedOptions",
        ]);
        if (
          raw.actorType !== "System" ||
          raw.actorReference !== null ||
          raw.action !== "ResolveConfiguredRecipePreparation" ||
          raw.purpose !== "CreateKitchenWork" ||
          raw.brandReference !== brand
        )
          return fail();
        const store = parseRecipeReference(raw.storeReference);
        const sku = parseRecipeReference(raw.skuReference);
        const at = preparationInstant(raw.effectiveAt);
        if (!(await options.authorize(tx, input))) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        await tx.query(
          "LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version IN SHARE MODE",
          [],
        );
        const runner = {
          run: async <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
        };
        const base = await createPostgresBaseRecipeSource(runner, brand).resolve({
          storeReference: store,
          skuReference: sku,
          occurredAt: at,
        });
        const rules = await createPostgresRecipeModifierSource(runner).resolveOptions(
          base.snapshot,
          input.selectedOptions,
          at,
        );
        const query = {
          actorType: "System" as const,
          actorReference: null,
          action: "ResolveRecipePreparationContent" as const,
          purpose: "CreateKitchenWork" as const,
          brandReference: brand,
          storeReference: store,
          recipeReference: base.snapshot.recipeReference,
          recipeVersionReference: base.snapshot.versionReference,
          effectiveAt: at,
        };
        const content = await options.content.resolve({
          transaction: tx,
          query: { ...query, modifierRuleVersionReference: null },
        });
        if (!content) return fail();
        const modifiers = [];
        const publications = [content.publicationReference];
        for (const rule of rules) {
          const evidence = await options.content.resolve({
            transaction: tx,
            query: { ...query, modifierRuleVersionReference: rule.ruleVersionReference },
          });
          if (!evidence) return fail();
          publications.push(evidence.publicationReference);
          modifiers.push({ rule, content: evidence.content });
        }
        const preparation = resolveRecipePreparation({
          snapshot: base.snapshot,
          content: content.content,
          selections: rules.map((rule) => rule.selection),
          modifiers,
          sha256: options.sha256,
        });
        return Object.freeze({
          brandReference: brand,
          storeReference: store,
          skuReference: sku,
          effectiveAt: at,
          bindingReference: base.bindingReference,
          publicationReferences: Object.freeze(publications),
          preparation,
          display: createRecipePreparationDisplay(preparation),
        });
      } catch {
        return fail();
      }
    },
  });
}

export interface RecipeReviewInput {
  readonly actorType: "User";
  readonly actorReference: string;
  readonly action: "ResolveMenuRecipeFacts";
  readonly purpose: "ReviewMenu";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly skuReference: string;
  readonly observedAt: string;
  readonly selections: readonly RecipeOptionSelection[];
}

/** What a menu review found missing, named by the recipe-side source so staff can fix it. */
export type RecipeReviewGap =
  | { readonly missing: "Recipe" }
  | { readonly missing: "SubRecipe" }
  | { readonly missing: "OptionRecipe"; readonly selection: RecipeOptionSelection };
export class RecipeReviewGapError extends RecipeWorkflowError {
  constructor(readonly gap: RecipeReviewGap) {
    super("RECIPE_EVIDENCE_INCOMPLETE");
    this.name = "RecipeReviewGapError";
  }
}

/** One explicit configuration, not an assertion of complete Menu option coverage.
 * Source snapshots retain Ingredient/SubRecipe evidence references; Catalog must
 * independently resolve and validate those actual evidence records.
 */
export function createPostgresRecipeReviewSource(options: {
  brandReference: string;
  authorize(tx: RecipeTransaction, input: RecipeReviewInput): Promise<boolean>;
}) {
  const brand = parseRecipeReference(options.brandReference);
  const parseSelections = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 256) return fail();
    const selections = value
      .map(parseRecipeOptionSelection)
      .sort(
        (a, b) =>
          a.bindingReference.localeCompare(b.bindingReference) ||
          a.optionReference.localeCompare(b.optionReference) ||
          a.quantity - b.quantity,
      );
    if (new Set(selections.map((item) => item.optionReference)).size !== selections.length)
      return fail();
    return selections;
  };
  /** Validates the request, admits the Actor and holds the Recipe sources for the review. */
  const begin = async (tx: RecipeTransaction, input: RecipeReviewInput) => {
    const raw = preparationObject(input, [
      "actorType",
      "actorReference",
      "action",
      "purpose",
      "brandReference",
      "storeReference",
      "skuReference",
      "observedAt",
      "selections",
    ]);
    if (
      raw.actorType !== "User" ||
      raw.action !== "ResolveMenuRecipeFacts" ||
      raw.purpose !== "ReviewMenu" ||
      raw.brandReference !== brand
    )
      return fail();
    parseRecipeReference(raw.actorReference);
    const store = parseRecipeReference(raw.storeReference);
    const sku = parseRecipeReference(raw.skuReference);
    const at = preparationInstant(raw.observedAt);
    const selections = parseSelections(raw.selections);
    const allowed = async () => {
      if ((await options.authorize(tx, input)) !== true)
        throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
    };
    await allowed();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query(
      "LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version IN SHARE MODE",
      [],
    );
    const runner = {
      run: async <T>(work: (transaction: RecipeTransaction) => Promise<T>) => work(tx),
    };
    return { store, sku, at, selections, allowed, runner };
  };
  const factsOf = (
    scope: { store: string; sku: string; at: string },
    base: { bindingReference: string; snapshot: RecipeSnapshot },
    graph: readonly RecipeSnapshot[],
    rules: readonly RecipeModifierRule[],
    configuredIngredients: readonly IngredientRequirement[],
  ) => {
    const facts = Object.freeze({
      brandReference: brand,
      storeReference: scope.store,
      skuReference: scope.sku,
      bindingReference: base.bindingReference,
      snapshot: base.snapshot,
      graph: Object.freeze(
        [...graph].sort((a, b) => a.versionReference.localeCompare(b.versionReference)),
      ),
      modifierRules: rules,
      configuredIngredients,
    });
    return Object.freeze({
      ...facts,
      observedAt: scope.at,
      sourceDigest: parseRecipeDigest("sha256:" + sha256Hex(canonicalizeRfc8785(facts))),
    });
  };
  const rethrow = (error: unknown): never => {
    if (
      error instanceof RecipeWorkflowError &&
      (error.code === "RECIPE_PERMISSION_DENIED" || error instanceof RecipeReviewGapError)
    )
      throw error;
    return fail();
  };
  return Object.freeze({
    async resolve(tx: RecipeTransaction, input: RecipeReviewInput) {
      try {
        const scope = await begin(tx, input);
        const resolved = await createDemandSource(scope.runner, brand).resolve({
          storeReference: scope.store,
          skuReference: scope.sku,
          occurredAt: scope.at,
          selections: scope.selections,
          requestedYieldMicrounits: "1",
        });
        const rules = await createPostgresRecipeModifierSource(scope.runner).resolve(
          resolved.snapshot,
          scope.selections,
          scope.at,
        );
        const configured = applyRecipeIngredientModifiers(
          resolved.snapshot,
          scope.selections,
          rules,
        );
        const facts = factsOf(scope, resolved, resolved.graph, rules, configured.ingredients);
        await scope.allowed();
        return facts;
      } catch (error) {
        return rethrow(error);
      }
    },
    /** WP-2423 (v15 2026-10-22): the same facts as `resolve` for each configuration, in order, but
     * the base recipe, each published option rule and each SubRecipe are read once per call and
     * the selections applied in memory. A Latte menu has thousands of review configurations and
     * one full resolution per configuration made submit take 50 s. Recipe sources stay share-locked
     * for the caller's transaction, so every configuration sees the same rows it would read alone.
     * A missing recipe or option rule is reported as a `RecipeReviewGapError`.
     */
    async resolveConfigurations(
      tx: RecipeTransaction,
      input: Omit<RecipeReviewInput, "selections">,
      configurations: readonly (readonly RecipeOptionSelection[])[],
    ) {
      try {
        if (
          !Array.isArray(configurations) ||
          configurations.length < 1 ||
          configurations.length > 10000
        )
          return fail();
        const scope = await begin(tx, { ...input, selections: [] });
        const base = await createPostgresBaseRecipeSource(scope.runner, brand)
          .resolve({ storeReference: scope.store, skuReference: scope.sku, occurredAt: scope.at })
          .catch((): never => {
            throw new RecipeReviewGapError({ missing: "Recipe" });
          });
        const modifiers = createPostgresRecipeModifierSource(scope.runner);
        const rules = new Map<string, Promise<RecipeModifierRule>>();
        const ruleFor = (selection: RecipeOptionSelection) => {
          const key = `${selection.bindingReference}|${selection.optionReference}|${selection.quantity}`;
          let rule = rules.get(key);
          if (!rule) {
            rule = modifiers.resolve(base.snapshot, [selection], scope.at).then(
              ([found]) => found ?? fail(),
              (): never => {
                throw new RecipeReviewGapError({ missing: "OptionRecipe", selection });
              },
            );
            rule.catch(() => undefined);
            rules.set(key, rule);
          }
          return rule;
        };
        const load = subRecipeLoader(tx, base.brandReference, scope.at);
        const subRecipes = new Map<string, Promise<RecipeSnapshot>>();
        const subRecipeFor = (requirement: IngredientRequirement) => {
          const key = `${requirement.sourceReference}|${requirement.sourceVersionReference}`;
          let snapshot = subRecipes.get(key);
          if (!snapshot) {
            snapshot = load(requirement).catch((): never => {
              throw new RecipeReviewGapError({ missing: "SubRecipe" });
            });
            snapshot.catch(() => undefined);
            subRecipes.set(key, snapshot);
          }
          return snapshot;
        };
        const results = [];
        for (const configuration of configurations) {
          const selections = parseSelections(configuration);
          const applied: RecipeModifierRule[] = [];
          for (const selection of selections) applied.push(await ruleFor(selection));
          const modifierRules = Object.freeze(applied);
          const configured = applyRecipeIngredientModifiers(
            base.snapshot,
            selections,
            modifierRules,
          );
          const graph = await loadSubRecipeGraph(
            createRecipeSnapshot({ ...base.snapshot, ingredients: configured.ingredients }),
            subRecipeFor,
          );
          // Same demand check `resolve` makes; a configuration it rejects is rejected here too.
          calculateConfiguredRecipeInventoryDemand(
            base.snapshot,
            graph,
            selections,
            modifierRules,
            "1",
          );
          results.push(factsOf(scope, base, graph, modifierRules, configured.ingredients));
        }
        await scope.allowed();
        return Object.freeze(results);
      } catch (error) {
        return rethrow(error);
      }
    },
  });
}
