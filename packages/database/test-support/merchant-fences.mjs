/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: every write fence the triggers take, one place. The migrations'
 * triggers, the readers' keys and the acceptance matrix are all checked against this list, so a
 * new table or a mistyped key cannot silently drop a guarantee a table lock used to give.
 */
const brand = (...parts) => parts.join(":");

export const merchantFences = Object.freeze([
  {
    fence: "CatalogOptionContentFence",
    schema: "rms_catalog",
    scope: "brand",
    tables: ["option_set", "option_set_version", "option", "option_conflict"],
  },
  {
    fence: "CatalogProductBindingFence",
    schema: "rms_catalog",
    scope: "brand",
    tables: [
      "sku",
      "product_version",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ],
  },
  {
    fence: "CatalogAllergenRegistryFence",
    schema: "rms_catalog",
    scope: "brand",
    tables: ["allergen_registry_version", "allergen_registry_entry"],
  },
  {
    fence: "CatalogAllergenEvidenceFence",
    schema: "rms_catalog",
    scope: "brand",
    tables: ["allergen_source_evidence", "allergen_source_assertion"],
  },
  {
    fence: "StoreAuthoringFence",
    schema: "rms_store",
    scope: "store",
    tables: ["store_configuration_authoring_operation"],
  },
  {
    fence: "StoreConfigurationFence",
    schema: "rms_store",
    scope: "store",
    tables: [
      "store_configuration_version",
      "store_configuration_publication_content",
      "store_weekly_service_period",
      "store_service_exception",
      "store_service_exception_content",
      "store_service_exception_interval",
    ],
  },
  {
    fence: "StoreServicePauseFence",
    schema: "rms_store",
    scope: "store",
    tables: [
      "store_configuration_operation",
      "store_service_pause_content",
      "store_service_resume_content",
    ],
  },
  {
    fence: "StoreReviewSnapshotFence",
    schema: "rms_store",
    scope: "store",
    tables: ["store_configuration_review_snapshot"],
  },
  {
    fence: "StorePublicProfileFence",
    schema: "rms_store",
    scope: "store",
    tables: ["public_store_profile_version"],
  },
  {
    fence: "StorePublicProfileTimingFence",
    schema: "rms_store",
    scope: "store",
    tables: ["public_store_profile_timing"],
  },
  {
    fence: "WorkflowDefinitionFence",
    schema: "bop_workflow",
    scope: "tenant",
    tables: ["workflow_definition_version"],
  },
  {
    fence: "LiveGateFence",
    schema: "bop_publishing",
    scope: "store",
    tables: ["live_gate_version", "live_gate_requirement"],
  },
  {
    fence: "PermissionPolicyFence",
    schema: "bop_permission",
    scope: "brand",
    tables: ["policy_state", "role", "role_assignment", "permission_grant", "permission_override"],
  },
  {
    fence: "MembershipFence",
    schema: "bop_membership",
    scope: "brand",
    tables: ["membership", "store_assignment"],
  },
  {
    fence: "RecipeCatalogReferenceV1",
    schema: "rms_recipe",
    scope: "brand",
    // A guest's order reads this fence: a writer waits only briefly, then its route tries again.
    bounded: true,
    tables: [
      "recipe",
      "recipe_version",
      "recipe_scope_binding",
      "recipe_modifier_version",
      "recipe_ingredient_requirement",
      "recipe_measurement_content",
    ],
  },
  {
    fence: "RecipePreparationContentFence",
    schema: "rms_recipe",
    scope: "brand",
    tables: ["recipe_preparation_content"],
  },
]);

/** The key a fence takes for a merchant scope, as the triggers and the readers build it. */
export function merchantFenceKey(entry, { tenant, brand: brandReference, store }) {
  if (entry.scope === "brand") return brand(entry.fence, brandReference);
  if (entry.scope === "store") return brand(entry.fence, brandReference, store);
  return brand(entry.fence, tenant, brandReference);
}

/**
 * Who takes which fence, as the code says it: S shared, X exclusive, E either by mode. Fences on
 * existing reference keys (Pricing, Inventory) are held by their AFTER triggers and listed here too.
 */
export const merchantFenceSites = Object.freeze({
  "packages/rms/catalog/src/infrastructure/persistence/menu-review-option-source.ts": {
    CatalogOptionContentFence: "S",
    CatalogProductBindingFence: "S",
  },
  "packages/rms/catalog/src/infrastructure/persistence/current-option-bindings-store.ts": {
    CatalogOptionContentFence: "S",
  },
  "packages/rms/catalog/src/infrastructure/persistence/option-set-list-query-store.ts": {
    CatalogOptionContentFence: "S",
    CatalogProductBindingFence: "S",
  },
  "packages/rms/catalog/src/infrastructure/persistence/allergen-review-facts-store.ts": {
    CatalogAllergenRegistryFence: "S",
    CatalogAllergenEvidenceFence: "S",
  },
  "packages/rms/catalog/src/infrastructure/persistence/recipe-allergen-coverage-source.ts": {
    CatalogAllergenRegistryFence: "S",
    CatalogAllergenEvidenceFence: "S",
  },
  "packages/rms/catalog/src/infrastructure/persistence/product-editor-allergen-registry-source.ts":
    { CatalogAllergenRegistryFence: "S" },
  "packages/rms/recipe/src/infrastructure/persistence/recipe-demand-store.ts": {
    RecipeCatalogReferenceV1: "S",
  },
  "packages/rms/recipe/src/infrastructure/persistence/recipe-owner-coverage-source.ts": {
    RecipeCatalogReferenceV1: "S",
    RecipePreparationContentFence: "S",
  },
  "packages/rms/recipe/src/infrastructure/persistence/recipe-preparation-content-store.ts": {
    RecipeCatalogReferenceV1: "S",
  },
  "packages/rms/recipe/src/infrastructure/persistence/recipe-authoring-store.ts": {
    RecipeCatalogReferenceV1: "X",
  },
  "packages/rms/inventory/src/infrastructure/persistence/recipe-configuration-coverage-source.ts": {
    InventoryCatalogReferenceV1: "S",
  },
  "packages/rms/pricing/src/infrastructure/persistence/option-price-authoring-store.ts": {
    PricingConfigurationReferenceV1: "E",
  },
  "packages/rms/pricing/src/infrastructure/persistence/tax-config-authoring-store.ts": {
    PricingTaxReferenceV1: "X",
  },
  "packages/rms/store/src/infrastructure/persistence/business-date-source.ts": {
    StoreAuthoringFence: "S",
    StoreConfigurationFence: "S",
  },
  "packages/rms/store/src/infrastructure/persistence/publication-content-source.ts": {
    StoreConfigurationFence: "S",
  },
  "packages/rms/store/src/infrastructure/persistence/weekly-schedule-source.ts": {
    StoreConfigurationFence: "S",
  },
  "packages/rms/store/src/infrastructure/persistence/exception-content-source.ts": {
    StoreConfigurationFence: "S",
  },
  "packages/rms/store/src/infrastructure/persistence/pause-history-source.ts": {
    StoreServicePauseFence: "S",
  },
  "packages/rms/store/src/infrastructure/persistence/service-control-store.ts": {
    StoreServicePauseFence: "X",
  },
  "packages/rms/store/src/infrastructure/persistence/configuration-authoring-store.ts": {
    StoreAuthoringFence: "E",
  },
  "packages/rms/store/src/infrastructure/persistence/review-snapshot-store.ts": {
    StoreReviewSnapshotFence: "E",
  },
  "packages/rms/store/src/infrastructure/persistence/public-store-profile-store.ts": {
    StorePublicProfileFence: "E",
  },
  "packages/rms/store/src/infrastructure/persistence/public-store-profile-timing-store.ts": {
    StorePublicProfileTimingFence: "E",
  },
  "packages/bop/workflow/src/infrastructure/persistence/workflow-definition-store.ts": {
    WorkflowDefinitionFence: "E",
  },
  "packages/bop/publishing/src/infrastructure/persistence/current-live-gate-source.ts": {
    LiveGateFence: "S",
  },
  "packages/bop/permission/src/infrastructure/persistence/current-policy-store.ts": {
    PermissionPolicyFence: "S",
  },
  "packages/bop/permission/src/infrastructure/persistence/role-assignment-store.ts": {
    PermissionPolicyFence: "X",
  },
  "packages/bop/permission/src/infrastructure/persistence/store-role-provisioning-store.ts": {
    PermissionPolicyFence: "X",
  },
  "packages/bop/permission/src/infrastructure/persistence/brand-role-provisioning-store.ts": {
    PermissionPolicyFence: "X",
  },
  "packages/bop/permission/src/infrastructure/persistence/role-administration-store.ts": {
    PermissionPolicyFence: "X",
  },
  "packages/bop/permission/src/infrastructure/persistence/approved-workforce-policy-store.ts": {
    PermissionPolicyFence: "E",
  },
  "packages/bop/permission/src/infrastructure/persistence/internal-test-validity-store.ts": {
    PermissionPolicyFence: "X",
  },
  "packages/bop/membership/src/infrastructure/persistence/current-membership-store.ts": {
    MembershipFence: "E",
  },
  "packages/bop/membership/src/infrastructure/persistence/approved-workforce-membership-store.ts": {
    MembershipFence: "X",
  },
  "packages/bop/membership/src/infrastructure/persistence/initial-brand-membership-store.ts": {
    MembershipFence: "X",
  },
  "packages/bop/membership/src/infrastructure/persistence/internal-test-validity-store.ts": {
    MembershipFence: "X",
  },
});
