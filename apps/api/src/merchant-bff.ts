import {
  parseMerchantStoreConfigurationOrdinaryWorkspace,
  parseMerchantStoreConfigurationHistoryPage,
} from "./merchant-store-configuration-ordinary-values.js";
import {
  parseBrandStoreTopologyWorkbench,
  type createMerchantBrandStoreTopologyDraft,
} from "./merchant-brand-store-topology-draft.js";
import { MerchantBrandStoreTopologyFeatureDisabled } from "./merchant-brand-store-topology-capability.js";
import {
  BrandStoreTopologyError,
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyOperationReceipt,
  parsePlatformTenantReference,
  parseBrandReference,
} from "@bop/tenant";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { MerchantTaxConfigFeatureDisabled } from "./merchant-tax-config-capability.js";
import {
  parseTaxConfigClassificationChoices,
  parseTaxConfigAuthoringSimulation,
  parseMerchantTaxConfigSimulationCommand,
  parseMerchantTaxConfigMaterialComparisonCommand,
  parseTaxConfigMaterialComparison,
} from "./merchant-tax-config-workbench-values.js";
import type { createMerchantTaxConfigAuthoring } from "./merchant-tax-config-authoring.js";
import type { createMerchantReceiptTemplatePublished } from "./merchant-receipt-template-published.js";
import type { createMerchantReceiptTemplateLifecycle } from "./merchant-receipt-template-lifecycle.js";
import { bindMerchantReceiptTemplateLifecycleCommand } from "./merchant-receipt-template-lifecycle-command.js";
import type { createMerchantReceiptTemplateReview } from "./merchant-receipt-template-review.js";
import type { createMerchantReceiptTemplateSubmit } from "./merchant-receipt-template-submit.js";
import { bindMerchantReceiptTemplateSubmitCommand } from "./merchant-receipt-template-submit-command.js";
import type { createMerchantReceiptTemplateDraft } from "./merchant-receipt-template-draft.js";
import { bindMerchantReceiptTemplateDraftCommand } from "./merchant-receipt-template-draft-command.js";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
import type { createMerchantReceiptTemplateArtifacts } from "./merchant-receipt-template-artifacts.js";
import { bindMerchantReceiptTemplateArtifactCommand } from "./merchant-receipt-template-artifact-command.js";
import { StorePaymentConfigurationError } from "@rms/payment";
import type { createMerchantStorePaymentConfiguration } from "./merchant-store-payment-configuration.js";
import { bindMerchantStorePaymentConfigurationCommand } from "./merchant-store-payment-configuration-command.js";
import { bindMerchantStoreSetupReferenceCommand } from "./merchant-store-setup-reference-command.js";
import type { createMerchantStoreSetupReferences } from "./merchant-store-setup-references.js";
import { bindMerchantStoreSetupCommand } from "./merchant-store-setup-command.js";
import type { createMerchantStoreSetup } from "./merchant-store-setup.js";
import {
  StoreConfigurationOriginalError,
  StoreConfigurationAdministrationError,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
  type StoreConfigurationOriginalScope,
  type StoreConfigurationOrdinaryCommand,
  type StoreConfigurationOrdinaryResolve,
  StoreSetupOperationError,
  StoreSetupReferenceError,
  parseStoreAdministrationReference,
} from "@rms/store";
import type { createMerchantProductOptionPickerQuery } from "./merchant-product-option-picker-query.js";
import type { createMerchantOptionPriceAuthoringCommand } from "./merchant-option-price-authoring-command.js";
import type { createMerchantOptionPriceReviewCommand } from "./merchant-option-price-review-command.js";
import {
  OptionPriceAuthoringError,
  TaxConfigWorkflowError,
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringOperation,
  taxConfigAuthoringIntentDigest,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  parseTaxConfigCandidateOperation,
  taxConfigCandidateIntentDigest,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialOperation,
  taxConfigMaterialIntentDigest,
  type TaxConfigMaterialKind,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  optionPriceWireState,
  parsePricingReference,
  parsePricingDigest,
  parseCurrencyCode,
  createCurrencyMetadataSnapshot,
} from "@rms/pricing";
import { readClosedRecord } from "@bop/identity";
import {
  parseCatalogReference,
  parseCatalogInstant,
  parseProductOptionBinding,
  parseCatalogLocale,
  parseLocalizedNames,
} from "@rms/catalog";
import {
  parsePublishingOptionSetPublicationOperation,
  parseRecordedPublishingMutation,
  publishingLifecycleStates,
} from "@bop/publishing";
import type { createMerchantOptionSetPublicationCommand } from "./merchant-option-set-publication-command.js";
import type { createMerchantOptionSetPublicationResolutionCommand } from "./merchant-option-set-publication-resolution-command.js";
import type { createMerchantOptionSetPublicationContextQuery } from "./merchant-option-set-publication-context-query.js";
import type { createMerchantOptionSetAuthoringContextQuery } from "./merchant-option-set-authoring-context-query.js";
import type { createMerchantOptionSetListQuery } from "./merchant-option-set-list-query.js";
import type { createMerchantOptionSetAuthoringCommand } from "./merchant-option-set-authoring-command.js";
import type { createMerchantOptionSetHistoryQuery } from "./merchant-option-set-history-query.js";
import type { createMerchantOptionSetCurrentPublicationQuery } from "./merchant-option-set-current-publication-query.js";
import type { createMerchantOptionSetEditorQuery } from "./merchant-option-set-editor-query.js";
import type { createMerchantOptionSetAuthoringResolutionCommand } from "./merchant-option-set-authoring-resolution-command.js";
import type { createMerchantProductSellingUnitRegistry } from "./merchant-product-selling-unit-registry.js";
import type { createMerchantProductAuthoringContextQuery } from "./merchant-product-authoring-context-query.js";
import type { createMerchantProductAuthoringResolutionCommand } from "./merchant-product-authoring-resolution-command.js";
import type { createMerchantProductPublicationResolutionCommand } from "./merchant-product-publication-resolution-command.js";
import type { createMerchantProductPublicationWarningAcknowledgementCommand } from "./merchant-product-publication-warning-acknowledgement-command.js";
import type { createMerchantProductPublicationManagementQuery } from "./merchant-product-publication-management-query.js";
import type { createMerchantProductPublicationManagementQueryV2 } from "./merchant-product-publication-management-query-v2.js";
import type { createMerchantProductPublicationValidationReportQueryV2 } from "./merchant-product-publication-validation-report-query-v2.js";
import type { createMerchantProductPublicationCommandV2 } from "./merchant-product-publication-command-v2.js";
import type { createMerchantProductEditorQuery } from "./merchant-product-editor-query.js";
import type { createMerchantProductScopeJournalQuery } from "./merchant-product-scope-journal-query.js";
import type { createMerchantProductPublicationQuery } from "./merchant-product-publication-query.js";
import type { createMerchantStoreCapability } from "./merchant-store-capability.js";
import type { createMerchantProductPublicationCommand } from "./merchant-product-publication-command.js";
import { parseMerchantTaskInboxFilters } from "./merchant-task-inbox-filters.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import {
  MerchantProductDraftBaselineError,
  parseProductDraftBaselineRequest,
  parseMerchantProductDraftBaselineResult,
  type createMerchantProductDraftBaselineQuery,
} from "./merchant-product-draft-baseline-query.js";
import {
  MerchantProductCategoryLookupError,
  parseProductCategoryLookupRequest,
  parseMerchantProductCategoryLookupResult,
  type createMerchantProductCategoryLookupQuery,
} from "./merchant-product-category-lookup-query.js";
import { decodeMerchantProductCommandScopeHeader } from "./merchant-product-command-scope.js";
import {
  MerchantCategoryTreeError,
  parseMerchantCategoryTreeResult,
  type createMerchantCategoryTreeQuery,
} from "./merchant-category-tree-query.js";
import {
  parseCatalogCategoryTreeFilters,
  parseCatalogProductEditorSnapshot,
  parseProductPublicationSourceRequest,
} from "@rms/catalog";
import type { createMerchantProductListQuery } from "./merchant-product-list-query.js";
import type { createMerchantReconciliationAssigneeQuery } from "./merchant-reconciliation-assignee-query.js";
import { parseOpaqueUuidV7 } from "@bop/identity";
import type { createMerchantReconciliationEvidenceQuery } from "./merchant-reconciliation-evidence-query.js";
import type { createMerchantReconciliationFollowUpQuery } from "./merchant-reconciliation-follow-up-query.js";
import type { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
import { ReconciliationFollowUpError, PaymentReconciliationError } from "@rms/payment";
import type { createMerchantCompensationReconciliationQuery } from "./merchant-compensation-reconciliation-query.js";
import { BrowserSessionError, parseCanonicalInstant } from "@bop/identity";
import type { createMerchantCompensationReconciliationCommand } from "./merchant-compensation-reconciliation-command.js";
import type { createMerchantOrdinaryRefundSendCommand } from "./merchant-ordinary-refund-send-command.js";
import type { createMerchantOrdinaryRefundReconciliationCommand } from "./merchant-ordinary-refund-reconciliation-command.js";
import type { createMerchantDiningHostSelection } from "./merchant-dining-host-selection.js";
import type { createMerchantDiningHostTransfer } from "./merchant-dining-host-transfer.js";
import type { createMerchantOrdinaryRefundStatus } from "./merchant-ordinary-refund-status.js";
import type { createMerchantRefundPaymentContext } from "./merchant-refund-payment-context.js";
import type { createMerchantOrdinaryRefundItems } from "./merchant-ordinary-refund-items.js";
import type { createMerchantOrdinaryRefundRequest } from "./merchant-ordinary-refund-request.js";
import type { createMerchantDiningJoinState } from "./merchant-dining-join-state.js";
import type { createMerchantDiningJoinRegenerate } from "./merchant-dining-join-regenerate.js";
import type { createMerchantDiningSessionStart } from "./merchant-dining-session-start.js";
import type { createMerchantDiningTables } from "./merchant-dining-tables.js";
import type { createMerchantDiningClosingCommand } from "./merchant-dining-closing-command.js";
import type { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
import type { createMerchantTaskInboxRead } from "./merchant-task-inbox-read.js";
import type { createMerchantDiningServeCommand } from "./merchant-dining-serve-command.js";
import type { createMerchantDiningTableCommand } from "./merchant-dining-table-command.js";
import type { createMerchantDiningOrderProgress } from "./merchant-dining-order-progress.js";
import type { createMerchantPickupQuery } from "./merchant-pickup-query.js";
import { FulfillmentReadinessError } from "@rms/fulfillment";
import type { createMerchantPickupProof } from "./merchant-pickup-proof.js";
import type { createMerchantPickupHandoff } from "./merchant-pickup-handoff.js";
import { PickupHandoffError, PickupProofError } from "@rms/fulfillment";
import type { createMerchantKitchenCommand } from "./merchant-kitchen-command.js";
import type { createMerchantKitchenRelease } from "./merchant-kitchen-release.js";
import {
  MerchantRoleAdministrationError,
  type createMerchantRoleAdministration,
} from "./merchant-role-administration.js";
import {
  MerchantStoreReceiptError,
  type createMerchantStoreReceipts,
} from "./merchant-store-receipts.js";
import { MerchantRecipeError, type createMerchantRecipes } from "./merchant-recipes.js";
import { MerchantProductError, type createMerchantProducts } from "./merchant-products.js";
import { MerchantPriceError, type createMerchantPrices } from "./merchant-prices.js";
import {
  MerchantStockCountError,
  type createMerchantStockCounts,
} from "./merchant-stock-counts.js";
import { MerchantStoreWasteError, type createMerchantStoreWaste } from "./merchant-store-waste.js";
import {
  MerchantOpeningCountError,
  type createMerchantOpeningCount,
} from "./merchant-opening-count.js";
import {
  MerchantStockPlaceError,
  type createMerchantStockPlaces,
} from "./merchant-stock-places.js";
import {
  MerchantInventoryItemError,
  type createMerchantInventoryItems,
} from "./merchant-inventory-items.js";
import {
  MerchantStaffAdministrationError,
  type createMerchantStaffAdministration,
} from "./merchant-staff-administration.js";
import type { createMerchantKitchenQuery } from "./merchant-kitchen-query.js";
import { KitchenQueueProjectionError, KitchenWorkLifecycleError } from "@rms/kitchen";
import type { createBrandLifecycleCommand } from "./brand-lifecycle-command.js";
import { BrandAdministrationServiceError } from "@bop/tenant";
import type { createMerchantProductDraftCommand } from "./merchant-product-draft-command.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
import type { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import type { createMerchantMenuDraftQuery } from "./merchant-menu-draft-query.js";
import type { createMerchantProductCreationCommand } from "./merchant-product-creation-command.js";
import {
  CatalogError,
  CatalogProductListError,
  CatalogOptionSetListError,
  parseOptionSetListView,
  parseCatalogProductListView,
} from "@rms/catalog";
import type { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
import { PriceBookWorkflowError } from "@rms/pricing";
import type { createMerchantPriceBookHttpCommand } from "./merchant-price-book-http-command.js";
import type { createPersistentMerchantOrderQueue } from "./persistent-merchant-order-queue.js";
import type { createMerchantOrderAcceptanceCommand } from "./merchant-order-acceptance-command.js";
import type { createMerchantDiningItemService } from "./merchant-dining-item-service.js";
import type { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type { createMerchantServiceControl } from "./merchant-service-control.js";
import type { createMerchantOrderExceptionRead } from "./merchant-order-exception-read.js";
import type {
  AuthenticationSession,
  BrowserCookieMutation,
  RawBrowserCredential,
} from "@bop/identity";
import express, { type Request, type RequestHandler, type Router } from "express";
import { httpRequestLimits } from "./http-security.js";

export interface MerchantWorkspaceSnapshot {
  readonly screenId: "HOME-OVERVIEW";
  readonly selectedScope: {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  };
  readonly authorizedStores: readonly {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
  }[];
  readonly businessDate: string;
  readonly storeStatus: "Open" | "Closed" | "Paused" | "Unavailable";
  readonly freshness: "Current" | "Stale";
  readonly dashboardAvailability: "UnavailableUntilWP1905";
  readonly navigation: readonly MerchantNavigationItem[];
}

const merchantNavigation = Object.freeze({
  "HOME-OVERVIEW": ["/app", "merchant.access"],
  "TASK-INBOX": ["/app/tasks", "workflow.operate"],
  "ORG-STORE-LIST": ["/app/organization/stores", "organization.store.read"],
  "CAT-PRODUCT-LIST": ["/app/commerce/products", "catalog.manage"],
  "CAT-OPTIONSET-LIST": ["/app/commerce/option-sets", "catalog.manage"],
  "CAT-MENU-LIST": ["/app/commerce/menus", "catalog.read"],
  "TAX-CONFIG": ["/app/commerce/tax", "pricing.tax-config.manage"],
  "OPS-ORDER-QUEUE": ["/operations/orders", "ordering.operate"],
  "OPS-ORDER-EXCEPTION": ["/operations/order-exceptions", "operations.order-exception.manage"],
  "KIT-KITCHEN-QUEUE": ["/operations/kitchen", "kitchen.operate"],
  "FUL-PICKUP-QUEUE": ["/operations/pickup", "fulfillment.operate"],
  "DEV-KDS-PROFILE": ["/app/integrations/kds-profiles", "integration.manage"],
  "IAM-ROLE-LIST": ["/app/organization/roles", "identity.role.read"],
  "IAM-USER-LIST": ["/app/organization/users", "organization.staff.read"],
  "INV-ITEM-LIST": ["/app/supply/items", "inventory.item.read"],
  "INV-LOCATION-LIST": ["/app/supply/locations", "inventory.location.read"],
  "INV-OPENING-COUNT": ["/app/supply/opening-count", "inventory.count.read"],
  "INV-RECEIPT-LIST": ["/operations/receiving", "inventory.receipt.read"],
  "RECIPE-LIST": ["/app/commerce/recipes", "recipe.read"],
  "PRICE-BOOK-LIST": ["/app/commerce/pricing", "pricing.price_book.read"],
  "INV-COUNT-LIST": ["/operations/inventory/counts", "inventory.count.read"],
  "INV-WASTE-RECORD": ["/operations/inventory/waste", "inventory.waste.record"],
} as const);

export interface MerchantNavigationItem {
  readonly screenId: keyof typeof merchantNavigation | "STORE-SETUP" | "ORG-BRAND-DETAIL";
  readonly label: string;
  readonly href: string;
  readonly permission: string;
}

export interface MerchantBffService {
  start(postLoginPath: unknown): Promise<{
    readonly authorizationUrl: string;
    readonly cookie: BrowserCookieMutation;
  }>;
  callback(input: {
    readonly code: unknown;
    readonly state: unknown;
    readonly authCookie: unknown;
  }): Promise<{
    readonly postLoginPath: string;
    readonly session: AuthenticationSession;
    readonly cookies: readonly BrowserCookieMutation[];
  }>;
  bootstrap(sessionCookie: unknown): Promise<{
    readonly session: AuthenticationSession;
    readonly csrf: RawBrowserCredential;
    readonly workspace: unknown;
  }>;
  authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession>;
  logout(sessionCookie: unknown): Promise<BrowserCookieMutation>;
  switchStore(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    readonly targetStoreReference: unknown;
  }): Promise<{ readonly cookie: BrowserCookieMutation; readonly workspace: unknown }>;
}

export interface MerchantStoreConfigurationOrdinaryPort {
  history?(
    input: Readonly<{
      sessionCookie: string;
      csrf: string;
      expectedStoreReference: string;
      expectedScope: StoreConfigurationOriginalScope;
      beforeSequence: number | null;
    }>,
  ): Promise<unknown>;
  read(
    input: Readonly<{
      sessionCookie: string;
      expectedStoreReference: string;
      expectedScope: StoreConfigurationOriginalScope;
      original?: StoreConfigurationOrdinaryResolve;
      csrf?: string;
    }>,
  ): Promise<unknown>;
  write(
    input: Readonly<{
      sessionCookie: string;
      csrf: string;
      command: StoreConfigurationOrdinaryCommand | StoreConfigurationOrdinaryResolve;
      expectedScope: StoreConfigurationOriginalScope;
    }>,
  ): Promise<unknown>;
}

export interface MerchantBffRouterOptions {
  readonly storeConfigurationOrdinary?: MerchantStoreConfigurationOrdinaryPort;
  readonly storeConfigurationOrdinaryClock?: { readonly now: () => string };
  readonly brandStoreTopologyDraft?: ReturnType<typeof createMerchantBrandStoreTopologyDraft>;
  readonly brandStoreTopologyClock?: { readonly now: () => string };
  readonly taxConfigAuthoring?: ReturnType<typeof createMerchantTaxConfigAuthoring>;
  readonly storeSetup?: Pick<ReturnType<typeof createMerchantStoreSetup>, "read" | "write"> &
    Partial<Pick<ReturnType<typeof createMerchantStoreSetup>, "classifications">>;
  readonly storeSetupClock?: { readonly now: () => string };
  readonly receiptTemplateArtifacts?: ReturnType<typeof createMerchantReceiptTemplateArtifacts>;
  readonly receiptTemplateDraft?: ReturnType<typeof createMerchantReceiptTemplateDraft>;
  readonly receiptTemplateLifecycle?: ReturnType<typeof createMerchantReceiptTemplateLifecycle>;
  readonly receiptTemplateSubmit?: ReturnType<typeof createMerchantReceiptTemplateSubmit>;
  readonly receiptTemplatePublished?: ReturnType<typeof createMerchantReceiptTemplatePublished>;
  readonly receiptTemplateReview?: ReturnType<typeof createMerchantReceiptTemplateReview>;
  readonly storePaymentConfiguration?: ReturnType<typeof createMerchantStorePaymentConfiguration>;
  readonly storeSetupReferences?: ReturnType<typeof createMerchantStoreSetupReferences>;
  readonly optionPriceAuthoring?: ReturnType<typeof createMerchantOptionPriceAuthoringCommand>;
  readonly optionPriceReview?: ReturnType<typeof createMerchantOptionPriceReviewCommand>;
  readonly productOptionPicker?: ReturnType<typeof createMerchantProductOptionPickerQuery>;
  readonly optionSetPublicationCommand?: ReturnType<
    typeof createMerchantOptionSetPublicationCommand
  >;
  readonly optionSetPublicationResolution?: ReturnType<
    typeof createMerchantOptionSetPublicationResolutionCommand
  >;
  readonly optionSetList?: ReturnType<typeof createMerchantOptionSetListQuery>;
  readonly optionSetPublicationContext?: ReturnType<
    typeof createMerchantOptionSetPublicationContextQuery
  >;
  readonly optionSetAuthoring?: ReturnType<typeof createMerchantOptionSetAuthoringCommand>;
  readonly optionSetHistory?: ReturnType<typeof createMerchantOptionSetHistoryQuery>;
  readonly optionSetCurrentPublication?: ReturnType<
    typeof createMerchantOptionSetCurrentPublicationQuery
  >;
  readonly optionSetEditor?: ReturnType<typeof createMerchantOptionSetEditorQuery>;
  readonly optionSetAuthoringContext?: ReturnType<
    typeof createMerchantOptionSetAuthoringContextQuery
  >;
  readonly optionSetAuthoringResolution?: ReturnType<
    typeof createMerchantOptionSetAuthoringResolutionCommand
  >;
  readonly productSellingUnitRegistry?: ReturnType<typeof createMerchantProductSellingUnitRegistry>;
  readonly productAuthoringContext?: ReturnType<typeof createMerchantProductAuthoringContextQuery>;
  readonly productAuthoringResolution?: ReturnType<
    typeof createMerchantProductAuthoringResolutionCommand
  >;
  readonly productPublicationResolution?: ReturnType<
    typeof createMerchantProductPublicationResolutionCommand
  >;
  readonly productDraftBaseline?: ReturnType<typeof createMerchantProductDraftBaselineQuery>;
  readonly productCategoryLookup?: ReturnType<typeof createMerchantProductCategoryLookupQuery>;
  readonly categoryTree?: ReturnType<typeof createMerchantCategoryTreeQuery>;
  readonly productList?: ReturnType<typeof createMerchantProductListQuery>;
  readonly reconciliationAssigneeQuery?: ReturnType<
    typeof createMerchantReconciliationAssigneeQuery
  >;
  readonly reconciliationEvidenceQuery?: ReturnType<
    typeof createMerchantReconciliationEvidenceQuery
  >;
  readonly reconciliationFollowUpQuery?: ReturnType<
    typeof createMerchantReconciliationFollowUpQuery
  >;
  readonly reconciliationFollowUp?: ReturnType<typeof createMerchantReconciliationFollowUpCommand>;
  readonly compensationQuery?: ReturnType<typeof createMerchantCompensationReconciliationQuery>;
  readonly compensationReconciliation?: ReturnType<
    typeof createMerchantCompensationReconciliationCommand
  >;
  readonly refundPaymentContext?: ReturnType<typeof createMerchantRefundPaymentContext>;
  readonly ordinaryRefundPreview?: ReturnType<
    typeof createMerchantOrdinaryRefundRequest
  >["preview"];
  readonly ordinaryRefundStatus?: ReturnType<typeof createMerchantOrdinaryRefundStatus>;
  readonly ordinaryRefundItems?: ReturnType<typeof createMerchantOrdinaryRefundItems>;
  readonly ordinaryRefundRequest?: (
    ...args: Parameters<ReturnType<typeof createMerchantOrdinaryRefundRequest>>
  ) => ReturnType<ReturnType<typeof createMerchantOrdinaryRefundRequest>>;
  readonly taskInbox?: ReturnType<typeof createMerchantTaskInboxRead>;
  readonly pickupQuery?: ReturnType<typeof createMerchantPickupQuery>;
  readonly pickupProof?: ReturnType<typeof createMerchantPickupProof>;
  readonly pickupHandoff?: ReturnType<typeof createMerchantPickupHandoff>;
  readonly kitchenQuery?: ReturnType<typeof createMerchantKitchenQuery>;
  readonly kitchenCommand?: ReturnType<typeof createMerchantKitchenCommand>;
  readonly kitchenRelease?: ReturnType<typeof createMerchantKitchenRelease>;
  readonly roleAdministration?: ReturnType<typeof createMerchantRoleAdministration>;
  readonly staffAdministration?: ReturnType<typeof createMerchantStaffAdministration>;
  readonly inventoryItems?: ReturnType<typeof createMerchantInventoryItems>;
  readonly stockPlaces?: ReturnType<typeof createMerchantStockPlaces>;
  readonly openingCount?: ReturnType<typeof createMerchantOpeningCount>;
  readonly storeReceipts?: ReturnType<typeof createMerchantStoreReceipts>;
  readonly recipes?: ReturnType<typeof createMerchantRecipes>;
  readonly products?: ReturnType<typeof createMerchantProducts>;
  readonly prices?: ReturnType<typeof createMerchantPrices>;
  readonly stockCounts?: ReturnType<typeof createMerchantStockCounts>;
  readonly storeWaste?: ReturnType<typeof createMerchantStoreWaste>;
  readonly ordinaryRefund?: ReturnType<typeof createMerchantOrdinaryRefundCommand>;
  readonly ordinaryRefundSend?: ReturnType<typeof createMerchantOrdinaryRefundSendCommand>;
  readonly ordinaryRefundReconciliation?: ReturnType<
    typeof createMerchantOrdinaryRefundReconciliationCommand
  >;
  readonly orderQueue?: ReturnType<typeof createPersistentMerchantOrderQueue>;
  readonly menuPublication?: ReturnType<typeof createMerchantMenuPublicationCommand>;
  readonly menuDraft?: ReturnType<typeof createMerchantMenuDraftQuery>;
  readonly brandLifecycle?: ReturnType<typeof createBrandLifecycleCommand>;
  readonly productDraft?: ReturnType<typeof createMerchantProductDraftCommand>;
  readonly productCreation?: ReturnType<typeof createMerchantProductCreationCommand>;
  readonly productLifecycle?: ReturnType<typeof createMerchantProductLifecycleCommand>;
  readonly storeCapability?: ReturnType<typeof createMerchantStoreCapability>["observe"];
  readonly productEditor?: ReturnType<typeof createMerchantProductEditorQuery>;
  readonly productPublicationManagement?: ReturnType<
    typeof createMerchantProductPublicationManagementQuery
  >;
  readonly productPublicationManagementV2?: ReturnType<
    typeof createMerchantProductPublicationManagementQueryV2
  >;
  readonly productPublicationWarningAcknowledgement?: ReturnType<
    typeof createMerchantProductPublicationWarningAcknowledgementCommand
  >;
  readonly productPublicationValidationReportV2?: ReturnType<
    typeof createMerchantProductPublicationValidationReportQueryV2
  >;
  readonly productPublicationV2?: ReturnType<typeof createMerchantProductPublicationCommandV2>;
  readonly productScopeJournals?: ReturnType<typeof createMerchantProductScopeJournalQuery>;
  readonly productPublicationQuery?: ReturnType<typeof createMerchantProductPublicationQuery>;
  readonly productPublication?: ReturnType<typeof createMerchantProductPublicationCommand>;
  readonly priceBooks?: ReturnType<typeof createMerchantPriceBookHttpCommand>;
  readonly diningJoinState?: ReturnType<typeof createMerchantDiningJoinState>;
  readonly diningJoinRegenerate?: ReturnType<typeof createMerchantDiningJoinRegenerate>;
  readonly diningHostSelection?: ReturnType<typeof createMerchantDiningHostSelection>;
  readonly diningHostTransfer?: ReturnType<typeof createMerchantDiningHostTransfer>;
  readonly diningSessionStart?: ReturnType<typeof createMerchantDiningSessionStart>;
  readonly diningClosing?: ReturnType<typeof createMerchantDiningClosingCommand>;
  readonly orderClosure?: ReturnType<typeof createMerchantDiningOrderCloseCommand>;
  readonly orderAcceptance?: ReturnType<typeof createMerchantOrderAcceptanceCommand>;
  readonly diningServe?: ReturnType<typeof createMerchantDiningServeCommand>;
  readonly diningTables?: ReturnType<typeof createMerchantDiningTables>;
  readonly diningTableCommand?: ReturnType<typeof createMerchantDiningTableCommand>;
  readonly diningOrderProgress?: ReturnType<typeof createMerchantDiningOrderProgress>;
  readonly diningItemService?: ReturnType<typeof createMerchantDiningItemService>;
  readonly serviceControl?: (
    input: Parameters<ReturnType<typeof createMerchantServiceControl>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantServiceControl>>;
  readonly storeConfiguration?: (
    input: Parameters<ReturnType<typeof createMerchantStoreConfiguration>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantStoreConfiguration>>;
  readonly storeConfigurationState?: ReturnType<typeof createMerchantStoreConfiguration>["read"];
  readonly serviceControlState?: ReturnType<typeof createMerchantServiceControl>["read"];
  readonly orderExceptions?: ReturnType<typeof createMerchantOrderExceptionRead>;
  readonly service: MerchantBffService;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
}

const NO_STORE = "no-store";

function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function cookie(request: Request, name: string): string | null {
  const headers = rawHeaderValues(request, "cookie");
  const header = headers[0];
  if (headers.length !== 1 || header === undefined || header.length > 4096) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match === undefined) return null;
  const value = match.slice(name.length + 1);
  return value && !/[\s;,]/u.test(value) ? value : null;
}

function serializeCookie(mutation: BrowserCookieMutation): string {
  const { descriptor } = mutation;
  const parts = [
    `${descriptor.name}=${mutation.value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mutation.clear) parts.push("Max-Age=0");
  else if (descriptor.maxAgeSeconds !== null) parts.push(`Max-Age=${descriptor.maxAgeSeconds}`);
  return parts.join("; ");
}

function exactHeader(request: Request, name: string): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function trustedHost(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (exactHeader(request, "host") !== options.acceptedHost) {
      response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
      return;
    }
    next();
  };
}

function safeRead(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      (fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function oidcCallbackNavigation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      !["same-origin", "cross-site", "none"].includes(fetchSite ?? "")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

function sameOriginMutation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (
      exactHeader(request, "origin") !== options.exactOrigin ||
      exactHeader(request, "sec-fetch-site") !== "same-origin"
    ) {
      denied(response);
      return;
    }
    next();
  };
}

const workspaceKeys = [
  "screenId",
  "selectedScope",
  "authorizedStores",
  "businessDate",
  "storeStatus",
  "freshness",
  "dashboardAvailability",
  "navigation",
] as const;
const scopeKeys = ["brandLabel", "storeLabel", "storeReference"] as const;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeLabel = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function targetStoreReference(value: unknown): unknown {
  return closed(value, ["targetStoreReference"]).targetStoreReference;
}

function scope(value: unknown) {
  const input = closed(value, scopeKeys);
  if (
    typeof input.brandLabel !== "string" ||
    !safeLabel.test(input.brandLabel) ||
    typeof input.storeLabel !== "string" ||
    !safeLabel.test(input.storeLabel) ||
    typeof input.storeReference !== "string" ||
    !uuidV7.test(input.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    brandLabel: input.brandLabel,
    storeLabel: input.storeLabel,
    storeReference: input.storeReference,
  });
}

function navigationItem(value: unknown, selectedStoreReference: string): MerchantNavigationItem {
  const input = closed(value, ["screenId", "label", "href", "permission"]);
  if (input.screenId === "ORG-BRAND-DETAIL") {
    const prefix = "/app/organization/brands/";
    if (
      typeof input.label !== "string" ||
      !safeLabel.test(input.label) ||
      typeof input.href !== "string" ||
      !input.href.startsWith(prefix) ||
      !uuidV7.test(input.href.slice(prefix.length)) ||
      input.permission !== "organization.manage"
    )
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    return Object.freeze({
      screenId: "ORG-BRAND-DETAIL",
      label: input.label,
      href: input.href,
      permission: "organization.manage",
    });
  }
  if (input.screenId === "STORE-SETUP") {
    const href = "/app/organization/stores/" + selectedStoreReference + "/setup";
    if (
      typeof input.label !== "string" ||
      !safeLabel.test(input.label) ||
      input.href !== href ||
      input.permission !== "organization.manage"
    )
      throw new Error("MERCHANT_WORKSPACE_DENIED");
    return Object.freeze({
      screenId: "STORE-SETUP",
      label: input.label,
      href,
      permission: "organization.manage",
    });
  }
  if (
    typeof input.screenId !== "string" ||
    !Object.hasOwn(merchantNavigation, input.screenId) ||
    typeof input.label !== "string" ||
    !safeLabel.test(input.label)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const screenId = input.screenId as keyof typeof merchantNavigation;
  const expected = merchantNavigation[screenId];
  if (input.href !== expected[0] || input.permission !== expected[1])
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId,
    label: input.label,
    href: expected[0],
    permission: expected[1],
  });
}

export function parseMerchantWorkspaceSnapshot(value: unknown): MerchantWorkspaceSnapshot {
  const input = closed(value, workspaceKeys);
  const parsedBusinessDate =
    typeof input.businessDate === "string"
      ? Date.parse(`${input.businessDate}T00:00:00.000Z`)
      : Number.NaN;
  if (
    input.screenId !== "HOME-OVERVIEW" ||
    !Array.isArray(input.authorizedStores) ||
    input.authorizedStores.length < 1 ||
    input.authorizedStores.length > 100 ||
    typeof input.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isFinite(parsedBusinessDate) ||
    new Date(parsedBusinessDate).toISOString().slice(0, 10) !== input.businessDate ||
    !["Open", "Closed", "Paused", "Unavailable"].includes(String(input.storeStatus)) ||
    (input.freshness !== "Current" && input.freshness !== "Stale") ||
    input.dashboardAvailability !== "UnavailableUntilWP1905" ||
    !Array.isArray(input.navigation) ||
    input.navigation.length > 20
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const selectedScope = scope(input.selectedScope);
  const navigation = Object.freeze(
    input.navigation.map((value) => navigationItem(value, selectedScope.storeReference)),
  );
  if (new Set(navigation.map((item) => item.screenId)).size !== navigation.length)
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  const authorizedStores = Object.freeze(input.authorizedStores.map(scope));
  if (
    new Set(authorizedStores.map((item) => item.storeReference)).size !== authorizedStores.length ||
    !authorizedStores.some((item) => item.storeReference === selectedScope.storeReference)
  )
    throw new Error("MERCHANT_WORKSPACE_DENIED");
  return Object.freeze({
    screenId: "HOME-OVERVIEW",
    selectedScope,
    authorizedStores,
    businessDate: input.businessDate,
    storeStatus: input.storeStatus as MerchantWorkspaceSnapshot["storeStatus"],
    freshness: input.freshness,
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation,
  });
}

function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}

export function createMerchantBffRouter(options: MerchantBffRouterOptions): Router {
  const router = express.Router();
  async function currentTaxNavigation(value: unknown, sessionCookie: unknown) {
    const workspace = parseMerchantWorkspaceSnapshot(value);
    const navigation = workspace.navigation.filter((item) => item.screenId !== "TAX-CONFIG");
    const port = options.taxConfigAuthoring;
    if (port) {
      try {
        const current = parseTaxConfigAuthoringCurrent(
          await port.current({
            sessionCookie,
            expectedStoreReference: workspace.selectedScope.storeReference,
            configurationReference: null,
          }),
          null,
        );
        if (
          current.storeReference === workspace.selectedScope.storeReference &&
          current.state === null
        ) {
          navigation.push({
            screenId: "TAX-CONFIG",
            label: "Tax",
            href: "/app/commerce/tax",
            permission: "pricing.tax-config.manage",
          });
        }
      } catch {
        // The owning port requires current Session/IAM and FeatureControl. Its
        // refusal hides only this entry; it does not invalidate other workspaces.
      }
    }
    return parseMerchantWorkspaceSnapshot({ ...workspace, navigation });
  }

  const ordinaryJson = express.json({ limit: "8kb", strict: true });
  const storeSetupJson = express.json({ limit: 2_097_152, strict: true });
  const storeSetupReferenceJson = express.json({ limit: 32_768, strict: true });
  const draftBytes = new WeakMap<object, number>();
  const completeDraftJson = express.json({
    limit: httpRequestLimits.jsonBodyBytesMaximum,
    strict: true,
    verify(request, _response, bytes) {
      draftBytes.set(request, bytes.byteLength);
    },
  });
  // The complete owning Option document has a one-MiB canonical command cap.
  // Control requests keep the small transport budget.
  const optionDraftJson = express.json({ limit: 1_048_576, strict: true });
  const optionControlJson = express.json({ limit: "8kb", strict: true });
  const taxDraftJson = express.json({ limit: 98_304, strict: true });
  const taxSimulationJson = express.json({ limit: 196_608, strict: true });
  const taxMaterialJson = express.json({ limit: 1_056_768, strict: true });
  router.use((request, response, next) => {
    if (
      request.method === "POST" &&
      [
        "/store-configuration/ordinary-command",
        "/store-configuration/ordinary-state",
        "/store-configuration/ordinary-history",
      ].includes(request.path)
    ) {
      ordinaryJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "store_configuration_ordinary_invalid" });
      });
      return;
    }
    // WP-2423 / DEC-INV-OPENING: an opening count may carry up to 5000 lines.
    if (
      request.method === "POST" &&
      (request.path === "/supply/opening-count/command" ||
        request.path === "/supply/receipts/command" ||
        request.path === "/commerce/recipes/command" ||
        request.path === "/commerce/pricing/command")
    ) {
      express.json({ limit: 1_048_576, strict: true })(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "Invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      [
        "/organization/brands/topology/draft/workspace",
        "/organization/brands/topology/draft/save",
        "/organization/brands/topology/draft/resolve",
      ].includes(request.path)
    ) {
      const parser = request.path.endsWith("/save")
        ? express.json({ limit: 2_105_344, strict: true })
        : ordinaryJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "brand_store_topology_invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      (request.path === "/tax-config/authoring/commands" ||
        request.path === "/tax-config/authoring/resolve-original" ||
        request.path === "/tax-config/authoring/simulate" ||
        request.path === "/tax-config/authoring/materials/commands" ||
        request.path === "/tax-config/authoring/materials/resolve-original" ||
        request.path === "/tax-config/authoring/materials/compare" ||
        request.path === "/tax-config/authoring/candidates/commands" ||
        request.path === "/tax-config/authoring/candidates/resolve-original")
    ) {
      const parser = request.path.startsWith("/tax-config/authoring/candidates/")
        ? ordinaryJson
        : request.path === "/tax-config/authoring/materials/commands"
          ? taxMaterialJson
          : request.path.endsWith("/commands")
            ? taxDraftJson
            : request.path.endsWith("/simulate")
              ? taxSimulationJson
              : ordinaryJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "tax_config_authoring_invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      (/^\/store-setup\/references\/(address|contact)$/u.test(request.path) ||
        request.path === "/store-setup/payment-configuration" ||
        request.path === "/store-setup/receipt-template-draft" ||
        request.path === "/store-setup/receipt-template-submit" ||
        request.path === "/store-setup/receipt-template-lifecycle" ||
        /^\/store-setup\/receipt-artifacts\/[^/]+$/u.test(request.path))
    ) {
      storeSetupReferenceJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error:
              request.path === "/store-setup/receipt-template-lifecycle"
                ? "receipt_template_lifecycle_invalid"
                : request.path === "/store-setup/receipt-template-submit"
                  ? "receipt_template_submit_invalid"
                  : request.path === "/store-setup/receipt-template-draft"
                    ? "receipt_template_draft_invalid"
                    : request.path.startsWith("/store-setup/receipt-artifacts/")
                      ? "receipt_template_artifact_invalid"
                      : request.path === "/store-setup/payment-configuration"
                        ? "store_payment_configuration_invalid"
                        : "store_setup_reference_invalid",
          });
      });
      return;
    }
    if (request.method === "POST" && request.path === "/store-setup") {
      storeSetupJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "store_setup_invalid" });
      });
      return;
    }
    const optionDraft =
      request.path === "/catalog/option-sets/create" ||
      request.path === "/catalog/option-sets/draft";
    const optionControl =
      request.path === "/catalog/products/option-binding-picker" ||
      request.path === "/catalog/option-sets/list" ||
      request.path === "/catalog/option-sets/current-editor" ||
      request.path === "/catalog/option-sets/current-published" ||
      request.path === "/catalog/option-sets/history" ||
      request.path === "/catalog/option-sets/authoring/resolve" ||
      request.path === "/catalog/option-sets/authoring/context" ||
      request.path === "/catalog/option-sets/publication/context" ||
      request.path === "/catalog/option-sets/publication/command" ||
      request.path === "/catalog/option-sets/publication/resolve" ||
      request.path === "/pricing/option-prices/scope" ||
      request.path === "/pricing/option-prices/current" ||
      request.path === "/pricing/option-prices/command" ||
      request.path === "/pricing/option-prices/review/current" ||
      request.path === "/pricing/option-prices/review/command" ||
      request.path === "/pricing/option-prices/review/resolve" ||
      request.path === "/pricing/option-prices/resolve";
    if (request.method === "POST" && (optionDraft || optionControl)) {
      const parser = optionDraft ? optionDraftJson : optionControlJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error: request.path.startsWith("/pricing/option-prices/")
              ? "option_price_invalid"
              : request.path === "/catalog/products/option-binding-picker"
                ? "product_option_picker_invalid"
                : request.path === "/catalog/option-sets/current-published"
                  ? "option_set_current_publication_invalid"
                  : request.path === "/catalog/option-sets/history"
                    ? "option_set_history_invalid"
                    : request.path === "/catalog/option-sets/publication/context"
                      ? "option_set_publication_context_invalid"
                      : request.path === "/catalog/option-sets/publication/command" ||
                          request.path === "/catalog/option-sets/publication/resolve"
                        ? "option_set_publication_invalid"
                        : "option_set_authoring_invalid",
          });
      });
      return;
    }
    if (request.method !== "POST" || request.path !== "/catalog/products/draft") {
      ordinaryJson(request, response, next);
      return;
    }
    completeDraftJson(request, response, (error?: unknown) => {
      const size = draftBytes.get(request) ?? 0;
      draftBytes.delete(request);
      if (error) {
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error: "product_draft_invalid",
          });
        return;
      }
      const body: unknown = request.body;
      const draft = body && typeof body === "object" && "draft" in body ? body.draft : undefined;
      // Larger transport is only a complete-content candidate. The command still
      // performs closed structural parsing and current permission/reference checks.
      if (
        size > 8192 &&
        !(draft && typeof draft === "object" && Object.hasOwn(draft, "editorContent"))
      ) {
        response
          .status(413)
          .set("Cache-Control", NO_STORE)
          .json({ error: "product_draft_invalid" });
        return;
      }
      next();
    });
  });
  router.use(trustedHost(options));
  router.use((_request, response, next) => {
    response.set("Cache-Control", NO_STORE);
    next();
  });

  router.get("/catalog/products/draft-baseline", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-draft-baseline");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,342}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let query: ReturnType<typeof parseProductDraftBaselineRequest>;
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 256 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      query = parseProductDraftBaselineRequest(JSON.parse(decoded));
    } catch {
      response.status(400).json({ error: "product_draft_baseline_invalid" });
      return;
    }
    if (!options.productDraftBaseline) {
      response.status(503).json({ error: "product_draft_baseline_unavailable" });
      return;
    }
    void options
      .productDraftBaseline({ sessionCookie, query })
      .then((view) => {
        const safe = parseMerchantProductDraftBaselineResult(view);
        if (safe.baseline !== null && safe.baseline.productReference !== query.productReference)
          throw new MerchantProductDraftBaselineError("Unavailable");
        response.json(safe);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof MerchantProductDraftBaselineError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "product_draft_baseline_" + suffix });
      });
  });
  router.get("/catalog/products/category-lookup", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-category-lookup");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,342}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let query: { readonly parentScreenId: ReturnType<typeof parseProductCategoryLookupRequest> };
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 256 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      query = { parentScreenId: parseProductCategoryLookupRequest(JSON.parse(decoded)) };
    } catch {
      response.status(400).json({ error: "product_category_lookup_invalid" });
      return;
    }
    if (!options.productCategoryLookup) {
      response.status(503).json({ error: "product_category_lookup_unavailable" });
      return;
    }
    void options
      .productCategoryLookup({ sessionCookie, query })
      .then((view) => {
        const safe = parseMerchantProductCategoryLookupResult(view);
        if (safe.lookup.parentScreenId !== query.parentScreenId)
          throw new MerchantProductCategoryLookupError("Unavailable");
        response.json(safe);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof MerchantProductCategoryLookupError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "product_category_lookup_" + suffix });
      });
  });

  router.get("/catalog/categories", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-category-tree");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,5462}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let filters: unknown;
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 4096 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      filters = parseCatalogCategoryTreeFilters(JSON.parse(decoded));
    } catch {
      response.status(400).json({ error: "category_tree_invalid" });
      return;
    }
    if (!options.categoryTree) {
      response.status(503).json({ error: "category_tree_unavailable" });
      return;
    }
    void options
      .categoryTree({ sessionCookie, filters })
      .then((view) => {
        response.json(parseMerchantCategoryTreeResult(view));
      })
      .catch((error: unknown) => {
        const code = error instanceof MerchantCategoryTreeError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "category_tree_" + suffix });
      });
  });

  router.get("/catalog/products", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-list");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,5462}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let filters: unknown;
    try {
      const bytes = Buffer.from(headers[0], "base64url");
      const decoded = bytes.toString("utf8");
      if (
        bytes.length > 4096 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      filters = JSON.parse(decoded);
    } catch {
      response.status(400).json({ error: "product_list_invalid" });
      return;
    }
    if (!options.productList) {
      response.status(503).json({ error: "product_list_unavailable" });
      return;
    }
    void options
      .productList({ sessionCookie, filters })
      .then((view) => {
        try {
          response.json(parseCatalogProductListView(view));
        } catch {
          throw new CatalogProductListError("Unavailable");
        }
      })
      .catch((error: unknown) => {
        const code = error instanceof CatalogProductListError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled"
                ? 409
                : code === "Stale"
                  ? 409
                  : 503;
        response.status(status).json({
          error:
            code === "Invalid"
              ? "product_list_invalid"
              : code === "Denied"
                ? "product_list_denied"
                : code === "FeatureDisabled"
                  ? "product_list_feature_disabled"
                  : code === "Stale"
                    ? "product_list_stale"
                    : "product_list_unavailable",
        });
      });
  });

  router.get("/orders", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const after = request.query.after;
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).some((key) => key !== "after") ||
      (after !== undefined &&
        (typeof after !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after))) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderQueue) {
      response.status(503).json({ error: "order_queue_unavailable" });
      return;
    }
    void options
      .orderQueue({ sessionCookie, afterOrderReference: after ?? null })
      .then((view) =>
        response.json({
          items: view.items.map((item) => ({
            orderReference: item.orderReference,
            orderNumber: item.orderNumber,
            orderType: item.orderType,
            sourceChannel: item.sourceChannel,
            submittedAt: item.submittedAt,
            initialBatchReference: item.initialBatchReference,
            canRequestAcceptance: item.canRequestAcceptance,
            batches: item.batches.map((batch) => ({
              orderBatchReference: batch.orderBatchReference,
              sequence: batch.sequence,
              acceptanceStatus: batch.acceptanceStatus,
              canRequestAcceptance: batch.canRequestAcceptance,
            })),
            currentPhase: item.currentPhase,
            currentVersion: item.currentVersion,
            observedAt: item.observedAt,
          })),
          nextAfterOrderReference: view.nextAfterOrderReference,
        }),
      )
      .catch(() => denied(response));
  });

  router.get("/tasks", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const cursors = rawHeaderValues(request, "x-bop-task-after"),
      after = cursors[0];
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      cursors.length > 1 ||
      (after !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(after))
    ) {
      denied(response);
      return;
    }
    const filterHeaders = rawHeaderValues(request, "x-bop-task-filters");
    let filters: ReturnType<typeof parseMerchantTaskInboxFilters> | undefined;
    try {
      if (filterHeaders.length > 1) throw new Error("invalid");
      if (filterHeaders[0] !== undefined) {
        if (Buffer.byteLength(filterHeaders[0], "utf8") > 512) throw new Error("invalid");
        filters = parseMerchantTaskInboxFilters(JSON.parse(filterHeaders[0]));
      }
    } catch {
      denied(response);
      return;
    }
    if (!options.taskInbox) {
      response.status(503).json({ error: "task_inbox_unavailable" });
      return;
    }
    void options
      .taskInbox(sessionCookie, {
        afterTaskReference: after ?? null,
        ...(filters === undefined ? {} : { filters }),
      })
      .then((view) => {
        response.json({
          screenId: view.screenId,
          storeLabel: view.storeLabel,
          observedAt: view.observedAt,
          nextAfterTaskReference: view.nextAfterTaskReference,
          items: view.items.map((item) => ({
            taskReference: item.taskReference,
            version: item.version,
            taskType: item.taskType,
            severity: item.severity,
            priority: item.priority,
            status: item.status,
            ownerStatus: item.ownerStatus,
            dueAt: item.dueAt,
            sourceType: item.sourceType,
            canClaim: item.canClaim,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.get("/order-exceptions", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      sessionCookie === null ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderExceptions) {
      response.status(503).json({ error: "order_exceptions_unavailable" });
      return;
    }
    void options
      .orderExceptions(sessionCookie)
      .then((view) => {
        response.json({
          screenId: view.screenId,
          projectionName: view.projectionName,
          storeLabel: view.storeLabel,
          businessDate: view.businessDate,
          projectedAt: view.projectedAt,
          freshnessStatus: view.freshnessStatus,
          items: view.items.map((item) => ({
            exceptionReference: item.exceptionReference,
            orderReference: item.orderReference,
            kind: item.kind,
            severity: item.severity,
            status: item.status,
            providerState: item.providerState,
            compensationStatus: item.compensationStatus,
            sourceOwner: item.sourceOwner,
            createdAt: item.createdAt,
            dueAt: item.dueAt,
            ownerStatus: item.ownerStatus,
            sourceFinal: item.sourceFinal,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.get("/login", safeRead(options), (request, response) => {
    void options.service
      .start(request.query.returnTo ?? "/")
      .then((result) => {
        response.set("Set-Cookie", serializeCookie(result.cookie));
        response.redirect(303, result.authorizationUrl);
      })
      .catch(() => denied(response));
  });

  router.get("/callback", oidcCallbackNavigation(options), (request, response) => {
    void options.service
      .callback({
        code: request.query.code,
        state: request.query.state,
        authCookie: cookie(request, "__Host-bop-auth"),
      })
      .then((result) => {
        response.set("Set-Cookie", result.cookies.map(serializeCookie));
        response.redirect(303, result.postLoginPath);
      })
      .catch(() => {
        response.set(
          "Set-Cookie",
          "__Host-bop-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        denied(response);
      });
  });

  router.get("/session", safeRead(options), (request, response) => {
    void options.service
      .bootstrap(cookie(request, "__Host-bop-merchant"))
      .then(async (result) => {
        response.json({
          authenticated: true,
          csrf: result.csrf,
          workspace: await currentTaxNavigation(
            result.workspace,
            cookie(request, "__Host-bop-merchant"),
          ),
        });
      })
      .catch((error: unknown) => {
        if (
          error instanceof BrandStoreTopologyError &&
          error.code === "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE"
        ) {
          response.status(503).json({ error: "merchant_workspace_unavailable" });
          return;
        }
        denied(response);
      });
  });

  router.get("/service-control", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.serviceControlState) {
      response.status(503).json({ error: "service_control_unavailable" });
      return;
    }
    void options
      .serviceControlState(sessionCookie)
      .then((state) => response.json(state))
      .catch(() => denied(response));
  });

  const ordinaryFailure = (response: express.Response, error: unknown): void => {
    const code =
      error instanceof StoreConfigurationOriginalError ||
      error instanceof StoreConfigurationAdministrationError ||
      error instanceof StoreSetupOperationError
        ? error.code
        : undefined;
    const invalid =
      code === "STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID" ||
      code === "STORE_CONFIGURATION_INPUT_INVALID";
    const forbidden = code === "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED";
    const conflict =
      code === "STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT" ||
      code === "STORE_SETUP_OPERATION_VERSION_CONFLICT" ||
      code === "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT" ||
      code === "STORE_CONFIGURATION_STATE_INVALID" ||
      code === "STORE_CONFIGURATION_OVERLAP" ||
      code === "STORE_CONFIGURATION_GATE_REQUIRED";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_configuration_ordinary_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_configuration_ordinary_conflict"
              : "store_configuration_ordinary_unavailable",
      });
  };
  const ordinaryScope = (request: express.Request): StoreConfigurationOriginalScope => {
    const encoded = exactHeader(request, "x-bop-store-setup-scope");
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    const bytes = Buffer.from(encoded, "base64url"),
      text = bytes.toString("utf8");
    if (bytes.toString("base64url") !== encoded || !Buffer.from(text, "utf8").equals(bytes))
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    const raw = readClosedRecord(JSON.parse(text), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    return Object.freeze({
      tenantReference: parseStoreAdministrationReference(raw.tenantReference),
      brandReference: parseStoreAdministrationReference(raw.brandReference),
      storeReference: parseStoreAdministrationReference(raw.storeReference),
      actorReference: parseStoreAdministrationReference(raw.actorReference),
    });
  };
  const ordinaryInput = (value: unknown, scope: StoreConfigurationOriginalScope) => {
    const profile =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "profile")?.value
        : undefined;
    const parsed =
      profile === "StoreConfigurationOrdinaryResolveV1"
        ? parseStoreConfigurationOrdinaryResolve(value)
        : parseStoreConfigurationOrdinaryCommand(value);
    if (
      Object.entries(scope).some(
        ([key, reference]) => Object.getOwnPropertyDescriptor(parsed, key)?.value !== reference,
      )
    )
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    const body = { ...parsed, profile: "StoreConfigurationOrdinaryCommandV1" };
    Reflect.deleteProperty(body, "intentDigest");
    const command = parseStoreConfigurationOrdinaryCommand(body),
      intentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
    if ("intentDigest" in parsed && parsed.intentDigest !== intentDigest)
      throw new StoreConfigurationOriginalError(
        "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
      );
    return { parsed, command, intentDigest };
  };
  const ordinaryReceipt = (value: unknown, input: ReturnType<typeof ordinaryInput>) => {
    const receipt = parseStoreConfigurationOrdinaryReceipt(value),
      body = { ...receipt, profile: "StoreConfigurationOrdinaryCommandV1" };
    for (const key of [
      "intentDigest",
      "outcome",
      "operation",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ])
      Reflect.deleteProperty(body, key);
    if (
      canonicalizeRfc8785(parseStoreConfigurationOrdinaryCommand(body)) !==
        canonicalizeRfc8785(input.command) ||
      receipt.intentDigest !== input.intentDigest
    )
      throw new Error("invalid ordinary response");
    return receipt;
  };
  const ordinaryRead = (
    response: express.Response,
    requestInput: Parameters<MerchantStoreConfigurationOrdinaryPort["read"]>[0],
  ) => {
    const port = options.storeConfigurationOrdinary,
      read = port?.read,
      clock = options.storeConfigurationOrdinaryClock,
      now = clock?.now;
    if (!port || typeof read !== "function" || !clock || typeof now !== "function") {
      ordinaryFailure(response, undefined);
      return;
    }
    let before: string;
    try {
      before = parseCatalogInstant(now.call(clock));
    } catch {
      ordinaryFailure(response, undefined);
      return;
    }
    void read
      .call(port, requestInput)
      .then((value) => {
        try {
          if (
            options.storeConfigurationOrdinary !== port ||
            port.read !== read ||
            options.storeConfigurationOrdinaryClock !== clock ||
            clock.now !== now
          )
            throw new Error("changed ordinary response source");
          const view = parseMerchantStoreConfigurationOrdinaryWorkspace(
              value,
              requestInput.expectedScope,
            ),
            at = parseCatalogInstant(now.call(clock));
          if (
            at < before ||
            String(view.observedAt) > String(at) ||
            String(view.validUntil) <= String(at)
          )
            throw new Error("unavailable ordinary response");
          if (requestInput.original) {
            if (view.original !== null)
              ordinaryReceipt(
                view.original,
                ordinaryInput(requestInput.original, requestInput.expectedScope),
              );
          } else if (view.original !== null) throw new Error("unexpected original response");
          response.json(view);
        } catch {
          ordinaryFailure(response, undefined);
        }
      })
      .catch((error) => ordinaryFailure(response, error));
  };
  router.get("/store-configuration/ordinary", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      sessionCookie === null ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    try {
      if (
        Object.keys(request.query).length !== 1 ||
        typeof request.query.expectedStoreReference !== "string"
      )
        throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
      const expectedScope = ordinaryScope(request),
        expectedStoreReference = parseStoreAdministrationReference(
          request.query.expectedStoreReference,
        );
      if (expectedStoreReference !== expectedScope.storeReference)
        throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
      ordinaryRead(response, { sessionCookie, expectedStoreReference, expectedScope });
    } catch (error) {
      ordinaryFailure(
        response,
        error instanceof StoreConfigurationOriginalError
          ? error
          : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
      );
    }
  });
  router.post(
    "/store-configuration/ordinary-history",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      try {
        const expectedScope = ordinaryScope(request);
        const body = readClosedRecord(request.body, ["expectedStoreReference", "beforeSequence"]);
        const expectedStoreReference = parseStoreAdministrationReference(
            body.expectedStoreReference,
          ),
          beforeSequence = body.beforeSequence;
        if (expectedStoreReference !== expectedScope.storeReference)
          throw new StoreConfigurationOriginalError(
            "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
          );
        if (
          beforeSequence !== null &&
          (typeof beforeSequence !== "number" ||
            !Number.isSafeInteger(beforeSequence) ||
            beforeSequence < 1)
        )
          throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
        const port = options.storeConfigurationOrdinary,
          read = port?.history,
          clock = options.storeConfigurationOrdinaryClock,
          now = clock?.now;
        if (!port || !read || !clock || typeof now !== "function") {
          ordinaryFailure(response, undefined);
          return;
        }
        let origin: string;
        try {
          origin = parseCanonicalInstant(now.call(clock));
        } catch {
          ordinaryFailure(response, undefined);
          return;
        }
        void read
          .call(port, {
            sessionCookie,
            csrf,
            expectedStoreReference,
            expectedScope,
            beforeSequence,
          })
          .then((value) => {
            if (
              options.storeConfigurationOrdinary !== port ||
              port.history !== read ||
              options.storeConfigurationOrdinaryClock !== clock ||
              clock.now !== now
            )
              throw new Error("Changed history source");
            const page = parseMerchantStoreConfigurationHistoryPage(
                value,
                expectedScope,
                beforeSequence,
              ),
              at = parseCanonicalInstant(now.call(clock));
            if (
              at < origin ||
              page.observedAt < origin ||
              page.observedAt > at ||
              at >= page.validUntil ||
              Date.parse(at) - Date.parse(origin) >= 5000
            )
              throw new Error("Expired history source");
            response.set("Cache-Control", NO_STORE).json(page);
          })
          .catch((error) => ordinaryFailure(response, error));
      } catch (error) {
        ordinaryFailure(
          response,
          error instanceof StoreConfigurationOriginalError
            ? error
            : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
        );
      }
    },
  );
  for (const path of [
    "/store-configuration/ordinary-command",
    "/store-configuration/ordinary-state",
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      try {
        const expectedScope = ordinaryScope(request);
        if (path.endsWith("ordinary-state")) {
          const body = readClosedRecord(request.body, ["original", "expectedStoreReference"]),
            original = parseStoreConfigurationOrdinaryResolve(body.original);
          ordinaryInput(original, expectedScope);
          const expectedStoreReference = parseStoreAdministrationReference(
            body.expectedStoreReference,
          );
          if (expectedStoreReference !== expectedScope.storeReference)
            throw new StoreConfigurationOriginalError(
              "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
            );
          void options.service
            .authorize({ sessionCookie, csrf })
            .then(() =>
              ordinaryRead(response, {
                sessionCookie,
                expectedStoreReference,
                expectedScope,
                original,
                csrf,
              }),
            )
            .catch(() => denied(response));
          return;
        }
        const body = readClosedRecord(request.body, ["command"]),
          input = ordinaryInput(body.command, expectedScope),
          port = options.storeConfigurationOrdinary,
          write = port?.write;
        const clock = options.storeConfigurationOrdinaryClock,
          now = clock?.now;
        if (!port || typeof write !== "function" || !clock || typeof now !== "function") {
          ordinaryFailure(response, undefined);
          return;
        }
        let before: string;
        try {
          before = parseCatalogInstant(now.call(clock));
        } catch {
          ordinaryFailure(response, undefined);
          return;
        }
        void write
          .call(port, { sessionCookie, csrf, command: input.parsed, expectedScope })
          .then((value) => {
            try {
              if (
                options.storeConfigurationOrdinary !== port ||
                port.write !== write ||
                options.storeConfigurationOrdinaryClock !== clock ||
                clock.now !== now
              )
                throw new Error("changed ordinary response source");
              const receipt = ordinaryReceipt(value, input),
                at = parseCatalogInstant(now.call(clock));
              if (at < before || receipt.occurredAt > String(at))
                throw new Error("future ordinary response");
              response.json(receipt);
            } catch {
              ordinaryFailure(response, undefined);
            }
          })
          .catch((error) => ordinaryFailure(response, error));
      } catch (error) {
        ordinaryFailure(
          response,
          error instanceof StoreConfigurationOriginalError
            ? error
            : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
        );
      }
    });

  const storeSetupFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof StoreSetupOperationError ? error.code : undefined;
    const invalid = code === "STORE_SETUP_OPERATION_INPUT_INVALID";
    const forbidden = code === "STORE_SETUP_OPERATION_PERMISSION_DENIED";
    const conflict =
      code === "STORE_SETUP_OPERATION_VERSION_CONFLICT" ||
      code === "STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_setup_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_setup_conflict"
              : "store_setup_unavailable",
      });
  };
  router.get("/store-setup", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetup;
    if (!port) {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storeSetupFailure(response, error));
  });
  router.get("/store-setup/fee-context-classifications", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        text = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(text, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(text), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
      if (expectedScope.storeReference !== expectedStoreReference) throw new Error("invalid");
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetup,
      clock = options.storeSetupClock,
      clockNow = clock?.now;
    if (!port || typeof port.classifications !== "function" || typeof clockNow !== "function") {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .classifications({ sessionCookie, expectedStoreReference })
      .then((value) => {
        try {
          if (options.storeSetupClock !== clock || clock?.now !== clockNow)
            throw new Error("unavailable");
          const at = String(parseCanonicalInstant(clockNow.call(clock))),
            result = parseTaxConfigClassificationChoices(value);
          if (
            result.observedAt > at ||
            result.validUntil <= at ||
            Object.entries(expectedScope).some(
              ([key, reference]) =>
                Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
            )
          )
            throw new Error("unavailable");
          response.json(result);
        } catch {
          storeSetupFailure(response, undefined);
        }
      })
      .catch((error) => storeSetupFailure(response, error));
  });
  router.post("/store-setup", sameOriginMutation(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
      Object.keys(request.query).length !== 0 ||
      request.body === undefined
    ) {
      denied(response);
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    try {
      bindMerchantStoreSetupCommand(request.body, expectedScope);
    } catch (error) {
      storeSetupFailure(response, error);
      return;
    }
    const port = options.storeSetup;
    if (!port) {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .write({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((value) => response.json(value))
      .catch((error) => storeSetupFailure(response, error));
  });

  const storeSetupReferenceFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof StoreSetupReferenceError ? error.code : undefined;
    const invalid = code === "STORE_SETUP_REFERENCE_INPUT_INVALID";
    const forbidden = code === "STORE_SETUP_REFERENCE_PERMISSION_DENIED";
    const conflict =
      code === "STORE_SETUP_REFERENCE_VERSION_CONFLICT" ||
      code === "STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_setup_reference_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_setup_reference_conflict"
              : "store_setup_reference_unavailable",
      });
  };
  router.get("/store-setup/references", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetupReferences;
    if (!port) {
      storeSetupReferenceFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storeSetupReferenceFailure(response, error));
  });
  router.post("/store-setup/references/:kind", sameOriginMutation(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
      Object.keys(request.query).length !== 0 ||
      request.body === undefined
    ) {
      denied(response);
      return;
    }
    const kind =
      request.params.kind === "address"
        ? "Address"
        : request.params.kind === "contact"
          ? "Contact"
          : null;
    if (kind === null) {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    try {
      bindMerchantStoreSetupReferenceCommand(request.body, expectedScope, kind);
    } catch (error) {
      storeSetupReferenceFailure(response, error);
      return;
    }
    const port = options.storeSetupReferences;
    if (!port) {
      storeSetupReferenceFailure(response, undefined);
      return;
    }
    void port
      .write({ sessionCookie, csrf, command: request.body, expectedScope, kind })
      .then((value) => response.json(value))
      .catch((error) => storeSetupReferenceFailure(response, error));
  });

  const storePaymentConfigurationFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof StorePaymentConfigurationError ? error.code : undefined;
    const invalid = code === "STORE_PAYMENT_CONFIGURATION_INPUT_INVALID";
    const forbidden = code === "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED";
    const conflict =
      code === "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT" ||
      code === "STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_payment_configuration_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_payment_configuration_conflict"
              : "store_payment_configuration_unavailable",
      });
  };
  router.get("/store-setup/payment-configuration", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storePaymentConfigurationFailure(
        response,
        new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storePaymentConfiguration;
    if (!port) {
      storePaymentConfigurationFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storePaymentConfigurationFailure(response, error));
  });
  router.post(
    "/store-setup/payment-configuration",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        storePaymentConfigurationFailure(
          response,
          new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantStorePaymentConfigurationCommand(request.body, expectedScope);
      } catch (error) {
        storePaymentConfigurationFailure(response, error);
        return;
      }
      const port = options.storePaymentConfiguration;
      if (!port) {
        storePaymentConfigurationFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => storePaymentConfigurationFailure(response, error));
    },
  );

  const receiptTemplateArtifactsFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_artifact_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_artifact_conflict"
              : "receipt_template_artifact_unavailable",
      });
  };
  router.get("/store-setup/receipt-artifacts", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      receiptTemplateArtifactsFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateArtifacts;
    if (!port) {
      receiptTemplateArtifactsFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateArtifactsFailure(response, error));
  });
  router.post(
    "/store-setup/receipt-artifacts/:kind",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      const artifactKind =
        request.params.kind === "layout"
          ? "Layout"
          : request.params.kind === "compliance"
            ? "Compliance"
            : null;
      if (!artifactKind) {
        receiptTemplateArtifactsFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        receiptTemplateArtifactsFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateArtifactCommand(request.body, expectedScope, artifactKind);
      } catch (error) {
        receiptTemplateArtifactsFailure(response, error);
        return;
      }
      const port = options.receiptTemplateArtifacts;
      if (!port) {
        receiptTemplateArtifactsFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope, artifactKind })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateArtifactsFailure(response, error));
    },
  );

  const topologyFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof BrandStoreTopologyError ? error.code : undefined;
    const invalid = code === "BRAND_STORE_TOPOLOGY_INPUT_INVALID",
      forbidden = code === "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED";
    const conflict =
      code === "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" ||
      code === "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          error instanceof MerchantBrandStoreTopologyFeatureDisabled
            ? "brand_store_topology_feature_disabled"
            : invalid
              ? "brand_store_topology_invalid"
              : forbidden
                ? "request_denied"
                : conflict
                  ? "brand_store_topology_conflict"
                  : "brand_store_topology_unavailable",
      });
  };
  const topologyScope = (value: unknown) => {
    const r = readClosedRecord(value, ["tenantReference", "brandReference", "actorReference"]);
    return Object.freeze({
      tenantReference: parsePlatformTenantReference(r.tenantReference),
      brandReference: parseBrandReference(r.brandReference),
      actorReference: parseBrandReference(r.actorReference),
    });
  };
  for (const mode of ["workspace", "save", "resolve"] as const)
    router.post(
      "/organization/brands/topology/draft/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-csrf").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        const port = options.brandStoreTopologyDraft;
        if (!port) {
          topologyFailure(response, undefined);
          return;
        }
        void (async () => {
          let expectedBrandReference: string | undefined,
            expectedScope: ReturnType<typeof topologyScope> | undefined;
          let command:
            | ReturnType<typeof parseBrandStoreTopologySave>
            | ReturnType<typeof parseBrandStoreTopologyResolve>
            | undefined;
          try {
            if (mode === "workspace") {
              const body = readClosedRecord(
                request.body,
                Object.hasOwn(request.body, "expectedScope")
                  ? ["expectedBrandReference", "expectedScope"]
                  : ["expectedBrandReference"],
              );
              expectedBrandReference = String(parseBrandReference(body.expectedBrandReference));
              if (Object.hasOwn(body, "expectedScope"))
                expectedScope = topologyScope(body.expectedScope);
              if (expectedScope && expectedScope.brandReference !== expectedBrandReference)
                throw new Error("invalid");
            } else {
              const body = readClosedRecord(request.body, ["expectedScope", "command"]);
              expectedScope = topologyScope(body.expectedScope);
              command =
                mode === "save"
                  ? parseBrandStoreTopologySave(body.command)
                  : parseBrandStoreTopologyResolve(body.command);
              if (
                Object.entries(expectedScope).some(
                  ([key, value]) => Object.getOwnPropertyDescriptor(command, key)?.value !== value,
                )
              )
                throw new Error("invalid");
            }
          } catch {
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
          }
          if (mode === "workspace") {
            const value = await port.workspace({
              sessionCookie,
              csrf,
              expectedBrandReference,
              ...(expectedScope ? { expectedScope } : {}),
            });
            const result = parseBrandStoreTopologyWorkbench(
              value,
              options.brandStoreTopologyClock?.now(),
            );
            if (
              result.brandReference !== expectedBrandReference ||
              (expectedScope &&
                Object.entries(expectedScope).some(
                  ([key, value]) => Object.getOwnPropertyDescriptor(result, key)?.value !== value,
                ))
            )
              throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
            response.json(result);
            return;
          }
          if (!command || !expectedScope)
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
          const value = await port[mode]({ sessionCookie, csrf, expectedScope, command });
          let result: ReturnType<typeof parseBrandStoreTopologyOperationReceipt>;
          try {
            result = parseBrandStoreTopologyOperationReceipt(value);
          } catch {
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
          }
          const intent =
            command.profile === "BrandStoreTopologySaveV1"
              ? "sha256:" + sha256Hex(canonicalizeRfc8785(command))
              : command.intentDigest;
          if (
            Object.entries(expectedScope).some(
              ([key, value]) => Object.getOwnPropertyDescriptor(result, key)?.value !== value,
            ) ||
            result.operationReference !== command.operationReference ||
            result.expectedRevision !== command.expectedRevision ||
            result.intentDigest !== intent ||
            (command.profile === "BrandStoreTopologySaveV1" &&
              result.snapshot &&
              canonicalizeRfc8785(result.snapshot.content) !== canonicalizeRfc8785(command.content))
          )
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })().catch((error) => topologyFailure(response, error));
      },
    );

  const taxConfigAuthoringFailure = (response: express.Response, error: unknown): void => {
    if (error instanceof MerchantTaxConfigFeatureDisabled) {
      response
        .status(503)
        .set("Cache-Control", NO_STORE)
        .json({ error: "tax_config_authoring_feature_disabled" });
      return;
    }
    const code = error instanceof TaxConfigWorkflowError ? error.code : undefined;
    const invalid = code === "TAX_CONFIG_INPUT_INVALID";
    const forbidden = code === "TAX_CONFIG_PERMISSION_DENIED";
    const conflict =
      code === "TAX_CONFIG_VERSION_CONFLICT" ||
      code === "TAX_CONFIG_IDEMPOTENCY_CONFLICT" ||
      code === "TAX_CONFIG_LIFECYCLE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "tax_config_authoring_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "tax_config_authoring_conflict"
              : "tax_config_authoring_unavailable",
      });
  };
  const taxConfigOutput = <T>(work: () => T): T => {
    try {
      return work();
    } catch {
      throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
    }
  };
  const taxConfigExpectedScope = (request: express.Request) => {
    const encoded = exactHeader(request, "x-bop-store-setup-scope");
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
      throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
    const bytes = Buffer.from(encoded, "base64url"),
      decoded = bytes.toString("utf8");
    if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
      throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
    return parseTaxConfigAuthoringScope(JSON.parse(decoded));
  };
  router.get("/tax-config/authoring/classifications", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
    try {
      expectedScope = taxConfigExpectedScope(request);
      if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
    } catch (error) {
      taxConfigAuthoringFailure(
        response,
        error instanceof TaxConfigWorkflowError
          ? error
          : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
      );
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .classifications({
        sessionCookie,
        expectedScope,
        expectedStoreReference: expectedScope.storeReference,
      })
      .then((value) => {
        const result = taxConfigOutput(() => parseTaxConfigClassificationChoices(value));
        if (
          Object.entries(expectedScope).some(
            ([key, reference]) => Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
          )
        )
          throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  router.post(
    "/tax-config/authoring/simulate",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
      let command: ReturnType<typeof parseMerchantTaxConfigSimulationCommand>;
      try {
        expectedScope = taxConfigExpectedScope(request);
        command = parseMerchantTaxConfigSimulationCommand(request.body);
      } catch (error) {
        taxConfigAuthoringFailure(
          response,
          error instanceof TaxConfigWorkflowError
            ? error
            : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
        );
        return;
      }
      const port = options.taxConfigAuthoring;
      if (!port) {
        taxConfigAuthoringFailure(response, undefined);
        return;
      }
      void port
        .simulate({ sessionCookie, csrf, expectedScope, command })
        .then((value) => {
          const result = taxConfigOutput(() => parseTaxConfigAuthoringSimulation(value));
          if (
            Object.entries(expectedScope).some(
              ([key, reference]) =>
                Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
            ) ||
            result.configurationReference !== command.configurationReference ||
            result.versionReference !== command.expectedVersionReference ||
            result.snapshotDigest !== command.expectedSnapshotDigest ||
            result.simulation.fixtureReference !== command.fixture.fixtureReference ||
            result.simulation.kind !== command.fixture.kind
          )
            throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })
        .catch((error) => taxConfigAuthoringFailure(response, error));
    },
  );
  router.get("/tax-config/authoring/scope", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 0
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: ReturnType<typeof parsePricingReference>;
    try {
      expectedStoreReference = parsePricingReference(request.query.storeReference);
    } catch {
      taxConfigAuthoringFailure(response, new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"));
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .current({ sessionCookie, expectedStoreReference, configurationReference: null })
      .then((value) => {
        const result = taxConfigOutput(() => parseTaxConfigAuthoringCurrent(value, null));
        if (result.storeReference !== expectedStoreReference || result.state !== null)
          throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  for (const listing of [false, true]) {
    router.get(
      listing ? "/tax-config/authoring/roster" : "/tax-config/authoring/current",
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant");
        const key = listing ? "afterConfiguration" : "configurationReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some((k) => k !== "storeReference" && k !== key) ||
          typeof request.query.storeReference !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
        let target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
        };
        void (
          listing
            ? port.roster({ ...input, afterConfiguration: target })
            : port.current({ ...input, configurationReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              listing
                ? parseTaxConfigAuthoringRoster(value, target)
                : parseTaxConfigAuthoringCurrent(value, target),
            );
            if (
              Object.entries(expectedScope).some(
                ([key, reference]) =>
                  Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
              )
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            if (
              listing
                ? "afterConfiguration" in result && result.afterConfiguration !== target
                : "configurationReference" in result && result.configurationReference !== target
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving ? "/tax-config/authoring/resolve-original" : "/tax-config/authoring/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
        let command:
          | ReturnType<typeof parseTaxConfigAuthoringCommand>
          | ReturnType<typeof parseTaxConfigAuthoringResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigAuthoringResolve(request.body)
            : parseTaxConfigAuthoringCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope };
        void (resolving ? port.resolve({ ...input, command }) : port.execute({ ...input, command }))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigAuthoringOperation(value));
            if (
              Object.entries(expectedScope).some(
                ([key, reference]) =>
                  Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
              ) ||
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.configurationReference !== command.configurationReference ||
              result.expectedAggregateVersion !== command.expectedAggregateVersion ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigAuthoringIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  const taxMaterialKind = (value: unknown): TaxConfigMaterialKind => {
    if (
      value === "RegistrationApplicability" ||
      value === "ProfessionalReport" ||
      value === "FixtureSuite"
    )
      return value;
    throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
  };
  const taxSameScope = (
    value: object,
    expected: ReturnType<typeof parseTaxConfigAuthoringScope>,
  ) => {
    if (
      Object.entries(expected).some(
        ([key, reference]) => Object.getOwnPropertyDescriptor(value, key)?.value !== reference,
      )
    )
      throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
  };
  router.get("/tax-config/authoring/tax-registrant", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some((key) => key !== "storeReference") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
    try {
      expectedScope = taxConfigExpectedScope(request);
      if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
    } catch (error) {
      taxConfigAuthoringFailure(
        response,
        error instanceof TaxConfigWorkflowError
          ? error
          : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
      );
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .taxRegistrant({
        sessionCookie,
        expectedScope,
        expectedStoreReference: expectedScope.storeReference,
      })
      .then((value) => {
        const result = taxConfigOutput(() => {
          if (value === null) return null;
          const r = readClosedRecord(value, [
            "profile",
            ...Object.keys(expectedScope),
            "businessFunction",
            "effectiveAt",
            "assignmentReference",
            "assignmentVersion",
            "effectiveFrom",
            "effectiveUntil",
            "operatingEntityReference",
            "entityVersion",
            "operatingEntityProfileVersionReference",
            "profileVersion",
            "legalName",
            "jurisdictionCode",
            "registrationReference",
            "taxRegistrationReference",
            "observedAt",
            "validUntil",
            "qualification",
          ]);
          taxSameScope(r, expectedScope);
          if (
            r.profile !== "TaxRegistrantCurrentSourceV1" ||
            r.businessFunction !== "TaxRegistrant" ||
            r.jurisdictionCode !== "CA-ON" ||
            r.qualification !== "NotEvaluated" ||
            typeof r.legalName !== "string" ||
            !r.legalName.trim() ||
            r.legalName.length > 512 ||
            Array.from(r.legalName).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error("Invalid source");
          for (const key of [
            "assignmentReference",
            "operatingEntityReference",
            "operatingEntityProfileVersionReference",
          ])
            parsePricingReference(r[key]);
          for (const key of ["registrationReference", "taxRegistrationReference"])
            if (r[key] !== null) parsePricingReference(r[key]);
          for (const key of ["assignmentVersion", "entityVersion", "profileVersion"])
            if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < 1)
              throw new Error("Invalid version");
          for (const key of ["effectiveAt", "effectiveFrom", "observedAt", "validUntil"])
            parseCanonicalInstant(r[key]);
          if (r.effectiveUntil !== null) parseCanonicalInstant(r.effectiveUntil);
          const observed = Date.parse(String(r.observedAt)),
            until = Date.parse(String(r.validUntil)),
            effective = Date.parse(String(r.effectiveAt));
          if (
            until <= observed ||
            until - observed > 5000 ||
            effective > observed ||
            Date.parse(String(r.effectiveFrom)) > effective ||
            (r.effectiveUntil !== null && Date.parse(String(r.effectiveUntil)) <= effective)
          )
            throw new Error("Invalid lease");
          return r;
        });
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  for (const mode of ["current", "version", "roster"] as const) {
    router.get(
      "/tax-config/authoring/materials/" + mode,
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          key =
            mode === "roster"
              ? "afterMaterial"
              : mode === "version"
                ? "versionReference"
                : "materialReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some(
            (k) => !["storeReference", "materialKind", key].includes(k),
          ) ||
          typeof request.query.storeReference !== "string" ||
          typeof request.query.materialKind !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          materialKind: TaxConfigMaterialKind,
          target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          materialKind = taxMaterialKind(request.query.materialKind);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
          if (mode === "version" && target === null)
            throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
          materialKind,
        };
        void (
          mode === "roster"
            ? port.materialRoster({ ...input, afterMaterial: target })
            : mode === "version"
              ? port.materialVersion({ ...input, versionReference: target })
              : port.materialCurrent({ ...input, materialReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              mode === "roster"
                ? parseTaxConfigMaterialRoster(value)
                : parseTaxConfigMaterialCurrent(value),
            );
            taxSameScope(result, expectedScope);
            if (
              result.materialKind !== materialKind ||
              (mode === "roster"
                ? !("afterMaterial" in result) || result.afterMaterial !== target
                : mode === "version"
                  ? !("version" in result) || result.version?.versionReference !== target
                  : !("materialReference" in result) || result.materialReference !== target)
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving
        ? "/tax-config/authoring/materials/resolve-original"
        : "/tax-config/authoring/materials/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          command:
            | ReturnType<typeof parseTaxConfigMaterialCommand>
            | ReturnType<typeof parseTaxConfigMaterialResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigMaterialResolve(request.body)
            : parseTaxConfigMaterialCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope, command };
        void (resolving ? port.materialResolve(input) : port.materialExecute(input))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigMaterialOperation(value));
            taxSameScope(result, expectedScope);
            if (
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.materialReference !== command.materialReference ||
              result.expectedRevision !== command.expectedRevision ||
              result.materialKind !== command.materialKind ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigMaterialIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  for (const listing of [false, true]) {
    router.get(
      listing
        ? "/tax-config/authoring/candidates/roster"
        : "/tax-config/authoring/candidates/current",
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          key = listing ? "afterCandidate" : "targetVersionReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some(
            (k) => !["storeReference", "configurationReference", key].includes(k),
          ) ||
          typeof request.query.storeReference !== "string" ||
          typeof request.query.configurationReference !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          configurationReference: ReturnType<typeof parsePricingReference>,
          target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          configurationReference = parsePricingReference(request.query.configurationReference);
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
          configurationReference,
        };
        void (
          listing
            ? port.candidateRoster({ ...input, afterCandidate: target })
            : port.candidateCurrent({ ...input, targetVersionReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              listing
                ? parseTaxConfigCandidateRoster(value)
                : parseTaxConfigCandidateCurrent(value),
            );
            taxSameScope(result, expectedScope);
            if (
              result.configurationReference !== configurationReference ||
              (listing
                ? !("afterCandidate" in result) || result.afterCandidate !== target
                : !("targetVersionReference" in result) ||
                  (target !== null && result.targetVersionReference !== target))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving
        ? "/tax-config/authoring/candidates/resolve-original"
        : "/tax-config/authoring/candidates/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          command:
            | ReturnType<typeof parseTaxConfigCandidateCommand>
            | ReturnType<typeof parseTaxConfigCandidateResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigCandidateResolve(request.body)
            : parseTaxConfigCandidateCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope, command };
        void (resolving ? port.candidateResolve(input) : port.candidatePrepare(input))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigCandidateOperation(value));
            taxSameScope(result, expectedScope);
            if (
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.configurationReference !== command.configurationReference ||
              canonicalizeRfc8785(result.expectedDraft) !==
                canonicalizeRfc8785(command.expectedDraft) ||
              canonicalizeRfc8785(result.registrationMaterial) !==
                canonicalizeRfc8785(command.registrationMaterial) ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigCandidateIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  router.post(
    "/tax-config/authoring/materials/compare",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
        command: ReturnType<typeof parseMerchantTaxConfigMaterialComparisonCommand>;
      try {
        expectedScope = taxConfigExpectedScope(request);
        command = parseMerchantTaxConfigMaterialComparisonCommand(request.body);
      } catch (error) {
        taxConfigAuthoringFailure(
          response,
          error instanceof TaxConfigWorkflowError
            ? error
            : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
        );
        return;
      }
      const port = options.taxConfigAuthoring;
      if (!port) {
        taxConfigAuthoringFailure(response, undefined);
        return;
      }
      void port
        .materialCompare({ sessionCookie, csrf, expectedScope, command })
        .then((value) => {
          const result = taxConfigOutput(() => parseTaxConfigMaterialComparison(value));
          if (
            canonicalizeRfc8785({
              tenantReference: result.tenantReference,
              brandReference: result.brandReference,
              storeReference: result.storeReference,
              actorReference: result.actorReference,
            }) !== canonicalizeRfc8785(expectedScope) ||
            canonicalizeRfc8785(result.comparison.candidate) !==
              canonicalizeRfc8785(command.targetPublicationCandidate) ||
            canonicalizeRfc8785(result.comparison.suite) !==
              canonicalizeRfc8785(command.fixtureSuiteMaterial)
          )
            throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })
        .catch((error) => taxConfigAuthoringFailure(response, error));
    },
  );

  const receiptTemplateDraftFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_draft_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_draft_conflict"
              : "receipt_template_draft_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-draft", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "templateReference",
      ) ||
      (Object.hasOwn(request.query, "templateReference") &&
        typeof request.query.templateReference !== "string") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let templateReference: string | null = null;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      if (Object.hasOwn(request.query, "templateReference"))
        templateReference = parseStoreAdministrationReference(request.query.templateReference);
    } catch {
      receiptTemplateDraftFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateDraft;
    if (!port) {
      receiptTemplateDraftFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference, templateReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateDraftFailure(response, error));
  });
  router.get("/store-setup/receipt-template-drafts", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "afterTemplate",
      ) ||
      (Object.hasOwn(request.query, "afterTemplate") &&
        typeof request.query.afterTemplate !== "string") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let afterTemplate: string | null = null;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      if (Object.hasOwn(request.query, "afterTemplate"))
        afterTemplate = parseStoreAdministrationReference(request.query.afterTemplate);
    } catch {
      receiptTemplateDraftFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateDraft;
    if (!port) {
      receiptTemplateDraftFailure(response, undefined);
      return;
    }
    void port
      .list({ sessionCookie, expectedStoreReference, afterTemplate })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateDraftFailure(response, error));
  });
  router.post(
    "/store-setup/receipt-template-draft",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        receiptTemplateDraftFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateDraftCommand(request.body, expectedScope);
      } catch (error) {
        receiptTemplateDraftFailure(response, error);
        return;
      }
      const port = options.receiptTemplateDraft;
      if (!port) {
        receiptTemplateDraftFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateDraftFailure(response, error));
    },
  );

  const receiptTemplateReviewFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    response
      .status(
        code === "RECEIPT_TEMPLATE_INPUT_INVALID"
          ? 400
          : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
            ? 403
            : code === "RECEIPT_TEMPLATE_CONFLICT"
              ? 409
              : 503,
      )
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          code === "RECEIPT_TEMPLATE_INPUT_INVALID"
            ? "receipt_template_review_invalid"
            : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
              ? "request_denied"
              : code === "RECEIPT_TEMPLATE_CONFLICT"
                ? "receipt_template_review_conflict"
                : "receipt_template_review_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-review", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "templateReference",
      ) ||
      typeof request.query.storeReference !== "string" ||
      typeof request.query.templateReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      receiptTemplateReviewFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }

    let expectedStoreReference: string, templateReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      templateReference = parseStoreAdministrationReference(request.query.templateReference);
      if (expectedStoreReference !== expectedScope.storeReference) throw new Error("invalid");
    } catch {
      receiptTemplateReviewFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateReview;
    if (!port) {
      receiptTemplateReviewFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference, expectedScope, templateReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateReviewFailure(response, error));
  });

  const receiptTemplatePublishedFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    response
      .status(
        code === "RECEIPT_TEMPLATE_INPUT_INVALID"
          ? 400
          : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
            ? 403
            : code === "RECEIPT_TEMPLATE_CONFLICT"
              ? 409
              : 503,
      )
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          code === "RECEIPT_TEMPLATE_INPUT_INVALID"
            ? "receipt_template_published_invalid"
            : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
              ? "request_denied"
              : code === "RECEIPT_TEMPLATE_CONFLICT"
                ? "receipt_template_published_conflict"
                : "receipt_template_published_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-published", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "templateReference" && key !== "locale",
      ) ||
      typeof request.query.storeReference !== "string" ||
      typeof request.query.templateReference !== "string" ||
      typeof request.query.locale !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      receiptTemplatePublishedFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }

    let expectedStoreReference: string, templateReference: string, locale: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      templateReference = parseStoreAdministrationReference(request.query.templateReference);
      if (expectedStoreReference !== expectedScope.storeReference) throw new Error("invalid");
      if (
        typeof request.query.locale !== "string" ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(request.query.locale)
      )
        throw new Error("invalid");
      locale = request.query.locale;
    } catch {
      receiptTemplatePublishedFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplatePublished;
    if (!port) {
      receiptTemplatePublishedFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference, expectedScope, templateReference, locale })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplatePublishedFailure(response, error));
  });

  const receiptTemplateSubmitFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_submit_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_submit_conflict"
              : "receipt_template_submit_unavailable",
      });
  };
  router.post(
    "/store-setup/receipt-template-submit",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        receiptTemplateSubmitFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateSubmitCommand(request.body, expectedScope);
      } catch (error) {
        receiptTemplateSubmitFailure(response, error);
        return;
      }
      const port = options.receiptTemplateSubmit;
      if (!port) {
        receiptTemplateSubmitFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateSubmitFailure(response, error));
    },
  );

  const receiptTemplateLifecycleFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_lifecycle_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_lifecycle_conflict"
              : "receipt_template_lifecycle_unavailable",
      });
  };
  router.post(
    "/store-setup/receipt-template-lifecycle",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        receiptTemplateLifecycleFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateLifecycleCommand(request.body, expectedScope);
      } catch (error) {
        receiptTemplateLifecycleFailure(response, error);
        return;
      }
      const port = options.receiptTemplateLifecycle;
      if (!port) {
        receiptTemplateLifecycleFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateLifecycleFailure(response, error));
    },
  );

  router.get("/store-configuration", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.storeConfigurationState) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfigurationState(sessionCookie)
      .then((state) => response.json(state))
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/status", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundStatus) {
      response.status(503).json({ error: "refund_status_unavailable" });
      return;
    }
    void options
      .ordinaryRefundStatus({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          observedAt: result.observedAt,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          payments: result.payments.map((payment) => ({
            paymentAttemptReference: payment.paymentAttemptReference,
            paymentIntentReference: payment.paymentIntentReference,
            state: payment.state,
            executionOperationReference: payment.executionOperationReference,
            amountMinor: payment.amountMinor,
            confirmedMinor: payment.confirmedMinor,
            pendingMinor: payment.pendingMinor,
          })),
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/context", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.refundPaymentContext) {
      response.status(503).json({ error: "refund_payment_context_unavailable" });
      return;
    }
    void options
      .refundPaymentContext({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          paymentIntentReference: result.paymentIntentReference,
          paymentAttemptReference: result.paymentAttemptReference,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          observedAt: result.observedAt,
          paymentState: result.paymentState,
          currencyCode: result.currencyCode,
          capturedAmountMinor: result.capturedAmountMinor,
          confirmedRefundMinor: result.confirmedRefundMinor,
          pendingRefundMinor: result.pendingRefundMinor,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/items", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundItems) {
      response.status(503).json({ error: "refund_items_unavailable" });
      return;
    }
    void options
      .ordinaryRefundItems({ sessionCookie, csrf, query: request.body })
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          orderNumber: result.orderNumber,
          claimVersion: result.claimVersion,
          recentRequests: result.recentRequests.map((entry) => ({
            requestReference: entry.requestReference,
            operationReference: entry.operationReference,
            claimVersion: entry.claimVersion,
            requestedAt: entry.requestedAt,
            reasonCode: entry.reasonCode,
            currencyCode: entry.currencyCode,
            amountMinor: entry.amountMinor,
          })),
          items: result.items.map((item) => ({
            orderBatchReference: item.orderBatchReference,
            orderItemReference: item.orderItemReference,
            label: item.label,
            quantity: item.quantity,
            unclaimedQuantity: item.unclaimedQuantity,
            paymentCaptured: item.paymentCaptured,
            paymentIntentReference: item.paymentIntentReference,
          })),
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/preview", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundPreview) {
      response.status(503).json({ error: "refund_preview_unavailable" });
      return;
    }
    void options
      .ordinaryRefundPreview({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          components: {
            netAmountMinor: result.components.netAmountMinor,
            taxAmountMinor: result.components.taxAmountMinor,
            tipAmountMinor: result.components.tipAmountMinor,
            serviceChargeAmountMinor: result.components.serviceChargeAmountMinor,
            serviceChargeTaxAmountMinor: result.components.serviceChargeTaxAmountMinor,
          },
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/request", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundRequest) {
      response.status(503).json({ error: "refund_request_unavailable" });
      return;
    }
    void options
      .ordinaryRefundRequest({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.status(202).json({
          status: "RequestRecorded",
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          replayed: result.status === "AlreadyCommitted",
        });
      })
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/prepare", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefund) {
      response.status(503).json({ error: "refund_preparation_unavailable" });
      return;
    }
    void options
      .ordinaryRefund({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.status(202).json({
          status: "PreparationRecorded",
          operationReference: result.operationReference,
          replayed: result.status === "AlreadyCommitted",
        }),
      )
      .catch(() => denied(response));
  });

  router.post(
    "/operations/compensations/query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.compensationQuery) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationQuery({ sessionCookie, csrf, query: request.body })
        .then((result) =>
          response.json({
            caseVersion: result.caseVersion,
            caseState: result.caseState,
            refund: {
              amountMinor: result.refund.amountMinor,
              currencyCode: result.refund.currencyCode,
              confirmedAt: result.refund.confirmedAt,
            },
            acknowledgmentRecorded: result.acknowledgmentRecorded,
          }),
        )
        .catch(() =>
          response.status(503).json({ error: "compensation_reconciliation_unavailable" }),
        );
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-assignees",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationAssigneeQuery) {
        response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        return;
      }
      void options
        .reconciliationAssigneeQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (!Array.isArray(result.items) || result.items.length > 25)
            throw Error("RECONCILIATION_ASSIGNEES_INVALID");
          const seen = new Set<string>();
          const items = result.items.map((item) => {
            const actorReference = String(
              parseOpaqueUuidV7(item.actorReference, "ACTOR_REFERENCE_INVALID"),
            );
            if (
              seen.has(actorReference) ||
              typeof item.label !== "string" ||
              !/^([^\p{Cc}\p{Cf}]){1,80}$/u.test(item.label) ||
              item.label.trim() !== item.label ||
              item.label.includes("@")
            )
              throw Error("RECONCILIATION_ASSIGNEES_INVALID");
            seen.add(actorReference);
            return { actorReference, label: item.label };
          });
          const nextAfterActorReference =
            result.nextAfterActorReference === null
              ? null
              : String(
                  parseOpaqueUuidV7(result.nextAfterActorReference, "ACTOR_REFERENCE_INVALID"),
                );
          response.status(200).json({ items, nextAfterActorReference });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-evidence",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationEvidenceQuery) {
        response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        return;
      }
      void options
        .reconciliationEvidenceQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (result === null) {
            response.status(200).json({ evidence: null });
            return;
          }
          if (
            typeof result.amountMinor !== "string" ||
            !/^[1-9][0-9]{0,18}$/.test(result.amountMinor) ||
            BigInt(result.amountMinor) > 9223372036854775807n ||
            result.currencyCode !== "CAD" ||
            !["Test", "Live"].includes(result.environment) ||
            result.recordedReason !== "ProviderCaptureWithoutInternalOperation"
          )
            throw Error("RECONCILIATION_EVIDENCE_INVALID");
          const occurredAt = String(parseCanonicalInstant(result.occurredAt)),
            observedAt = String(parseCanonicalInstant(result.observedAt));
          if (occurredAt > observedAt) throw Error("RECONCILIATION_EVIDENCE_INVALID");
          response.status(200).json({
            evidence: {
              amountMinor: result.amountMinor,
              currencyCode: "CAD",
              environment: result.environment,
              occurredAt,
              observedAt,
              recordedReason: result.recordedReason,
            },
          });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof PaymentReconciliationError &&
              error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationFollowUpQuery) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUpQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (
            !Number.isSafeInteger(result.version) ||
            result.version < 1 ||
            !["Open", "Acknowledged", "Assigned"].includes(result.followUpStatus) ||
            typeof result.acknowledged !== "boolean" ||
            typeof result.assigned !== "boolean" ||
            (result.followUpStatus === "Open" && (result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Acknowledged" &&
              (!result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Assigned" && !result.assigned)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          response.status(200).json({
            version: result.version,
            followUpStatus: result.followUpStatus,
            acknowledged: result.acknowledged,
            assigned: result.assigned,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "reconciliation_follow_up_unavailable" }));
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.reconciliationFollowUp) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUp({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (
            !["Created", "Duplicate"].includes(result.status) ||
            !Number.isSafeInteger(result.version) ||
            result.version < 2 ||
            !["Acknowledged", "Assigned"].includes(result.followUpStatus)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          return response.status(202).json({
            status: "FollowUpRecorded",
            replayed: result.status === "Duplicate",
            version: result.version,
            followUpStatus: result.followUpStatus,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch((error) => {
          if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") {
            denied(response);
            return;
          }
          if (error instanceof ReconciliationFollowUpError) {
            if (error.code === "RECONCILIATION_FOLLOW_UP_CONFLICT") {
              response.status(409).json({ error: "reconciliation_follow_up_conflict" });
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED") {
              denied(response);
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_INVALID") {
              response.status(400).json({ error: "reconciliation_follow_up_invalid" });
              return;
            }
          }
          response.status(503).json({ error: "reconciliation_follow_up_unknown" });
        });
    },
  );

  router.post(
    "/operations/compensations/reconcile",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.compensationReconciliation) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationReconciliation({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (result.status !== "Created" && result.status !== "Duplicate")
            throw new Error("COMPENSATION_RECONCILIATION_RESULT_INVALID");
          return response.status(202).json({
            status: "ReconciliationRecorded",
            replayed: result.status === "Duplicate",
            reconciledAt: String(parseCanonicalInstant(result.reconciledAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "compensation_reconciliation_unknown" }));
    },
  );

  for (const [path, capability, status] of [
    ["send", "ordinaryRefundSend", "DispatchRecorded"],
    ["reconcile", "ordinaryRefundReconciliation", "ReconciliationRecorded"],
  ] as const) {
    router.post("/payments/refunds/" + path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      const execute = options[capability];
      if (!execute) {
        response.status(503).json({ error: "refund_execution_unavailable" });
        return;
      }
      void execute({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (path === "send") return response.status(202).json({ status });
          if (!("receipt" in result)) throw new Error("REFUND_RECEIPT_RESULT_INVALID");
          const receipt = result.receipt;
          return response.status(202).json({
            status,
            receipt: {
              status: receipt.status,
              version: receipt.version,
              kind: receipt.kind,
            },
          });
        })
        // A failure may follow committed dispatch/observation. Never tell the client
        // to discard its original identity or infer that nothing happened.
        .catch(() => response.status(503).json({ error: "refund_execution_unknown" }));
    });
  }

  router.post("/kitchen/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenQuery) {
      response.status(503).json({ error: "kitchen_queue_unavailable" });
      return;
    }
    void options
      .kitchenQuery({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenQueueProjectionError)) {
          denied(response);
          return;
        }
        const status = {
          KITCHEN_QUEUE_INPUT_INVALID: 400,
          KITCHEN_QUEUE_PERMISSION_DENIED: 403,
          KITCHEN_QUEUE_NOT_FOUND: 404,
          KITCHEN_QUEUE_VERSION_CONFLICT: 409,
          KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/kitchen/work", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenCommand) {
      response.status(503).json({ error: "kitchen_work_unavailable" });
      return;
    }
    void options
      .kitchenCommand({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenWorkLifecycleError)) {
          denied(response);
          return;
        }
        const status = {
          KITCHEN_WORK_INPUT_INVALID: 400,
          KITCHEN_WORK_PERMISSION_DENIED: 403,
          KITCHEN_WORK_NOT_FOUND: 404,
          KITCHEN_WORK_VERSION_CONFLICT: 409,
          KITCHEN_WORK_PRECONDITION_FAILED: 422,
          KITCHEN_WORK_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  // WP-2423: IAM-ROLE-LIST / IAM-ROLE-EDITOR reads and role administration commands.
  const roleAdministrationStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    InUse: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const roleAdministrationFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantRoleAdministrationError)) {
      denied(response);
      return;
    }
    response.status(roleAdministrationStatus[error.code]).json({ error: error.code });
  };
  router.post("/organization/roles/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { roleReference?: unknown } | undefined;
    const roleReference = body?.roleReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "roleReference" ||
      (roleReference !== null &&
        (typeof roleReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            roleReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.roleAdministration) {
      response.status(503).json({ error: "role_administration_unavailable" });
      return;
    }
    const roles = options.roleAdministration;
    void (
      roleReference === null
        ? roles.list({ sessionCookie, csrf })
        : roles.detail({ sessionCookie, csrf, roleReference })
    )
      .then((result) => response.json(result))
      .catch((error: unknown) => roleAdministrationFailure(response, error));
  });
  router.post("/organization/roles/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.roleAdministration) {
      response.status(503).json({ error: "role_administration_unavailable" });
      return;
    }
    void options.roleAdministration
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => roleAdministrationFailure(response, error));
  });

  // WP-2423: IAM-USER-LIST / IAM-USER-DETAIL reads and staff role assignment commands.
  const staffStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    LastOwner: 409,
    Invalid: 400,
  } as const;
  const staffFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStaffAdministrationError)) {
      denied(response);
      return;
    }
    response.status(staffStatus[error.code]).json({ error: error.code });
  };
  router.post("/organization/staff/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { actorReference?: unknown } | undefined;
    const actorReference = body?.actorReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "actorReference" ||
      (actorReference !== null &&
        (typeof actorReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            actorReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .query({ sessionCookie, csrf, actorReference })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });
  router.post("/organization/staff/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });

  // WP-2423: INV-ITEM-LIST / DETAIL / CREATE / EDIT reads and Inventory Item commands.
  const inventoryItemStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    StockRemaining: 409,
    Locked: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const inventoryItemFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantInventoryItemError)) {
      denied(response);
      return;
    }
    response.status(inventoryItemStatus[error.code]).json({ error: error.code });
  };
  router.post("/supply/items/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "afterInternalCode,itemReference,lifecycle,search" ||
      (body.itemReference !== null &&
        (typeof body.itemReference !== "string" || !uuid.test(body.itemReference))) ||
      (body.search !== null && (typeof body.search !== "string" || body.search.length > 80)) ||
      (body.lifecycle !== null &&
        !["Active", "Inactive", "Archived"].includes(String(body.lifecycle))) ||
      (body.afterInternalCode !== null &&
        (typeof body.afterInternalCode !== "string" ||
          !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(body.afterInternalCode)))
    ) {
      denied(response);
      return;
    }
    if (!options.inventoryItems) {
      response.status(503).json({ error: "inventory_items_unavailable" });
      return;
    }
    void options.inventoryItems
      .query({
        sessionCookie,
        csrf,
        itemReference: body.itemReference as string | null,
        search: body.search as string | null,
        lifecycle: body.lifecycle as "Active" | "Inactive" | "Archived" | null,
        afterInternalCode: body.afterInternalCode as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => inventoryItemFailure(response, error));
  });
  router.post("/supply/items/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.inventoryItems) {
      response.status(503).json({ error: "inventory_items_unavailable" });
      return;
    }
    void options.inventoryItems
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => inventoryItemFailure(response, error));
  });

  // WP-2423 / DEC-INV-LOCATIONS: INV-LOCATION-LIST reads and Stock Site / Storage Location commands.
  const stockPlaceStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    DefaultRequired: 409,
    StockRemaining: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const stockPlaceFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStockPlaceError)) {
      denied(response);
      return;
    }
    response.status(stockPlaceStatus[error.code]).json({ error: error.code });
  };
  for (const [path, handler] of [
    ["/supply/locations/query", "query"],
    ["/supply/locations/command", "command"],
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0 ||
        (handler === "query" &&
          (request.body === undefined || Object.keys(request.body as object).length !== 0))
      ) {
        denied(response);
        return;
      }
      if (!options.stockPlaces) {
        response.status(503).json({ error: "stock_places_unavailable" });
        return;
      }
      void (
        handler === "query"
          ? options.stockPlaces.query({ sessionCookie, csrf })
          : options.stockPlaces.command({ sessionCookie, csrf, body: request.body })
      )
        .then((result) => response.json(result))
        .catch((error: unknown) => stockPlaceFailure(response, error));
    });

  // WP-2423 / DEC-INV-OPENING: INV-OPENING-COUNT reads and opening count commands.
  const openingCountStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyPosted: 409,
    StockExists: 409,
    LineInvalid: 422,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const openingCountFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantOpeningCountError)) {
      denied(response);
      return;
    }
    response
      .status(openingCountStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/opening-count/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { countReference?: unknown } | undefined;
    const countReference = body?.countReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "countReference" ||
      (countReference !== null &&
        (typeof countReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            countReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.openingCount) {
      response.status(503).json({ error: "opening_count_unavailable" });
      return;
    }
    void options.openingCount
      .query({ sessionCookie, csrf, countReference })
      .then((result) => response.json(result))
      .catch((error: unknown) => openingCountFailure(response, error));
  });
  router.post("/supply/opening-count/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.openingCount) {
      response.status(503).json({ error: "opening_count_unavailable" });
      return;
    }
    void options.openingCount
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => openingCountFailure(response, error));
  });

  // WP-2423 / DEC-INV-DIRECT-RECEIPT: Store direct receipts.
  const receiptStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyVoided: 409,
    StockUsed: 409,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const receiptFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStoreReceiptError)) {
      denied(response);
      return;
    }
    response
      .status(receiptStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/receipts/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { receiptReference?: unknown; before?: unknown } | undefined;
    const receiptReference = body?.receiptReference ?? null,
      before = body?.before ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,receiptReference" ||
      (receiptReference !== null &&
        (typeof receiptReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            receiptReference,
          ))) ||
      (before !== null &&
        (typeof before !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(before)))
    ) {
      denied(response);
      return;
    }
    if (!options.storeReceipts) {
      response.status(503).json({ error: "store_receipts_unavailable" });
      return;
    }
    void options.storeReceipts
      .query({
        sessionCookie,
        csrf,
        receiptReference: receiptReference as string | null,
        before: before as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => receiptFailure(response, error));
  });
  router.post("/supply/receipts/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeReceipts) {
      response.status(503).json({ error: "store_receipts_unavailable" });
      return;
    }
    void options.storeReceipts
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => receiptFailure(response, error));
  });

  // WP-2423 / DEC-RECIPE-AUTHORING: RECIPE-LIST / RECIPE-EDITOR reads and recipe commands.
  const recipeStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    ReviewRequired: 409,
    ReviewerNotIndependent: 403,
    Lifecycle: 409,
    InUse: 409,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const recipeFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantRecipeError)) {
      denied(response);
      return;
    }
    response.status(recipeStatus[error.code]).json({ error: error.code, line: error.line });
  };
  router.post("/commerce/recipes/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { recipeReference?: unknown } | undefined;
    const recipeReference = body?.recipeReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "recipeReference" ||
      (recipeReference !== null &&
        (typeof recipeReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            recipeReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.recipes) {
      response.status(503).json({ error: "recipes_unavailable" });
      return;
    }
    void options.recipes
      .query({ sessionCookie, csrf, recipeReference: recipeReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => recipeFailure(response, error));
  });
  router.post("/commerce/recipes/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.recipes) {
      response.status(503).json({ error: "recipes_unavailable" });
      return;
    }
    void options.recipes
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => recipeFailure(response, error));
  });

  // WP-2423 / DEC-CAT-PRODUCT-ADMIN: CAT-PRODUCT-LIST / CAT-PRODUCT-DETAIL reads and Product commands.
  const productStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    SizeInUse: 409,
    TaxClassUnavailable: 422,
    Lifecycle: 409,
    Invalid: 400,
  } as const;
  const productFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantProductError)) {
      denied(response);
      return;
    }
    response.status(productStatus[error.code]).json({ error: error.code });
  };
  router.post("/commerce/products/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { productReference?: unknown } | undefined;
    const productReference = body?.productReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "productReference" ||
      (productReference !== null &&
        (typeof productReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            productReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.products) {
      response.status(503).json({ error: "products_unavailable" });
      return;
    }
    void options.products
      .query({ sessionCookie, csrf, productReference: productReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => productFailure(response, error));
  });
  router.post("/commerce/products/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.products) {
      response.status(503).json({ error: "products_unavailable" });
      return;
    }
    void options.products
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => productFailure(response, error));
  });

  // WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: PRICE-BOOK-LIST / PRICE-BOOK-EDITOR reads and commands.
  const priceStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    ApprovalRequired: 403,
    NotCovered: 409,
    NotPublished: 409,
    AlreadyAssigned: 409,
    Lifecycle: 409,
    Invalid: 400,
  } as const;
  const priceFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantPriceError)) {
      denied(response);
      return;
    }
    response
      .status(priceStatus[error.code])
      .json({ error: error.code, sellableReferences: error.sellableReferences });
  };
  router.post("/commerce/pricing/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { priceBookReference?: unknown } | undefined;
    const priceBookReference = body?.priceBookReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "priceBookReference" ||
      (priceBookReference !== null &&
        (typeof priceBookReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            priceBookReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.prices) {
      response.status(503).json({ error: "prices_unavailable" });
      return;
    }
    void options.prices
      .query({ sessionCookie, csrf, priceBookReference: priceBookReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => priceFailure(response, error));
  });
  router.post("/commerce/pricing/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.prices) {
      response.status(503).json({ error: "prices_unavailable" });
      return;
    }
    void options.prices
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => priceFailure(response, error));
  });

  // WP-2423 / DEC-INV-STOCK-COUNT: INV-COUNT-LIST / INV-COUNT-WORKBENCH.
  const countStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyOpen: 409,
    StockChanged: 409,
    Incomplete: 409,
    NotIndependent: 403,
    State: 409,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const countFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStockCountError)) {
      denied(response);
      return;
    }
    response
      .status(countStatus[error.code])
      .json({ error: error.code, lineReferences: error.lineReferences });
  };
  const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  const nullable = (value: unknown, pattern: RegExp) =>
    value === null || (typeof value === "string" && pattern.test(value));
  router.post("/supply/counts/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { countReference?: unknown; before?: unknown } | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,countReference" ||
      !nullable(body.countReference, uuidV7Pattern) ||
      !nullable(body.before, instantPattern)
    ) {
      denied(response);
      return;
    }
    if (!options.stockCounts) {
      response.status(503).json({ error: "stock_counts_unavailable" });
      return;
    }
    void options.stockCounts
      .query({
        sessionCookie,
        csrf,
        countReference: body.countReference as string | null,
        before: body.before as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => countFailure(response, error));
  });
  router.post("/supply/counts/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.stockCounts) {
      response.status(503).json({ error: "stock_counts_unavailable" });
      return;
    }
    void options.stockCounts
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => countFailure(response, error));
  });

  // WP-2423 / DEC-INV-WASTE: INV-WASTE-WIZARD and the waste record list with reviews.
  const wasteStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    NotEnoughStock: 409,
    AlreadyReviewed: 409,
    NotIndependent: 403,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const wasteFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStoreWasteError)) {
      denied(response);
      return;
    }
    response
      .status(wasteStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/waste/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as
      { wasteReference?: unknown; before?: unknown; needsReviewOnly?: unknown } | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,needsReviewOnly,wasteReference" ||
      !nullable(body.wasteReference, uuidV7Pattern) ||
      !nullable(body.before, instantPattern) ||
      typeof body.needsReviewOnly !== "boolean"
    ) {
      denied(response);
      return;
    }
    if (!options.storeWaste) {
      response.status(503).json({ error: "store_waste_unavailable" });
      return;
    }
    void options.storeWaste
      .query({
        sessionCookie,
        csrf,
        wasteReference: body.wasteReference as string | null,
        before: body.before as string | null,
        needsReviewOnly: body.needsReviewOnly,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => wasteFailure(response, error));
  });
  router.post("/supply/waste/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeWaste) {
      response.status(503).json({ error: "store_waste_unavailable" });
      return;
    }
    void options.storeWaste
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => wasteFailure(response, error));
  });

  router.post("/kitchen/release", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenRelease) {
      response.status(503).json({ error: "kitchen_release_unavailable" });
      return;
    }
    void options
      .kitchenRelease({ sessionCookie, csrf })
      .then(() => response.status(204).end())
      .catch(() => denied(response));
  });

  router.post("/pickup/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupQuery) {
      response.status(503).json({ error: "pickup_queue_unavailable" });
      return;
    }
    void options
      .pickupQuery({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof FulfillmentReadinessError)) {
          denied(response);
          return;
        }
        const status = {
          FULFILLMENT_READINESS_INPUT_INVALID: 400,
          FULFILLMENT_READINESS_PERMISSION_DENIED: 403,
          FULFILLMENT_READINESS_NOT_FOUND: 404,
          FULFILLMENT_READINESS_CONFLICT: 409,
          FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/handoff", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupHandoff) {
      response.status(503).json({ error: "pickup_handoff_unavailable" });
      return;
    }
    void options
      .pickupHandoff({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/proof", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupProof) {
      response.status(503).json({ error: "pickup_proof_unavailable" });
      return;
    }
    void options
      .pickupProof({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError) && !(error instanceof PickupProofError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_PROOF_INPUT_INVALID: 400,
          PICKUP_PROOF_NOT_READY: 422,
          PICKUP_PROOF_VERSION_CONFLICT: 409,
          PICKUP_PROOF_UNAVAILABLE: 422,
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/dining/sessions/join-state", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinState) {
      response.status(503).json({ error: "dining_join_state_unavailable" });
      return;
    }
    void options
      .diningJoinState({ sessionCookie, csrf, query: request.body })
      .then((r) =>
        response.json({
          diningSessionReference: r.diningSessionReference,
          tableReference: r.tableReference,
          sessionVersion: r.sessionVersion,
          tableAssignmentVersion: r.tableAssignmentVersion,
          capabilityVersion: r.capabilityVersion,
          generation: r.generation,
          joinKind: r.joinKind,
        }),
      )
      .catch(() => denied(response));
  });
  router.post("/dining/sessions/regenerate", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinRegenerate) {
      response.status(503).json({ error: "dining_join_regenerate_unavailable" });
      return;
    }
    void options
      .diningJoinRegenerate({ sessionCookie, csrf, command: request.body })
      .then((r) => {
        if (
          !r ||
          !["Issued", "AlreadyApplied"].includes(r.status) ||
          !Number.isSafeInteger(r.generation) ||
          r.generation < 1 ||
          !Number.isSafeInteger(r.capabilityVersion) ||
          r.capabilityVersion < 1 ||
          !["HumanCode", "Invitation"].includes(r.joinKind) ||
          (r.status === "Issued" &&
            (typeof r.joinCredential !== "string" ||
              !(r.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                r.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: r.status,
          generation: r.generation,
          capabilityVersion: r.capabilityVersion,
          joinKind: r.joinKind,
          ...(r.status === "Issued" ? { joinCredential: r.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post(
    "/dining/sessions/host-transfer",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostTransfer) {
        response.status(503).json({ error: "dining_host_transfer_unavailable" });
        return;
      }
      void options
        .diningHostTransfer({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !result ||
            !["Applied", "AlreadyApplied"].includes(result.status) ||
            !reference.test(result.operationReference) ||
            !reference.test(result.diningSessionReference) ||
            !reference.test(String(result.hostParticipantReference)) ||
            (result.previousHostParticipantReference !== null &&
              !reference.test(result.previousHostParticipantReference)) ||
            result.hostParticipantReference === result.previousHostParticipantReference ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 2 ||
            result.sessionVersion > 2147483647 ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.transferredAt) ||
            !Number.isFinite(Date.parse(result.transferredAt)) ||
            new Date(result.transferredAt).toISOString() !== result.transferredAt
          ) {
            denied(response);
            return;
          }
          response.json({
            status: result.status,
            operationReference: result.operationReference,
            diningSessionReference: result.diningSessionReference,
            previousHostParticipantReference: result.previousHostParticipantReference,
            hostParticipantReference: result.hostParticipantReference,
            sessionVersion: result.sessionVersion,
            transferredAt: result.transferredAt,
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post(
    "/dining/sessions/host-selection",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostSelection) {
        response.status(503).json({ error: "dining_host_selection_unavailable" });
        return;
      }
      void options
        .diningHostSelection({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          const instant = (value: string) =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value;
          if (
            !result ||
            !reference.test(result.diningSessionReference) ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 1 ||
            result.sessionVersion >= 2147483647 ||
            !["Active", "Closing"].includes(result.phase) ||
            (result.hostParticipantReference !== null &&
              !reference.test(result.hostParticipantReference)) ||
            !instant(result.observedAt) ||
            !Array.isArray(result.participants) ||
            result.participants.length > 100
          ) {
            denied(response);
            return;
          }
          const seen = new Set<string>();
          for (const p of result.participants) {
            if (
              !p ||
              !reference.test(p.participantReference) ||
              !instant(p.joinedAt) ||
              p.joinedAt > result.observedAt ||
              p.isHost !== (p.participantReference === result.hostParticipantReference) ||
              seen.has(p.participantReference)
            ) {
              denied(response);
              return;
            }
            seen.add(p.participantReference);
          }
          response.json({
            diningSessionReference: result.diningSessionReference,
            sessionVersion: result.sessionVersion,
            phase: result.phase,
            hostParticipantReference: result.hostParticipantReference,
            observedAt: result.observedAt,
            participants: result.participants.map((p) => ({
              participantReference: p.participantReference,
              joinedAt: p.joinedAt,
              isHost: p.isHost,
            })),
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post("/dining/sessions/start", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningSessionStart) {
      response.status(503).json({ error: "dining_session_start_unavailable" });
      return;
    }
    void options
      .diningSessionStart({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        if (
          !result ||
          !["Issued", "AlreadyApplied"].includes(result.status) ||
          !reference.test(result.diningSessionReference) ||
          !reference.test(result.tableReference) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1 ||
          !Number.isSafeInteger(result.tableAssignmentVersion) ||
          result.tableAssignmentVersion < 1 ||
          !["Invitation", "HumanCode"].includes(result.joinKind) ||
          (result.status === "Issued" &&
            (typeof result.joinCredential !== "string" ||
              !(result.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                result.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          diningSessionReference: result.diningSessionReference,
          sessionVersion: result.sessionVersion,
          tableReference: result.tableReference,
          tableAssignmentVersion: result.tableAssignmentVersion,
          joinKind: result.joinKind,
          ...(result.status === "Issued" ? { joinCredential: result.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/tables", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTables) {
      response.status(503).json({ error: "dining_tables_unavailable" });
      return;
    }
    void options
      .diningTables({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch(() => denied(response));
  });

  router.post("/dining/tables/availability", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTableCommand) {
      response.status(503).json({ error: "dining_table_command_unavailable" });
      return;
    }
    void options
      .diningTableCommand({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        if (
          !result ||
          !["Applied", "AlreadyApplied"].includes(result.status) ||
          !reference.test(result.tableReference) ||
          !["Available", "TemporarilyBlocked"].includes(result.operationalState) ||
          !Number.isSafeInteger(result.aggregateVersion) ||
          result.aggregateVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          tableReference: result.tableReference,
          operationalState: result.operationalState,
          aggregateVersion: result.aggregateVersion,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/order-progress", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningOrderProgress) {
      response.status(503).json({ error: "dining_order_progress_unavailable" });
      return;
    }
    void options
      .diningOrderProgress({ sessionCookie, csrf, query: request.body })
      .then((current) => {
        if (!current) {
          response.status(404).json({ error: "dining_order_progress_unavailable" });
          return;
        }
        response.json({
          orderReference: current.orderReference,
          tableLabel: current.tableLabel,
          diningSessionReference: current.diningSessionReference,
          sessionPhase: current.sessionPhase,
          closureStatus: current.closureStatus,
          closureVersion: current.closureVersion,
          currentOrderVersion: current.currentOrderVersion,
          sessionVersion: current.sessionVersion,
          tableAssignmentVersion: current.tableAssignmentVersion,
          orderVersion: current.orderVersion,
          phase: current.phase,
          observedAt: current.observedAt,
          items: current.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            orderBatchReference: item.orderBatchReference,
            displayName: item.displayName,
            batchSequence: item.batchSequence,
            itemOrdinal: item.itemOrdinal,
            phase: item.phase,
            orderedQuantity: item.orderedQuantity,
            deliveredQuantity: item.deliveredQuantity,
            remainingQuantity: item.remainingQuantity,
            itemServiceVersion: item.itemServiceVersion,
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/serve", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningServe) {
      response.status(503).json({ error: "dining_serve_unavailable" });
      return;
    }
    void options
      .diningServe({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/dining/item-service", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningItemService) {
      response.status(503).json({ error: "dining_item_service_unavailable" });
      return;
    }
    void options
      .diningItemService({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.record.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/catalog/menus/publication", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.menuPublication) {
      response.status(503).json({ error: "menu_publication_unavailable" });
      return;
    }
    void options
      .menuPublication({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_publication_invalid"
              : status === 409
                ? "menu_publication_conflict"
                : status === 503
                  ? "menu_publication_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/menus/draft", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.menuDraft) {
      response.status(503).json({ error: "menu_draft_unavailable" });
      return;
    }
    void options
      .menuDraft({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_draft_invalid"
              : status === 409
                ? "menu_draft_conflict"
                : status === 503
                  ? "menu_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post(
    "/organization/brands/lifecycle",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.brandLifecycle) {
        response.status(503).json({ error: "brand_lifecycle_unavailable" });
        return;
      }
      void options
        .brandLifecycle({ sessionCookie, csrf, command: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (!(error instanceof BrandAdministrationServiceError)) {
            denied(response);
            return;
          }
          const status =
            error.code === "BRAND_ADMIN_INPUT_INVALID"
              ? 400
              : [
                    "BRAND_ADMIN_VERSION_CONFLICT",
                    "BRAND_ADMIN_IDEMPOTENCY_CONFLICT",
                    "BRAND_ADMIN_LIFECYCLE_CONFLICT",
                  ].includes(error.code)
                ? 409
                : error.code === "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
          response.status(status).json({
            error:
              status === 400
                ? "brand_lifecycle_invalid"
                : status === 409
                  ? "brand_lifecycle_conflict"
                  : status === 503
                    ? "brand_lifecycle_unavailable"
                    : "request_denied",
          });
        });
    },
  );

  router.post("/catalog/products", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productCreation) {
      response.status(503).json({ error: "product_creation_unavailable" });
      return;
    }
    void options
      .productCreation({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_creation_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_creation_invalid"
              : status === 409
                ? "product_creation_conflict"
                : status === 503
                  ? "product_creation_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/draft", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productDraft) {
      response.status(503).json({ error: "product_draft_unavailable" });
      return;
    }
    void options
      .productDraft({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_draft_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_draft_invalid"
              : status === 409
                ? "product_draft_conflict"
                : status === 503
                  ? "product_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/lifecycle", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productLifecycle) {
      response.status(503).json({ error: "product_lifecycle_unavailable" });
      return;
    }
    void options
      .productLifecycle({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_lifecycle_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_lifecycle_invalid"
              : status === 409
                ? "product_lifecycle_conflict"
                : status === 503
                  ? "product_lifecycle_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/store-capability", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeCapability) {
      response.status(503).json({ error: "store_capability_unavailable" });
      return;
    }
    void options
      .storeCapability({ sessionCookie, csrf, query: request.body })
      .then((decision) => response.json(decision))
      .catch(() => {
        response.status(503).json({ error: "store_capability_unavailable" });
      });
  });

  const optionSetList = options.optionSetList;
  router.post("/catalog/option-sets/list", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    let expectedScope;
    try {
      const headers = rawHeaderValues(request, "x-bop-catalog-scope");
      if (headers.length !== 1) throw Error();
      expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
    } catch {
      denied(response);
      return;
    }
    if (!optionSetList) {
      response.status(503).json({ error: "option_set_list_unavailable" });
      return;
    }
    void optionSetList({ sessionCookie, csrf, filters: request.body, expectedScope })
      .then((view) => {
        try {
          response.json(parseOptionSetListView(view));
        } catch {
          throw new CatalogOptionSetListError("DependencyUnavailable");
        }
      })
      .catch((error: unknown) => {
        const code =
          error instanceof CatalogOptionSetListError ? error.code : "DependencyUnavailable";
        response
          .status(
            code === "Invalid"
              ? 400
              : code === "Denied"
                ? 403
                : code === "FeatureDisabled" || code === "Stale"
                  ? 409
                  : 503,
          )
          .json({
            error:
              code === "Invalid"
                ? "option_set_list_invalid"
                : code === "Denied"
                  ? "request_denied"
                  : code === "FeatureDisabled"
                    ? "option_set_list_feature_disabled"
                    : code === "Stale"
                      ? "option_set_list_stale"
                      : "option_set_list_unavailable",
          });
      });
  });

  router.post("/catalog/products/editor", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    let expectedScope;
    try {
      const headers = rawHeaderValues(request, "x-bop-catalog-scope");
      if (headers.length !== 1) throw Error();
      expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productEditor) {
      response.status(503).json({ error: "product_editor_unavailable" });
      return;
    }
    let query;
    try {
      query = parseProductPublicationSourceRequest(request.body);
    } catch {
      response.status(400).json({ error: "product_editor_invalid" });
      return;
    }
    void options
      .productEditor({ sessionCookie, csrf, query, expectedScope })
      .then((value) => {
        let view;
        try {
          view = parseCatalogProductEditorSnapshot(value);
        } catch {
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        }
        if (
          view.productReference !== query.productReference ||
          view.aggregateVersion !== query.expectedAggregateVersion ||
          view.brandReference !== expectedScope.brandReference
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        response.json(view);
      })
      .catch((error: unknown) => {
        const status =
          error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
              ? 403
              : 503;
        response.status(status).json({
          error:
            status === 400
              ? "product_editor_invalid"
              : status === 403
                ? "request_denied"
                : "product_editor_unavailable",
        });
      });
  });

  router.post(
    "/catalog/products/publication/management",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationManagement) {
        response.status(503).json({ error: "product_publication_management_unavailable" });
        return;
      }
      void options
        .productPublicationManagement({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const status =
            error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
              ? 400
              : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                ? 403
                : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_management_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_management_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/management/v2",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationManagementV2) {
        response.status(503).json({ error: "product_publication_management_unavailable" });
        return;
      }
      void options
        .productPublicationManagementV2({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const status =
            error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
              ? 400
              : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                ? 403
                : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_management_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_management_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/validation-report/v2",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationValidationReportV2) {
        response.status(503).json({ error: "product_publication_validation_report_unavailable" });
        return;
      }
      void options
        .productPublicationValidationReportV2({
          sessionCookie,
          csrf,
          query: request.body,
          expectedScope,
        })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const status =
            error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
              ? 400
              : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                ? 403
                : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_validation_report_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_validation_report_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/resolve/v1",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const values = rawHeaderValues(request, "x-bop-catalog-scope");
        if (values.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationResolution) {
        response.status(503).json({ error: "product_publication_resolution_unavailable" });
        return;
      }
      void options
        .productPublicationResolution({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          const status =
            error instanceof MerchantProductWriteFeatureDisabled
              ? 409
              : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                ? 400
                : error instanceof CatalogError &&
                    [
                      "CATALOG_VERSION_CONFLICT",
                      "CATALOG_IDEMPOTENCY_CONFLICT",
                      "CATALOG_LIFECYCLE_CONFLICT",
                    ].includes(error.code)
                  ? 409
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_resolution_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_publication_resolution_conflict"
                    : "product_publication_resolution_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/authoring-resolution",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const values = rawHeaderValues(request, "x-bop-catalog-scope");
        if (values.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productAuthoringResolution) {
        response.status(503).json({ error: "product_authoring_resolution_unavailable" });
        return;
      }
      void options
        .productAuthoringResolution({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          const status =
            error instanceof MerchantProductWriteFeatureDisabled
              ? 409
              : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                ? 400
                : error instanceof CatalogError &&
                    [
                      "CATALOG_VERSION_CONFLICT",
                      "CATALOG_IDEMPOTENCY_CONFLICT",
                      "CATALOG_LIFECYCLE_CONFLICT",
                    ].includes(error.code)
                  ? 409
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_authoring_resolution_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_authoring_resolution_conflict"
                    : "product_authoring_resolution_unavailable",
          });
        });
    },
  );

  router.post(
    "/pricing/option-prices/review/current",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      const endpoint = options.optionPriceReview;
      if (!endpoint || typeof endpoint.query !== "function") {
        response.status(503).json({ error: "option_price_unavailable" });
        return;
      }
      const positive = (value: unknown) => {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > 2147483647
        )
          throw Error();
        return value;
      };
      let ruleReference: string, call: Promise<unknown>;
      try {
        const envelope = readClosedRecord(request.body, ["ruleReference", "context"]),
          context = readClosedRecord(envelope.context, [
            "productReference",
            "expectedProductAggregateVersion",
            "bindingReference",
            "optionReference",
          ]);
        ruleReference = parsePricingReference(envelope.ruleReference);
        call = endpoint.query({
          sessionCookie,
          csrf,
          expectedScope,
          ruleReference,
          context: {
            productReference: parsePricingReference(context.productReference),
            expectedProductAggregateVersion: positive(context.expectedProductAggregateVersion),
            bindingReference: parsePricingReference(context.bindingReference),
            optionReference: parsePricingReference(context.optionReference),
          },
        });
      } catch {
        response.status(400).json({ error: "option_price_invalid" });
        return;
      }
      void call
        .then((result) => {
          try {
            const value = readClosedRecord(result, [
              "profile",
              "tenantReference",
              "brandReference",
              "storeReference",
              "actorReference",
              "ruleReference",
              "aggregateVersion",
              "draftVersionReference",
              "draftSnapshotDigest",
              "draftAuthorActorReference",
              "policy",
              "review",
              "observedAt",
              "validUntil",
            ]);
            for (const field of [
              "tenantReference",
              "brandReference",
              "storeReference",
              "actorReference",
              "ruleReference",
              "draftVersionReference",
              "draftAuthorActorReference",
            ])
              parsePricingReference(value[field]);
            parsePricingDigest(value.draftSnapshotDigest);
            positive(value.aggregateVersion);
            const observedAt = parseCatalogInstant(value.observedAt),
              validUntil = parseCatalogInstant(value.validUntil);
            if (
              value.profile !== "MerchantOptionPriceReviewCurrentV1" ||
              value.ruleReference !== ruleReference ||
              value.brandReference !== expectedScope.brandReference ||
              value.storeReference !== expectedScope.storeReference ||
              observedAt >= validUntil ||
              Date.parse(validUntil) - Date.parse(observedAt) > 5000
            )
              throw Error();
            const policy = readClosedRecord(value.policy, [
              "familyReference",
              "policyReference",
              "policyVersion",
              "approvalPolicy",
              "effectiveFrom",
              "effectiveUntil",
              "currentPublicationReference",
            ]);
            for (const field of [
              "familyReference",
              "policyReference",
              "currentPublicationReference",
            ])
              parsePricingReference(policy[field]);
            positive(policy.policyVersion);
            const effectiveFrom = parseCatalogInstant(policy.effectiveFrom),
              effectiveUntil =
                policy.effectiveUntil === null ? null : parseCatalogInstant(policy.effectiveUntil);
            if (
              (policy.approvalPolicy !== "Required" && policy.approvalPolicy !== "NotRequired") ||
              (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
            )
              throw Error();
            if (
              value.review === null ||
              typeof value.review !== "object" ||
              Array.isArray(value.review)
            )
              throw Error();
            const discriminator = Object.getOwnPropertyDescriptor(value.review, "outcome");
            if (!discriminator?.enumerable || !("value" in discriminator)) throw Error();
            if (discriminator.value === "Absent") readClosedRecord(value.review, ["outcome"]);
            else {
              const review = readClosedRecord(value.review, [
                  "outcome",
                  "lifecycle",
                  "validationValidUntil",
                  "approvalValidUntil",
                  "submittedActorReference",
                  "approvedActorReference",
                  "sourceAuthority",
                  "qualification",
                ]),
                lifecycle = readClosedRecord(review.lifecycle, [
                  "lifecycleReference",
                  "version",
                  "state",
                  "latestMutationOperationReference",
                ]);
              if (
                review.outcome !== "Recorded" ||
                review.sourceAuthority !== "RecordedHistory" ||
                review.qualification !== "NotEvaluated" ||
                !publishingLifecycleStates.some((state) => state === lifecycle.state)
              )
                throw Error();
              parsePricingReference(lifecycle.lifecycleReference);
              parsePricingReference(lifecycle.latestMutationOperationReference);
              positive(lifecycle.version);
              const validationValidUntil =
                  review.validationValidUntil === null
                    ? null
                    : parseCatalogInstant(review.validationValidUntil),
                approvalValidUntil =
                  review.approvalValidUntil === null
                    ? null
                    : parseCatalogInstant(review.approvalValidUntil);
              if (
                approvalValidUntil !== null &&
                (validationValidUntil === null || approvalValidUntil > validationValidUntil)
              )
                throw Error();
              for (const field of ["submittedActorReference", "approvedActorReference"])
                if (review[field] !== null) parsePricingReference(review[field]);
            }
            response.json(result);
          } catch {
            response.status(503).json({ error: "option_price_unavailable" });
          }
        })
        .catch((error: unknown) => {
          const feature = error instanceof MerchantProductWriteFeatureDisabled,
            code = error instanceof OptionPriceAuthoringError ? error.code : null,
            status = feature
              ? 409
              : code === "OPTION_PRICE_INPUT_INVALID"
                ? 400
                : code === "OPTION_PRICE_PERMISSION_DENIED"
                  ? 403
                  : code !== null &&
                      [
                        "OPTION_PRICE_VERSION_CONFLICT",
                        "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                        "OPTION_PRICE_LIFECYCLE_CONFLICT",
                        "OPTION_PRICE_APPROVAL_REQUIRED",
                        "OPTION_PRICE_CONFLICT",
                      ].includes(code)
                    ? 409
                    : 503;
          response.status(status).json({
            error: feature
              ? "option_price_feature_disabled"
              : status === 400
                ? "option_price_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "option_price_conflict"
                    : "option_price_unavailable",
          });
        });
    },
  );

  for (const mode of ["command", "resolve"] as const) {
    router.post(
      "/pricing/option-prices/review/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          Object.keys(request.query).length !== 0
        ) {
          denied(response);
          return;
        }
        let expectedScope;
        try {
          const headers = rawHeaderValues(request, "x-bop-catalog-scope");
          if (headers.length !== 1) throw Error();
          expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
        } catch {
          denied(response);
          return;
        }
        const endpoint = options.optionPriceReview;
        if (!endpoint) {
          response.status(503).json({ error: "option_price_unavailable" });
          return;
        }
        let command: Record<string, unknown>, call: Promise<unknown>;
        try {
          const envelope = readClosedRecord(
            request.body,
            mode === "command" ? ["command", "context"] : ["command"],
          );
          command = readClosedRecord(envelope.command, [
            "action",
            "operationReference",
            "ruleReference",
            "draftVersionReference",
            "draftSnapshotDigest",
            "expectedAggregateVersion",
            "validationValidUntil",
            "approvalValidUntil",
            "expectedLifecycle",
          ]);
          if (command.action !== "SubmitReview" && command.action !== "Approve") throw Error();
          parsePricingReference(command.operationReference);
          parsePricingReference(command.ruleReference);
          parsePricingReference(command.draftVersionReference);
          parsePricingDigest(command.draftSnapshotDigest);
          const positive = (v: unknown) => {
            if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 2147483647)
              throw Error();
            return v;
          };
          positive(command.expectedAggregateVersion);
          parseCatalogInstant(command.validationValidUntil);
          if (command.approvalValidUntil !== null) parseCatalogInstant(command.approvalValidUntil);
          if ((command.action === "SubmitReview") !== (command.approvalValidUntil === null))
            throw Error();
          if (command.expectedLifecycle !== null) {
            const head = readClosedRecord(command.expectedLifecycle, [
              "lifecycleReference",
              "version",
              "state",
              "latestMutationOperationReference",
            ]);
            parsePricingReference(head.lifecycleReference);
            parsePricingReference(head.latestMutationOperationReference);
            positive(head.version);
            if (head.state !== (command.action === "Approve" ? "InReview" : "Draft")) throw Error();
          } else if (command.action === "Approve") throw Error();
          if (mode === "resolve")
            call = endpoint.resolve({ sessionCookie, csrf, expectedScope, command });
          else {
            const raw = readClosedRecord(envelope.context, [
              "productReference",
              "expectedProductAggregateVersion",
              "bindingReference",
              "optionReference",
            ]);
            call = endpoint.execute({
              sessionCookie,
              csrf,
              expectedScope,
              command,
              context: {
                productReference: parsePricingReference(raw.productReference),
                expectedProductAggregateVersion: positive(raw.expectedProductAggregateVersion),
                bindingReference: parsePricingReference(raw.bindingReference),
                optionReference: parsePricingReference(raw.optionReference),
              },
            });
          }
        } catch {
          response.status(400).json({ error: "option_price_invalid" });
          return;
        }
        void call
          .then((result) => {
            try {
              const value = readClosedRecord(result, [
                "profile",
                "action",
                "operationReference",
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
                "outcome",
                "occurredAt",
                "observedAt",
                "validUntil",
              ]);
              for (const key of [
                "operationReference",
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
              ])
                parsePricingReference(value[key]);
              const occurred = parseCatalogInstant(value.occurredAt),
                observed = parseCatalogInstant(value.observedAt),
                until = parseCatalogInstant(value.validUntil);
              if (
                value.profile !== "MerchantOptionPriceReviewResultV1" ||
                value.action !== command.action ||
                value.operationReference !== command.operationReference ||
                value.brandReference !== expectedScope.brandReference ||
                value.storeReference !== expectedScope.storeReference ||
                (value.outcome !== "Committed" && value.outcome !== "Abandoned") ||
                occurred > observed ||
                observed >= until ||
                Date.parse(until) - Date.parse(observed) > 5000
              )
                throw Error();
              response.json(result);
            } catch {
              response.status(503).json({ error: "option_price_unavailable" });
            }
          })
          .catch((error: unknown) => {
            const feature = error instanceof MerchantProductWriteFeatureDisabled,
              code = error instanceof OptionPriceAuthoringError ? error.code : null,
              status = feature
                ? 409
                : code === "OPTION_PRICE_INPUT_INVALID"
                  ? 400
                  : code === "OPTION_PRICE_PERMISSION_DENIED"
                    ? 403
                    : code !== null &&
                        [
                          "OPTION_PRICE_VERSION_CONFLICT",
                          "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                          "OPTION_PRICE_LIFECYCLE_CONFLICT",
                          "OPTION_PRICE_APPROVAL_REQUIRED",
                          "OPTION_PRICE_CONFLICT",
                        ].includes(code)
                      ? 409
                      : 503;
            response.status(status).json({
              error: feature
                ? "option_price_feature_disabled"
                : status === 400
                  ? "option_price_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "option_price_conflict"
                      : "option_price_unavailable",
            });
          });
      },
    );
  }

  for (const mode of ["scope", "current", "command", "resolve"] as const) {
    router.post(
      "/pricing/option-prices/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          Object.keys(request.query).length !== 0
        ) {
          denied(response);
          return;
        }
        let expectedScope;
        try {
          const headers = rawHeaderValues(request, "x-bop-catalog-scope");
          if (headers.length !== 1) throw Error();
          expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
        } catch {
          denied(response);
          return;
        }
        const endpoint = options.optionPriceAuthoring;
        if (!endpoint) {
          response.status(503).json({ error: "option_price_unavailable" });
          return;
        }
        let call: Promise<unknown>;
        try {
          const envelope = readClosedRecord(
            request.body,
            mode === "scope"
              ? []
              : mode === "current"
                ? ["context"]
                : mode === "command"
                  ? ["command", "context"]
                  : ["command"],
          );
          if (mode === "scope") {
            if (typeof endpoint.scope !== "function") {
              response.status(503).json({ error: "option_price_unavailable" });
              return;
            }
            call = endpoint.scope({ sessionCookie, csrf, expectedScope });
          } else if (mode === "resolve") {
            const command = parseOptionPriceAuthoringCommand(envelope.command);
            call = endpoint.resolve({ sessionCookie, csrf, expectedScope, command });
          } else {
            const raw = readClosedRecord(
              envelope.context,
              mode === "current"
                ? [
                    "productReference",
                    "expectedProductAggregateVersion",
                    "bindingReference",
                    "optionReference",
                  ]
                : ["productReference", "expectedProductAggregateVersion"],
            );
            if (
              typeof raw.expectedProductAggregateVersion !== "number" ||
              !Number.isSafeInteger(raw.expectedProductAggregateVersion) ||
              raw.expectedProductAggregateVersion < 1 ||
              raw.expectedProductAggregateVersion > 2147483647
            )
              throw Error();
            const context = {
              productReference: parsePricingReference(raw.productReference),
              expectedProductAggregateVersion: raw.expectedProductAggregateVersion,
            };
            call =
              mode === "current"
                ? endpoint.query({
                    sessionCookie,
                    csrf,
                    expectedScope,
                    context: {
                      ...context,
                      bindingReference: parsePricingReference(raw.bindingReference),
                      optionReference: parsePricingReference(raw.optionReference),
                    },
                  })
                : endpoint.execute({
                    sessionCookie,
                    csrf,
                    expectedScope,
                    command: parseOptionPriceAuthoringCommand(envelope.command),
                    context,
                  });
          }
        } catch {
          response.status(400).json({ error: "option_price_invalid" });
          return;
        }
        void call
          .then((result) => {
            try {
              const raw = readClosedRecord(
                  result,
                  mode === "scope"
                    ? [
                        "profile",
                        "tenantReference",
                        "brandReference",
                        "storeReference",
                        "actorReference",
                        "observedAt",
                        "validUntil",
                      ]
                    : mode === "current"
                      ? [
                          "profile",
                          "tenantReference",
                          "brandReference",
                          "storeReference",
                          "actorReference",
                          "context",
                          "states",
                          "observedAt",
                          "validUntil",
                        ]
                      : [
                          "profile",
                          "action",
                          "operationReference",
                          "tenantReference",
                          "brandReference",
                          "storeReference",
                          "actorReference",
                          "outcome",
                          "state",
                          "occurredAt",
                          "observedAt",
                          "validUntil",
                        ],
                ),
                tenant = parsePricingReference(raw.tenantReference),
                brand = parsePricingReference(raw.brandReference),
                store = parsePricingReference(raw.storeReference),
                actor = parsePricingReference(raw.actorReference),
                observedAt = parseCatalogInstant(raw.observedAt),
                validUntil = parseCatalogInstant(raw.validUntil);
              if (
                brand !== expectedScope.brandReference ||
                store !== expectedScope.storeReference ||
                validUntil <= observedAt ||
                Date.parse(validUntil) - Date.parse(observedAt) > 5000
              )
                throw Error();
              if (mode === "scope") {
                if (raw.profile !== "MerchantOptionPriceScopeV1") throw Error();
              } else if (mode === "current") {
                const context = readClosedRecord(raw.context, [
                    "profile",
                    "tenantReference",
                    "brandReference",
                    "storeReference",
                    "actorReference",
                    "productReference",
                    "productAggregateVersion",
                    "productVersionReference",
                    "productSnapshotDigest",
                    "binding",
                    "versionResolution",
                    "optionReference",
                    "optionSetReference",
                    "optionSetVersionReference",
                    "optionSourceDigest",
                    "optionSourceAuthority",
                    "defaultLocale",
                    "localizedNames",
                    "choices",
                    "skus",
                    "currencyMetadata",
                    "referenceEligibility",
                    "publishValidation",
                    "observedAt",
                    "validUntil",
                  ]),
                  binding = parseProductOptionBinding(context.binding),
                  requested = readClosedRecord(
                    readClosedRecord(request.body, ["context"]).context,
                    [
                      "productReference",
                      "expectedProductAggregateVersion",
                      "bindingReference",
                      "optionReference",
                    ],
                  );
                if (
                  raw.profile !== "MerchantOptionPriceAuthoringQueryV1" ||
                  context.profile !== "MerchantOptionPriceContextV1" ||
                  context.tenantReference !== tenant ||
                  context.brandReference !== brand ||
                  context.storeReference !== store ||
                  context.actorReference !== actor ||
                  context.productReference !== requested.productReference ||
                  context.productAggregateVersion !== requested.expectedProductAggregateVersion ||
                  binding.bindingReference !== requested.bindingReference ||
                  context.optionReference !== requested.optionReference ||
                  context.optionSetReference !== binding.optionSetReference ||
                  context.optionSetVersionReference !== binding.optionSetVersionReference ||
                  context.referenceEligibility !== "NotEvaluated" ||
                  context.publishValidation !== "Incomplete" ||
                  !["Pinned", "CurrentPublished"].includes(String(context.versionResolution)) ||
                  context.optionSourceAuthority !==
                    (context.versionResolution === "Pinned"
                      ? "RecordedFrozen"
                      : "CurrentPublishingReleaseAndFrozenContent") ||
                  parseCatalogInstant(context.observedAt) > observedAt ||
                  parseCatalogInstant(context.validUntil) !== validUntil ||
                  !Array.isArray(raw.states) ||
                  raw.states.length > 1000
                )
                  throw Error();
                const seen = new Set<string>();
                const locale = parseCatalogLocale(context.defaultLocale),
                  metadata = readClosedRecord(context.currencyMetadata, [
                    "currencyCode",
                    "minorUnitExponent",
                    "metadataVersion",
                    "metadataVersionReference",
                    "metadataDigest",
                  ]);
                parseLocalizedNames(context.localizedNames, locale);
                parsePricingReference(context.productVersionReference);
                parsePricingDigest(context.productSnapshotDigest);
                parsePricingDigest(context.optionSourceDigest);
                if (
                  typeof metadata.minorUnitExponent !== "number" ||
                  typeof metadata.metadataVersion !== "number" ||
                  !Array.isArray(context.choices) ||
                  !Array.isArray(context.skus)
                )
                  throw Error();
                createCurrencyMetadataSnapshot({
                  currencyCode: parseCurrencyCode(metadata.currencyCode),
                  minorUnitExponent: metadata.minorUnitExponent,
                  metadataVersion: metadata.metadataVersion,
                  metadataVersionReference: parsePricingReference(
                    metadata.metadataVersionReference,
                  ),
                  metadataDigest: parsePricingDigest(metadata.metadataDigest),
                });
                const choices = new Set<string>();
                for (const item of context.choices) {
                  const choice = readClosedRecord(item, [
                      "optionReference",
                      "stableCode",
                      "lifecycle",
                      "localizedNames",
                    ]),
                    reference = parsePricingReference(choice.optionReference);
                  if (
                    choices.has(reference) ||
                    !binding.enabledOptionReferences.some((value) => String(value) === reference) ||
                    typeof choice.stableCode !== "string" ||
                    !["Draft", "Active", "Inactive", "Archived"].includes(String(choice.lifecycle))
                  )
                    throw Error();
                  choices.add(reference);
                  parseLocalizedNames(choice.localizedNames, locale);
                }
                if (
                  choices.size !== binding.enabledOptionReferences.length ||
                  !choices.has(parsePricingReference(context.optionReference))
                )
                  throw Error();
                const skus = new Set<string>();
                for (const item of context.skus) {
                  const sku = readClosedRecord(item, [
                      "skuReference",
                      "skuCode",
                      "lifecycle",
                      "localizedNames",
                    ]),
                    reference = parsePricingReference(sku.skuReference),
                    names = sku.localizedNames;
                  if (
                    skus.has(reference) ||
                    typeof sku.skuCode !== "string" ||
                    !["Draft", "Active", "Suspended", "Discontinued", "Archived"].includes(
                      String(sku.lifecycle),
                    ) ||
                    names === null ||
                    typeof names !== "object" ||
                    Array.isArray(names)
                  )
                    throw Error();
                  skus.add(reference);
                  const skuLocale = Object.keys(names)[0];
                  if (skuLocale === undefined) throw Error();
                  parseLocalizedNames(names, skuLocale);
                }
                for (const value of raw.states) {
                  const state = parseOptionPriceAuthoringState(value);
                  if (
                    state.brandReference !== brand ||
                    String(state.bindingReference) !== String(binding.bindingReference) ||
                    state.optionReference !== context.optionReference ||
                    seen.has(state.ruleReference)
                  )
                    throw Error();
                  seen.add(state.ruleReference);
                  optionPriceWireState(state);
                }
              } else {
                const original = parseOptionPriceAuthoringCommand(
                    readClosedRecord(
                      request.body,
                      mode === "command" ? ["command", "context"] : ["command"],
                    ).command,
                  ),
                  recordedAt = parseCatalogInstant(raw.occurredAt);
                if (
                  raw.profile !== "MerchantOptionPriceAuthoringResultV1" ||
                  raw.action !== original.action ||
                  raw.operationReference !== original.operationReference ||
                  !["Committed", "Abandoned"].includes(String(raw.outcome)) ||
                  (raw.outcome === "Abandoned") !== (raw.state === null) ||
                  recordedAt > observedAt
                )
                  throw Error();
                if (raw.state !== null) {
                  const state = parseOptionPriceAuthoringState(raw.state);
                  if (
                    state.brandReference !== brand ||
                    state.ruleReference !== original.ruleReference ||
                    state.updatedAt !== recordedAt
                  )
                    throw Error();
                  optionPriceWireState(state);
                }
              }
              response.json(result);
            } catch {
              response.status(503).json({ error: "option_price_unavailable" });
            }
          })
          .catch((error: unknown) => {
            const feature = error instanceof MerchantProductWriteFeatureDisabled,
              code = error instanceof OptionPriceAuthoringError ? error.code : null,
              status = feature
                ? 409
                : code === "OPTION_PRICE_INPUT_INVALID"
                  ? 400
                  : code === "OPTION_PRICE_PERMISSION_DENIED"
                    ? 403
                    : code !== null &&
                        [
                          "OPTION_PRICE_VERSION_CONFLICT",
                          "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                          "OPTION_PRICE_LIFECYCLE_CONFLICT",
                          "OPTION_PRICE_APPROVAL_REQUIRED",
                          "OPTION_PRICE_CONFLICT",
                        ].includes(code)
                      ? 409
                      : 503;
            response.status(status).json({
              error: feature
                ? "option_price_feature_disabled"
                : status === 400
                  ? "option_price_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "option_price_conflict"
                      : "option_price_unavailable",
            });
          });
      },
    );
  }

  router.post(
    "/catalog/products/option-binding-picker",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productOptionPicker) {
        response.status(503).json({ error: "product_option_picker_unavailable" });
        return;
      }
      void options
        .productOptionPicker({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const feature = error instanceof MerchantProductWriteFeatureDisabled;
          const code =
            error instanceof CatalogError ? error.code : "CATALOG_DEPENDENCY_UNAVAILABLE";
          const status =
            feature || code === "CATALOG_VERSION_CONFLICT"
              ? 409
              : code === "CATALOG_INPUT_INVALID"
                ? 400
                : code === "CATALOG_PERMISSION_DENIED"
                  ? 403
                  : 503;
          response.status(status).json({
            error: feature
              ? "product_option_picker_feature_disabled"
              : status === 409
                ? "product_option_picker_conflict"
                : status === 400
                  ? "product_option_picker_invalid"
                  : status === 403
                    ? "request_denied"
                    : "product_option_picker_unavailable",
          });
        });
    },
  );

  for (const mode of [
    "create",
    "draft",
    "current-editor",
    "current-published",
    "history",
    "authoring/resolve",
    "authoring/context",
    "publication/context",
    "publication/command",
    "publication/resolve",
  ] as const) {
    const endpoint =
      mode === "create"
        ? options.optionSetAuthoring?.create.bind(options.optionSetAuthoring)
        : mode === "draft"
          ? options.optionSetAuthoring?.edit.bind(options.optionSetAuthoring)
          : mode === "current-editor"
            ? options.optionSetEditor
            : mode === "current-published"
              ? options.optionSetCurrentPublication
              : mode === "history"
                ? options.optionSetHistory
                : mode === "authoring/resolve"
                  ? options.optionSetAuthoringResolution
                  : mode === "publication/context"
                    ? options.optionSetPublicationContext
                    : mode === "publication/command"
                      ? options.optionSetPublicationCommand
                      : mode === "publication/resolve"
                        ? options.optionSetPublicationResolution
                        : options.optionSetAuthoringContext;
    const errorPrefix =
      mode === "current-published"
        ? "option_set_current_publication"
        : mode === "history"
          ? "option_set_history"
          : mode === "publication/context"
            ? "option_set_publication_context"
            : mode === "publication/command" || mode === "publication/resolve"
              ? "option_set_publication"
              : "option_set_authoring";
    router.post(
      "/catalog/option-sets/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          Object.keys(request.query).length !== 0
        ) {
          denied(response);
          return;
        }
        let expectedScope;
        try {
          const headers = rawHeaderValues(request, "x-bop-catalog-scope");
          if (headers.length !== 1) throw Error();
          expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
        } catch {
          denied(response);
          return;
        }
        if (!endpoint) {
          response.status(503).json({ error: errorPrefix + "_unavailable" });
          return;
        }
        void endpoint({ sessionCookie, csrf, command: request.body, expectedScope })
          .then((result) => {
            if (mode !== "publication/command" && mode !== "publication/resolve")
              return response.json(result);
            const value = readClosedRecord(
              result,
              Object.hasOwn(result, "outcome")
                ? ["profile", "storeReference", "outcome", "validation"]
                : ["profile", "storeReference", "resolution"],
            );
            const storeReference = parseCatalogReference(value.storeReference);
            if (
              storeReference !== expectedScope.storeReference ||
              value.profile !==
                (mode === "publication/command"
                  ? "CatalogOptionSetPublicationCommandResultV1"
                  : "CatalogOptionSetPublicationResolutionResultV1")
            )
              throw Error();
            if (value.outcome === "Validated") {
              if (mode !== "publication/command" || request.body?.action !== "Validate")
                throw Error();
              const validation = readClosedRecord(value.validation, [
                "checks",
                "findings",
                "decision",
                "observedAt",
                "qualifiedActivationAt",
                "independentApproval",
                "saleEligibility",
              ]);
              if (
                !Array.isArray(validation.checks) ||
                !Array.isArray(validation.findings) ||
                !["Pass", "HardError", "Indeterminate"].includes(String(validation.decision)) ||
                validation.independentApproval !== "NotEvaluated" ||
                validation.saleEligibility !== "NotEvaluated"
              )
                throw Error();
              parseCatalogInstant(validation.observedAt);
              parseCatalogInstant(validation.qualifiedActivationAt);
              return response.json({
                profile: value.profile,
                storeReference,
                outcome: "Validated",
                validation,
              });
            }
            const original = readClosedRecord(
              value.resolution,
              (value.resolution as { outcome?: unknown })?.outcome === "Committed"
                ? ["outcome", "command", "originalOccurredAt", "auditReference", "mutation"]
                : ["outcome", "command", "recordedAt", "auditReference"],
            );
            const command = parsePublishingOptionSetPublicationOperation(original.command);
            if (
              command.brandReference !== expectedScope.brandReference ||
              String(command.selectedStoreReference) !== String(storeReference) ||
              command.operationReference !== request.body?.operationReference ||
              command.action !== request.body?.action
            )
              throw Error();
            const recordedAt = parseCatalogInstant(
              original.outcome === "Committed" ? original.originalOccurredAt : original.recordedAt,
            );
            if (original.outcome === "Committed") {
              const mutation = parseRecordedPublishingMutation(original.mutation);
              if (
                mutation.operation !== command.action ||
                mutation.idempotencyKey !== command.operationReference ||
                mutation.audit.auditId !== original.auditReference ||
                mutation.audit.occurredAt !== recordedAt
              )
                throw Error();
            } else if (original.outcome !== "Abandoned") throw Error();
            return response.json({
              profile: "CatalogOptionSetPublicationReceiptV1",
              storeReference,
              operationReference: command.operationReference,
              action: command.action,
              outcome: original.outcome,
              recordedAt,
            });
          })
          .catch((error: unknown) => {
            const status =
              error instanceof MerchantProductWriteFeatureDisabled
                ? 409
                : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                  ? 400
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : error instanceof CatalogError &&
                        [
                          "CATALOG_VERSION_CONFLICT",
                          "CATALOG_IDEMPOTENCY_CONFLICT",
                          "CATALOG_LIFECYCLE_CONFLICT",
                          "CATALOG_CODE_CONFLICT",
                        ].includes(error.code)
                      ? 409
                      : 503;
            response.status(status).json({
              error:
                error instanceof MerchantProductWriteFeatureDisabled && mode === "current-published"
                  ? "option_set_current_publication_feature_disabled"
                  : error instanceof MerchantProductWriteFeatureDisabled && mode === "history"
                    ? "option_set_history_feature_disabled"
                    : error instanceof MerchantProductWriteFeatureDisabled &&
                        (mode === "publication/context" ||
                          mode === "publication/command" ||
                          mode === "publication/resolve")
                      ? "option_set_publication_feature_disabled"
                      : status === 400
                        ? errorPrefix + "_invalid"
                        : status === 403
                          ? "request_denied"
                          : status === 409
                            ? errorPrefix + "_conflict"
                            : errorPrefix + "_unavailable",
            });
          });
      },
    );
  }

  for (const mode of ["context", "resolve", "inspect", "register"] as const)
    router.post(
      "/catalog/products/selling-units/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          Object.keys(request.query).length !== 0
        ) {
          denied(response);
          return;
        }
        let expectedScope;
        try {
          const values = rawHeaderValues(request, "x-bop-catalog-scope");
          if (values.length !== 1) throw Error();
          expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
        } catch {
          denied(response);
          return;
        }
        if (!options.productSellingUnitRegistry) {
          response.status(503).json({ error: "product_selling_unit_registry_unavailable" });
          return;
        }
        void options.productSellingUnitRegistry[mode]({
          sessionCookie,
          csrf,
          command: request.body,
          expectedScope,
        })
          .then((result) => response.json(result))
          .catch((error: unknown) => {
            const status =
              error instanceof MerchantProductWriteFeatureDisabled
                ? 409
                : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                  ? 400
                  : error instanceof CatalogError &&
                      [
                        "CATALOG_VERSION_CONFLICT",
                        "CATALOG_IDEMPOTENCY_CONFLICT",
                        "CATALOG_LIFECYCLE_CONFLICT",
                      ].includes(error.code)
                    ? 409
                    : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                      ? 403
                      : 503;
            response.status(status).json({
              error:
                status === 400
                  ? "product_selling_unit_registry_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "product_selling_unit_registry_conflict"
                      : "product_selling_unit_registry_unavailable",
            });
          });
      },
    );

  router.post(
    "/catalog/products/authoring-context",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const values = rawHeaderValues(request, "x-bop-catalog-scope");
        if (values.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productAuthoringContext) {
        response.status(503).json({ error: "product_authoring_context_unavailable" });
        return;
      }
      void options
        .productAuthoringContext({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          const status =
            error instanceof MerchantProductWriteFeatureDisabled
              ? 409
              : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                ? 400
                : error instanceof CatalogError &&
                    [
                      "CATALOG_VERSION_CONFLICT",
                      "CATALOG_IDEMPOTENCY_CONFLICT",
                      "CATALOG_LIFECYCLE_CONFLICT",
                    ].includes(error.code)
                  ? 409
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_authoring_context_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_authoring_context_conflict"
                    : "product_authoring_context_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/warning-acknowledgements/v1",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const values = rawHeaderValues(request, "x-bop-catalog-scope");
        if (values.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationWarningAcknowledgement) {
        response
          .status(503)
          .json({ error: "product_publication_warning_acknowledgement_unavailable" });
        return;
      }
      void options
        .productPublicationWarningAcknowledgement({
          sessionCookie,
          csrf,
          command: request.body,
          expectedScope,
        })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          const status =
            error instanceof MerchantProductWriteFeatureDisabled
              ? 409
              : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                ? 400
                : error instanceof CatalogError &&
                    [
                      "CATALOG_VERSION_CONFLICT",
                      "CATALOG_IDEMPOTENCY_CONFLICT",
                      "CATALOG_LIFECYCLE_CONFLICT",
                    ].includes(error.code)
                  ? 409
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_warning_acknowledgement_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_publication_warning_acknowledgement_conflict"
                    : "product_publication_warning_acknowledgement_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/v2",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationV2) {
        response.status(503).json({ error: "product_publication_unavailable" });
        return;
      }
      void options
        .productPublicationV2({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (error instanceof MerchantProductWriteFeatureDisabled) {
            response.status(409).json({ error: "product_publication_feature_disabled" });
            return;
          }
          if (!(error instanceof CatalogError)) {
            denied(response);
            return;
          }
          const status =
            error.code === "CATALOG_INPUT_INVALID"
              ? 400
              : [
                    "CATALOG_VERSION_CONFLICT",
                    "CATALOG_IDEMPOTENCY_CONFLICT",
                    "CATALOG_LIFECYCLE_CONFLICT",
                  ].includes(error.code)
                ? 409
                : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
          response.status(status).json({
            error:
              status === 400
                ? "product_publication_invalid"
                : status === 409
                  ? "product_publication_conflict"
                  : status === 503
                    ? "product_publication_unavailable"
                    : "request_denied",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/scope-journals",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productScopeJournals) {
        response.status(503).json({ error: "product_scope_journals_unavailable" });
        return;
      }
      void options
        .productScopeJournals({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const status =
            error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
              ? 400
              : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                ? 403
                : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_scope_journals_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_scope_journals_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productPublicationQuery) {
        response.status(503).json({ error: "product_publication_unavailable" });
        return;
      }
      void options
        .productPublicationQuery({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch(() => {
          response.status(503).json({ error: "product_publication_unavailable" });
        });
    },
  );

  router.post("/catalog/products/publication", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productPublication) {
      response.status(503).json({ error: "product_publication_unavailable" });
      return;
    }
    void options
      .productPublication({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_publication_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_publication_invalid"
              : status === 409
                ? "product_publication_conflict"
                : status === 503
                  ? "product_publication_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/pricing/price-books", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.priceBooks) {
      response.status(503).json({ error: "price_book_unavailable" });
      return;
    }
    void options
      .priceBooks({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PriceBookWorkflowError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "PRICE_BOOK_INPUT_INVALID"
            ? 400
            : [
                  "PRICE_BOOK_VERSION_CONFLICT",
                  "PRICE_BOOK_IDEMPOTENCY_CONFLICT",
                  "PRICE_BOOK_CODE_CONFLICT",
                  "PRICE_BOOK_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "PRICE_BOOK_COVERAGE_INVALID"
                ? 422
                : error.code === "PRICE_BOOK_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
        response.status(status).json({
          error:
            status === 403
              ? "request_denied"
              : status === 400
                ? "price_book_invalid"
                : status === 409
                  ? "price_book_conflict"
                  : status === 422
                    ? "price_book_coverage_invalid"
                    : "price_book_unavailable",
        });
      });
  });

  router.post("/dining/closing", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningClosing) {
      response.status(503).json({ error: "dining_closing_unavailable" });
      return;
    }
    void options
      .diningClosing({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Applied", "AlreadyApplied"].includes(result.status) ||
          !["Closing", "Closed"].includes(result.phase) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          phase: result.phase,
          sessionVersion: result.sessionVersion,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/orders/close", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderClosure) {
      response.status(503).json({ error: "order_closure_unavailable" });
      return;
    }
    void options
      .orderClosure({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Committed", "AlreadyCommitted"].includes(result.status) ||
          !Number.isSafeInteger(result.closedOrderVersion) ||
          result.closedOrderVersion < 1 ||
          !Number.isSafeInteger(result.closureVersion) ||
          result.closureVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          closedOrderVersion: result.closedOrderVersion,
          closureVersion: result.closureVersion,
        });
      })
      .catch(() => denied(response));
  });

  router.post("/orders/accept", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.orderAcceptance) {
      response.status(503).json({ error: "order_acceptance_unavailable" });
      return;
    }
    void options
      .orderAcceptance({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          acceptedOrderVersion: result.acceptedOrderVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/service-control", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
      denied(response);
      return;
    }
    if (!options.serviceControl) {
      response.status(503).json({ error: "service_control_unavailable" });
      return;
    }
    void options
      .serviceControl({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({ status: result.status, resultingVersion: result.resultingVersion }),
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          ["STORE_SERVICE_VERSION_CONFLICT", "STORE_SERVICE_IDEMPOTENCY_CONFLICT"].includes(
            error.message,
          )
        )
          response.status(409).json({ error: "service_control_conflict" });
        else denied(response);
      });
  });

  router.post("/store-configuration", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
      denied(response);
      return;
    }
    if (!options.storeConfiguration) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfiguration({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({ status: result.status, resultingVersion: result.resultingVersion }),
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          [
            "STORE_CONFIGURATION_VERSION_CONFLICT",
            "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT",
          ].includes(Object.getOwnPropertyDescriptor(error, "code")?.value)
        )
          response.status(409).json({ error: "store_configuration_conflict" });
        else denied(response);
      });
  });

  router.post("/store-context", sameOriginMutation(options), (request, response) => {
    let target: unknown;
    try {
      target = targetStoreReference(request.body);
    } catch {
      denied(response);
      return;
    }
    void options.service
      .switchStore({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
        targetStoreReference: target,
      })
      .then(async (result) => {
        response
          .set("Set-Cookie", serializeCookie(result.cookie))
          .json({ workspace: await currentTaxNavigation(result.workspace, result.cookie.value) });
      })
      .catch(() => denied(response));
  });

  router.post("/protected", sameOriginMutation(options), (request, response) => {
    void options.service
      .authorize({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
      })
      .then(() => {
        response.json({ authorized: true });
      })
      .catch(() => denied(response));
  });

  router.post("/logout", sameOriginMutation(options), (request, response) => {
    void options.service
      .logout(cookie(request, "__Host-bop-merchant"))
      .then((mutation) => {
        response.set("Set-Cookie", serializeCookie(mutation)).status(204).end();
      })
      .catch(() => denied(response));
  });

  return router;
}
