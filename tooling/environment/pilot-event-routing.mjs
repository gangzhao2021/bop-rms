/**
 * WP-2423 5e (DEC-PILOT-EVENT-ROUTING, docs/spec/design/pilot-exhausted-event-recovery.md):
 * outbox routing of the single-store pilot business worker.
 *
 * Brand-scoped events (no Store, e.g. availability rules, Product/Menu/price/recipe authoring) are
 * claimable only from a Brand-only dispatch scope; the Store scope never claims them. The worker
 * therefore dispatches its bound Store and its bound Brand.
 *
 * The event catalog registers consumers that this pilot intentionally does not deploy: the pilot
 * reads the owner's current tables (or projects in the publishing request) instead. Their events
 * are published with no subscriber. Any other event without a deployed consumer is still rejected
 * by the transport, so a consumer the pilot needs but has not wired stays visible.
 */
export const pilotUndeployedConsumers = Object.freeze(
  [
    {
      consumerName: "catalog.availability-workbench-projection:v1",
      eventTypes: [
        "AvailabilityRuleCreated",
        "AvailabilityRuleReplaced",
        "AvailabilityRuleLifecycleChanged",
      ],
      reason:
        "Item availability page, kitchen sold-out and customer menu read rms_catalog.availability_rule directly",
    },
    {
      consumerName: "catalog.product-search-projection:v1",
      eventTypes: [
        "ProductCreated",
        "ProductDraftUpdated",
        "ProductActivated",
        "ProductSuspended",
        "ProductResumed",
        "ProductDiscontinued",
        "ProductArchived",
        "ProductRestored",
        "ProductValidationCompleted",
        "ProductReviewSubmitted",
        "ProductVersionApproved",
        "ProductVersionRejected",
        "ProductVersionPublishScheduled",
        "ProductVersionPublishRescheduled",
        "ProductVersionPublishScheduleCancelled",
        "ProductVersionPublished",
        "ProductVersionSuperseded",
      ],
      reason: "Product list builds its search generation from the source tables on read",
    },
    {
      consumerName: "catalog.category-source:v1",
      eventTypes: [
        "CategoryCreated",
        "CategoryUpdated",
        "CategoryMoved",
        "CategoryReordered",
        "CategoryDeactivated",
        "CategoryRestored",
        "CategoryArchived",
      ],
      reason: "Category tree reads the category source tables directly",
    },
    {
      consumerName: "catalog.option-set-draft-current:v1",
      eventTypes: ["OptionSetDraftCreated", "OptionSetDraftReplaced", "OptionSetContentSealed"],
      reason: "Option set editor reads the current draft tables directly",
    },
    {
      consumerName: "catalog.option-set-record-history:v1",
      eventTypes: ["OptionSetReviewContentRecorded", "OptionSetPublicationReleaseRecorded"],
      reason: "Option set review and release records are read from their owner tables",
    },
    {
      consumerName: "catalog.published-menu-projection:v1",
      eventTypes: ["MenuPublished"],
      reason:
        "Customer menu is projected in the publishing request (merchant menu Publish); Rebuild re-projects",
    },
    {
      consumerName: "catalog.content-registry-current:v1",
      eventTypes: ["ProductContentRegistryVersionRecorded"],
      reason: "Content registry is read from its owner table",
    },
    {
      consumerName: "catalog.tax-classification-registry-current:v1",
      eventTypes: ["ProductTaxClassificationRegistryVersionRecorded"],
      reason: "Tax classification registry is read from its owner table",
    },
    {
      consumerName: "catalog.selling-unit-registry-current:v1",
      eventTypes: ["SellingUnitRegistryVersionRecorded"],
      reason: "Selling unit registry is read from its owner table",
    },
    {
      consumerName: "catalog.product-publication-warning-acknowledgement:v1",
      eventTypes: ["ProductPublicationWarningsAcknowledged"],
      reason: "Publication warning acknowledgements are read from their owner table",
    },
    {
      consumerName: "pricing.price-book-admin-projection:v1",
      eventTypes: [
        "PriceBookDraftCreated",
        "PriceBookDraftReplaced",
        "PriceBookVersionPublished",
        "PriceBookArchived",
      ],
      reason: "Price book pages and quotes read the price book tables directly",
    },
    {
      consumerName: "pricing.option-price-authoring-history:v1",
      eventTypes: [
        "OptionPriceDraftCreated",
        "OptionPriceDraftReplaced",
        "OptionPriceVersionPublished",
        "OptionPriceArchived",
      ],
      reason: "Option prices are read from the option price tables directly",
    },
    {
      consumerName: "pricing.tax-config-admin-projection:v1",
      eventTypes: ["TaxConfigDraftCreated", "TaxConfigDraftReplaced", "TaxConfigPublished"],
      reason: "Store tax pages and quotes read the tax configuration tables directly",
    },
    {
      consumerName: "pricing.tax-config-material-history:v1",
      eventTypes: ["TaxConfigMaterialCreated", "TaxConfigMaterialReplaced"],
      reason: "Tax materials are read from their owner tables",
    },
    {
      consumerName: "pricing.tax-config-candidate-history:v1",
      eventTypes: ["TaxConfigCandidatePrepared"],
      reason: "Tax candidates are read from their owner tables",
    },
    {
      consumerName: "recipe.admin-projection:v1",
      eventTypes: [
        "RecipeDraftCreated",
        "RecipeDraftReplaced",
        "RecipePublished",
        "RecipeInvalidated",
        "RecipeArchived",
      ],
      reason: "Recipe pages read the recipe tables directly",
    },
  ].map((entry) => Object.freeze({ ...entry, eventTypes: Object.freeze([...entry.eventTypes]) })),
);

/** The bound Store, then the bound Brand (Brand-scoped events have no Store). */
export function pilotDispatchScopes(scope) {
  return Object.freeze([
    Object.freeze({ brandId: scope.brandReference, storeId: scope.storeReference }),
    Object.freeze({ brandId: scope.brandReference }),
  ]);
}

/** Only the bound Brand, either at the bound Store or Brand-wide. */
export function isPilotDispatchScope(value, scope) {
  return (
    value?.brandId === scope.brandReference &&
    (value.storeId === undefined || value.storeId === scope.storeReference)
  );
}

/**
 * Event types published with no subscriber in this deployment: those of the undeployed consumers,
 * minus any type a deployed consumer subscribes to. Deploying a consumer declared undeployed is a
 * contradiction and fails composition.
 */
export function pilotUnsubscribedEventTypes(registrations) {
  const declared = new Set(pilotUndeployedConsumers.map((entry) => entry.consumerName));
  const subscribed = new Set();
  for (const registration of registrations) {
    if (declared.has(registration.consumerName))
      throw new Error("PILOT_EVENT_ROUTING_CONSUMER_DEPLOYED");
    subscribed.add(registration.eventType);
  }
  const types = new Set(pilotUndeployedConsumers.flatMap((entry) => entry.eventTypes));
  return Object.freeze([...types].filter((eventType) => !subscribed.has(eventType)));
}
