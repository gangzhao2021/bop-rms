/** Merchant BFF public contract: the workspace snapshot, navigation, Session service and router options. */
import type { createMerchantStoreOpening } from "./merchant-store-opening.js";
import type {
  createMerchantDiningStaffCallAnswer,
  createMerchantDiningStaffCallCount,
} from "./merchant-dining-staff-calls.js";
import type {
  createMerchantDiningPaymentTimingChange,
  createMerchantDiningPaymentTimingRead,
} from "./merchant-dining-payment-timing.js";
import type { createMerchantDiningUnpaidDeparture } from "./merchant-dining-unpaid-departure.js";
import type { createMerchantDiningUnpaidItemRemoval } from "./merchant-dining-unpaid-item-removal.js";
import type { createMerchantDiningItemComp } from "./merchant-dining-item-comp.js";
import type {
  createMerchantDiningTableCashRefund,
  createMerchantDiningTablePaymentRead,
} from "./merchant-dining-table-payment.js";
import type {
  createMerchantDiningTableBillRead,
  createMerchantDiningTableSettle,
  createMerchantDiningTableSplit,
} from "./merchant-dining-table-checkout.js";
import type { createMerchantDiningTableOnlinePaymentStop } from "./merchant-dining-table-online-payment.js";
import type {
  AuthenticationSession,
  BrowserCookieMutation,
  RawBrowserCredential,
} from "@bop/identity";
import type {
  StoreConfigurationOrdinaryCommand,
  StoreConfigurationOrdinaryResolve,
  StoreConfigurationOriginalScope,
} from "@rms/store";
import type { createMerchantBrandStoreTopologyDraft } from "./merchant-brand-store-topology-draft.js";
import type { createMerchantTaxConfigAuthoring } from "./merchant-tax-config-authoring.js";
import type { createMerchantStoreSetup } from "./merchant-store-setup.js";
import type { createMerchantReceiptTemplateArtifacts } from "./merchant-receipt-template-artifacts.js";
import type { createMerchantReceiptTemplateDraft } from "./merchant-receipt-template-draft.js";
import type { createMerchantReceiptTemplateLifecycle } from "./merchant-receipt-template-lifecycle.js";
import type { createMerchantReceiptTemplateSubmit } from "./merchant-receipt-template-submit.js";
import type { createMerchantReceiptTemplatePublished } from "./merchant-receipt-template-published.js";
import type { createMerchantReceiptTemplateReview } from "./merchant-receipt-template-review.js";
import type { createMerchantStorePaymentConfiguration } from "./merchant-store-payment-configuration.js";
import type { createMerchantStoreSetupReferences } from "./merchant-store-setup-references.js";
import type { createMerchantOptionPriceAuthoringCommand } from "./merchant-option-price-authoring-command.js";
import type { createMerchantOptionPriceReviewCommand } from "./merchant-option-price-review-command.js";
import type { createMerchantProductOptionPickerQuery } from "./merchant-product-option-picker-query.js";
import type { createMerchantOptionSetPublicationCommand } from "./merchant-option-set-publication-command.js";
import type { createMerchantOptionSetPublicationResolutionCommand } from "./merchant-option-set-publication-resolution-command.js";
import type { createMerchantOptionSetListQuery } from "./merchant-option-set-list-query.js";
import type { createMerchantOptionSetPublicationContextQuery } from "./merchant-option-set-publication-context-query.js";
import type { createMerchantOptionSetAuthoringCommand } from "./merchant-option-set-authoring-command.js";
import type { createMerchantOptionSetHistoryQuery } from "./merchant-option-set-history-query.js";
import type { createMerchantOptionSetCurrentPublicationQuery } from "./merchant-option-set-current-publication-query.js";
import type { createMerchantOptionSetEditorQuery } from "./merchant-option-set-editor-query.js";
import type { createMerchantOptionSetAuthoringContextQuery } from "./merchant-option-set-authoring-context-query.js";
import type { createMerchantOptionSetAuthoringResolutionCommand } from "./merchant-option-set-authoring-resolution-command.js";
import type { createMerchantProductSellingUnitRegistry } from "./merchant-product-selling-unit-registry.js";
import type { createMerchantProductAuthoringContextQuery } from "./merchant-product-authoring-context-query.js";
import type { createMerchantProductAuthoringResolutionCommand } from "./merchant-product-authoring-resolution-command.js";
import type { createMerchantProductPublicationResolutionCommand } from "./merchant-product-publication-resolution-command.js";
import type { createMerchantProductDraftBaselineQuery } from "./merchant-product-draft-baseline-query.js";
import type { createMerchantProductCategoryLookupQuery } from "./merchant-product-category-lookup-query.js";
import type { createMerchantCategoryTreeQuery } from "./merchant-category-tree-query.js";
import type { createMerchantProductListQuery } from "./merchant-product-list-query.js";
import type { createMerchantReconciliationAssigneeQuery } from "./merchant-reconciliation-assignee-query.js";
import type { createMerchantReconciliationEvidenceQuery } from "./merchant-reconciliation-evidence-query.js";
import type { createMerchantReconciliationFollowUpQuery } from "./merchant-reconciliation-follow-up-query.js";
import type { createMerchantReconciliationFollowUpCommand } from "./merchant-reconciliation-follow-up-command.js";
import type { createMerchantCompensationReconciliationQuery } from "./merchant-compensation-reconciliation-query.js";
import type { createMerchantCompensationReconciliationCommand } from "./merchant-compensation-reconciliation-command.js";
import type { createMerchantRefundPaymentContext } from "./merchant-refund-payment-context.js";
import type { createMerchantOrdinaryRefundRequest } from "./merchant-ordinary-refund-request.js";
import type { createMerchantOrdinaryRefundStatus } from "./merchant-ordinary-refund-status.js";
import type { createMerchantOrdinaryRefundItems } from "./merchant-ordinary-refund-items.js";
import type { createMerchantTaskInboxRead } from "./merchant-task-inbox-read.js";
import type { createMerchantPickupQuery } from "./merchant-pickup-query.js";
import type { createMerchantPickupProof } from "./merchant-pickup-proof.js";
import type { createMerchantPickupHandoff } from "./merchant-pickup-handoff.js";
import type { createMerchantPickupNotCollected } from "./merchant-pickup-not-collected.js";
import type { createMerchantPickupIdentityCheck } from "./merchant-pickup-identity-check.js";
import type {
  createMerchantOrderStaffCancellation,
  createMerchantOrderStaffCancellationPreview,
} from "./merchant-order-staff-cancellation.js";
import type { createMerchantUnpaidRoundCancellation } from "./merchant-unpaid-round-cancellation.js";
import type { createMerchantEndedOrderStockRelease } from "./merchant-stock-holding-orders.js";
import type { createMerchantOrderAcceptanceHoldRefund } from "./merchant-order-acceptance-hold-refund.js";
import type { createMerchantOrderItemStaffCancellation } from "./merchant-order-item-staff-cancellation.js";
import type { createMerchantCounterMenu } from "./merchant-counter-menu.js";
import type { createMerchantCounterOrder } from "./merchant-counter-order.js";
import type { createMerchantStaffDiningRound } from "./merchant-staff-dining-round.js";
import type {
  CardMachinePaymentAcceptance,
  createMerchantCardMachinePayment,
} from "./merchant-card-machine-payment.js";
import type { createMerchantCardMachineCancellationRefund } from "./merchant-card-machine-refund.js";
import type { createMerchantCardMachineOrdinaryRefund } from "./merchant-card-machine-ordinary-refund.js";
import type { createMerchantUnmatchedCaptureRefund } from "./merchant-unmatched-capture-refund.js";
import type { createMerchantMfaStepUp } from "./merchant-mfa-step-up.js";
import type { createMerchantProviderStepUp } from "./merchant-provider-step-up.js";
import type { createMerchantOrdinaryRefundApproval } from "./merchant-ordinary-refund-approval.js";
import type { createMerchantOrdinaryRefundDecline } from "./merchant-ordinary-refund-decline.js";
import type { createMerchantOrdinaryRefundProgress } from "./merchant-ordinary-refund-progress.js";
import type { createMerchantOrdinaryRefundApprovals } from "./merchant-ordinary-refund-approvals.js";
import type { createMerchantSoleOperator } from "./merchant-sole-operator-setting.js";
import type { createMerchantStoreReceiptProfile } from "./merchant-store-receipt-profile.js";
import type { createMerchantStorePublicProfile } from "./merchant-store-public-profile.js";
import type { createMerchantKitchenQuery } from "./merchant-kitchen-query.js";
import type { createMerchantKitchenCommand } from "./merchant-kitchen-command.js";
import type { createMerchantKitchenRelease } from "./merchant-kitchen-release.js";
import type { createMerchantKitchenRework } from "./merchant-kitchen-rework.js";
import type { createMerchantKitchenStaleClose } from "./merchant-kitchen-stale-close.js";
import type { createMerchantRoleAdministration } from "./merchant-role-administration.js";
import type { createMerchantStaffAdministration } from "./merchant-staff-administration.js";
import type { createMerchantInventoryItems } from "./merchant-inventory-items.js";
import type { createMerchantStockPlaces } from "./merchant-stock-places.js";
import type { createMerchantOpeningCount } from "./merchant-opening-count.js";
import type { createMerchantStoreReceipts } from "./merchant-store-receipts.js";
import type { createMerchantRecipes } from "./merchant-recipes.js";
import type { createMerchantDishAllergens } from "./merchant-dish-allergens.js";
import type { createMerchantCombos } from "./merchant-combos.js";
import type { createMerchantComboPartCommands } from "./merchant-combo-part-commands.js";
import type { createMerchantOneStoreDishes } from "./merchant-one-store-dishes.js";
import type { createMerchantProducts } from "./merchant-products.js";
import type { createMerchantPrices } from "./merchant-prices.js";
import type { createMerchantAllergens } from "./merchant-allergens.js";
import type { createMerchantMenus } from "./merchant-menus.js";
import type { createMerchantAvailability } from "./merchant-availability.js";
import type { createMerchantOptionSets } from "./merchant-option-sets.js";
import type { createMerchantOptionPrices } from "./merchant-option-prices.js";
import type { createMerchantOptionRecipes } from "./merchant-option-recipes.js";
import type { createMerchantStoreTax } from "./merchant-store-tax.js";
import type { createMerchantTaxClassifications } from "./merchant-tax-classifications.js";
import type { createMerchantStockCounts } from "./merchant-stock-counts.js";
import type { createMerchantStoreWaste } from "./merchant-store-waste.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
import type { createMerchantOrdinaryRefundSendCommand } from "./merchant-ordinary-refund-send-command.js";
import type { createMerchantOrdinaryRefundReconciliationCommand } from "./merchant-ordinary-refund-reconciliation-command.js";
import type { createPersistentMerchantOrderQueue } from "./persistent-merchant-order-queue.js";
import type { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import type { createMerchantMenuDraftQuery } from "./merchant-menu-draft-query.js";
import type { createBrandLifecycleCommand } from "./brand-lifecycle-command.js";
import type { createMerchantProductDraftCommand } from "./merchant-product-draft-command.js";
import type { createMerchantProductCreationCommand } from "./merchant-product-creation-command.js";
import type { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
import type { createMerchantStoreCapability } from "./merchant-store-capability.js";
import type { createMerchantProductEditorQuery } from "./merchant-product-editor-query.js";
import type { createMerchantProductPublicationManagementQuery } from "./merchant-product-publication-management-query.js";
import type { createMerchantProductPublicationManagementQueryV2 } from "./merchant-product-publication-management-query-v2.js";
import type { createMerchantProductPublicationWarningAcknowledgementCommand } from "./merchant-product-publication-warning-acknowledgement-command.js";
import type { createMerchantProductPublicationValidationReportQueryV2 } from "./merchant-product-publication-validation-report-query-v2.js";
import type { createMerchantProductPublicationCommandV2 } from "./merchant-product-publication-command-v2.js";
import type { createMerchantProductScopeJournalQuery } from "./merchant-product-scope-journal-query.js";
import type { createMerchantProductPublicationQuery } from "./merchant-product-publication-query.js";
import type { createMerchantProductPublicationCommand } from "./merchant-product-publication-command.js";
import type { createMerchantPriceBookHttpCommand } from "./merchant-price-book-http-command.js";
import type { createMerchantDiningJoinState } from "./merchant-dining-join-state.js";
import type { createMerchantDiningQrJoin } from "./merchant-dining-qr-join.js";
import type {
  createMerchantDiningHeldRound,
  createMerchantDiningRoundHoldSetting,
} from "./merchant-dining-held-round.js";
import type { createMerchantDiningJoinRegenerate } from "./merchant-dining-join-regenerate.js";
import type { createMerchantStoreFeatures } from "./merchant-store-features.js";
import type { createMerchantDiningChase } from "./merchant-dining-chase.js";
import type { createMerchantDiningPartySize } from "./merchant-dining-party-size.js";
import type { createMerchantKitchenNotPrepared } from "./merchant-kitchen-not-prepared.js";
import type { createMerchantKitchenSections } from "./merchant-kitchen-sections.js";
import type { createMerchantDiningTeaCharge } from "./merchant-dining-tea-charge.js";
import type { createMerchantDiningHostSelection } from "./merchant-dining-host-selection.js";
import type { createMerchantDiningHostTransfer } from "./merchant-dining-host-transfer.js";
import type { createMerchantDiningSessionStart } from "./merchant-dining-session-start.js";
import type { createMerchantDiningClosingCommand } from "./merchant-dining-closing-command.js";
import type { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
import type { createMerchantOrderAcceptanceCommand } from "./merchant-order-acceptance-command.js";
import type { createMerchantDiningServeCommand } from "./merchant-dining-serve-command.js";
import type { createMerchantDiningServeReadyCommand } from "./merchant-dining-serve-ready-command.js";
import type { createMerchantDiningTables } from "./merchant-dining-tables.js";
import type { createMerchantDiningTableCommand } from "./merchant-dining-table-command.js";
import type { createMerchantDiningTableMove } from "./merchant-dining-table-move.js";
import type { createMerchantDiningTableMerge } from "./merchant-dining-table-merge.js";
import type { createMerchantDiningTableQr } from "./merchant-dining-table-qr.js";
import type { createMerchantDiningOrderProgress } from "./merchant-dining-order-progress.js";
import type { createMerchantDiningTableClosePlan } from "./merchant-dining-table-close-plan.js";
import type { createMerchantDiningItemService } from "./merchant-dining-item-service.js";
import type { createMerchantServiceControl } from "./merchant-service-control.js";
import type { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type {
  createMerchantStoreHoursSetupDraft,
  createMerchantStoreHoursSetupRestore,
} from "./merchant-store-hours-setup-draft.js";
import { createMerchantStoreConfigurationWithdrawal } from "./merchant-store-configuration-withdrawal.js";
import type { createMerchantOrderExceptionRead } from "./merchant-order-exception-read.js";
import type { createMerchantSettlementRead } from "./merchant-settlement-read.js";
import type { createPersistentMerchantOperationsAlerts } from "./merchant-operations-alerts.js";
import type { createPersistentMerchantStoreReports } from "./persistent-merchant-store-reports.js";
import type { createMerchantStaffPin } from "./merchant-staff-pin.js";

export interface MerchantWorkspaceSnapshot {
  readonly screenId: "HOME-OVERVIEW";
  readonly selectedScope: {
    readonly brandLabel: string;
    readonly storeLabel: string;
    readonly storeReference: string;
    /** WP-2423: the Store's IANA time zone, for store-local times and the Business Date. */
    readonly timeZone?: string;
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

export const merchantNavigation = Object.freeze({
  "HOME-OVERVIEW": ["/app", "merchant.access"],
  "TASK-INBOX": ["/app/tasks", "workflow.operate"],
  // WP-2423 Q5: refunds awaiting an Owner/Finance approval (Section 88 APPROVAL-INBOX).
  "APPROVAL-INBOX": ["/app/approvals", "workflow.operate"],
  "ORG-STORE-LIST": ["/app/organization/stores", "organization.store.read"],
  "CAT-PRODUCT-LIST": ["/app/commerce/products", "catalog.manage"],
  "CAT-OPTIONSET-LIST": ["/app/commerce/option-sets", "catalog.option_set.read"],
  "CAT-MENU-LIST": ["/app/commerce/menus", "catalog.menu.read"],
  "CAT-AVAILABILITY": ["/app/commerce/availability", "catalog.sku.read"],
  "TAX-CONFIG": ["/app/commerce/tax", "pricing.tax-config.manage"],
  "OPS-ORDER-QUEUE": ["/operations/orders", "ordering.operate"],
  // WP-2423 Q7: staff take a pickup order at the counter (Section 88 OPS-ORDER-ENTRY).
  "OPS-ORDER-ENTRY": ["/operations/order-entry", "ordering.order.create_staff"],
  "OPS-ORDER-EXCEPTION": ["/operations/order-exceptions", "operations.order-exception.manage"],
  // WP-2423 P1: day-end settlement (Section 88 PAY-RECONCILIATION) under its own read permission
  // (catalog v17, Owner "单独加权限（推荐）"), apart from exception handling.
  "PAY-RECONCILIATION": ["/app/operations/payment-reconciliation", "payment.settlement.read"],
  // WP-2423 Q14: sales, item, hourly and tip reports with CSV export (Section 88 RPT-OPS-DASHBOARD).
  "RPT-OPS-DASHBOARD": ["/app/reports/operations", "reporting.sales.read"],
  "KIT-KITCHEN-QUEUE": ["/operations/kitchen", "kitchen.operate"],
  "FUL-PICKUP-QUEUE": ["/operations/pickup", "fulfillment.operate"],
  // WP-2423 Q8: the dining tables board (Section 88 DIN-FLOOR-BOARD).
  "DIN-FLOOR-BOARD": ["/operations/dining", "dining.operate"],
  // WP-2423 Q11: print, replace and turn off table QR codes (Section 88 DIN-TABLE-LIST).
  "DIN-TABLE-LIST": ["/app/operations/tables", "dining.table.qr.manage"],
  "DEV-KDS-PROFILE": ["/app/integrations/kds-profiles", "integration.manage"],
  "IAM-ROLE-LIST": ["/app/organization/roles", "identity.role.read"],
  "IAM-USER-LIST": ["/app/organization/users", "organization.staff.read"],
  // WP-2423 Q18 option A: shared tablets and staff PINs (Section 88 IAM-SESSION-LIST).
  "IAM-SESSION-LIST": ["/app/organization/sessions", "identity.store_device.manage"],
  "INV-ITEM-LIST": ["/app/supply/items", "inventory.item.read"],
  "INV-LOCATION-LIST": ["/app/supply/locations", "inventory.location.read"],
  "INV-OPENING-COUNT": ["/app/supply/opening-count", "inventory.count.read"],
  "INV-RECEIPT-LIST": ["/operations/receiving", "inventory.receipt.read"],
  "RECIPE-LIST": ["/app/commerce/recipes", "recipe.read"],
  "PRICE-BOOK-LIST": ["/app/commerce/pricing", "pricing.price_book.read"],
  "PRICE-OPTION-LIST": ["/app/commerce/option-prices", "pricing.price_book.read"],
  "RECIPE-OPTION-LIST": ["/app/commerce/option-recipes", "recipe.read"],
  "TAX-STORE-REVIEW": ["/app/commerce/tax-review", "pricing.tax_config.read"],
  // WP-2423 Store setup: the Brand Owner adds, renames and retires the Brand's tax classifications.
  "CAT-TAX-CLASSIFICATION-LIST": [
    "/app/commerce/tax-classifications",
    "catalog.tax-classification.manage",
  ],
  "CMP-ALLERGEN-REVIEW": ["/app/compliance/allergens", "catalog.allergen.read"],
  "INV-COUNT-LIST": ["/operations/inventory/counts", "inventory.count.read"],
  "INV-WASTE-RECORD": ["/operations/inventory/waste", "inventory.waste.record"],
} as const);

/**
 * WP-2423 Q17: further actions that also admit a navigation entry. Kitchen and Front of House reach
 * Item availability with the today-only sold-out mark, without reading the Brand catalog.
 */
const navigationAlternatives: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "CAT-AVAILABILITY": Object.freeze(["catalog.sku.sold_out.mark"]),
  // WP-2423 Q18 option A: a manager who only resets staff PINs reaches the same page.
  "IAM-SESSION-LIST": Object.freeze(["identity.staff_pin.reset"]),
  // v15 finding: the Store Manager reads Store setup (screen registry STORE-SETUP: Owner / Store
  // Manager, restricted steps permission-trimmed); only the Owner changes it.
  "STORE-SETUP": Object.freeze(["organization.store.read"]),
});

/** Actions any one of which admits a navigation entry: its own permission first. */
export function merchantNavigationActions(item: {
  readonly screenId: string;
  readonly permission: string;
}): readonly string[] {
  return [item.permission, ...(navigationAlternatives[item.screenId] ?? [])];
}

export interface MerchantNavigationItem {
  readonly screenId:
    | keyof typeof merchantNavigation
    | "STORE-SETUP"
    | "STORE-CAPABILITY"
    | "STORE-HOURS-SERVICE"
    | "ORG-BRAND-DETAIL";
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
  /**
   * WP-2423 Q18: genuine staff activity slides the Session's idle deadline (bounded writes, never
   * past the absolute deadline); `extend: false` only reads the deadlines. Throws
   * `BROWSER_SESSION_ENDED` only for a genuinely ended Session and `BROWSER_SESSION_UNAVAILABLE`
   * when it cannot be checked now. Absent where the Session store keeps a fixed deadline.
   */
  recordActivity?(
    input: { readonly sessionCookie: unknown; readonly csrf: unknown },
    extend?: boolean,
  ): Promise<AuthenticationSession>;
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
      /** WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner approves their own configuration alone. */
      approvalMode?: "SoleOperator";
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
  /** WP-2423: `soleOperatorGate` only where sole-operator approval of receipt templates is offered. */
  readonly receiptTemplateLifecycle?: Pick<
    ReturnType<typeof createMerchantReceiptTemplateLifecycle>,
    "write"
  > &
    Partial<Pick<ReturnType<typeof createMerchantReceiptTemplateLifecycle>, "soleOperatorGate">>;
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
  readonly pickupNotCollected?: ReturnType<typeof createMerchantPickupNotCollected>;
  /** WP-2423: the name and last four phone digits staff compare for an in-person pickup check. */
  readonly pickupIdentityCheck?: ReturnType<typeof createMerchantPickupIdentityCheck>;
  /** WP-2423 Q6: staff cancel a paid order or batch before the kitchen starts it. */
  readonly orderStaffCancellation?: ReturnType<typeof createMerchantOrderStaffCancellation>;
  /** WP-2423 (v15 2026-10-18): what that cancellation would refund, for the cancel dialog. */
  readonly orderStaffCancellationPreview?: ReturnType<
    typeof createMerchantOrderStaffCancellationPreview
  >;
  /** WP-2423 abandoned payment: a manager cancels a dine-in round nobody paid for. */
  readonly unpaidRoundCancellation?: ReturnType<typeof createMerchantUnpaidRoundCancellation>;
  /** WP-2423 (2026-10-16): return stock still set aside for an earlier-day Order that ended. */
  readonly endedOrderStockRelease?: ReturnType<typeof createMerchantEndedOrderStockRelease>;
  /** WP-2423 Q9-G1: a manager refunds an order paid while the Store was offline. */
  readonly orderAcceptanceHoldRefund?: ReturnType<typeof createMerchantOrderAcceptanceHoldRefund>;
  /** WP-2423 Q6 step 2a: staff cancel item lines before the kitchen starts them. */
  readonly orderItemStaffCancellation?: ReturnType<typeof createMerchantOrderItemStaffCancellation>;
  /** WP-2423 Q7: the pickup menu staff take a counter order from (as customers see it now). */
  readonly counterMenu?: ReturnType<typeof createMerchantCounterMenu>;
  /** WP-2423 Q7: staff take a pickup order at the counter or enter a paper order afterwards. */
  readonly counterOrder?: ReturnType<typeof createMerchantCounterOrder>;
  /** WP-2423 Q7 slice 2: staff enter a dine-in round for a table (or a paper round afterwards). */
  readonly staffDiningRound?: ReturnType<typeof createMerchantStaffDiningRound>;
  /** WP-2423 Q7: staff record a payment the Store's card machine approved (and, D1, the server
   * accepts the paid order or round with it: `withPaidBatchAcceptance`). */
  readonly cardMachinePayment?: (
    ...args: Parameters<ReturnType<typeof createMerchantCardMachinePayment>>
  ) => Promise<
    Awaited<ReturnType<ReturnType<typeof createMerchantCardMachinePayment>>> & {
      readonly acceptance?: CardMachinePaymentAcceptance;
    }
  >;
  /** WP-2423 Q7: staff record the card-machine refund of a cancelled card-machine order. */
  readonly cardMachineRefund?: ReturnType<typeof createMerchantCardMachineCancellationRefund>;
  /** WP-2423 item 4: staff record an item refund of a card-machine payment made on the machine. */
  readonly cardMachineOrdinaryRefund?: ReturnType<typeof createMerchantCardMachineOrdinaryRefund>;
  /** WP-2423 P6: refund a Provider capture that matches no payment or Order. */
  readonly unmatchedCaptureRefund?: ReturnType<typeof createMerchantUnmatchedCaptureRefund>;
  /** WP-2423 Q5: the signed-in staff member re-verifies a second factor (MFA step-up). */
  readonly mfaStepUp?: ReturnType<typeof createMerchantMfaStepUp>;
  /**
   * WP-2423 DEC-COGNITO-STORE-STAFF: the production step-up — signing in again with the
   * authenticator at the identity provider. When present it answers the step-up status and the
   * authenticator-code route is not offered.
   */
  readonly providerStepUp?: ReturnType<typeof createMerchantProviderStepUp>;
  /** WP-2423 Q5: an Owner/Finance member approves an escalated refund, which is then sent. */
  readonly ordinaryRefundApproval?: ReturnType<typeof createMerchantOrdinaryRefundApproval>;
  /** WP-2423 Q5: an Owner/Finance member declines a refund nothing was prepared for. */
  readonly ordinaryRefundDecline?: ReturnType<typeof createMerchantOrdinaryRefundDecline>;
  /** WP-2423 Q5: where one refund request stands, for anyone who may read refunds. */
  readonly ordinaryRefundProgress?: ReturnType<typeof createMerchantOrdinaryRefundProgress>;
  /** WP-2423 Q5: refunds at this Store awaiting approval or approved and not yet sent. */
  readonly ordinaryRefundApprovals?: ReturnType<typeof createMerchantOrdinaryRefundApprovals>;
  /** WP-2423 Q19: the Brand Owner's sole-operator setting (read and turn on/off). */
  readonly soleOperator?: ReturnType<typeof createMerchantSoleOperator>;
  /** WP-2423 Q15/Q16: the Store's receipt registration numbers and privacy notice link. */
  readonly storeReceiptProfile?: ReturnType<typeof createMerchantStoreReceiptProfile>;
  /** WP-2423 DEC-STORE-CUSTOMER-NAME: the name, address and phone customers see. */
  readonly storePublicProfile?: ReturnType<typeof createMerchantStorePublicProfile>;
  readonly kitchenQuery?: ReturnType<typeof createMerchantKitchenQuery>;
  readonly kitchenCommand?: ReturnType<typeof createMerchantKitchenCommand>;
  readonly kitchenRelease?: ReturnType<typeof createMerchantKitchenRelease>;
  /** WP-2423 Q26 (Handoff Section 26.6): remake a finished dish from the Kitchen board. */
  readonly kitchenRework?: ReturnType<typeof createMerchantKitchenRework>;
  /** DEC-KITCHEN-STALE-TICKETS: a manager closes an earlier business day's kitchen ticket. */
  readonly kitchenStaleClose?: ReturnType<typeof createMerchantKitchenStaleClose>;
  readonly roleAdministration?: ReturnType<typeof createMerchantRoleAdministration>;
  readonly staffAdministration?: ReturnType<typeof createMerchantStaffAdministration>;
  readonly inventoryItems?: ReturnType<typeof createMerchantInventoryItems>;
  readonly stockPlaces?: ReturnType<typeof createMerchantStockPlaces>;
  readonly openingCount?: ReturnType<typeof createMerchantOpeningCount>;
  readonly storeReceipts?: ReturnType<typeof createMerchantStoreReceipts>;
  readonly recipes?: ReturnType<typeof createMerchantRecipes>;
  /** WP-2423 item 8 ⑥: a dish's allergens declared by staff in the one-page menu. */
  readonly dishAllergens?: ReturnType<typeof createMerchantDishAllergens>;
  /** WP-2423 item 8 ⑥: a dish saved from the one-page menu, and "List it" for all of it. */
  readonly oneStoreDishes?: ReturnType<typeof createMerchantOneStoreDishes>;
  /** WP-2423 item 8 ⑥ part 4: the combos of the one-page menu (saved and listed through it). */
  readonly combos?: ReturnType<typeof createMerchantCombos>;
  /** WP-2423 item 8 ⑥ part 4: a combo's dish done in the kitchen or served at its table. */
  readonly comboParts?: ReturnType<typeof createMerchantComboPartCommands>;
  readonly products?: ReturnType<typeof createMerchantProducts>;
  readonly prices?: ReturnType<typeof createMerchantPrices>;
  readonly allergens?: ReturnType<typeof createMerchantAllergens>;
  readonly menus?: ReturnType<typeof createMerchantMenus>;
  readonly availability?: ReturnType<typeof createMerchantAvailability>;
  readonly optionSets?: ReturnType<typeof createMerchantOptionSets>;
  readonly optionPrices?: ReturnType<typeof createMerchantOptionPrices>;
  readonly optionRecipes?: ReturnType<typeof createMerchantOptionRecipes>;
  readonly storeTax?: ReturnType<typeof createMerchantStoreTax>;
  readonly taxClassifications?: ReturnType<typeof createMerchantTaxClassifications>;
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
  /** WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3a: the Brand's Owner opens a Store. */
  readonly storeOpening?: ReturnType<typeof createMerchantStoreOpening>;
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
  /** WP-2423 item 8 ⑤: the phones at a table, pause/resume joining by QR, remove a phone. */
  readonly diningQrJoin?: ReturnType<typeof createMerchantDiningQrJoin>;
  /** WP-2423 item 8 ⑤: send a round waiting for staff to the kitchen, or cancel it. */
  readonly diningHeldRound?: ReturnType<typeof createMerchantDiningHeldRound>;
  /** WP-2423 item 8 ⑤: the Store's "a new phone's first round waits for staff". */
  readonly diningRoundHoldSetting?: ReturnType<typeof createMerchantDiningRoundHoldSetting>;
  /** WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the modules the Store uses (Store features page). */
  readonly storeFeatures?: ReturnType<typeof createMerchantStoreFeatures>;
  /** WP-2423 item 8 ⑦: a server chases a dish not yet served (the kitchen sees it). */
  readonly diningChase?: ReturnType<typeof createMerchantDiningChase>;
  /** WP-2423 item 8 ⑦ (decision 2): how many guests sit at a table. */
  readonly diningPartySize?: ReturnType<typeof createMerchantDiningPartySize>;
  /** WP-2423 item 8 ⑦: dishes the kitchen does not prepare (the menu's mark). */
  readonly kitchenNotPrepared?: ReturnType<typeof createMerchantKitchenNotPrepared>;
  /** WP-2423 item 8 ⑧ (decision 5): the kitchen sections (档口) and each dish's section. */
  readonly kitchenSections?: ReturnType<typeof createMerchantKitchenSections>;
  /** WP-2423 item 8 ⑦ 4b-2: the per-head tea charge of a table. */
  readonly diningTeaCharge?: ReturnType<typeof createMerchantDiningTeaCharge>;
  readonly diningJoinRegenerate?: ReturnType<typeof createMerchantDiningJoinRegenerate>;
  readonly diningHostSelection?: ReturnType<typeof createMerchantDiningHostSelection>;
  readonly diningHostTransfer?: ReturnType<typeof createMerchantDiningHostTransfer>;
  readonly diningSessionStart?: ReturnType<typeof createMerchantDiningSessionStart>;
  readonly diningClosing?: ReturnType<typeof createMerchantDiningClosingCommand>;
  readonly orderClosure?: ReturnType<typeof createMerchantDiningOrderCloseCommand>;
  readonly orderAcceptance?: ReturnType<typeof createMerchantOrderAcceptanceCommand>;
  readonly diningServe?: ReturnType<typeof createMerchantDiningServeCommand>;
  /** WP-2423: "Serve all ready items" for a round or a table (one serve command per line). */
  readonly diningServeReady?: ReturnType<typeof createMerchantDiningServeReadyCommand>;
  readonly diningTables?: ReturnType<typeof createMerchantDiningTables>;
  /** WP-2423 Q28: guests waiting for staff (navigation count) and answering a call. */
  readonly diningStaffCallCount?: ReturnType<typeof createMerchantDiningStaffCallCount>;
  readonly diningStaffCallAnswer?: ReturnType<typeof createMerchantDiningStaffCallAnswer>;
  /** WP-2423 DEC-DINE-IN-PAY-LATER: the Store's dine-in payment timing. */
  readonly diningPaymentTimingRead?: ReturnType<typeof createMerchantDiningPaymentTimingRead>;
  readonly diningPaymentTimingChange?: ReturnType<typeof createMerchantDiningPaymentTimingChange>;
  /** WP-2423 DEC-DINE-IN-PAY-LATER: a pay-later table's bill and its one payment. */
  readonly diningTableBill?: ReturnType<typeof createMerchantDiningTableBillRead>;
  readonly diningTableSettle?: ReturnType<typeof createMerchantDiningTableSettle>;
  /** WP-2423 item 8 ④: split a pay-later table's bill evenly or by rounds (or pay it whole). */
  readonly diningTableSplit?: ReturnType<typeof createMerchantDiningTableSplit>;
  /** S4: staff stop a phone payment a guest gave up on (the Provider is asked first). */
  readonly diningTableOnlinePaymentStop?: ReturnType<
    typeof createMerchantDiningTableOnlinePaymentStop
  >;
  readonly orderUnpaidDeparture?: ReturnType<typeof createMerchantDiningUnpaidDeparture>;
  readonly tablePayment?: ReturnType<typeof createMerchantDiningTablePaymentRead>;
  readonly tableCashRefund?: ReturnType<typeof createMerchantDiningTableCashRefund>;
  readonly unpaidItemRemoval?: ReturnType<typeof createMerchantDiningUnpaidItemRemoval>;
  /** WP-2423 item 8 ① segment 2: a manager comps or discounts dishes before the table pays. */
  readonly itemComp?: ReturnType<typeof createMerchantDiningItemComp>;
  readonly diningTableCommand?: ReturnType<typeof createMerchantDiningTableCommand>;
  /** WP-2423 item 8 ⑧ (Owner decision 3): move a table's party to another free table. */
  readonly diningTableMove?: ReturnType<typeof createMerchantDiningTableMove>;
  /** WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): merge a table's party into another seated table. */
  readonly diningTableMerge?: ReturnType<typeof createMerchantDiningTableMerge>;
  /** WP-2423 Q11: table QR codes (DIN-TABLE-LIST). */
  readonly diningTableQr?: ReturnType<typeof createMerchantDiningTableQr>;
  readonly diningOrderProgress?: ReturnType<typeof createMerchantDiningOrderProgress>;
  /** DEC-TABLE-CLOSE-GUESTS-LEFT: the open rounds of a table whose guests left, and their refunds. */
  readonly diningTableClosePlan?: ReturnType<typeof createMerchantDiningTableClosePlan>;
  readonly diningItemService?: ReturnType<typeof createMerchantDiningItemService>;
  readonly serviceControl?: (
    input: Parameters<ReturnType<typeof createMerchantServiceControl>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantServiceControl>>;
  readonly storeConfiguration?: (
    input: Parameters<ReturnType<typeof createMerchantStoreConfiguration>>[0],
  ) => ReturnType<ReturnType<typeof createMerchantStoreConfiguration>>;
  readonly storeConfigurationState?: ReturnType<typeof createMerchantStoreConfiguration>["read"];
  /** WP-2423 Q4: an hours change on a Store whose configuration came from Store setup. */
  readonly storeHoursDraft?: ReturnType<typeof createMerchantStoreHoursSetupDraft>;
  /** WP-2423 (v15 D2/D3): withdraw or decline the Store's configuration that is not published. */
  readonly storeConfigurationWithdrawal?: ReturnType<
    typeof createMerchantStoreConfigurationWithdrawal
  >;
  /**
   * WP-2423 (2026-10-16 v15): after a withdrawal or decline, Store setup's saved hours return to
   * the published hours when the withdrawn change changed nothing but hours.
   */
  readonly storeHoursRestore?: ReturnType<typeof createMerchantStoreHoursSetupRestore>;
  readonly serviceControlState?: ReturnType<typeof createMerchantServiceControl>["read"];
  /** WP-2423 Q21: the selected Store's current business day (date, start, end). */
  readonly businessDay?: ReturnType<typeof createMerchantServiceControl>["businessDay"];
  readonly orderExceptions?: ReturnType<typeof createMerchantOrderExceptionRead>;
  /** WP-2423 P1: the day-end settlement view for one business day. */
  readonly settlement?: ReturnType<typeof createMerchantSettlementRead>;
  /** WP-2423 Q13: the installation's operations alerts for the Home (Owner and Store Manager). */
  readonly operationsAlerts?: ReturnType<typeof createPersistentMerchantOperationsAlerts>;
  /** WP-2423 Q14: the Store's sales, item, hourly and tip reports and their CSV export. */
  readonly storeReports?: ReturnType<typeof createPersistentMerchantStoreReports>;
  readonly service: MerchantBffService;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  /**
   * WP-2423 Q18: where staff sign in. Production uses the Cognito sign-in (`/merchant/login`); the
   * InternalTest pilot passes its TEST-ONLY staff sign-in page, labelled as such for staff.
   */
  readonly signInEntry?: { readonly path: string; readonly testOnly: boolean };
  /**
   * WP-2423 Q18 option A: shared-tablet staff PIN (tablet registration, own PIN, lock screen,
   * manager reset) and the gate that refuses sensitive actions of an unverified PIN session.
   */
  readonly staffPin?: ReturnType<typeof createMerchantStaffPin>;
}
