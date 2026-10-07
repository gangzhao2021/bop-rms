export { moduleManifest } from "./module.manifest.js";
export * from "./contracts/selling-unit-registry.js";
export * from "./contracts/product.js";
export * from "./domain/product.js";
export * from "./application/product-service.js";
export * from "./application/ports/product-ports.js";
export * from "./contracts/category-menu.js";
export * from "./application/category-menu-service.js";
export * from "./application/ports/category-menu-ports.js";
export * from "./contracts/option-set.js";
export * from "./contracts/option-set-publication-content.js";
export * from "./contracts/option-set-editor-content.js";
export * from "./contracts/option-set-rule-satisfiability.js";
export * from "./application/product-publication-option-selection.js";
export * from "./contracts/option-set-content-policy.js";
export * from "./infrastructure/persistence/option-set-full-draft-store.js";
export * from "./application/option-set-service.js";
export * from "./application/ports/option-set-ports.js";
export * from "./contracts/availability.js";
export * from "./application/availability-service.js";
export * from "./application/ports/availability-ports.js";
export * from "./contracts/menu-publication.js";
export * from "./domain/menu-publication.js";
export * from "./application/menu-publication-service.js";
export * from "./application/ports/menu-publication-ports.js";
export * from "./contracts/published-menu-projection.js";
export * from "./domain/published-menu-projection.js";
export * from "./application/menu-published-event.js";
export * from "./application/published-menu-projection-service.js";
export * from "./application/ports/published-menu-projection-ports.js";
export * from "./contracts/customer-menu-query.js";
export * from "./application/customer-menu-query-service.js";
export * from "./application/ports/customer-menu-query-ports.js";
export * from "./contracts/allergen-provenance.js";
export * from "./domain/allergen-provenance.js";
export * from "./application/allergen-provenance-service.js";
export * from "./application/ports/allergen-provenance-ports.js";
export * from "./contracts/selection-validation.js";
export * from "./application/selection-validation-service.js";
export * from "./application/ports/selection-validation-ports.js";
export * from "./contracts/bundle.js";
export * from "./application/ports/bundle-ports.js";
export * from "./application/bundle-service.js";
export * from "./infrastructure/persistence/published-menu-query-store.js";
export * from "./application/selection-display-query-service.js";
export * from "./infrastructure/persistence/availability-query-store.js";
export * from "./application/current-availability-query-service.js";
export * from "./application/ports/current-availability-query-ports.js";

export * from "./infrastructure/persistence/current-menu-release-store.js";

export * from "./infrastructure/persistence/current-sku-store.js";

export * from "./infrastructure/persistence/current-option-bindings-store.js";

export * from "./application/current-selection-rules.js";

export { createPostgresCurrentMenuPlacementStore } from "./infrastructure/persistence/current-menu-placement-store.js";

export {
  createCurrentCatalogSelectionSource,
  type CurrentSelectionSourcePorts,
} from "./application/current-selection-source.js";

export {
  createPostgresCurrentSelectionFactsStore,
  createPostgresCatalogSelectionService,
  createPostgresCatalogOrderSnapshotSource,
} from "./infrastructure/persistence/current-selection-facts-store.js";

export { createPostgresMenuPricingFactsSource } from "./infrastructure/persistence/menu-pricing-facts-source.js";

export {
  createPostgresProductLifecycleStore,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  type ProductLifecycleTransaction,
  type ProductAggregateVersionReader,
} from "./infrastructure/persistence/product-lifecycle-store.js";

export { createPostgresMenuDraftSource } from "./infrastructure/persistence/menu-draft-source.js";

export { createPostgresMenuPublicationRepository } from "./infrastructure/persistence/menu-publication-repository.js";

export { createPostgresMenuPublicationEvidenceSource } from "./infrastructure/persistence/menu-publication-evidence-source.js";

export {
  createPostgresMenuReviewContentStore,
  createMenuReviewContent,
  type MenuReviewContent,
} from "./infrastructure/persistence/menu-review-content-store.js";

export { createPostgresAllergenReviewFactsStore } from "./infrastructure/persistence/allergen-review-facts-store.js";

export {
  parseProductEditorAllergenRegistryRequest,
  buildProductEditorAllergenRegistrySnapshot,
  productEditorAllergenRegistryFields,
  type ProductEditorAllergenRegistryRequest,
  type ProductEditorAllergenRegistrySnapshot,
} from "./contracts/product-editor-allergen-registry.js";
export {
  createPostgresProductEditorAllergenRegistrySource,
  type ProductEditorAllergenRegistryAuthority,
} from "./infrastructure/persistence/product-editor-allergen-registry-source.js";

export { createPostgresMenuReviewProductSource } from "./infrastructure/persistence/menu-review-product-source.js";

export { createPostgresMenuReviewOptionSource } from "./infrastructure/persistence/menu-review-option-source.js";

export { buildReviewedMenuOptionRules } from "./application/reviewed-menu-option-rules.js";

export {
  buildReviewedMenuContent,
  type MenuReviewSellableFact,
} from "./application/reviewed-menu-content.js";

export { createPostgresProductOptionSetSource } from "./infrastructure/persistence/current-option-bindings-store.js";

export {
  CatalogProductListError,
  parseCatalogProductListRequest,
  parseCatalogProductListView,
  type CatalogProductListRequest,
  type CatalogProductListItem,
  type CatalogProductListCategory,
  type CatalogProductListCategoryOptions,
  catalogProductListCategoryFields,
  type CatalogProductListView,
} from "./contracts/product-list.js";
export {
  createPostgresCatalogProductListQueryStore,
  type CatalogProductListCategorySource,
  type CatalogProductListTransactionRunner,
  type CatalogProductListAuthorization,
} from "./infrastructure/persistence/product-list-query-store.js";

export type {
  ProductSearchBuildRequest,
  ProductSearchGeneration,
  ProductSearchGenerationState,
  ProductSearchBuildResult,
} from "./contracts/product-search-generation.js";
export {
  parseProductSearchBuildRequest,
  parseProductSearchGeneration,
} from "./contracts/product-search-generation.js";
export {
  createPostgresProductSearchGenerationStore,
  type ProductSearchBuildAuthority,
  type CategoryProductViewAuthority,
  type CategoryTreeViewAuthority,
} from "./infrastructure/persistence/product-search-generation-store.js";

export {
  copyCategoryPersistenceValue,
  parseCategoryOperationRecord,
  validateCategoryPersistenceWrite,
  validateCategoryTreeSnapshot,
  type CategoryPersistenceWrite,
  type CategorySourceEventType,
} from "./contracts/category-persistence.js";

export {
  createPostgresCategoryRepository,
  categoryPersistenceFields,
  type CategoryPersistenceAuthority,
} from "./infrastructure/persistence/category-repository.js";

export {
  categorySourceRevision,
  categorySourceEventDigest,
  categorySourceDigest,
  parseCategorySourceEvent,
  categorySourceEventTypes,
  type CategorySourceSnapshot,
  type CategorySourcePort,
} from "./contracts/category-source.js";

export {
  createPostgresCategorySourceStore,
  type CategorySourceAuthority,
} from "./infrastructure/persistence/category-source-store.js";

export {
  createPostgresCategorySourceConsumer,
  type CategorySourceConsumer,
} from "./infrastructure/persistence/category-source-consumer.js";

export * from "./domain/product-category.js";

export {
  createPostgresProductCategoryAssignmentAuthority,
  productCategoryAssignmentFields,
  type ProductCategoryAssignmentAuthority,
} from "./infrastructure/persistence/product-category-assignment.js";

export * from "./contracts/product-category-source.js";

export * from "./contracts/category-tree-view.js";

export {
  parseMenuCategoryBindings,
  type MenuCategoryBinding,
} from "./domain/menu-category-bindings.js";

export {
  buildMenuCategorySourceSnapshot,
  menuCategorySourceFields,
  type MenuCategorySourceSnapshot,
  type MenuCategoryReviewState,
} from "./contracts/menu-category-source.js";
export {
  createPostgresMenuCategorySourceStore,
  type MenuCategorySourceAuthority,
} from "./infrastructure/persistence/menu-category-source-store.js";

export { parseMenuCategorySourceSnapshot } from "./contracts/menu-category-source.js";
export {
  deriveCategoryMenuUse,
  parseCategoryMenuUse,
  categoryMenuReviewStates,
  type CategoryMenuUse,
  type CategoryMenuMeasure,
} from "./contracts/category-menu-use.js";
export { categoryTreeMenuViewFields } from "./contracts/category-tree-view.js";

export * from "./contracts/product-category-lookup.js";

export * from "./contracts/product-draft-baseline.js";

export {
  createPostgresProductDraftBaselineStore,
  type ProductDraftBaselineSourceAuthority,
} from "./infrastructure/persistence/product-draft-baseline-store.js";

export * from "./contracts/product-lifecycle-review.js";

export * from "./contracts/product-availability-source.js";
export * from "./infrastructure/persistence/product-availability-source-store.js";

export * from "./contracts/product-bundle-source.js";
export * from "./infrastructure/persistence/product-bundle-source-store.js";

export * from "./contracts/product-menu-source.js";
export * from "./infrastructure/persistence/product-menu-source-store.js";

export {
  productPricingBindingSourceMaximumRows,
  productPricingBindingSourceFields,
  productPricingBindingCurrentSourceFields,
  buildProductPricingBindingSourceSnapshot,
  parseProductPricingBindingSourceSnapshot,
  type ProductPricingBindingReference,
  type ProductPricingBindingSourceSnapshot,
} from "./contracts/product-pricing-binding-source.js";
export * from "./infrastructure/persistence/product-pricing-binding-source-store.js";

export * from "./contracts/product-reference-history-source.js";
export * from "./contracts/product-publication-reference-request-v2.js";
export * from "./infrastructure/persistence/product-reference-history-source-store.js";

export * from "./contracts/availability-reference-source.js";
export * from "./infrastructure/persistence/availability-reference-source-store.js";

export * from "./contracts/product-availability-reference-matches.js";

export * from "./contracts/bundle-reference-source.js";
export * from "./infrastructure/persistence/bundle-reference-source-store.js";

export * from "./contracts/product-bundle-reference-matches.js";

export * from "./contracts/menu-reference-source.js";
export * from "./infrastructure/persistence/menu-reference-source-store.js";

export * from "./contracts/product-menu-reference-matches.js";
export * from "./contracts/inventory-sku-reference-source.js";
export { createPostgresCatalogInventorySkuReferenceSourceStore } from "./infrastructure/persistence/inventory-sku-reference-source-store.js";
export type { CatalogInventorySkuReferenceOptions } from "./infrastructure/persistence/inventory-sku-reference-source-store.js";

export * from "./contracts/product-publication.js";
export * from "./contracts/product-scope-replacement-intent.js";
export * from "./contracts/product-publication-v2.js";
export * from "./contracts/product-publication-content.js";

export * from "./contracts/product-publication-event.js";
export * from "./infrastructure/persistence/product-publication-store.js";
export * from "./infrastructure/persistence/recipe-allergen-coverage-source.js";

export * from "./contracts/product-publication-source.js";
export * from "./infrastructure/persistence/product-publication-source-store.js";

export * from "./application/current-product-publication.js";

export * from "./application/product-publication-scheduler.js";

export * from "./contracts/product-editor-content.js";

export * from "./application/product-editor-content-authority.js";
export {
  productVariantHistoryFields,
  buildProductVariantIdentityHistory,
  parseProductVariantIdentityHistoryRequest,
  parseProductVariantIdentityHistorySnapshot,
  assertProductVariantIdentityHistory,
  type ProductVariantIdentityHistoryRequest,
  type ProductVariantIdentityHistorySnapshot,
  productVariantCreationFields,
  parseProductVariantCreationRequest,
  buildProductVariantCreationAbsence,
  parseProductVariantCreationAbsence,
  assertProductVariantCreationAbsence,
  type ProductVariantCreationRequest,
  type ProductVariantCreationAbsence,
} from "./contracts/product-variant-identity-history.js";
export * from "./contracts/product-publication-reference-provenance.js";
export * from "./application/product-publication-reference-coverage.js";
export * from "./application/product-publication-catalog-reference-matches.js";
export * from "./contracts/product-scope-overlap.js";

export * from "./contracts/product-scope-journal.js";
export * from "./contracts/product-content-policy.js";
export * from "./contracts/product-content-registry.js";
export * from "./contracts/product-approval-receipt.js";
export * from "./contracts/product-approval-policy.js";
export * from "./contracts/product-approval-decision.js";
export * from "./infrastructure/persistence/product-content-registry-store.js";

export * from "./contracts/product-validation-candidate.js";
export {
  createPostgresProductValidationCandidateSource,
  type ProductValidationCandidateAuthority,
  createPostgresProductValidationCandidateSourceV2,
  type ProductValidationCandidateAuthorityV2,
} from "./infrastructure/persistence/product-draft-baseline-store.js";

export * from "./contracts/product-unique-scope.js";
export * from "./contracts/product-unique-scope-v2.js";
export * from "./application/product-unique-scope-validation-v2.js";

export * from "./contracts/option-set-full-create.js";
export * from "./infrastructure/persistence/product-whole-scope-replacement-store.js";
export * from "./contracts/product-editor-snapshot.js";
export * from "./infrastructure/persistence/product-editor-source-store.js";

export * from "./contracts/option-set-review-binding.js";
export * from "./contracts/product-candidate-recipe-target.js";

export * from "./contracts/product-publication-management.js";
export * from "./contracts/product-publication-management-v2.js";

export {
  applyCatalogProductUniqueScopeValidation,
  type ProductUniqueScopeValidationBinding,
} from "./application/product-unique-scope-validation.js";

export * from "./contracts/product-validation-policy.js";
export * from "./application/product-candidate-validation.js";
export * from "./application/product-content-policy-validation.js";

export * from "./contracts/product-scope-retirement.js";
export * from "./contracts/product-publication-source-v2.js";
export * from "./contracts/product-approval-v2.js";
export * from "./contracts/product-publication-validation-context-v2.js";
export * from "./contracts/product-tax-classification-registry.js";
export * from "./infrastructure/persistence/product-tax-classification-registry-store.js";

export * from "./contracts/product-publication-validation-report.js";
export * from "./contracts/product-publication-warning-acknowledgement.js";
export * from "./contracts/product-publication-validation-report-query-v2.js";
export * from "./infrastructure/persistence/product-publication-validation-report-source-store.js";

export * from "./contracts/product-publication-warning-acknowledgement-event.js";
export * from "./infrastructure/persistence/product-publication-warning-acknowledgement-store.js";
export * from "./contracts/product-publication-qualification-context.js";
export * from "./application/product-publication-validation-composition.js";
export * from "./contracts/product-publication-scope-assessment.js";
export * from "./contracts/product-warning-acknowledgement-reference-request.js";
export * from "./contracts/product-publication-resolution.js";
export * from "./application/product-publication-business-classification.js";
export {
  createPostgresProductPublicationResolutionStore,
  productPublicationResolutionFields,
  type ProductPublicationResolutionStoreOptions,
  type ProductPublicationResolutionWriteResult,
} from "./infrastructure/persistence/product-publication-resolution-store.js";
export * from "./infrastructure/persistence/selling-unit-registry-store.js";
export * from "./contracts/product-authoring-resolution.js";
export * from "./infrastructure/persistence/product-authoring-resolution-store.js";
export * from "./contracts/option-set-review-record.js";
export * from "./infrastructure/persistence/option-set-review-content-store.js";

export * from "./contracts/option-set-full-edit.js";

export * from "./contracts/option-set-authoring-resolution.js";
export * from "./infrastructure/persistence/option-set-authoring-resolution-store.js";
export * from "./contracts/option-set-list.js";
export * from "./infrastructure/persistence/option-set-list-query-store.js";

export { assessCatalogOptionSetBrandScope } from "./contracts/option-set-brand-scope-assessment.js";

export {
  prepareCatalogOptionSetRecordedReviewQualification,
  assertCatalogOptionSetRecordedReviewQualification,
} from "./contracts/option-set-review-qualification.js";

export * from "./contracts/option-set-history.js";
export * from "./infrastructure/persistence/option-set-history-store.js";
export * from "./contracts/option-set-content-comparison.js";

export * from "./contracts/product-option-price-context-source.js";
export * from "./infrastructure/persistence/product-option-price-context-source-store.js";
export * from "./contracts/product-tax-coverage-source.js";
export * from "./infrastructure/persistence/product-tax-coverage-source-store.js";

export * from "./contracts/brand-catalog-source.js";

export * from "./infrastructure/persistence/brand-catalog-source-store.js";
