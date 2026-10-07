export { moduleManifest } from "./module.manifest.js";
export * from "./application/ports/recipe-ports.js";
export * from "./application/recipe-service.js";
export * from "./domain/recipe.js";

export * from "./infrastructure/persistence/recipe-query-store.js";
export { createPostgresRecipeAdminQueryStore } from "./infrastructure/persistence/recipe-admin-query-store.js";
export * from "./domain/publication-review.js";
export { createPostgresRecipeStore } from "./infrastructure/persistence/recipe-store.js";
export { createPostgresBaseRecipeSource } from "./infrastructure/persistence/recipe-binding-store.js";
export * from "./domain/recipe-authoring.js";
export * from "./infrastructure/persistence/recipe-authoring-store.js";
export * from "./domain/recipe-demand.js";
export { createPostgresBaseRecipeDemandSource } from "./infrastructure/persistence/recipe-demand-store.js";
export * from "./domain/recipe-modifier.js";
export { createPostgresRecipeModifierSource } from "./infrastructure/persistence/recipe-modifier-store.js";

export { createPostgresConfiguredRecipeDemandSource } from "./infrastructure/persistence/recipe-demand-store.js";

export {
  createPostgresSubmissionRecipeDemandSource,
  createPostgresSaleRecipeDemandSource,
} from "./infrastructure/persistence/recipe-demand-store.js";

export * from "./domain/recipe-preparation-content.js";

export {
  parseRecipePreparationPublication,
  type RecipePreparationPublicationRecord,
} from "./domain/recipe-preparation-publication.js";
export {
  createPostgresRecipePreparationContentStore,
  type ResolveRecipePreparationContentInput,
} from "./infrastructure/persistence/recipe-preparation-content-store.js";

export {
  createPostgresConfiguredRecipePreparationSource,
  type ConfiguredRecipePreparationInput,
} from "./infrastructure/persistence/recipe-demand-store.js";

export {
  createPostgresRecipeReviewSource,
  type RecipeReviewInput,
} from "./infrastructure/persistence/recipe-demand-store.js";

export {
  recipeReferenceSourceFields,
  recipeReferenceSourceMaximumRows,
  parseRecipeReferenceSourceRequest,
  buildRecipeReferenceSourceSnapshot,
  parseRecipeReferenceSourceSnapshot,
  type RecipeReferenceSourceRequest,
  type RecipeReferenceSourceSnapshot,
  type RecipeRootReference,
  type RecipeVersionReference,
  type RecipeBindingReference,
  type RecipeModifierReference,
  type RecipeReferenceLifecycle,
} from "./contracts/recipe-reference-source.js";
export {
  createPostgresRecipeReferenceSourceStore,
  type RecipeReferenceSourceOptions,
  type RecipeReferenceTransaction,
} from "./infrastructure/persistence/recipe-reference-source-store.js";

export {
  matchRecipeCatalogReferences,
  matchRecipeCatalogReferenceGraphs,
  recipeCatalogReferenceMatchMaximumRows,
  type RecipeCatalogReferenceTarget,
  type RecipeCatalogReferenceContext,
  type RecipeCatalogUnresolvedContext,
} from "./contracts/recipe-catalog-reference-matches.js";

export {
  recipeInventoryReferenceFields,
  recipeInventoryReferenceMaximumRows,
  parseRecipeInventoryReferenceRequest,
  buildRecipeInventoryReferenceSnapshot,
  parseRecipeInventoryReferenceSnapshot,
  type RecipeInventoryReferenceRequest,
  type RecipeInventoryReferenceSnapshot,
  type RecipeIngredientReference,
  type RecipeInventoryModifierReference,
  type RecipeInventoryChangeReference,
} from "./contracts/recipe-inventory-reference-source.js";
export {
  createPostgresRecipeInventoryReferenceSourceStore,
  type RecipeInventoryReferenceOptions,
  type RecipeInventoryReferenceTransaction,
} from "./infrastructure/persistence/recipe-inventory-reference-source-store.js";
export {
  matchRecipeInventoryReferenceRoots,
  type RecipeInventoryReachableRequirement,
} from "./contracts/recipe-inventory-reference-matches.js";
export * from "./application/recipe-source-coverage.js";

export * from "./infrastructure/persistence/recipe-coverage-publication-store.js";

export * from "./infrastructure/persistence/recipe-owner-coverage-source.js";

export * from "./application/recipe-coverage-source-assembly.js";

export * from "./application/recipe-projection-graph.js";

export * from "./application/recipe-projection-core.js";

export * from "./infrastructure/persistence/recipe-core-publication-store.js";

export {
  RecipeCoreQueryError,
  decodeRecipeCoreGeneration,
  type DecodedRecipeCoreGeneration,
} from "./application/recipe-core-query.js";
export * from "./infrastructure/persistence/recipe-core-query-store.js";

export {
  createRecipeCoreRebuildCoordinator,
  RecipeCoreRebuildError,
  type RecipeCoreRebuildRequest,
  type RecipeCoreRebuildResult,
  type RecipeCoreRebuildState,
} from "./application/recipe-core-rebuild.js";
export * from "./infrastructure/persistence/recipe-core-rebuild-state-store.js";

export { matchOptionDraftRecipeConsumptionMetadata } from "./contracts/recipe-reference-source.js";
export {
  parseRecipeOptionPublicationOriginalClock,
  type RecipeOptionPublicationOriginalClock,
} from "./contracts/recipe-reference-source.js";

export * from "./contracts/option-consumption-yield-source.js";
export * from "./infrastructure/persistence/option-consumption-yield-source-store.js";
export * from "./contracts/current-catalog-binding-scope.js";
export * from "./contracts/current-store-recipe-resolution.js";

export {
  createCurrentPublishedRecipeContentSource,
  currentPublishedRecipeContentFields,
  type CurrentPublishedRecipeContent,
  type CurrentPublishedRecipeContentOptions,
} from "./infrastructure/persistence/current-published-recipe-content-source.js";

export {
  createCurrentPublishedRecipeDependencyGraphSource,
  currentPublishedRecipeDependencyGraphFields,
  type CurrentPublishedRecipeDependencyGraph,
  type CurrentPublishedRecipeDependencyGraphOptions,
} from "./infrastructure/persistence/current-published-recipe-dependency-graph-source.js";

export * from "./domain/recipe-measurement-content.js";

export * from "./contracts/recipe-measurement-content-digest.js";
export * from "./application/recipe-measurement-draft-service.js";
export { createPostgresRecipeMeasurementDraftStore } from "./infrastructure/persistence/recipe-measurement-draft-store.js";

export * from "./contracts/recipe-measurement-amount-assessment.js";

export * from "./contracts/recipe-measurement-recursive-demand.js";
export * from "./contracts/recipe-measurement-batch-demands.js";
export { createPostgresRecipeMeasurementPublicationStore } from "./infrastructure/persistence/recipe-measurement-draft-store.js";
export { readPublishedRecipeMeasurementContent } from "./infrastructure/persistence/recipe-measurement-draft-store.js";
export {
  createCurrentPublishedRecipeMeasurementGraphSource,
  currentPublishedRecipeMeasurementGraphFields,
  type CurrentPublishedRecipeMeasurementGraph,
  type CurrentPublishedRecipeMeasurementGraphOptions,
} from "./infrastructure/persistence/current-published-recipe-measurement-graph-source.js";

export {
  createPinnedPublishedRecipeDependencyGraphSource,
  type PinnedPublishedRecipeDependencyGraph,
} from "./infrastructure/persistence/current-published-recipe-dependency-graph-source.js";
export {
  createPinnedPublishedRecipeMeasurementGraphSource,
  type PinnedPublishedRecipeMeasurementGraph,
} from "./infrastructure/persistence/current-published-recipe-measurement-graph-source.js";

export * from "./contracts/product-publication-reference-request-v2.js";
export {
  recipeProductPublicationReferenceSourceFieldsV2,
  buildRecipeProductPublicationReferenceSnapshotV2,
  parseRecipeProductPublicationReferenceSnapshotV2,
  type RecipeProductPublicationReferenceSnapshotV2,
} from "./contracts/recipe-reference-source.js";
export {
  recipeInventoryProductPublicationReferenceSourceFieldsV2,
  buildRecipeInventoryProductPublicationReferenceSnapshotV2,
  parseRecipeInventoryProductPublicationReferenceSnapshotV2,
  type RecipeInventoryProductPublicationReferenceSnapshotV2,
} from "./contracts/recipe-inventory-reference-source.js";
export {
  createPostgresRecipeProductPublicationReferenceSourceV2,
  type RecipeProductPublicationReferenceSourceOptionsV2,
} from "./infrastructure/persistence/recipe-reference-source-store.js";
export {
  createPostgresRecipeInventoryProductPublicationReferenceSourceV2,
  type RecipeInventoryProductPublicationReferenceSourceOptionsV2,
} from "./infrastructure/persistence/recipe-inventory-reference-source-store.js";
export {
  matchRecipeProductPublicationReferenceGraphsV2,
  type RecipeProductPublicationReferenceTargetV2,
} from "./contracts/recipe-catalog-reference-matches.js";
export { matchRecipeInventoryProductPublicationReferenceRootsV2 } from "./contracts/recipe-inventory-reference-matches.js";

export { createPostgresRecipeOptionConsumptionYieldSource } from "./infrastructure/persistence/option-consumption-yield-source-store.js";
export {
  parseRecipeOptionConsumptionPins,
  recipeOptionConsumptionYieldFields,
  assessRecipeOptionConsumptionYields,
} from "./contracts/option-consumption-yield-source.js";
