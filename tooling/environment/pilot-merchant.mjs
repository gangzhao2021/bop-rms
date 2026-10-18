import console from "node:console";
import { createMerchantTaxConfigAuthoring } from "../../apps/api/dist/merchant-tax-config-authoring.js";
import { createMerchantReconciliationEvidenceQuery } from "../../apps/api/dist/merchant-reconciliation-evidence-query.js";
import { createMerchantReconciliationFollowUpCommand } from "../../apps/api/dist/merchant-reconciliation-follow-up-command.js";
import { createMerchantReconciliationFollowUpQuery } from "../../apps/api/dist/merchant-reconciliation-follow-up-query.js";
import { resolveInternalDiningTaskPolicy } from "./pilot-dining-task-policy.mjs";
import { createInternalExceptionSnapshotTransactions } from "./pilot-exception-snapshot.mjs";
import { readInternalExceptionCoverage } from "./pilot-exception-coverage.mjs";
import { createPersistentMerchantOrderExceptions } from "../../apps/api/dist/persistent-merchant-order-exceptions.js";
import { createPersistentMerchantSettlement } from "../../apps/api/dist/persistent-merchant-settlement.js";
import { createPersistentMerchantOperationsAlerts } from "../../apps/api/dist/merchant-operations-alerts.js";
import { createPersistentMerchantStoreReports } from "../../apps/api/dist/persistent-merchant-store-reports.js";
import {
  dailySettlementRunReference,
  dailySettlementRecheckRunReference,
  dailySettlementRecheckLimit,
  dailySettlementDayEnd,
} from "./pilot-daily-settlement-reference.mjs";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { createMerchantCompensationReconciliationQuery } from "../../apps/api/dist/merchant-compensation-reconciliation-query.js";
import { createMerchantCompensationReconciliationCommand } from "../../apps/api/dist/merchant-compensation-reconciliation-command.js";
import { createMerchantDiningHostSelection } from "../../apps/api/dist/merchant-dining-host-selection.js";
import { createMerchantDiningHostTransfer } from "../../apps/api/dist/merchant-dining-host-transfer.js";
import { createMerchantOrdinaryRefundStatus } from "../../apps/api/dist/merchant-ordinary-refund-status.js";
import { createMerchantRefundPaymentContext } from "../../apps/api/dist/merchant-refund-payment-context.js";
import { createMerchantOrdinaryRefundItems } from "../../apps/api/dist/merchant-ordinary-refund-items.js";
import { createMerchantOrdinaryRefundRequest } from "../../apps/api/dist/merchant-ordinary-refund-request.js";
import { createMerchantDiningJoinState } from "../../apps/api/dist/merchant-dining-join-state.js";
import { createMerchantDiningJoinRegenerate } from "../../apps/api/dist/merchant-dining-join-regenerate.js";
import { createMerchantDiningSessionStart } from "../../apps/api/dist/merchant-dining-session-start.js";
import { createMerchantDiningTableCommand } from "../../apps/api/dist/merchant-dining-table-command.js";
import { createMerchantDiningTables } from "../../apps/api/dist/merchant-dining-tables.js";
import { createMerchantDiningClosingCommand } from "../../apps/api/dist/merchant-dining-closing-command.js";
import { createMerchantDiningTableClosePlan } from "../../apps/api/dist/merchant-dining-table-close-plan.js";
import { createMerchantDiningOrderCloseCommand } from "../../apps/api/dist/merchant-dining-order-close-command.js";
import { createDiningOrderCloseConfiguration } from "../../apps/api/dist/dining-order-close-configuration.js";
import { createPersistentMerchantTaskInbox } from "../../apps/api/dist/persistent-merchant-task-inbox.js";
import { createMerchantDiningTaskSource } from "../../apps/api/dist/merchant-dining-task-source.js";
import { createMerchantDiningServeCommand } from "../../apps/api/dist/merchant-dining-serve-command.js";
import { createMerchantDiningServeReadyCommand } from "../../apps/api/dist/merchant-dining-serve-ready-command.js";
import { createMerchantDiningOrderProgress } from "../../apps/api/dist/merchant-dining-order-progress.js";
import { createHash } from "node:crypto";
import { createMerchantKitchenQuery } from "../../apps/api/dist/merchant-kitchen-query.js";
import { createMerchantKitchenRelease } from "../../apps/api/dist/merchant-kitchen-release.js";
import { createMerchantRoleAdministration } from "../../apps/api/dist/merchant-role-administration.js";
import { createMerchantStaffAdministration } from "../../apps/api/dist/merchant-staff-administration.js";
import { createMerchantInventoryItems } from "../../apps/api/dist/merchant-inventory-items.js";
import { createMerchantStockPlaces } from "../../apps/api/dist/merchant-stock-places.js";
import { createMerchantOpeningCount } from "../../apps/api/dist/merchant-opening-count.js";
import { createMerchantStoreReceipts } from "../../apps/api/dist/merchant-store-receipts.js";
import { createMerchantRecipes } from "../../apps/api/dist/merchant-recipes.js";
import { createMerchantProducts } from "../../apps/api/dist/merchant-products.js";
import { createPilotProductImages } from "../../apps/api/dist/product-image-route.js";
import { createMerchantPrices } from "../../apps/api/dist/merchant-prices.js";
import { createMerchantAllergens } from "../../apps/api/dist/merchant-allergens.js";
import { createMerchantMenus } from "../../apps/api/dist/merchant-menus.js";
import { createMerchantAvailability } from "../../apps/api/dist/merchant-availability.js";
import { createMerchantKitchenRework } from "../../apps/api/dist/merchant-kitchen-rework.js";
import { createMerchantKitchenStaleClose } from "../../apps/api/dist/merchant-kitchen-stale-close.js";
import { createMerchantOptionSets } from "../../apps/api/dist/merchant-option-sets.js";
import { logUnexpected, reportUnexpected } from "./pilot-merchant-pickup.mjs";
import { createMerchantOptionPrices } from "../../apps/api/dist/merchant-option-prices.js";
import { createMerchantOptionRecipes } from "../../apps/api/dist/merchant-option-recipes.js";
import { createMerchantStoreTax } from "../../apps/api/dist/merchant-store-tax.js";
import { createMerchantTaxClassifications } from "../../apps/api/dist/merchant-tax-classifications.js";
import { createMerchantStockCounts } from "../../apps/api/dist/merchant-stock-counts.js";
import { createMerchantStoreWaste } from "../../apps/api/dist/merchant-store-waste.js";
import { createPersistentMerchantBffService } from "../../apps/api/dist/persistent-merchant-bff.js";
import { createMerchantServiceControl } from "../../apps/api/dist/merchant-service-control.js";
import { createMerchantUnmatchedCaptureRefund } from "../../apps/api/dist/merchant-unmatched-capture-refund.js";
import { createMerchantOrderStaffCancellation } from "../../apps/api/dist/merchant-order-staff-cancellation.js";
import { createMerchantUnpaidRoundCancellation } from "../../apps/api/dist/merchant-unpaid-round-cancellation.js";
import { createMerchantEndedOrderStockRelease } from "../../apps/api/dist/merchant-stock-holding-orders.js";
import { createMerchantBusinessDayWindows } from "../../apps/api/dist/merchant-business-day-window.js";
import { createMerchantOrderItemStaffCancellation } from "../../apps/api/dist/merchant-order-item-staff-cancellation.js";
import { createMerchantOrdinaryRefundBusinessDate } from "../../apps/api/dist/merchant-ordinary-refund-business-date.js";
import { createPersistentMerchantOrderQueue } from "../../apps/api/dist/persistent-merchant-order-queue.js";
import { createMerchantStorePresence } from "../../apps/api/dist/merchant-store-presence.js";
import { createMerchantOrderAcceptanceHoldRefund } from "../../apps/api/dist/merchant-order-acceptance-hold-refund.js";
import { createInternalStoreConfiguration } from "./pilot-store-configuration.mjs";
import { createInternalStoreSetupBff } from "./pilot-store-setup.mjs";
import { createMerchantMfaStepUp } from "../../apps/api/dist/merchant-mfa-step-up.js";
import { createMerchantStaffPin } from "../../apps/api/dist/merchant-staff-pin.js";
import { createStoreAwaitingPickupDeadlines } from "../../apps/api/dist/pickup-acceptance-deadline.js";
import {
  createPostgresMerchantOrganizationSource,
  parseStoreReference,
} from "../../packages/bop/tenant/src/index.ts";
import { createMerchantRefundSoleOperatorResolver } from "../../apps/api/dist/merchant-sole-operator.js";
import { createMerchantSoleOperator } from "../../apps/api/dist/merchant-sole-operator-setting.js";
import { createMerchantStoreReceiptProfile } from "../../apps/api/dist/merchant-store-receipt-profile.js";
import { createMerchantStorePublicProfile } from "../../apps/api/dist/merchant-store-public-profile.js";
import { createMerchantOrdinaryRefundApproval } from "../../apps/api/dist/merchant-ordinary-refund-approval.js";
import { createMerchantOrdinaryRefundApprovals } from "../../apps/api/dist/merchant-ordinary-refund-approvals.js";
import { createMerchantOrdinaryRefundDecline } from "../../apps/api/dist/merchant-ordinary-refund-decline.js";
import { createMerchantOrdinaryRefundProgress } from "../../apps/api/dist/merchant-ordinary-refund-progress.js";
import { createMerchantCardMachineOrdinaryRefund } from "../../apps/api/dist/merchant-card-machine-ordinary-refund.js";
import { withPaidBatchAcceptance } from "../../apps/api/dist/merchant-card-machine-payment.js";
import {
  createRefundReceiptIssuance,
  hasDigitalReceipt,
} from "../../apps/api/dist/refund-receipt-issuance.js";
import { createInternalRefundWorkforceContext } from "./pilot-refund-workforce.mjs";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
export async function createInternalMerchant(
  resources,
  {
    createInternalRefundReconciliation,
    createInternalRefundSend,
    createInternalRefundPreparation,
    createInternalDiningCredentials,
    createInternalMerchantDining,
    createInternalMerchantPickup,
    createInternalKitchenCommand,
    createInternalMerchantAcceptance,
    createInternalMerchantSession,
    createInternalMerchantProduct,
    loadTaskQueue,
    expectedDatabaseName,
    providerAccountReference,
    exceptionPaymentMode,
    roleMapping,
    taxConfigCurrencyMetadata,
    loadPricingCurrencyMetadata,
    refundUnmatchedCapture,
    cancellationRefundProvider,
    staffTotpVerifier,
    createInternalCounterOrder,
    createInternalStaffStockShortage,
    createInternalTableQr,
    createInternalStaffPinCredentials,
    readOperationsAlertBoard,
    loadDailySettlementCoverage,
    refreshOrderReceiptObservations,
    createInternalUnpaidRoundCancellation,
    productImageDirectory,
  },
) {
  const session = await createInternalMerchantSession(resources);
  const selected = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const targetScope = async (_tx, authenticated, reference = selected.storeReference) => {
    if (
      reference !== selected.storeReference ||
      !(await session.validateAssociation(_tx, authenticated, selected, resources.now()))
    )
      throw new Error("INTERNAL_MERCHANT_SCOPE_DENIED");
    return selected;
  };
  const persistence = {
    ...session.persistence,
    ...(createInternalMerchantProduct === undefined
      ? {}
      : { catalogProductNavigation: { currentRuntime: true } }),
    publication: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      // WP-2423 StoreOperatingSource: the same gate codes the resources were verified against.
      requiredLiveGateRequirementCodes: resources.operating.requiredLiveGateRequirementCodes,
      // WP-2423 DEC-STORE-SETUP-PUBLICATION: the check inventory of a configuration published from
      // Store setup.
      requiredValidationCheckCodes: resources.operating.requiredValidationCheckCodes,
    },
    initialScope: targetScope,
    targetScope,
    workspace: async (_tx, { context }) => ({
      screenId: "HOME-OVERVIEW",
      selectedScope: {
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: selected.storeReference,
        timeZone: context.store.timeZone,
      },
      authorizedStores: [
        {
          brandLabel: context.brand.displayName,
          storeLabel: context.store.displayName,
          storeReference: selected.storeReference,
        },
      ],
      // The Store-local calendar date (a UTC date is already tomorrow in Toronto after 20:00).
      businessDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: context.store.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(context.resolvedAt)),
      storeStatus: "Unavailable",
      freshness: "Stale",
      dashboardAvailability: "UnavailableUntilWP1905",
      navigation: [
        {
          screenId: "STORE-SETUP",
          label: "Store setup",
          href: "/app/organization/stores/" + selected.storeReference + "/setup",
          permission: "organization.manage",
        },
        // WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Products (merchant-products).
        {
          screenId: "CAT-PRODUCT-LIST",
          label: "Products",
          href: "/app/commerce/products",
          permission: "catalog.manage",
        },
        ...(typeof product.optionSetList === "function"
          ? [
              {
                screenId: "CAT-OPTIONSET-LIST",
                label: "Option sets",
                href: "/app/commerce/option-sets",
                permission: "catalog.manage",
              },
            ]
          : []),
        {
          screenId: "OPS-ORDER-QUEUE",
          label: "Orders",
          href: "/operations/orders",
          permission: "ordering.operate",
        },
        // WP-2423 Q7: a pickup order taken at the counter, paid on the Store's card machine.
        {
          screenId: "OPS-ORDER-ENTRY",
          label: "Counter order",
          href: "/operations/order-entry",
          permission: "ordering.order.create_staff",
        },
        {
          screenId: "KIT-KITCHEN-QUEUE",
          label: "Kitchen",
          href: "/operations/kitchen",
          permission: "kitchen.operate",
        },
        {
          screenId: "FUL-PICKUP-QUEUE",
          label: "Pickup",
          href: "/operations/pickup",
          permission: "fulfillment.operate",
        },
        // WP-2423 Q8: dine-in tables — start a session, give the table its join code, hand over.
        {
          screenId: "DIN-FLOOR-BOARD",
          label: "Tables",
          href: "/operations/dining",
          permission: "dining.operate",
        },
        // WP-2423 Q11: print, replace and turn off table QR codes (Store Manager, Owner).
        ...(createInternalTableQr === undefined
          ? []
          : [
              {
                screenId: "DIN-TABLE-LIST",
                label: "Table QR codes",
                href: "/app/operations/tables",
                permission: "dining.table.qr.manage",
              },
            ]),
        // WP-2423 P1: day-end settlement for the Store Manager (Section 88 PAY-RECONCILIATION).
        {
          screenId: "PAY-RECONCILIATION",
          label: "Settlement",
          href: "/app/operations/payment-reconciliation",
          permission: "operations.order-exception.manage",
        },
        // v15 finding: open exceptions and payment differences (Owner, Store Manager); the store
        // system alerts send staff here, so the page must be reachable from the navigation.
        {
          screenId: "OPS-ORDER-EXCEPTION",
          label: "Exceptions",
          href: "/operations/order-exceptions",
          permission: "operations.order-exception.manage",
        },
        // WP-2423 Q14: sales, item, hourly and tip reports with CSV export (Owner, Store Manager).
        {
          screenId: "RPT-OPS-DASHBOARD",
          label: "Reports",
          href: "/app/reports/operations",
          permission: "reporting.sales.read",
        },
        {
          screenId: "INV-ITEM-LIST",
          label: "Inventory items",
          href: "/app/supply/items",
          permission: "inventory.item.read",
        },
        {
          screenId: "INV-LOCATION-LIST",
          label: "Stock locations",
          href: "/app/supply/locations",
          permission: "inventory.location.read",
        },
        {
          screenId: "INV-RECEIPT-LIST",
          label: "Receiving",
          href: "/operations/receiving",
          permission: "inventory.receipt.read",
        },
        {
          screenId: "RECIPE-LIST",
          label: "Recipes",
          href: "/app/commerce/recipes",
          permission: "recipe.read",
        },
        {
          screenId: "RECIPE-OPTION-LIST",
          label: "Option recipes",
          href: "/app/commerce/option-recipes",
          permission: "recipe.read",
        },
        {
          screenId: "CAT-MENU-LIST",
          label: "Menus",
          href: "/app/commerce/menus",
          permission: "catalog.menu.read",
        },
        {
          screenId: "CAT-OPTIONSET-LIST",
          label: "Options",
          href: "/app/commerce/option-sets",
          permission: "catalog.option_set.read",
        },
        // WP-2423 Q5: refunds awaiting an Owner approval (Section 88 APPROVAL-INBOX).
        {
          screenId: "APPROVAL-INBOX",
          label: "Approvals",
          href: "/app/approvals",
          permission: "workflow.operate",
        },
        // WP-2423 Q4: busy mode (pause/resume online ordering) and published hours.
        {
          screenId: "STORE-HOURS-SERVICE",
          label: "Hours & ordering",
          href: "/app/organization/stores/" + selected.storeReference + "/service",
          permission: "store.service.read",
        },
        {
          screenId: "CAT-AVAILABILITY",
          label: "Item availability",
          href: "/app/commerce/availability",
          permission: "catalog.sku.read",
        },
        {
          screenId: "PRICE-BOOK-LIST",
          label: "Prices",
          href: "/app/commerce/pricing",
          permission: "pricing.price_book.read",
        },
        {
          screenId: "PRICE-OPTION-LIST",
          label: "Option prices",
          href: "/app/commerce/option-prices",
          permission: "pricing.price_book.read",
        },
        {
          screenId: "TAX-STORE-REVIEW",
          label: "Tax review",
          href: "/app/commerce/tax-review",
          permission: "pricing.tax_config.read",
        },
        // WP-2423 Store setup: the Brand Owner's tax classifications (fees and products name one).
        {
          screenId: "CAT-TAX-CLASSIFICATION-LIST",
          label: "Tax classifications",
          href: "/app/commerce/tax-classifications",
          permission: "catalog.tax-classification.manage",
        },
        {
          screenId: "CMP-ALLERGEN-REVIEW",
          label: "Allergens",
          href: "/app/compliance/allergens",
          permission: "catalog.allergen.read",
        },
        {
          screenId: "INV-COUNT-LIST",
          label: "Stock counts",
          href: "/operations/inventory/counts",
          permission: "inventory.count.read",
        },
        {
          screenId: "INV-WASTE-RECORD",
          label: "Waste",
          href: "/operations/inventory/waste",
          permission: "inventory.waste.record",
        },
        {
          screenId: "INV-OPENING-COUNT",
          label: "Opening count",
          href: "/app/supply/opening-count",
          permission: "inventory.count.read",
        },
        {
          screenId: "IAM-USER-LIST",
          label: "Staff",
          href: "/app/organization/users",
          permission: "organization.staff.read",
        },
        {
          screenId: "IAM-ROLE-LIST",
          label: "Roles",
          href: "/app/organization/roles",
          permission: "identity.role.read",
        },
        // WP-2423 Q18 option A: register shared tablets and reset staff PINs.
        {
          screenId: "IAM-SESSION-LIST",
          label: "Shared tablets & PINs",
          href: "/app/organization/sessions",
          permission: "identity.store_device.manage",
        },
      ],
    }),
  };
  const queue = await loadTaskQueue();
  if (
    queue.environment !== "InternalTest" ||
    queue.database !== expectedDatabaseName ||
    queue.tenantReference !== selected.tenantReference ||
    queue.brandReference !== selected.brandReference ||
    queue.storeReference !== selected.storeReference
  )
    throw new Error("INTERNAL_TASK_QUEUE_UNAVAILABLE");
  const taskInbox = createPersistentMerchantTaskInbox({
    persistence,
    queues: [queue],
    authorizeSource: createMerchantDiningTaskSource(persistence),
  });
  const service = createPersistentMerchantBffService(persistence);
  const product =
    createInternalMerchantProduct === undefined
      ? {}
      : await createInternalMerchantProduct(resources, persistence, service);
  const orderExceptions = createPersistentMerchantOrderExceptions({
    persistence: {
      ...persistence,
      transactions: createInternalExceptionSnapshotTransactions(resources),
    },
    // WP-2423 D3: an unreadable reconciliation detail is logged (code and frames only).
    onUnexpected: (error) =>
      reportUnexpected("INTERNAL_ORDER_EXCEPTION_RECONCILIATION_DETAIL_UNAVAILABLE", error),
    // WP-2423: a business day's totals difference names its day by the scheduler's own runs.
    settlementDays: {
      dayEndOf: dailySettlementDayEnd,
      runReferences: async (scope, window) => {
        for (const key of ["brandReference", "storeReference"])
          if (scope[key] !== selected[key]) throw new Error("INTERNAL_EXCEPTION_SCOPE_DENIED");
        const day = {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          businessDate: window.businessDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        };
        return {
          original: dailySettlementRunReference(day).runReference,
          rechecks: Array.from({ length: dailySettlementRecheckLimit }, (_, n) =>
            dailySettlementRecheckRunReference(day, n + 1),
          ),
        };
      },
    },
    metadata: async (tx, { scope, storeLabel, sources }) => {
      if (
        scope.tenantReference !== selected.tenantReference ||
        scope.brandReference !== selected.brandReference ||
        scope.storeReference !== selected.storeReference
      )
        throw new Error("INTERNAL_EXCEPTION_SCOPE_DENIED");
      const at = resources.now();
      const status = await createPostgresPublishedStoreOperatingStatusReader({
        ...resources.operating,
        authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
      })(tx, at);
      if (
        status.businessDate.brandReference !== scope.brandReference ||
        status.businessDate.storeReference !== scope.storeReference ||
        status.evaluatedAt !== at
      )
        throw new Error("INTERNAL_EXCEPTION_SOURCE_UNAVAILABLE");
      const freshnessStatus = await readInternalExceptionCoverage({
        resources,
        providerAccountReference,
        paymentMode: exceptionPaymentMode,
        tx,
        sources,
      });
      return {
        storeLabel,
        businessDate: status.businessDate.businessDate,
        checkpointReference: resources.credentials.reference(),
        projectedAt: at,
        freshnessStatus,
        ...(freshnessStatus === "Fresh" ? { currentSourceCheck: "Complete" } : {}),
      };
    },
  });
  const reconciliationEvidenceQuery = createMerchantReconciliationEvidenceQuery({
    persistence,
    authentication: service,
  });
  const reconciliationFollowUpQuery = createMerchantReconciliationFollowUpQuery({
    persistence,
    authentication: service,
  });
  const reconciliationFollowUp = createMerchantReconciliationFollowUpCommand({
    persistence,
    authentication: service,
    now: resources.now,
    reference: () => resources.credentials.reference(),
  });
  const unmatchedCaptureRefund =
    refundUnmatchedCapture === undefined
      ? undefined
      : createMerchantUnmatchedCaptureRefund({
          persistence,
          authentication: service,
          nextReference: () => resources.credentials.reference(),
          refundPayment: refundUnmatchedCapture,
        });
  // WP-2423 Q6: staff cancel a paid order or batch before the kitchen starts. The refund is made by
  // the compensation workload (business worker), which discovers the staff cancellation record.
  const orderStaffCancellation = createMerchantOrderStaffCancellation({
    persistence,
    authentication: service,
    nextReference: () => resources.credentials.reference(),
    // DEC-TABLE-CLOSE-GUESTS-LEFT: what is left to refund of a never-accepted round paid online.
    resolveRefundConfiguration: async (tx, scope) => {
      const configuration = await refundConfiguration(tx, scope);
      return {
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
      };
    },
    installContext: async (tx, scope) => {
      for (const key of ["tenantReference", "brandReference", "storeReference"])
        if (scope[key] !== selected[key])
          throw new Error("INTERNAL_ORDER_CANCELLATION_SCOPE_DENIED");
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
    },
  });
  // WP-2423 abandoned payment: a manager cancels an unpaid dine-in round before its deadline.
  const unpaidRound =
    createInternalUnpaidRoundCancellation === undefined
      ? undefined
      : await createInternalUnpaidRoundCancellation(resources);
  const unpaidRoundCancellation =
    unpaidRound === undefined
      ? undefined
      : createMerchantUnpaidRoundCancellation({
          persistence,
          authentication: service,
          resolvePayment: (operation) => unpaidRound.payment.resolve(operation),
          cancellation: unpaidRound.cancellation,
          installContext: async (tx, scope) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (scope[key] !== selected[key])
                throw new Error("INTERNAL_UNPAID_ROUND_SCOPE_DENIED");
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [scope.tenantReference, scope.brandReference, scope.storeReference],
            );
          },
        });
  // WP-2423 (2026-10-16 v15 stock leak): a manager returns stock still set aside for an Order of
  // an earlier day that already ended (handed over, not collected, closed or cancelled).
  const installSelectedContext = async (tx, scope) => {
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (scope[key] !== selected[key]) throw new Error("INTERNAL_STOCK_RELEASE_SCOPE_DENIED");
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
  };
  const endedOrderStockRelease = createMerchantEndedOrderStockRelease({
    persistence,
    authentication: service,
    nextReference: () => resources.credentials.reference(),
    installContext: installSelectedContext,
    today: (tx) =>
      createMerchantBusinessDayWindows({
        persistence,
        scope: selected,
        timeZone: resources.operating.timeZone,
        authorize: async () => true,
      }).today(tx, resources.now()),
  });
  // WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): signed-in staff using the Orders page, kitchen
  // board or counter order mark the Store online (at most one write a minute); a manager may refund
  // an order paid online while the Store was offline instead of accepting it.
  const storePresence = createMerchantStorePresence({
    transactions: persistence.transactions,
    now: resources.now,
    newReference: () => resources.credentials.reference(),
  });
  const presenceScope = {
    brandReference: selected.brandReference,
    storeReference: selected.storeReference,
  };
  const orderAcceptanceHoldRefund = createMerchantOrderAcceptanceHoldRefund({
    persistence,
    authentication: service,
    nextReference: () => resources.credentials.reference(),
    audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
  });
  const compensationQuery = createMerchantCompensationReconciliationQuery({
    persistence,
    authentication: service,
  });
  const compensationReconciliation = createMerchantCompensationReconciliationCommand({
    persistence,
    authentication: service,
    now: resources.now,
  });
  const refundConfiguration = async (_tx, scope) => {
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (scope[key] !== selected[key]) throw new Error("INTERNAL_REFUND_SCOPE_DENIED");
    return { providerAccountReference, environment: "Test", roleMapping };
  };
  const settlement = logUnexpected(
    "INTERNAL_SETTLEMENT_UNAVAILABLE",
    createPersistentMerchantSettlement({
      persistence,
      resolveConfiguration: async (tx, scope) => {
        const configuration = await refundConfiguration(tx, scope);
        return {
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        };
      },
      // The run the pilot's daily settlement scheduler creates for that closed day.
      settlementRunReference: async (scope, window) => {
        for (const key of ["brandReference", "storeReference"])
          if (scope[key] !== selected[key]) throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
        return dailySettlementRunReference({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          businessDate: window.businessDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        }).runReference;
      },
      // WP-2423: the re-check runs the settlement worker derives for that day, in order.
      settlementRecheckRunReferences: async (scope, window) => {
        for (const key of ["brandReference", "storeReference"])
          if (scope[key] !== selected[key]) throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
        const day = {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          businessDate: window.businessDate,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        };
        return Array.from({ length: dailySettlementRecheckLimit }, (_, n) =>
          dailySettlementRecheckRunReference(day, n + 1),
        );
      },
      // WP-2423: the first business day the installation's settlement coverage starts.
      ...(loadDailySettlementCoverage === undefined
        ? {}
        : {
            firstBusinessDate: async (scope) => {
              for (const key of ["tenantReference", "brandReference", "storeReference"])
                if (scope[key] !== selected[key])
                  throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
              const coverage = await loadDailySettlementCoverage();
              for (const key of ["tenantReference", "brandReference", "storeReference"])
                if (coverage.scope[key] !== selected[key])
                  throw new Error("INTERNAL_SETTLEMENT_SCOPE_DENIED");
              return coverage.firstWindow.businessDate;
            },
          }),
    }),
  );
  // WP-2423 Q13: the operations monitor's alert board for the installation's Store (Home).
  const operationsAlerts =
    readOperationsAlertBoard === undefined
      ? undefined
      : logUnexpected(
          "INTERNAL_OPERATIONS_ALERTS_UNAVAILABLE",
          createPersistentMerchantOperationsAlerts({
            persistence,
            storeReference: selected.storeReference,
            readBoard: readOperationsAlertBoard,
          }),
        );
  // WP-2423 Q14: the Store's sales reports, over the same payment sources as the settlement.
  const reports = createPersistentMerchantStoreReports({
    persistence,
    resolveConfiguration: async (tx, scope) => {
      const configuration = await refundConfiguration(tx, scope);
      return {
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
      };
    },
  });
  const storeReports = {
    read: logUnexpected("INTERNAL_STORE_REPORTS_UNAVAILABLE", reports.read),
    export: logUnexpected("INTERNAL_STORE_REPORTS_EXPORT_UNAVAILABLE", reports.export),
  };
  const refundPaymentContext = createMerchantRefundPaymentContext({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    soleOperator: (...args) => refundSoleOperator(...args),
  });
  const ordinaryRefund = createInternalRefundPreparation({
    resources,
    persistence,
    authentication: service,
    resolveRefundConfiguration: refundConfiguration,
  });
  // WP-2423 Q5: the result check and receipt issuance log their real failure code (no payload).
  const ordinaryRefundReconciliation = logUnexpected(
    "INTERNAL_REFUND_RECONCILIATION_UNAVAILABLE",
    createInternalRefundReconciliation({
      resources,
      persistence,
      authentication: service,
    }),
  );
  const ordinaryRefundSend = logUnexpected(
    "INTERNAL_REFUND_SEND_UNAVAILABLE",
    createInternalRefundSend({
      resources,
      persistence,
      authentication: service,
      resolveRefundConfiguration: refundConfiguration,
    }),
  );
  // WP-2423 Q6 step 2a: staff cancel item lines before the kitchen starts them. The Cancellation
  // refund claim is dispatched after commit through the ordinary refund journal (simulated
  // Provider, TEST-ONLY); the last remaining lines go through the whole cancellation above.
  const orderItemStaffCancellation =
    cancellationRefundProvider === undefined
      ? undefined
      : createMerchantOrderItemStaffCancellation({
          persistence,
          authentication: service,
          nextReference: () => resources.credentials.reference(),
          installContext: async (tx, scope) => {
            for (const key of ["tenantReference", "brandReference", "storeReference"])
              if (scope[key] !== selected[key])
                throw new Error("INTERNAL_ORDER_CANCELLATION_SCOPE_DENIED");
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [scope.tenantReference, scope.brandReference, scope.storeReference],
            );
          },
          wholeCancellation: orderStaffCancellation,
          resolveRefundConfiguration: async (tx, scope) => {
            const configuration = await refundConfiguration(tx, scope);
            return {
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
            };
          },
          businessDate: createMerchantOrdinaryRefundBusinessDate({
            ...selected,
            ...persistence.publication,
            timeZone: resources.operating.timeZone,
            authorize: async (_tx, at) => at <= resources.now(),
          }),
          provider: cancellationRefundProvider,
          // WP-2423 (v15 3cd0f8dd M4): a confirmed item-cancellation refund gives the order's
          // digital receipt a refund version stating the cancelled items, as other refunds do.
          issueRefundReceipt: (request) => issueOrderRefundReceipt(request),
          onUnexpected: (error) =>
            reportUnexpected("INTERNAL_ITEM_CANCELLATION_RECEIPT_UNAVAILABLE", error),
        });
  const ordinaryRefundStatus = createMerchantOrdinaryRefundStatus({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
  });
  const ordinaryRefundItems = createMerchantOrdinaryRefundItems({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    newReference: () => resources.credentials.reference(),
    locale: "en-CA",
    soleOperator: (...args) => refundSoleOperator(...args),
  });
  // WP-2423 Q5: the Store Business Date of the published configuration (RF-D01) for escalation.
  const refundBusinessDate = createMerchantOrdinaryRefundBusinessDate({
    ...selected,
    ...persistence.publication,
    timeZone: resources.operating.timeZone,
    authorize: async (_tx, at) => at <= resources.now(),
  });
  const ordinaryRefundRequest = createMerchantOrdinaryRefundRequest({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    newAuditReference: () => resources.credentials.reference(),
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
    businessDate: refundBusinessDate,
    soleOperator: (...args) => refundSoleOperator(...args),
  });
  // WP-2423 item 4: staff record an item refund of a card-machine payment made on the machine.
  // When the Order has a digital receipt (a dine-in table that also paid rounds online), the
  // receipt gains a refund version afterwards, as after an online refund (System, TEST-ONLY audit
  // reason as the online receipt path). WP-2423 (v15 3cd0f8dd M4): item cancellations use it too.
  // The item cancellation above calls it only at run time, after this declaration has run.
  const issueOrderRefundReceipt = async ({ orderReference }) => {
    const active = async () => resources.now() < resources.publicProfile.binding.validUntil;
    const receiptScope = { ...selected, providerAccountReference, environment: "Test" };
    const has = await persistence.transactions.run((tx) =>
      hasDigitalReceipt(tx, { ...resources.scope, orderReference, authorize: active }),
    );
    if (!has) return "NoDigitalReceipt";
    const freshAfter = resources.now();
    if (refreshOrderReceiptObservations !== undefined)
      await refreshOrderReceiptObservations(
        { ...resources, transactions: persistence.transactions },
        orderReference,
        active,
      );
    const authorize = async (_t, q) =>
      q.brandReference === receiptScope.brandReference &&
      q.storeReference === receiptScope.storeReference &&
      q.orderReference === orderReference &&
      (await active());
    const ref = () => resources.credentials.reference();
    await persistence.transactions.run((tx) =>
      createRefundReceiptIssuance({
        scope: receiptScope,
        authorize,
        authorizeSources: authorize,
        authorizeOrder: authorize,
        identities: () => ({ recordReference: ref(), operationReference: ref() }),
        audit: async (record, operationReference) => ({
          auditId: ref(),
          brandId: receiptScope.brandReference,
          storeId: receiptScope.storeReference,
          actor: { type: "System" },
          actionCode: "DIGITAL_RECEIPT_APPEND",
          targetType: "DigitalReceipt",
          targetId: record.recordReference,
          reasonCode: "INTERNAL_TEST_REFUND_RECEIPT",
          correlationId: operationReference,
          occurredAt: record.recordedAt,
          sourceChannel: "SYSTEM",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      })(tx, { orderReference, observedAt: resources.now(), freshAfter }),
    );
    return "Issued";
  };
  const cardMachineOrdinaryRefund = createMerchantCardMachineOrdinaryRefund({
    persistence,
    authentication: service,
    resolveConfiguration: refundConfiguration,
    businessDate: refundBusinessDate,
    nextReference: () => resources.credentials.reference(),
    issueRefundReceipt: issueOrderRefundReceipt,
    onUnexpected: (error) =>
      reportUnexpected("INTERNAL_CARD_MACHINE_ORDINARY_REFUND_UNAVAILABLE", error),
  });
  // WP-2423 Q5: escalated refund approval. The requester's role, permission and MFA are read from
  // their owners for that person (Identity roster, Membership, Permission, MFA step-ups).
  const escalatedRefundConfiguration = async (tx, scope, authority) => {
    const deny = () => {
      throw new Error("INTERNAL_REFUND_APPROVAL_CONFIGURATION_DENIED");
    };
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (scope[key] !== selected[key]) deny();
    const context = authority.context;
    if (context.actor.actorReference !== scope.actorReference || !(await authority.authorize()))
      deny();
    const bound = await refundConfiguration(tx, scope);
    const current = async (t, at) =>
      t === tx &&
      parseCanonicalInstant(at) <= parseCanonicalInstant(resources.now()) &&
      (await authority.authorize());
    return {
      providerAccountReference: bound.providerAccountReference,
      environment: bound.environment,
      businessDate: refundBusinessDate,
      workforce: {
        resolveContext: createInternalRefundWorkforceContext({
          expected: selected,
          persistence,
          sessionActorReference: scope.actorReference,
          sessionContext: async () => context,
          current,
        }),
        resolveRoleMapping: async (t, query) => {
          for (const key of ["tenantReference", "brandReference", "storeReference"])
            if (query[key] !== selected[key]) deny();
          if (!(await current(t, query.observedAt))) deny();
          return (await refundConfiguration(t, scope)).roleMapping;
        },
        stepUp: true,
        // WP-2423 Q19: an Owner's own request and approval need sole operator in effect now.
        soleOperator: true,
      },
    };
  };
  // WP-2423 Q19: lets an Owner request (and see the request form) while sole operator is in
  // effect for them; resolved per command through the same owner reads as approval.
  const refundSoleOperator = createMerchantRefundSoleOperatorResolver((tx, scope, authority) =>
    escalatedRefundConfiguration(tx, scope, authority),
  );
  const ordinaryRefundApproval = logUnexpected(
    "INTERNAL_REFUND_APPROVAL_UNAVAILABLE",
    createMerchantOrdinaryRefundApproval({
      persistence,
      authentication: service,
      resolveConfiguration: escalatedRefundConfiguration,
      prepare: ordinaryRefund,
      send: ordinaryRefundSend,
      // WP-2423 Q5: answer once approved and prepared; send, confirm the result and issue the
      // refund receipt in the background (the browser follows progress; retry is the same approval).
      reconcile: ordinaryRefundReconciliation,
      sendInBackground: true,
      onBackgroundFailure: () =>
        console.error(JSON.stringify({ event: "INTERNAL_REFUND_APPROVAL_SEND_INCOMPLETE" })),
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  );
  // WP-2423 Q5: an Owner declines a refund nothing was prepared for (RF-D04 release).
  const ordinaryRefundDecline = logUnexpected(
    "INTERNAL_REFUND_DECLINE_UNAVAILABLE",
    createMerchantOrdinaryRefundDecline({
      persistence,
      authentication: service,
      resolveConfiguration: escalatedRefundConfiguration,
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  );
  const ordinaryRefundApprovals = logUnexpected(
    "INTERNAL_REFUND_APPROVALS_UNAVAILABLE",
    createMerchantOrdinaryRefundApprovals({
      persistence,
      resolveConfiguration: escalatedRefundConfiguration,
    }),
  );
  // WP-2423 Q5: TEST-ONLY authenticator step-up (Cognito re-authentication in production).
  const mfaStepUp =
    staffTotpVerifier === undefined
      ? undefined
      : createMerchantMfaStepUp({
          persistence,
          authentication: service,
          method: "InternalTestTotp",
          verify: staffTotpVerifier,
          newReference: () => resources.credentials.reference(),
          retentionPolicyCode: "SECURITY_AUDIT",
          retentionPolicyVersion: 1,
        });
  // WP-2423 Q18 option A: staff switch on a registered shared tablet with a six-digit PIN.
  const staffPin =
    createInternalStaffPinCredentials === undefined
      ? undefined
      : await (async () => {
          const keys = await createInternalStaffPinCredentials();
          return createMerchantStaffPin({
            persistence,
            authentication: service,
            deviceHasher: keys.deviceHasher,
            kdf: keys.kdf,
            choiceTokens: keys.choiceTokens,
            newReference: () => resources.credentials.reference(),
            describeStore: async (tx, scope) => {
              if (
                scope.brandReference !== selected.brandReference ||
                scope.storeReference !== selected.storeReference
              )
                throw new Error("INTERNAL_STAFF_PIN_STORE_DENIED");
              const store = await createPostgresMerchantOrganizationSource(tx, {
                ...selected,
                observedAt: scope.at,
              }).getStore(parseStoreReference(selected.storeReference));
              if (!store) throw new Error("INTERNAL_STAFF_PIN_STORE_UNAVAILABLE");
              return { label: store.displayName, timeZone: store.timeZone };
            },
            // v15 cbff9d6f: a registered tablet re-checks the refund countdowns it shows.
            awaitingPickupDeadlines: (() => {
              const read = createStoreAwaitingPickupDeadlines({
                persistence,
                tenantReference: selected.tenantReference,
              });
              return async (tx, scope) => {
                if (
                  scope.brandReference !== selected.brandReference ||
                  scope.storeReference !== selected.storeReference
                )
                  throw new Error("INTERNAL_STAFF_PIN_STORE_DENIED");
                return read(tx, scope);
              };
            })(),
            issueSession: (actorReference, finalize) =>
              session.issueForPin(actorReference, finalize),
            retentionPolicyCode: "SECURITY_AUDIT",
            retentionPolicyVersion: 1,
          });
        })();
  const diningClosing = createMerchantDiningClosingCommand({
    exceptionTaskPolicy: resolveInternalDiningTaskPolicy({
      queue,
      scope: selected,
      observedAt: resources.now(),
    }),
    persistence,
    authentication: service,
    providerAccountReference,
    environment: "Test",
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const orderClosure = createMerchantDiningOrderCloseCommand({
    persistence,
    authentication: service,
    resolveConfiguration: createDiningOrderCloseConfiguration({
      ...selected,
      providerAccountReference,
      environment: "Test",
    }),
    newReference: () => resources.credentials.reference(),
    audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
  const orderAcceptance = await createInternalMerchantAcceptance(resources, persistence, service);
  const diningJoinState = createMerchantDiningJoinState({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
  });
  const diningJoinRegenerate = createMerchantDiningJoinRegenerate({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
    pepperVersion: 1,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningSessionStart = createMerchantDiningSessionStart({
    persistence,
    authentication: service,
    credentials: await createInternalDiningCredentials(resources),
    pepperVersion: 1,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningHostSelection = createMerchantDiningHostSelection({
    persistence,
    authentication: service,
  });
  const diningHostTransfer = createMerchantDiningHostTransfer({
    persistence,
    authentication: service,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningTableCommand = createMerchantDiningTableCommand({
    persistence,
    authentication: service,
    newReference: () => resources.credentials.reference(),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const diningTables = createMerchantDiningTables({
    persistence,
    authentication: service,
    tableAvailabilityCommandEnabled: true,
  });
  // DEC-TABLE-CLOSE-GUESTS-LEFT: the close dialog's per-round plan (Owner, Store Manager).
  const diningTableClosePlan = createMerchantDiningTableClosePlan({
    persistence,
    authentication: service,
    resolveRefundConfiguration: async (tx, scope) => {
      const configuration = await refundConfiguration(tx, scope);
      return {
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
      };
    },
  });
  const diningOrderProgress = createMerchantDiningOrderProgress({
    locale: "en-CA",
    persistence,
    authentication: service,
  });
  const diningServe = createMerchantDiningServeCommand({
    persistence,
    authentication: service,
    reference: () => resources.credentials.reference(),
    audit: {
      reasonCode: "DINING_ITEM_SERVED",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  // WP-2423: "Serve all ready items" runs the serve command above once per line.
  const diningServeReady = createMerchantDiningServeReadyCommand({
    serve: diningServe,
    progress: diningOrderProgress,
  });
  const diningItemService = createInternalMerchantDining(resources, persistence, service);
  const kitchenCommand = createInternalKitchenCommand(resources, persistence, service);
  const kitchenQuery = storePresence.wrap(
    presenceScope,
    createMerchantKitchenQuery({
      persistence,
      authentication: service,
      sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    }),
  );
  // WP-2423 Q26 (Handoff Section 26.6): remake a finished dish from the Kitchen board.
  const kitchenRework = createMerchantKitchenRework({
    persistence,
    authentication: service,
    nextReference: () => resources.credentials.reference(),
  });
  // DEC-KITCHEN-STALE-TICKETS: a manager closes an earlier business day's kitchen ticket.
  const kitchenStaleClose = createMerchantKitchenStaleClose({
    persistence,
    authentication: service,
    nextReference: () => resources.credentials.reference(),
  });
  const kitchenRelease = createMerchantKitchenRelease({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
  });
  const roleAdministration = createMerchantRoleAdministration({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
  });
  const staffAdministration = createMerchantStaffAdministration({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
  });
  const inventoryItems = createMerchantInventoryItems({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const stockPlaces = createMerchantStockPlaces({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const openingCount = createMerchantOpeningCount({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const storeReceipts = createMerchantStoreReceipts({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const recipes = createMerchantRecipes({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  // TEST-ONLY locale: the internal-test Brand writes its menu in Canadian English.
  const products = createMerchantProducts({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en-CA",
    // WP-2423 menu descriptions and photos (pilot storage adapter in the runtime directory).
    ...(productImageDirectory === undefined
      ? {}
      : { images: createPilotProductImages(productImageDirectory).service }),
  });
  const prices =
    loadPricingCurrencyMetadata === undefined
      ? undefined
      : createMerchantPrices({
          persistence,
          authentication: service,
          references: { next: () => resources.credentials.reference() },
          currencyMetadata: await loadPricingCurrencyMetadata(),
          locale: "en-CA",
        });
  const optionPrices =
    loadPricingCurrencyMetadata === undefined
      ? undefined
      : createMerchantOptionPrices({
          persistence,
          authentication: service,
          currencyMetadata: await loadPricingCurrencyMetadata(),
          locale: "en-CA",
        });
  const menus =
    loadPricingCurrencyMetadata === undefined
      ? undefined
      : createMerchantMenus({
          persistence,
          authentication: service,
          references: { next: () => resources.credentials.reference() },
          currencyMetadata: await loadPricingCurrencyMetadata(),
          locale: "en-CA",
        });
  const availability = createMerchantAvailability({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en-CA",
    // WP-2423 (2026-10-16): what guests see from stock, and why (short ingredients).
    ...(createInternalStaffStockShortage === undefined
      ? {}
      : { stock: await createInternalStaffStockShortage(resources) }),
  });
  const storeTax = createMerchantStoreTax({
    persistence,
    authentication: service,
    locale: "en-CA",
  });
  const optionRecipes = createMerchantOptionRecipes({
    persistence,
    authentication: service,
    locale: "en-CA",
  });
  const optionSets = createMerchantOptionSets({
    persistence,
    authentication: service,
    locale: "en-CA",
  });
  const taxClassifications = createMerchantTaxClassifications({
    persistence,
    authentication: service,
  });
  const allergens = createMerchantAllergens({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en-CA",
  });
  const stockCounts = createMerchantStockCounts({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const storeWaste = createMerchantStoreWaste({
    persistence,
    authentication: service,
    references: { next: () => resources.credentials.reference() },
    locale: "en",
  });
  const { pickupQuery, pickupProof, pickupHandoff, pickupNotCollected, pickupIdentityCheck } =
    await createInternalMerchantPickup(resources, { persistence, service });
  // WP-2423 Q4: store hours and holiday editing — a manager drafts, the owner approves and publishes.
  const storeConfiguration = await createInternalStoreConfiguration(resources, {
    persistence,
    service,
  });
  const orderQueue = logUnexpected(
    "INTERNAL_ORDER_QUEUE_UNAVAILABLE",
    createPersistentMerchantOrderQueue({
      persistence,
      quoteVersion: 2,
      acceptanceConfigured: true,
      locale: "en-CA",
      storePresence,
      resolveRefundConfiguration: async (tx, scope) => {
        const configuration = await refundConfiguration(tx, scope);
        return {
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        };
      },
    }),
  );
  return {
    ordinaryRefundReconciliation,
    ordinaryRefundSend,
    // WP-2423 Q18: a full sign-in on a registered tablet ends the PIN sessions left on it, in the
    // transaction that creates the new session.
    issue: (selector, purpose, deviceCookie) =>
      staffPin === undefined || deviceCookie === undefined
        ? session.issue(selector, purpose)
        : session.issue(selector, purpose, (tx, created) =>
            staffPin.endTabletPinSessions(tx, deviceCookie, created),
          ),
    staffChoices: session.staffChoices,
    persistence,
    service,
    orderQueue,
    kitchenQuery,
    kitchenCommand,
    kitchenRelease,
    pickupQuery,
    pickupProof,
    pickupHandoff,
    pickupNotCollected,
    pickupIdentityCheck,
    orderAcceptance,
    bff: {
      // WP-2423 Q18: TEST-ONLY staff sign-in page of the InternalTest pilot (the Cognito sign-in is
      // an external gate); staff see it labelled as test sign-in.
      signInEntry: { path: "/internal-test/staff", testOnly: true },
      ...(staffPin === undefined ? {} : { staffPin }),
      // WP-2423 Q4: busy mode — a manager pauses and resumes taking new online orders.
      ...(() => {
        const control = createMerchantServiceControl({
          persistence,
          authentication: service,
          audit: {
            reasonCode: "STORE_SERVICE_CONTROL",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        });
        return {
          serviceControl: control,
          serviceControlState: control.read,
          // WP-2423 Q21: the Store's current business day for every merchant "today".
          businessDay: control.businessDay,
        };
      })(),
      // WP-2423 Q4: refusals are answered to staff; unexpected failures are logged as codes only.
      storeConfiguration: logUnexpected(
        "INTERNAL_STORE_CONFIGURATION_UNAVAILABLE",
        storeConfiguration,
      ),
      storeConfigurationState: logUnexpected(
        "INTERNAL_STORE_CONFIGURATION_READ_UNAVAILABLE",
        storeConfiguration.read,
      ),
      // WP-2423 Q4: an hours change once the configuration came from Store setup.
      storeHoursDraft: logUnexpected(
        "INTERNAL_STORE_HOURS_DRAFT_UNAVAILABLE",
        storeConfiguration.hoursDraft,
      ),
      // WP-2423 (2026-10-16 v15): withdrawn hours leave Store setup too.
      storeHoursRestore: logUnexpected(
        "INTERNAL_STORE_HOURS_RESTORE_UNAVAILABLE",
        storeConfiguration.hoursRestore,
      ),
      taxConfigAuthoring: createMerchantTaxConfigAuthoring({
        persistence,
        authentication: service,
        nextReference: () => resources.credentials.reference(),
        ...(taxConfigCurrencyMetadata === undefined
          ? {}
          : { currencyMetadata: taxConfigCurrencyMetadata }),
      }),
      // WP-2423 Q15/Q16: Store setup reads and saves, including the step 5 fee classification read.
      ...(await createInternalStoreSetupBff(resources, {
        persistence,
        authentication: service,
        nextReference: () => resources.credentials.reference(),
      })),
      ...product,
      reconciliationEvidenceQuery,
      reconciliationFollowUp,
      reconciliationFollowUpQuery,
      orderExceptions,
      settlement,
      ...(operationsAlerts === undefined ? {} : { operationsAlerts }),
      storeReports,
      compensationReconciliation,
      compensationQuery,
      ...(unmatchedCaptureRefund === undefined ? {} : { unmatchedCaptureRefund }),
      orderStaffCancellation,
      ...(unpaidRoundCancellation === undefined ? {} : { unpaidRoundCancellation }),
      endedOrderStockRelease,
      ...(orderItemStaffCancellation === undefined ? {} : { orderItemStaffCancellation }),
      // WP-2423 Q7: counter pickup orders and card-machine payments and refunds.
      ...(createInternalCounterOrder === undefined
        ? {}
        : await (async () => {
            const counter = await createInternalCounterOrder(resources, persistence, service, {
              diningClosing,
              // WP-2423 (v15 3cd0f8dd M4): a machine refund of a cancelled round is on the receipt.
              issueRefundReceipt: issueOrderRefundReceipt,
            });
            return {
              ...counter,
              ...(counter.counterMenu === undefined
                ? {}
                : { counterMenu: storePresence.wrap(presenceScope, counter.counterMenu) }),
              ...(counter.counterOrder === undefined
                ? {}
                : { counterOrder: storePresence.wrap(presenceScope, counter.counterOrder) }),
              // WP-2423 D1: the server accepts a card-machine-paid order or table round with its
              // payment record (staff member's acceptance authority, the Order's current version).
              ...(counter.cardMachinePayment === undefined
                ? {}
                : {
                    cardMachinePayment: withPaidBatchAcceptance(counter.cardMachinePayment, {
                      accept: orderAcceptance,
                      nextReference: () => resources.credentials.reference(),
                      onNotAccepted: (error) =>
                        reportUnexpected("INTERNAL_CARD_MACHINE_ACCEPTANCE_NOT_MADE", error),
                    }),
                  }),
              // WP-2423 Q7 slice 2: staff-entered dine-in rounds for a table.
              ...(counter.staffDiningRound === undefined
                ? {}
                : {
                    staffDiningRound: storePresence.wrap(presenceScope, counter.staffDiningRound),
                  }),
            };
          })()),
      orderAcceptanceHoldRefund,
      ordinaryRefundSend,
      ordinaryRefundReconciliation,
      ordinaryRefund,
      diningHostSelection,
      diningHostTransfer,
      // WP-2423 Q5: refund reads log their real refusal code (no payload) for the operator.
      ordinaryRefundStatus: logUnexpected(
        "INTERNAL_REFUND_STATUS_UNAVAILABLE",
        ordinaryRefundStatus,
      ),
      refundPaymentContext: logUnexpected(
        "INTERNAL_REFUND_CONTEXT_UNAVAILABLE",
        refundPaymentContext,
      ),
      ordinaryRefundPreview: ordinaryRefundRequest.preview,
      ordinaryRefundItems: logUnexpected("INTERNAL_REFUND_ITEMS_UNAVAILABLE", ordinaryRefundItems),
      ordinaryRefundProgress: logUnexpected(
        "INTERNAL_REFUND_PROGRESS_UNAVAILABLE",
        createMerchantOrdinaryRefundProgress({
          persistence,
          authentication: service,
          resolveConfiguration: refundConfiguration,
          newReference: () => resources.credentials.reference(),
        }),
      ),
      ordinaryRefundRequest,
      cardMachineOrdinaryRefund,
      ordinaryRefundApproval,
      ordinaryRefundApprovals,
      ordinaryRefundDecline,
      ...(mfaStepUp === undefined ? {} : { mfaStepUp }),
      // WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner turns sole operator on/off.
      soleOperator: (() => {
        const soleOperator = createMerchantSoleOperator({
          persistence,
          authentication: service,
          resolveConfiguration: escalatedRefundConfiguration,
          retentionPolicyCode: "SECURITY_AUDIT",
          retentionPolicyVersion: 1,
        });
        return Object.assign(logUnexpected("INTERNAL_SOLE_OPERATOR_UNAVAILABLE", soleOperator), {
          read: logUnexpected("INTERNAL_SOLE_OPERATOR_READ_UNAVAILABLE", soleOperator.read),
        });
      })(),
      // WP-2423 Q15/Q16: Store setup → receipt registrations and privacy notice link.
      storeReceiptProfile: (() => {
        const profile = createMerchantStoreReceiptProfile({ persistence, authentication: service });
        return Object.assign(logUnexpected("INTERNAL_RECEIPT_PROFILE_UNAVAILABLE", profile), {
          read: logUnexpected("INTERNAL_RECEIPT_PROFILE_READ_UNAVAILABLE", profile.read),
        });
      })(),
      // WP-2423 DEC-STORE-CUSTOMER-NAME: Store setup → name, address and phone customers see.
      storePublicProfile: (() => {
        const profile = createMerchantStorePublicProfile({ persistence, authentication: service });
        return Object.assign(logUnexpected("INTERNAL_PUBLIC_PROFILE_UNAVAILABLE", profile), {
          read: logUnexpected("INTERNAL_PUBLIC_PROFILE_READ_UNAVAILABLE", profile.read),
        });
      })(),
      diningJoinState,
      diningJoinRegenerate,
      diningSessionStart,
      diningTables,
      diningTableCommand,
      ...(createInternalTableQr === undefined
        ? {}
        : { diningTableQr: createInternalTableQr(resources, persistence, service) }),
      diningClosing,
      orderClosure,
      taskInbox,
      diningServe,
      diningServeReady,
      diningOrderProgress,
      diningTableClosePlan,
      diningItemService,
      service,
      orderQueue,
      kitchenQuery,
      kitchenCommand,
      kitchenRelease,
      kitchenRework,
      kitchenStaleClose,
      roleAdministration,
      staffAdministration: {
        ...staffAdministration,
        command: logUnexpected("INTERNAL_STAFF_COMMAND_UNAVAILABLE", staffAdministration.command),
      },
      inventoryItems,
      stockPlaces,
      openingCount,
      storeReceipts,
      recipes,
      products,
      ...(prices === undefined ? {} : { prices }),
      allergens,
      ...(menus === undefined ? {} : { menus }),
      availability,
      optionSets,
      optionPrices,
      optionRecipes,
      storeTax,
      taxClassifications,
      stockCounts,
      storeWaste,
      pickupQuery,
      pickupProof,
      pickupHandoff,
      pickupNotCollected,
      pickupIdentityCheck,
      orderAcceptance,
      exactOrigin: "https://127.0.0.1:4443",
      acceptedHost: "127.0.0.1:4443",
    },
  };
}
