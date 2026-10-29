import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { loadProductImages } from "@bop/media";
import {
  createPostgresMenuDraftSource,
  createPostgresMenuReviewContentStore,
  createPostgresMenuReviewProductSource,
  createPostgresMenuReviewOptionSource,
  buildReviewedMenuOptionRules,
  buildReviewedMenuContent,
  createMenuReviewContent,
  validateMenuAllergenProvenance,
  parseCatalogReference,
  parseCatalogInstant,
  type ProductLifecycleTransaction,
  type AllergenSourceEvidence,
  type AllergenRegistryEntry,
  type MenuAllergenPath,
  type MenuReviewSellableFact,
} from "@rms/catalog";
import {
  createCompleteMenuRecipeAllergenSource,
  MenuRecipeAllergenError,
  reviewStopReason,
} from "./menu-recipe-allergen-source.js";

export interface MenuReviewPreparationInput {
  actorReference: string;
  menuReference: string;
  lifecycleReference: string;
  validationEvidenceReference: string;
  registryVersionReference: string;
  observedAt: string;
  budget: { maximumConfigurations: number; maximumSearchSteps: number };
}
const fail = (reason = "MenuReview"): never => {
  throw new MenuRecipeAllergenError(null, reason);
};

/** Prepare only. Caller keeps tx open through immutable content/Publishing writes,
 * supplies current authority and uses the returned final digest for approval.
 */
export function createMenuReviewPreparationSource(options: {
  brandReference: string;
  authorize(
    tx: ProductLifecycleTransaction,
    input: {
      actorReference: string;
      menuReference: string;
      storeReference: string | null;
      owner: "Catalog" | "Recipe";
    },
  ): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return Object.freeze({
    async prepare(tx: ProductLifecycleTransaction, input: MenuReviewPreparationInput) {
      try {
        const raw = readClosedRecord(
          input,
          [
            "actorReference",
            "menuReference",
            "lifecycleReference",
            "validationEvidenceReference",
            "registryVersionReference",
            "observedAt",
            "budget",
          ],
          "ACTOR_SHAPE_INVALID",
        );
        const actor = parseCatalogReference(raw.actorReference);
        const menuReference = parseCatalogReference(raw.menuReference);
        const lifecycleReference = parseCatalogReference(raw.lifecycleReference);
        const validationEvidenceReference = parseCatalogReference(raw.validationEvidenceReference);
        const registryVersionReference = parseCatalogReference(raw.registryVersionReference);
        const at = parseCatalogInstant(raw.observedAt);
        const budget = readClosedRecord(
          raw.budget,
          ["maximumConfigurations", "maximumSearchSteps"],
          "ACTOR_SHAPE_INVALID",
        );
        const maximumConfigurations = Number(budget.maximumConfigurations);
        const maximumSearchSteps = Number(budget.maximumSearchSteps);
        if (
          typeof budget.maximumConfigurations !== "number" ||
          typeof budget.maximumSearchSteps !== "number" ||
          !Number.isSafeInteger(maximumConfigurations) ||
          maximumConfigurations < 1 ||
          maximumConfigurations > 10000 ||
          !Number.isSafeInteger(maximumSearchSteps) ||
          maximumSearchSteps < 1 ||
          maximumSearchSteps > 1000000
        )
          return fail();
        const authorize = (owner: "Catalog" | "Recipe", storeReference: string | null = null) =>
          options.authorize(tx, { actorReference: actor, menuReference, storeReference, owner });
        const owner = await createPostgresMenuDraftSource({
          brandReference: brand,
          transactions: { run: (work) => work(tx) },
          authorize: async () => authorize("Catalog"),
        }).load(menuReference, at);
        if (
          !owner ||
          !owner.aggregate.draft.storeReferences.length ||
          !owner.aggregate.draft.channelCodes.length
        )
          return fail();
        const menu = owner.aggregate,
          locale = menu.draft.defaultLocale;
        const references = [
          ...new Set(
            menu.draft.sections.flatMap((section) =>
              section.placements.map((placement) => placement.sellableReference),
            ),
          ),
        ].sort();
        if (!references.length) return fail();
        const products = await createPostgresMenuReviewProductSource({
          brandReference: brand,
          authorize: async () => authorize("Catalog"),
        })(tx, { sellableReferences: references, observedAt: at });
        // WP-2423 menu descriptions and photos: the review pins each product's description and the
        // sizes of its photo (Media's immutable image record), so customers see exactly what was
        // reviewed and a later draft edit changes the review's dependency digest.
        const photoReferences = [
          ...new Set(
            products.flatMap((product) =>
              product.customerPresentation?.photo
                ? [String(product.customerPresentation.photo.imageReference)]
                : [],
            ),
          ),
        ].sort();
        const images = photoReferences.length
          ? await loadProductImages(tx, { brandReference: brand, imageReferences: photoReferences })
          : new Map<string, never>();
        const presentationOf = (product: (typeof products)[number]) => {
          const presentation = product.customerPresentation;
          if (
            presentation === undefined ||
            (Object.keys(presentation.localizedDescriptions).length === 0 &&
              presentation.photo === null)
          )
            return {};
          const reference = presentation.photo?.imageReference;
          const image = reference === undefined ? undefined : images.get(String(reference));
          if (
            presentation.photo !== null &&
            (image === undefined || image.productReference !== String(product.productReference))
          )
            return fail();
          return {
            presentation: {
              localizedDescriptions: presentation.localizedDescriptions,
              photo:
                presentation.photo === null || image === undefined
                  ? null
                  : {
                      imageReference: presentation.photo.imageReference,
                      localizedAltText: presentation.photo.localizedAltText,
                      width: image.width,
                      height: image.height,
                      renditions: image.renditions.map((rendition) => ({
                        contentType: rendition.contentType,
                        width: rendition.width,
                        height: rendition.height,
                        path: rendition.path,
                      })),
                    },
            },
          };
        };
        const readOptions = createPostgresMenuReviewOptionSource({
          brandReference: brand,
          authorize: async () => authorize("Catalog"),
        });
        const recipes = createCompleteMenuRecipeAllergenSource({
          brandReference: brand,
          authorize: async (_tx, query, source) => authorize(source, query.storeReference),
        });
        const evidence = new Map<string, AllergenSourceEvidence>();
        let registry: readonly AllergenRegistryEntry[] | null = null;
        const paths: MenuAllergenPath[] = [],
          sellables: MenuReviewSellableFact[] = [];
        const optionDependencies: { sellableReference: string; sourceDigest: string }[] = [];
        const recipeDependencies: {
          sellableReference: string;
          storeReference: string;
          channelCode: string;
          sourceDigest: string;
        }[] = [];
        let resolvedConfigurations = 0;
        for (const product of products) {
          const optionSource = await readOptions(tx, {
            sellableReference: product.sellableReference,
            productVersionReference: product.productVersionReference,
            channelCodes: menu.draft.channelCodes,
            observedAt: at,
          });
          if (optionSource.productReference !== product.productReference) return fail();
          const optionRules = buildReviewedMenuOptionRules(optionSource.channels, locale);
          optionDependencies.push({
            sellableReference: product.sellableReference,
            sourceDigest: optionSource.sourceDigest,
          });
          const allReferences = new Set<string>();
          const optionReferences = new Map<string, Set<string>>();
          // WP-2423 ⑪: evidence per distinct set of chosen options (every Store and channel).
          const choiceEvidence = new Map<string, { options: string[]; evidence: Set<string> }>();
          for (const store of [...menu.draft.storeReferences].sort())
            for (const channel of optionSource.channels) {
              const resolved = await recipes.resolve(tx, {
                recipe: {
                  actorType: "User",
                  actorReference: actor,
                  action: "ResolveMenuRecipeFacts",
                  purpose: "ReviewMenu",
                  brandReference: brand,
                  storeReference: store,
                  skuReference: product.sellableReference,
                  observedAt: at,
                },
                rules: channel.rules,
                registryVersionReference,
                defaultLocale: locale,
                budget: {
                  maximumConfigurations: maximumConfigurations - resolvedConfigurations,
                  maximumSearchSteps,
                },
              });
              resolvedConfigurations += resolved.configurations.length;
              if (
                registry !== null &&
                canonicalizeRfc8785(registry) !== canonicalizeRfc8785(resolved.allergens.registry)
              )
                return fail();
              registry = resolved.allergens.registry;
              for (const item of resolved.allergens.evidence) {
                const existing = evidence.get(item.evidenceReference);
                if (existing && canonicalizeRfc8785(existing) !== canonicalizeRfc8785(item))
                  return fail();
                evidence.set(item.evidenceReference, item);
              }
              for (const configuration of resolved.configurations) {
                for (const reference of configuration.evidenceReferences)
                  allReferences.add(reference);
                const chosen = [
                  ...new Set(configuration.selections.map((item) => item.optionReference)),
                ].sort();
                const entry = choiceEvidence.get(chosen.join(",")) ?? {
                  options: chosen,
                  evidence: new Set<string>(),
                };
                for (const reference of configuration.evidenceReferences)
                  entry.evidence.add(reference);
                choiceEvidence.set(chosen.join(","), entry);
                for (const selection of configuration.selections) {
                  const union =
                    optionReferences.get(selection.optionReference) ?? new Set<string>();
                  for (const reference of configuration.evidenceReferences) union.add(reference);
                  optionReferences.set(selection.optionReference, union);
                }
              }
              recipeDependencies.push({
                sellableReference: product.sellableReference,
                storeReference: store,
                channelCode: channel.channelCode,
                sourceDigest: resolved.sourceDigest,
              });
            }
          paths.push({
            sellableReference: product.sellableReference,
            productVersionReference: product.productVersionReference,
            evidenceReferences: Object.freeze([...allReferences].sort().map(parseCatalogReference)),
            optionEvidenceReferences: Object.freeze(
              Object.fromEntries(
                [...optionReferences]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([reference, items]) => [
                    reference,
                    Object.freeze([...items].sort().map(parseCatalogReference)),
                  ]),
              ),
            ),
            ...(optionReferences.size === 0
              ? {}
              : { choiceEvidence: compactMenuChoiceEvidence(choiceEvidence) }),
          });
          sellables.push({ ...product, optionRules, ...presentationOf(product) });
        }
        if (!registry) return fail();
        const provenance = {
          brandReference: brand,
          menuVersionReference: menu.draft.versionReference,
          defaultLocale: locale,
          registryVersionReference,
          registry,
          evidence: Object.freeze(
            [...evidence.values()].sort((a, b) =>
              a.evidenceReference.localeCompare(b.evidenceReference),
            ),
          ),
          paths: Object.freeze(paths),
        };
        const dependencyDigest =
          "sha256:" +
          sha256Hex(
            canonicalizeRfc8785({
              configurationDigest: owner.configurationDigest,
              products,
              optionDependencies,
              recipeDependencies,
              provenance,
            }),
          );
        const content = buildReviewedMenuContent({
          menu,
          sellables,
          provenance,
          checkedAt: at,
          validationEvidenceReference,
        });
        const record = createMenuReviewContent({
          lifecycleReference,
          configurationDigest: owner.configurationDigest,
          dependencyDigest,
          content,
          createdByActorReference: actor,
          createdAt: at,
        });
        const validation = validateMenuAllergenProvenance({
          snapshot: { ...provenance, snapshotDigest: record.snapshotDigest },
          checkedAt: at,
          evidenceReference: validationEvidenceReference,
        }).validation;
        if (!(await authorize("Catalog"))) return fail();
        return Object.freeze({ record, validation, resolvedConfigurations });
      } catch (error) {
        // WP-2423 (v15 2026-10-22): keep what is missing so staff are told which item to fix;
        // v15 2026-10-29: otherwise why it stopped, and where.
        if (error instanceof MenuRecipeAllergenError) throw error;
        throw new MenuRecipeAllergenError(null, reviewStopReason(error));
      }
    },
  });
}

export class MenuReviewDependencyChangedError extends Error {
  readonly code = "MENU_REVIEW_DEPENDENCY_CHANGED";
  constructor() {
    super("Menu review dependencies changed");
    this.name = "MenuReviewDependencyChangedError";
  }
}

/** Revalidate a saved immutable binding; never replace its author/time or create
 * a new approval. Legacy records retain their original Menu-only binding.
 */
export function createMenuReviewDependencyBindingSource(
  options: Parameters<typeof createMenuReviewPreparationSource>[0] & {
    budget: MenuReviewPreparationInput["budget"];
  },
) {
  const preparation = createMenuReviewPreparationSource(options);
  return Object.freeze({
    async resolve(
      tx: ProductLifecycleTransaction,
      input: {
        actorReference: string;
        menuReference: string;
        menuVersionReference: string;
        snapshotDigest: string;
        observedAt: string;
        validationEvidenceReference: string;
      },
    ) {
      try {
        const actor = parseCatalogReference(input.actorReference);
        const menu = parseCatalogReference(input.menuReference);
        const record = await createPostgresMenuReviewContentStore({
          brandReference: options.brandReference,
          menuReference: menu,
          authorize: async () =>
            options.authorize(tx, {
              actorReference: actor,
              menuReference: menu,
              storeReference: null,
              owner: "Catalog",
            }),
        }).read(tx, input.menuVersionReference, input.snapshotDigest, input.observedAt);
        if (!record) return fail();
        if (record.dependencyDigest === undefined) return record;
        const registries = new Set(
          record.content.sections.flatMap((section) =>
            section.sellables.map(
              (sellable) => sellable.allergenDisclosure.registryVersionReference,
            ),
          ),
        );
        const registry = [...registries][0];
        if (registries.size !== 1 || !registry) return fail();
        const current = await preparation.prepare(tx, {
          actorReference: actor,
          menuReference: menu,
          lifecycleReference: record.lifecycleReference,
          validationEvidenceReference: input.validationEvidenceReference,
          registryVersionReference: registry,
          observedAt: input.observedAt,
          budget: options.budget,
        });
        if (
          current.record.configurationDigest !== record.configurationDigest ||
          current.record.dependencyDigest !== record.dependencyDigest ||
          current.record.snapshotDigest !== record.snapshotDigest
        )
          throw new MenuReviewDependencyChangedError();
        return record;
      } catch (error) {
        if (error instanceof MenuReviewDependencyChangedError) throw error;
        if (error instanceof MenuRecipeAllergenError && error.gap !== null) throw error;
        return fail();
      }
    },
  });
}

/**
 * WP-2423 ⑪: per-choice evidence as `{ options, outcomes, sets }` — options and evidence outcomes
 * stored once and referred to by index, so a drink with hundreds of choice sets stays small.
 */
export function compactMenuChoiceEvidence(
  choices: ReadonlyMap<
    string,
    { readonly options: readonly string[]; readonly evidence: ReadonlySet<string> }
  >,
) {
  const options = [...new Set([...choices.values()].flatMap((choice) => choice.options))].sort();
  const optionIndex = new Map(options.map((reference, index) => [reference, index]));
  const outcomes: string[][] = [];
  const outcomeIndex = new Map<string, number>();
  const sets = [...choices.keys()].sort().map((key) => {
    const choice = choices.get(key);
    if (!choice) throw new Error("choice evidence");
    const evidence = [...choice.evidence].sort();
    const outcomeKey = evidence.join(",");
    let outcome = outcomeIndex.get(outcomeKey);
    if (outcome === undefined) {
      outcome = outcomes.length;
      outcomeIndex.set(outcomeKey, outcome);
      outcomes.push(evidence);
    }
    return Object.freeze([
      outcome,
      ...choice.options
        .map((reference) => optionIndex.get(reference) as number)
        .sort((a, b) => a - b),
    ]);
  });
  return Object.freeze({
    options: Object.freeze(options.map(parseCatalogReference)),
    outcomes: Object.freeze(
      outcomes.map((items) => Object.freeze(items.map(parseCatalogReference))),
    ),
    sets: Object.freeze(sets),
  });
}
