import { t } from "./i18n/i18n.js";
import { CurrentOrderDetailRoute, CurrentOrderQueuePage } from "./CurrentOrderQueuePage.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { usesWorkspaceLayout, WorkspaceLayout } from "./WorkspaceLayout.js";
import { StaffSessionGuard, StaffSignedOutPanel, StaffSwitchButton } from "./StaffSession.js";
import { OwnNamePrompt } from "./OwnNamePrompt.js";
import { StaffPinControls } from "./StaffPinControls.js";
import { StaffSwitchPage } from "./StaffSwitchPage.js";
import { StaffSignInPage } from "./StaffSignInPage.js";
import { StepUpCompletePage } from "./StepUpCompletePage.js";
import { pilotHiddenRedirect } from "./pilot-routes.js";
import { isOperationalScreen } from "./staff-session.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { StoreBusinessDayProvider } from "./StoreBusinessDay.js";
import { MerchantShell } from "./MerchantShell.js";
import { StoreOverview } from "./StoreOverview.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { KitchenBoardPage, KitchenWorkItemPage } from "./KitchenBoardPages.js";
import { createKitchenBoardClient } from "./kitchen-board-client.js";
import { parseKitchenBoardView, type KitchenBoardView } from "./kitchen-board.js";
import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";
import {
  RefundDeadlineWatch,
  refundDeadlinesFromOrders,
  type RefundRecheckResult,
} from "./RefundDeadlineWatch.js";
import { createStaffPinClient, StaffPinError } from "./staff-pin-client.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { loadLastKnownRefundDeadlines, type RefundDeadline } from "./refund-deadline-warning.js";
import type { MerchantDemoClients } from "./merchant-demo.js";
import type { MerchantBrandWorkspaceClient } from "./merchant-brand-workspace.js";
import { FULL_SIGN_IN_REQUIRED, needsFullSignIn } from "./full-sign-in.js";
import { lazyModule, lazyPage, PageChunkBoundary, WithModule } from "./route-chunks.js";
import {
  createMerchantWorkspaceClient,
  type MerchantWorkspaceClient,
  type MerchantWorkspaceSnapshot,
} from "./merchant-workspace.js";

/**
 * WP-2423 C2: only the shell, sign-in, Home, Orders and Kitchen are in the first download; every
 * other screen loads on first use (route-chunks.tsx). The other pilot screens are fetched in the
 * background once the workspace is ready, so they still open if the Wi-Fi drops later.
 */
const routeClients = lazyModule(() => import("./route-clients.js"));
const StoreReceiptPrivacyPanel = lazyPage(
  () => import("./StoreReceiptPrivacyPanel.js"),
  "StoreReceiptPrivacyPanel",
);
const StorePublicProfilePanel = lazyPage(
  () => import("./StorePublicProfilePanel.js"),
  "StorePublicProfilePanel",
);
const RefundPaymentPage = lazyPage(() => import("./RefundPaymentPage.js"), "RefundPaymentPage");
const DiningSessionWorkspace = lazyPage(
  () => import("./DiningSessionWorkspace.js"),
  "DiningSessionWorkspace",
);
const SettlementPage = lazyPage(() => import("./SettlementPage.js"), "SettlementPage");
const StoreReportsPage = lazyPage(() => import("./StoreReportsPage.js"), "StoreReportsPage");
const RefundApprovalsPage = lazyPage(
  () => import("./RefundApprovalsPage.js"),
  "RefundApprovalsPage",
);
const PickupQueuePage = lazyPage(() => import("./PickupPages.js"), "PickupQueuePage");
const OrderExceptionPage = lazyPage(() => import("./OrderExceptionPage.js"), "OrderExceptionPage");
const StoreMenuBuilderPage = lazyPage(() => import("./StoreMenuPages.js"), "StoreMenuBuilderPage");
const StoreMenuListPage = lazyPage(() => import("./StoreMenuPages.js"), "StoreMenuListPage");
const TaxConfigDraftPage = lazyPage(() => import("./TaxConfigDraftPage.js"), "TaxConfigDraftPage");
const StoreSetupDraftPage = lazyPage(
  () => import("./StoreSetupDraftPage.js"),
  "StoreSetupDraftPage",
);
const StoreOptionSetEditPage = lazyPage(
  () => import("./StoreOptionSetPages.js"),
  "StoreOptionSetEditPage",
);
const StoreOptionSetListPage = lazyPage(
  () => import("./StoreOptionSetPages.js"),
  "StoreOptionSetListPage",
);
const StoreOptionPricesPage = lazyPage(
  () => import("./StoreOptionPricesPage.js"),
  "StoreOptionPricesPage",
);
const StoreOptionRecipesPage = lazyPage(
  () => import("./StoreOptionRecipesPage.js"),
  "StoreOptionRecipesPage",
);
const StoreTaxReviewPage = lazyPage(() => import("./StoreTaxReviewPage.js"), "StoreTaxReviewPage");
const TaxClassificationsPage = lazyPage(
  () => import("./TaxClassificationsPage.js"),
  "TaxClassificationsPage",
);
const CurrentStoreCapabilityPage = lazyPage(
  () => import("./CurrentStoreCapabilityPage.js"),
  "CurrentStoreCapabilityPage",
);
const StoreServiceControlPanel = lazyPage(
  () => import("./StoreServiceControlPanel.js"),
  "StoreServiceControlPanel",
);
const KdsProfilePage = lazyPage(() => import("./KdsProfilePage.js"), "KdsProfilePage");
const OrderAmendmentPage = lazyPage(() => import("./OrderAmendmentPage.js"), "OrderAmendmentPage");
const StoreAvailabilityPage = lazyPage(
  () => import("./StoreAvailabilityPage.js"),
  "StoreAvailabilityPage",
);
const BundleEditorPage = lazyPage(() => import("./BundlePages.js"), "BundleEditorPage");
const BundleListPage = lazyPage(() => import("./BundlePages.js"), "BundleListPage");
const StorePriceEditorPage = lazyPage(() => import("./StorePricePages.js"), "StorePriceEditorPage");
const StorePriceListPage = lazyPage(() => import("./StorePricePages.js"), "StorePriceListPage");
const AllergenItemPage = lazyPage(
  () => import("./AllergenDeclarationPages.js"),
  "AllergenItemPage",
);
const AllergenListPage = lazyPage(
  () => import("./AllergenDeclarationPages.js"),
  "AllergenListPage",
);
const TaxConfigPage = lazyPage(() => import("./TaxConfigPage.js"), "TaxConfigPage");
const PromotionEditorPage = lazyPage(() => import("./PromotionPages.js"), "PromotionEditorPage");
const PromotionListPage = lazyPage(() => import("./PromotionPages.js"), "PromotionListPage");
const RecipeEditorPage = lazyPage(() => import("./RecipePages.js"), "RecipeEditorPage");
const RecipeListPage = lazyPage(() => import("./RecipePages.js"), "RecipeListPage");
const ProductEditorPage = lazyPage(() => import("./ProductPages.js"), "ProductEditorPage");
const ProductListPage = lazyPage(() => import("./ProductPages.js"), "ProductListPage");
const ProductionBatchPage = lazyPage(
  () => import("./ProductionBatchPage.js"),
  "ProductionBatchPage",
);
const TableQrCodesPage = lazyPage(() => import("./TableQrCodesPage.js"), "TableQrCodesPage");
const ReservationCalendarPage = lazyPage(
  () => import("./ReservationPages.js"),
  "ReservationCalendarPage",
);
const ReservationDetailPage = lazyPage(
  () => import("./ReservationPages.js"),
  "ReservationDetailPage",
);
const ReservationListPage = lazyPage(() => import("./ReservationPages.js"), "ReservationListPage");
const WaitlistBoardPage = lazyPage(() => import("./WaitlistPages.js"), "WaitlistBoardPage");
const CapacityPolicyPage = lazyPage(() => import("./CapacityPolicyPage.js"), "CapacityPolicyPage");
const StaffOrderEntryPage = lazyPage(
  () => import("./StaffOrderEntryPage.js"),
  "StaffOrderEntryPage",
);
const StockOverviewPage = lazyPage(() => import("./InventoryPages.js"), "StockOverviewPage");
const InventoryItemStockHistoryPage = lazyPage(
  () => import("./InventoryMovementPages.js"),
  "InventoryItemStockHistoryPage",
);
const InventoryMovementDetailPage = lazyPage(
  () => import("./InventoryMovementPages.js"),
  "InventoryMovementDetailPage",
);
const InventoryMovementListPage = lazyPage(
  () => import("./InventoryMovementPages.js"),
  "InventoryMovementListPage",
);
const InventoryTransferDetailPage = lazyPage(
  () => import("./InventoryTransferPages.js"),
  "InventoryTransferDetailPage",
);
const InventoryTransferListPage = lazyPage(
  () => import("./InventoryTransferPages.js"),
  "InventoryTransferListPage",
);
const InventoryLotExpiryPage = lazyPage(
  () => import("./InventoryLotExpiryPage.js"),
  "InventoryLotExpiryPage",
);
const InventoryReplenishmentPage = lazyPage(
  () => import("./InventoryReplenishmentPage.js"),
  "InventoryReplenishmentPage",
);
const DiscrepancyPage = lazyPage(() => import("./DiscrepancyPage.js"), "DiscrepancyPage");
const SupplierPerformancePage = lazyPage(
  () => import("./SupplierPerformancePage.js"),
  "SupplierPerformancePage",
);
const CustomerDetailPage = lazyPage(
  () => import("./CustomerProfilePages.js"),
  "CustomerDetailPage",
);
const CustomerListPage = lazyPage(() => import("./CustomerProfilePages.js"), "CustomerListPage");
const CustomerMergeReviewPage = lazyPage(
  () => import("./CustomerMergeReviewPage.js"),
  "CustomerMergeReviewPage",
);
const LoyaltyProgramEditorPage = lazyPage(
  () => import("./LoyaltyProgramPages.js"),
  "LoyaltyProgramEditorPage",
);
const LoyaltyProgramListPage = lazyPage(
  () => import("./LoyaltyProgramPages.js"),
  "LoyaltyProgramListPage",
);
const LoyaltyAccountDetailPage = lazyPage(
  () => import("./LoyaltyAccountPages.js"),
  "LoyaltyAccountDetailPage",
);
const PointsReviewPage = lazyPage(() => import("./LoyaltyAccountPages.js"), "PointsReviewPage");
const ConsentPreferencePage = lazyPage(
  () => import("./ConsentPreferencePage.js"),
  "ConsentPreferencePage",
);
const CommunicationHistoryPage = lazyPage(
  () => import("./CommunicationPages.js"),
  "CommunicationHistoryPage",
);
const CommunicationTemplatePage = lazyPage(
  () => import("./CommunicationPages.js"),
  "CommunicationTemplatePage",
);
const PrivacyRequestPage = lazyPage(() => import("./PrivacyRequestPage.js"), "PrivacyRequestPage");
const DeliveryDispatchPage = lazyPage(
  () => import("./DeliveryDispatchPage.js"),
  "DeliveryDispatchPage",
);
const DeliveryDetailPage = lazyPage(() => import("./DeliveryDetailPage.js"), "DeliveryDetailPage");
const DeliveryExceptionPage = lazyPage(
  () => import("./DeliveryExceptionPage.js"),
  "DeliveryExceptionPage",
);
const SupplierDetailPage = lazyPage(() => import("./SupplierPages.js"), "SupplierDetailPage");
const SupplierListPage = lazyPage(() => import("./SupplierPages.js"), "SupplierListPage");
const RequisitionDetailPage = lazyPage(
  () => import("./RequisitionPages.js"),
  "RequisitionDetailPage",
);
const RequisitionListPage = lazyPage(() => import("./RequisitionPages.js"), "RequisitionListPage");
const PurchaseOrderDetailPage = lazyPage(
  () => import("./PurchaseOrderPages.js"),
  "PurchaseOrderDetailPage",
);
const PurchaseOrderEditorPage = lazyPage(
  () => import("./PurchaseOrderPages.js"),
  "PurchaseOrderEditorPage",
);
const PurchaseOrderListPage = lazyPage(
  () => import("./PurchaseOrderPages.js"),
  "PurchaseOrderListPage",
);
const OfferingEditorPage = lazyPage(() => import("./OfferingPages.js"), "OfferingEditorPage");
const OfferingListPage = lazyPage(() => import("./OfferingPages.js"), "OfferingListPage");
const StoreDetailPage = lazyPage(() => import("./StoreAdminPages.js"), "StoreDetailPage");
const StoreHoursServicePage = lazyPage(
  () => import("./StoreAdminPages.js"),
  "StoreHoursServicePage",
);
const StoreListPage = lazyPage(() => import("./StoreAdminPages.js"), "StoreListPage");
const StoreSetupPage = lazyPage(() => import("./StoreAdminPages.js"), "StoreSetupPage");
const OperationalDashboardPage = lazyPage(
  () => import("./OperationalDashboardPage.js"),
  "OperationalDashboardPage",
);
const ReportBuilderPage = lazyPage(() => import("./ReportPages.js"), "ReportBuilderPage");
const ReportCatalogPage = lazyPage(() => import("./ReportPages.js"), "ReportCatalogPage");
const ReportRunHistoryPage = lazyPage(
  () => import("./ReportRunHistoryPage.js"),
  "ReportRunHistoryPage",
);
const PipelineRunPage = lazyPage(() => import("./PipelineRunPage.js"), "PipelineRunPage");
const TaskInboxPage = lazyPage(() => import("./TaskInboxPage.js"), "TaskInboxPage");
const TaskInboxStatePanel = lazyPage(() => import("./TaskInboxPage.js"), "TaskInboxStatePanel");
const ComplianceDashboardPage = lazyPage(
  () => import("./ComplianceDashboardPage.js"),
  "ComplianceDashboardPage",
);
const ComplianceCaseDetailPage = lazyPage(
  () => import("./ComplianceCasePages.js"),
  "ComplianceCaseDetailPage",
);
const ComplianceCaseListPage = lazyPage(
  () => import("./ComplianceCasePages.js"),
  "ComplianceCaseListPage",
);
const ComplianceCorrectiveActionPage = lazyPage(
  () => import("./ComplianceInspectionActionPages.js"),
  "ComplianceCorrectiveActionPage",
);
const ComplianceInspectionPage = lazyPage(
  () => import("./ComplianceInspectionActionPages.js"),
  "ComplianceInspectionPage",
);
const CleaningLogPage = lazyPage(() => import("./ComplianceMonitoringPages.js"), "CleaningLogPage");
const TemperatureLogPage = lazyPage(
  () => import("./ComplianceMonitoringPages.js"),
  "TemperatureLogPage",
);
const ComplianceQualificationPage = lazyPage(
  () => import("./ComplianceQualificationPage.js"),
  "ComplianceQualificationPage",
);
const ComplianceIncidentPage = lazyPage(
  () => import("./ComplianceAllergenIncidentPages.js"),
  "ComplianceIncidentPage",
);
const ComplianceTraceabilityPage = lazyPage(
  () => import("./ComplianceTraceabilityPage.js"),
  "ComplianceTraceabilityPage",
);
const ComplianceRecallCasePage = lazyPage(
  () => import("./ComplianceRecallCasePage.js"),
  "ComplianceRecallCasePage",
);
const CompliancePolicyPage = lazyPage(
  () => import("./CompliancePolicyPage.js"),
  "CompliancePolicyPage",
);
const DeviceDetailPage = lazyPage(() => import("./DevicePages.js"), "DeviceDetailPage");
const DeviceListPage = lazyPage(() => import("./DevicePages.js"), "DeviceListPage");
const ProviderIntegrationDetailPage = lazyPage(
  () => import("./ProviderIntegrationPages.js"),
  "ProviderIntegrationDetailPage",
);
const ProviderIntegrationListPage = lazyPage(
  () => import("./ProviderIntegrationPages.js"),
  "ProviderIntegrationListPage",
);
const ApiClientPage = lazyPage(() => import("./ApiClientPage.js"), "ApiClientPage");
const OperatingEntityDetailPage = lazyPage(
  () => import("./OperatingEntityPages.js"),
  "OperatingEntityDetailPage",
);
const OperatingEntityListPage = lazyPage(
  () => import("./OperatingEntityPages.js"),
  "OperatingEntityListPage",
);
const BrandListPage = lazyPage(() => import("./BrandAdminPages.js"), "BrandListPage");
const BrandAdministrationWorkspace = lazyPage(
  () => import("./BrandAdministrationWorkspace.js"),
  "BrandAdministrationWorkspace",
);
const FeatureFlagListPage = lazyPage(
  () => import("./FeatureControlAdminPages.js"),
  "FeatureFlagListPage",
);
const PlatformLiveGatePage = lazyPage(() => import("./LiveGatePages.js"), "PlatformLiveGatePage");
const StoreLiveGatePage = lazyPage(() => import("./LiveGatePages.js"), "StoreLiveGatePage");
const RoleEditorPage = lazyPage(() => import("./RoleAdministrationPages.js"), "RoleEditorPage");
const RoleListPage = lazyPage(() => import("./RoleAdministrationPages.js"), "RoleListPage");
const StaffDetailPage = lazyPage(() => import("./StaffAdministrationPages.js"), "StaffDetailPage");
const StaffListPage = lazyPage(() => import("./StaffAdministrationPages.js"), "StaffListPage");
const SupplyItemDetailPage = lazyPage(() => import("./SupplyItemPages.js"), "SupplyItemDetailPage");
const SupplyItemFormPage = lazyPage(() => import("./SupplyItemPages.js"), "SupplyItemFormPage");
const SupplyItemListPage = lazyPage(() => import("./SupplyItemPages.js"), "SupplyItemListPage");
const StockLocationListPage = lazyPage(
  () => import("./StockLocationPages.js"),
  "StockLocationListPage",
);
const OpeningCountPage = lazyPage(() => import("./OpeningCountPages.js"), "OpeningCountPage");
const StoreReceiptDetailPage = lazyPage(
  () => import("./StoreReceiptPages.js"),
  "StoreReceiptDetailPage",
);
const StoreReceiptFormPage = lazyPage(
  () => import("./StoreReceiptPages.js"),
  "StoreReceiptFormPage",
);
const StoreReceiptListPage = lazyPage(
  () => import("./StoreReceiptPages.js"),
  "StoreReceiptListPage",
);
const StockCountListPage = lazyPage(() => import("./StockCountPages.js"), "StockCountListPage");
const StockCountWorkbenchPage = lazyPage(
  () => import("./StockCountPages.js"),
  "StockCountWorkbenchPage",
);
const StoreWasteDetailPage = lazyPage(() => import("./StoreWastePages.js"), "StoreWasteDetailPage");
const StoreWasteFormPage = lazyPage(() => import("./StoreWastePages.js"), "StoreWasteFormPage");
const StoreWasteListPage = lazyPage(() => import("./StoreWastePages.js"), "StoreWasteListPage");
const ExportJobListPage = lazyPage(() => import("./ExportJobPages.js"), "ExportJobListPage");
const PlatformTenantDetailPage = lazyPage(
  () => import("./PlatformTenantPages.js"),
  "PlatformTenantDetailPage",
);
const PlatformTemplateWorkspace = lazyPage(
  () => import("./PlatformTemplateWorkspace.js"),
  "PlatformTemplateWorkspace",
);
const SupportCasePage = lazyPage(() => import("./SupportCasePages.js"), "SupportCasePage");
// WP-2423 (design "A"): staff PIN quick switch on a shared tablet, and its management page.
const StoreDevicesPage = lazyPage(() => import("./StoreDevicesPage.js"), "StoreDevicesPage");
const MetricCatalogPage = lazyPage(() => import("./MetricPages.js"), "MetricCatalogPage");
const MetricDetailPage = lazyPage(() => import("./MetricPages.js"), "MetricDetailPage");
const DataQualityPage = lazyPage(() => import("./DataQualityPages.js"), "DataQualityPage");
const ReconciliationPage = lazyPage(() => import("./DataQualityPages.js"), "ReconciliationPage");

/** The other pilot screens staff move to from Orders and Kitchen, fetched once the workspace is ready. */
const pilotScreens: readonly { readonly prefetch: () => void }[] = [
  PickupQueuePage,
  OrderExceptionPage,
  StaffOrderEntryPage,
  DiningSessionWorkspace,
  RefundPaymentPage,
  RefundApprovalsPage,
  SettlementPage,
  StoreAvailabilityPage,
  StoreMenuListPage,
  StoreMenuBuilderPage,
  routeClients,
];
function prefetchPilotScreens(): () => void {
  const start = () => {
    for (const screen of pilotScreens) screen.prefetch();
  };
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(start, { timeout: 5_000 });
    return () => globalThis.cancelIdleCallback(handle);
  }
  const handle = setTimeout(start, 2_000);
  return () => clearTimeout(handle);
}

/** Screens that work without a sign-in (and the sign-in window's last page). */
const sessionlessPaths: ReadonlySet<string> = new Set([
  "/operations/switch-staff",
  "/operations/sign-in",
  "/app/identity/step-up-complete",
]);

type WorkspaceState =
  | { readonly kind: "Loading" }
  | { readonly kind: "SignedOut" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Failure" }
  | {
      readonly kind: "Ready";
      readonly csrf: string;
      readonly switching: boolean;
      /** FullSignInRequired: a PIN sign-in must be confirmed before switching Store. */
      readonly switchFailed: boolean | typeof FULL_SIGN_IN_REQUIRED;
      readonly workspace: MerchantWorkspaceSnapshot;
    };

export interface AppProps {
  readonly client?: MerchantWorkspaceClient;
  readonly brandClient?: MerchantBrandWorkspaceClient;
  readonly demo?: MerchantDemoClients;
}

function LocalDemoRoute({
  notice: Notice,
  children,
}: {
  readonly notice: ComponentType | null;
  readonly children: ReactNode;
}) {
  return (
    <>
      {Notice === null ? null : <Notice />}
      {children}
    </>
  );
}

/**
 * WP-2423: while the session answer (or a Store switch) is in flight, a page that needs it shows a
 * neutral loading state; its "unavailable" text is shown only once the session is really refused.
 */
function SessionPending({
  pending,
  children,
}: {
  readonly pending: boolean;
  readonly children: ReactNode;
}) {
  if (!pending) return <>{children}</>;
  return (
    <StatePanel heading={t("Loading")} tone="neutral" status>
      <p>{t("Loading this page…")}</p>
    </StatePanel>
  );
}

function clientProps<T>(
  client: T | undefined,
): { readonly client?: never } | { readonly client: T } {
  return client === undefined ? {} : { client };
}

export function App({ client: injectedClient, brandClient, demo: injectedDemo }: AppProps = {}) {
  const demo = injectedDemo ?? null;
  const DemoOverview = demo?.Overview;
  const client = useMemo(
    () => injectedClient ?? demo?.workspace ?? createMerchantWorkspaceClient(),
    [demo?.workspace, injectedClient],
  );
  const [state, setState] = useState<WorkspaceState>({ kind: "Loading" });
  const { pathname, search } = useLocation();
  // WP-2423 Q17: the kitchen display reaches sold-out marking in its own kitchen-only frame.
  const soldOutFromKitchen =
    pathname === "/app/commerce/availability" &&
    new URLSearchParams(search).get("from") === "kitchen";
  const switching = useRef(false);
  const sessionPending =
    demo === null && (state.kind === "Loading" || (state.kind === "Ready" && state.switching));
  // WP-2423 "Warn before timeouts": every screen warns before a paid order nobody accepted is
  // refunded. Staff who can open Orders read it there; the kitchen display role reads it from the
  // kitchen board (order number and deadline only).
  const watchReady = demo === null && state.kind === "Ready" && !state.switching;
  const watchCsrf = watchReady && state.kind === "Ready" ? state.csrf : null;
  const watchStore = state.kind === "Ready" ? state.workspace.selectedScope : null;
  const watchStoreReference = watchStore?.storeReference ?? null;
  const watchStoreLabel = watchStore?.storeLabel ?? "";
  const watchOrdersHref =
    state.kind === "Ready"
      ? (state.workspace.navigation.find((item) => item.screenId === "OPS-ORDER-QUEUE")?.href ??
        null)
      : null;
  const watchKitchen =
    state.kind === "Ready" &&
    state.workspace.navigation.some((item) => item.screenId === "KIT-KITCHEN-QUEUE");
  const refundRead = useMemo(():
    ((signal: AbortSignal) => Promise<readonly RefundDeadline[] | null>) | null => {
    if (watchCsrf === null || watchStoreReference === null) return null;
    if (watchOrdersHref !== null) {
      const orders = createCurrentOrderQueueClient();
      return async (signal) => refundDeadlinesFromOrders(await orders.load(null, signal));
    }
    if (!watchKitchen) return null;
    const kitchen = createKitchenBoardClient({
      csrf: watchCsrf,
      storeReference: watchStoreReference,
      storeLabel: watchStoreLabel,
    });
    return async () => {
      const awaiting = await kitchen.loadAwaitingAcceptance();
      return awaiting === null
        ? null
        : awaiting.flatMap((label) =>
            label.acceptBy ? [{ orderNumber: label.orderNumber, acceptBy: label.acceptBy }] : [],
          );
    };
  }, [watchCsrf, watchStoreReference, watchStoreLabel, watchOrdersHref, watchKitchen]);

  // v15 c9b377cb: a visible screen counts as in use while a paid order waits for acceptance, and
  // the signed-out cover keeps the refund countdown in view.
  const [awaitingAcceptance, setAwaitingAcceptance] = useState(false);
  const [coverSlot, setCoverSlot] = useState<HTMLElement | null>(null);
  const onRefundDeadlines = useCallback((deadlines: readonly RefundDeadline[]) => {
    const now = Date.now();
    setAwaitingAcceptance(deadlines.some((deadline) => Date.parse(deadline.acceptBy) > now));
  }, []);
  // Without a sign-in (the PIN screen, a signed-out staff page) the screen shows what this tab
  // last knew, labelled with when it was checked; nothing is read without a Session.
  const remembered = useMemo(
    () =>
      demo === null &&
      (pathname === "/operations/switch-staff" ||
        pathname === "/operations/sign-in" ||
        state.kind === "SignedOut")
        ? loadLastKnownRefundDeadlines(Date.now())
        : null,
    [demo, pathname, state.kind],
  );
  // v15 cbff9d6f: without a sign-in, a registered Store tablet re-checks only the orders it shows
  // (numbers and times, no Customer details); anywhere else the countdown says it may be out of date.
  const tabletRecheck = useMemo(() => {
    if (demo !== null) return undefined;
    const pins = createStaffPinClient();
    return async (
      orderNumbers: readonly string[],
      signal: AbortSignal,
    ): Promise<RefundRecheckResult> => {
      try {
        const result = await pins.refundRecheck(orderNumbers, signal);
        return {
          kind: "Checked",
          deadlines: result.orders.flatMap((order) =>
            order.acceptBy === null
              ? []
              : [{ orderNumber: order.orderNumber, acceptBy: order.acceptBy }],
          ),
        };
      } catch (error) {
        return error instanceof StaffPinError && error.code === "NotRegistered"
          ? { kind: "NoTablet" }
          : { kind: "Failed" };
      }
    };
  }, [demo]);
  // v15 cbff9d6f: nothing reads with a sign-in that has ended (the business-day check included).
  const sessionLive = useStaffSessionLive();

  useEffect(() => {
    let active = true;
    void client
      .bootstrap()
      .then((result) => {
        if (!active) return;
        setState(
          result === null
            ? { kind: "SignedOut" }
            : {
                kind: "Ready",
                csrf: result.csrf,
                switching: false,
                switchFailed: false,
                workspace: result.workspace,
              },
        );
      })
      .catch(() => {
        if (active) setState({ kind: navigator.onLine ? "Failure" : "Offline" });
      });
    return () => {
      active = false;
    };
  }, [client]);

  const ready = state.kind === "Ready";
  useEffect(() => (ready ? prefetchPilotScreens() : undefined), [ready]);

  const switchStore = async (targetStoreReference: string) => {
    if (state.kind !== "Ready" || state.switching || switching.current) return;
    switching.current = true;
    const current = state;
    setState({ ...current, switching: true, switchFailed: false });
    try {
      const refreshed = await client.switchStore(current.csrf, targetStoreReference);
      setState({
        ...current,
        csrf: refreshed.csrf,
        switching: false,
        switchFailed: false,
        workspace: refreshed.workspace,
      });
    } catch (error) {
      setState({
        ...current,
        switching: false,
        switchFailed: needsFullSignIn(error) ? FULL_SIGN_IN_REQUIRED : true,
      });
    } finally {
      switching.current = false;
    }
  };

  // WP-2423 (2026-10-21 live check): who the kitchen board says is using this sign-in, kept while
  // the sign-in lasts, so the Kitchen pages open in the right frame without waiting for a read.
  const kitchenOperatorKey =
    state.kind === "Ready" ? state.workspace.selectedScope.storeReference + state.csrf : "";
  const [kitchenOperator, setKitchenOperator] = useState<{
    readonly key: string;
    readonly status: KitchenBoardView["operatorStatus"];
  } | null>(null);
  const knownKitchenOperator =
    kitchenOperator !== null && kitchenOperator.key === kitchenOperatorKey
      ? kitchenOperator.status
      : null;
  const onKnownKitchenOperator = useCallback(
    (status: KitchenBoardView["operatorStatus"]) =>
      setKitchenOperator((current) =>
        current?.key === kitchenOperatorKey && current.status === status
          ? current
          : { key: kitchenOperatorKey, status },
      ),
    [kitchenOperatorKey],
  );
  // The shared workspace frame: grouped navigation with the session actions beneath it.
  const workspaceFrame = (content: ReactNode) =>
    state.kind === "Ready" ? (
      <WorkspaceLayout
        items={state.workspace.navigation}
        path={pathname}
        storeLabel={state.workspace.selectedScope.storeLabel}
        footer={
          demo === null ? (
            <>
              <StaffSwitchButton />
              <StaffPinControls
                csrf={state.csrf}
                timeZone={state.workspace.selectedScope.timeZone}
              />
            </>
          ) : null
        }
      >
        {content}
      </WorkspaceLayout>
    ) : (
      content
    );

  const routeTree = (
    <Suspense
      fallback={
        <StatePanel heading={t("Loading")} tone="neutral" status>
          <p>{t("Loading this page…")}</p>
        </StatePanel>
      }
    >
      <Routes>
        <Route
          path="/app"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              <MerchantShell
                overview={DemoOverview === undefined ? null : <DemoOverview />}
                today={
                  demo === null && state.kind === "Ready" && !state.switching ? (
                    <StoreOverview
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      csrf={state.csrf}
                      storeReference={state.workspace.selectedScope.storeReference}
                      storeLabel={state.workspace.selectedScope.storeLabel}
                      timeZone={state.workspace.selectedScope.timeZone}
                      screens={state.workspace.navigation.map((item) => item.screenId)}
                    />
                  ) : undefined
                }
                prompt={
                  demo === null && state.kind === "Ready" && !state.switching ? (
                    <OwnNamePrompt
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      csrf={state.csrf}
                    />
                  ) : null
                }
                state={state}
                onSwitchStore={switchStore}
              />
            </LocalDemoRoute>
          }
        />
        <Route
          path="/app/tasks"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              {state.kind === "Ready" && !state.switching ? (
                <TaskInboxPage key={state.workspace.selectedScope.storeReference + state.csrf} />
              ) : (
                <AppFrame title={t("Tasks")} description="TASK-INBOX">
                  <TaskInboxStatePanel
                    state={
                      state.kind === "Offline"
                        ? "Offline"
                        : state.kind === "SignedOut"
                          ? "PermissionDenied"
                          : state.kind === "Failure"
                            ? "Unavailable"
                            : "Loading"
                    }
                  />
                </AppFrame>
              )}
            </LocalDemoRoute>
          }
        />
        <Route
          path="/app/organization/stores"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              <StoreListPage {...clientProps(demo?.storeAdmin)} />
            </LocalDemoRoute>
          }
        />
        <Route
          path="/app/organization/stores/:id/setup"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo !== null ? (
                  <StoreSetupPage {...clientProps(demo.storeAdmin)} />
                ) : state.kind === "Ready" && !state.switching ? (
                  <StoreSetupDraftPage
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    storeReference={state.workspace.selectedScope.storeReference}
                    csrf={state.csrf}
                    {...(state.workspace.navigation.some(
                      (item) => item.screenId === "CAT-TAX-CLASSIFICATION-LIST",
                    )
                      ? { taxClassificationsHref: "/app/commerce/tax-classifications" }
                      : {})}
                  >
                    {/* WP-2423 DEC-STORE-CUSTOMER-NAME: the name, address and phone customers see. */}
                    <StorePublicProfilePanel csrf={state.csrf} />
                    {/* WP-2423 Q15/Q16: receipt registrations and the privacy notice link. */}
                    <StoreReceiptPrivacyPanel csrf={state.csrf} />
                  </StoreSetupDraftPage>
                ) : (
                  <StatePanel heading={t("Store setup unavailable")} status>
                    <p>{t("A current merchant session and selected Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route
          path="/app/organization/stores/:id/service"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo !== null ? (
                  <StoreHoursServicePage {...clientProps(demo.storeAdmin)} />
                ) : state.kind === "Ready" && !state.switching ? (
                  <StoreServiceControlPanel
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    store={state.workspace.selectedScope.storeReference}
                    csrf={state.csrf}
                  />
                ) : (
                  <StatePanel heading={t("Hours and service unavailable")} status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route
          path="/app/organization/stores/:id/capabilities"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <CurrentStoreCapabilityPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  scope={{ storeReference: state.workspace.selectedScope.storeReference }}
                  csrf={state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                />
              ) : (
                <StatePanel heading={t("Store capabilities unavailable")} status>
                  <p>{t("A current merchant session and selected Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        <Route path="/app/organization/stores/:id/live-gate" element={<StoreLiveGatePage />} />
        <Route
          path="/app/organization/stores/:id"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              <StoreDetailPage {...clientProps(demo?.storeAdmin)} />
            </LocalDemoRoute>
          }
        />
        <Route path="/app/organization/features" element={<FeatureFlagListPage />} />
        <Route
          path="/app/organization/users"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StaffListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStaffPageClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StaffListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/organization/users/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StaffDetailPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStaffPageClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StaffDetailPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/organization/roles"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <RoleListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createRoleAdministrationPageClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <RoleListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/organization/roles/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <RoleEditorPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createRoleAdministrationPageClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <RoleEditorPage />
              )}
            </SessionPending>
          }
        />
        <Route path="/platform/live-gates" element={<PlatformLiveGatePage />} />
        <Route path="/platform/tenants" element={<PlatformTemplateWorkspace />} />
        <Route path="/platform/tenants/:id" element={<PlatformTenantDetailPage />} />
        <Route
          path="/platform/support-cases"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              <SupportCasePage {...clientProps(demo?.supportCase)} />
            </LocalDemoRoute>
          }
        />
        <Route path="/app/exports" element={<ExportJobListPage />} />
        <Route
          path="/app/commerce/option-sets"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreOptionSetListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOptionSetClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreOptionSetListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/option-sets/:optionSetId"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreOptionSetEditPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOptionSetClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreOptionSetEditPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/products"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <ProductListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createProductClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <ProductListPage />
              )}
            </SessionPending>
          }
        />
        {["/app/commerce/products/new", "/app/commerce/products/:id/edit"].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <SessionPending pending={sessionPending}>
                {state.kind === "Ready" && !state.switching ? (
                  <WithModule module={routeClients}>
                    {(clients) => (
                      <ProductEditorPage
                        key={state.workspace.selectedScope.storeReference + state.csrf}
                        client={clients.createProductClient(state.csrf)}
                      />
                    )}
                  </WithModule>
                ) : (
                  <ProductEditorPage />
                )}
              </SessionPending>
            }
          />
        ))}
        <Route
          path="/app/commerce/menus"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {!demo && state.kind === "Ready" && !state.switching ? (
                  <WithModule module={routeClients}>
                    {(clients) => (
                      <StoreMenuListPage
                        key={state.workspace.selectedScope.storeReference + state.csrf}
                        client={clients.createMenuClient(state.csrf)}
                      />
                    )}
                  </WithModule>
                ) : (
                  // The local demo has no menu source; it fails closed without application requests.
                  <StoreMenuListPage />
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/menus/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreMenuBuilderPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createMenuClient(state.csrf)}
                      csrf={state.csrf}
                      availability={clients.createAvailabilityClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreMenuBuilderPage />
              )}
            </SessionPending>
          }
        />
        <Route path="/app/commerce/bundles" element={<BundleListPage />} />
        <Route path="/app/commerce/bundles/:id/edit" element={<BundleEditorPage />} />
        <Route
          path="/app/commerce/availability"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreAvailabilityPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createAvailabilityClient(state.csrf)}
                      {...(soldOutFromKitchen
                        ? {
                            kitchenDisplay: {
                              storeLabel: state.workspace.selectedScope.storeLabel,
                              csrf: state.csrf,
                              soldOutHref: pathname,
                              // The kitchen board's own read says whether this is a kitchen display
                              // sign-in (presentation only; the server checks every request).
                              loadOperatorStatus: () =>
                                createKitchenBoardClient({
                                  csrf: state.csrf,
                                  storeLabel: state.workspace.selectedScope.storeLabel,
                                  storeReference: state.workspace.selectedScope.storeReference,
                                })
                                  .loadQueue()
                                  .then((value) => parseKitchenBoardView(value).operatorStatus),
                            },
                          }
                        : {})}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreAvailabilityPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/tax-review"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreTaxReviewPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createTaxReviewClient(state.csrf)}
                      storeSetupHref={`/app/organization/stores/${state.workspace.selectedScope.storeReference}/setup#receipts-and-privacy`}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreTaxReviewPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/tax-classifications"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <TaxClassificationsPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createTaxClassificationClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <TaxClassificationsPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/option-recipes"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreOptionRecipesPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOptionRecipeClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreOptionRecipesPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/option-prices"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreOptionPricesPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOptionPriceClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreOptionPricesPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/pricing"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StorePriceListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createPriceClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StorePriceListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/pricing/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StorePriceEditorPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createPriceClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <StorePriceEditorPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/tax"
          element={
            <SessionPending pending={sessionPending}>
              {demo !== null ? (
                <TaxConfigPage />
              ) : state.kind === "Ready" && !state.switching ? (
                <TaxConfigDraftPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  storeReference={state.workspace.selectedScope.storeReference}
                  csrf={state.csrf}
                />
              ) : (
                <StatePanel heading={t("Tax Configuration unavailable")} status>
                  <p>{t("A current merchant session and selected Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        <Route path="/app/commerce/promotions" element={<PromotionListPage />} />
        <Route path="/app/commerce/promotions/:id/edit" element={<PromotionEditorPage />} />
        <Route
          path="/app/commerce/recipes"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <RecipeListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createRecipeClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <RecipeListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/commerce/recipes/:id/edit"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <RecipeEditorPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createRecipeClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <RecipeEditorPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/orders"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo !== null ? (
                  <CurrentOrderQueuePage
                    storeLabel={demo.demoStore.storeLabel}
                    csrf="local-demo"
                    timeZone={demo.demoStore.timeZone}
                    fetcher={demo.merchantFetch}
                  />
                ) : state.kind === "Ready" && !state.switching ? (
                  <CurrentOrderQueuePage
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    storeLabel={state.workspace.selectedScope.storeLabel}
                    csrf={state.csrf}
                    timeZone={state.workspace.selectedScope.timeZone}
                  />
                ) : (
                  <StatePanel heading={t("Order Queue unavailable")} status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route path="/operations/delivery" element={<DeliveryDispatchPage />} />
        <Route path="/operations/delivery/:id" element={<DeliveryDetailPage />} />
        <Route path="/operations/delivery/exceptions" element={<DeliveryExceptionPage />} />
        {/* WP-2423 Q7: a pickup order taken at the counter, paid on the store's card machine. */}
        <Route
          path="/operations/order-entry"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <StaffOrderEntryPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                  csrf={state.csrf}
                  timeZone={state.workspace.selectedScope.timeZone}
                  tableQrHref={
                    state.workspace.navigation.find((item) => item.screenId === "DIN-TABLE-LIST")
                      ?.href
                  }
                />
              ) : (
                <StatePanel heading={t("Counter order unavailable")} status>
                  <p>{t("A current merchant session and Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        <Route path="/operations/inventory" element={<StockOverviewPage />} />
        <Route
          path="/operations/inventory/counts"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StockCountListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStockCountClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StockCountListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/inventory/counts/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StockCountWorkbenchPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStockCountClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StockCountWorkbenchPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/inventory/waste"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreWasteListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreWasteClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreWasteListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/inventory/waste/new"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreWasteFormPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreWasteClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreWasteFormPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/inventory/waste/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreWasteDetailPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreWasteClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreWasteDetailPage />
              )}
            </SessionPending>
          }
        />
        <Route path="/operations/inventory/transfers" element={<InventoryTransferListPage />} />
        <Route
          path="/operations/inventory/transfers/:id"
          element={<InventoryTransferDetailPage />}
        />
        <Route path="/operations/inventory/lots" element={<InventoryLotExpiryPage />} />
        <Route
          path="/operations/receiving"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreReceiptListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreReceiptClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreReceiptListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/receiving/new"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreReceiptFormPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreReceiptClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreReceiptFormPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/receiving/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StoreReceiptDetailPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStoreReceiptClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StoreReceiptDetailPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/opening-count"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <OpeningCountPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOpeningCountClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <OpeningCountPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/opening-count/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <OpeningCountPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createOpeningCountClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <OpeningCountPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/locations"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <StockLocationListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createStockLocationClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <StockLocationListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/items"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <SupplyItemListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createSupplyItemClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <SupplyItemListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/items/new"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <SupplyItemFormPage
                      mode="Create"
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createSupplyItemClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <SupplyItemFormPage mode="Create" />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/supply/items/:id/edit"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <SupplyItemFormPage
                      mode="Edit"
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createSupplyItemClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <SupplyItemFormPage mode="Edit" />
              )}
            </SessionPending>
          }
        />
        <Route path="/app/supply/items/:id/movements" element={<InventoryItemStockHistoryPage />} />
        <Route
          path="/app/supply/items/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <SupplyItemDetailPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createSupplyItemClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <SupplyItemDetailPage />
              )}
            </SessionPending>
          }
        />
        <Route path="/app/supply/movements" element={<InventoryMovementListPage />} />
        <Route path="/app/supply/movements/:id" element={<InventoryMovementDetailPage />} />
        <Route path="/app/supply/replenishment" element={<InventoryReplenishmentPage />} />
        <Route path="/app/supply/requisitions" element={<RequisitionListPage />} />
        <Route path="/app/supply/requisitions/:id" element={<RequisitionDetailPage />} />
        <Route path="/app/supply/purchase-orders" element={<PurchaseOrderListPage />} />
        <Route path="/app/supply/purchase-orders/:id/edit" element={<PurchaseOrderEditorPage />} />
        <Route path="/app/supply/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
        <Route path="/app/supply/discrepancies" element={<DiscrepancyPage />} />
        <Route path="/app/supply/performance" element={<SupplierPerformancePage />} />
        {/* WP-2423 Q14: the Store's sales reports for a signed-in Owner or Store Manager; the
          Phase 3 dashboard contract stays for the local demo only. */}
        <Route
          path="/app/reports/operations"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <StoreReportsPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                />
              ) : demo !== null ? (
                <OperationalDashboardPage />
              ) : (
                <WorkspacePage title={t("Reports")}>
                  <StatePanel heading={t("Reports unavailable")} tone="error" status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                </WorkspacePage>
              )}
            </SessionPending>
          }
        />
        <Route path="/app/reports/metrics" element={<MetricCatalogPage />} />
        <Route path="/app/reports/metrics/:id" element={<MetricDetailPage />} />
        <Route path="/app/reports" element={<ReportCatalogPage />} />
        <Route path="/app/reports/:id/edit" element={<ReportBuilderPage />} />
        <Route path="/app/reports/runs" element={<ReportRunHistoryPage />} />
        <Route path="/app/reports/pipelines" element={<PipelineRunPage />} />
        <Route path="/app/reports/data-quality" element={<DataQualityPage />} />
        <Route path="/app/reports/reconciliation" element={<ReconciliationPage />} />
        <Route
          path="/app/compliance"
          element={
            <LocalDemoRoute notice={demo?.Notice ?? null}>
              <ComplianceDashboardPage {...clientProps(demo?.complianceDashboard)} />
            </LocalDemoRoute>
          }
        />
        <Route path="/app/compliance/cases" element={<ComplianceCaseListPage />} />
        <Route path="/app/compliance/cases/:id" element={<ComplianceCaseDetailPage />} />
        <Route path="/app/compliance/inspections" element={<ComplianceInspectionPage />} />
        <Route path="/app/compliance/actions" element={<ComplianceCorrectiveActionPage />} />
        <Route path="/operations/compliance/temperature" element={<TemperatureLogPage />} />
        <Route path="/operations/compliance/cleaning" element={<CleaningLogPage />} />
        <Route path="/app/compliance/qualifications" element={<ComplianceQualificationPage />} />
        <Route
          path="/app/compliance/allergens"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <AllergenListPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createAllergenClient(state.csrf)}
                      csrf={state.csrf}
                    />
                  )}
                </WithModule>
              ) : (
                <AllergenListPage />
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/compliance/allergens/:id"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <WithModule module={routeClients}>
                  {(clients) => (
                    <AllergenItemPage
                      key={state.workspace.selectedScope.storeReference + state.csrf}
                      client={clients.createAllergenClient(state.csrf)}
                    />
                  )}
                </WithModule>
              ) : (
                <AllergenItemPage />
              )}
            </SessionPending>
          }
        />
        <Route path="/app/compliance/incidents/:id" element={<ComplianceIncidentPage />} />
        <Route path="/app/compliance/traceability" element={<ComplianceTraceabilityPage />} />
        <Route path="/app/compliance/recalls/:id" element={<ComplianceRecallCasePage />} />
        <Route path="/app/compliance/policies" element={<CompliancePolicyPage />} />
        <Route path="/app/compliance/policies/:id" element={<CompliancePolicyPage />} />
        <Route path="/app/integrations/devices" element={<DeviceListPage />} />
        <Route path="/app/integrations/devices/:id" element={<DeviceDetailPage />} />
        <Route path="/app/integrations/providers" element={<ProviderIntegrationListPage />} />
        <Route path="/app/integrations/providers/:id" element={<ProviderIntegrationDetailPage />} />
        <Route path="/app/integrations/api-clients" element={<ApiClientPage />} />
        <Route path="/app/organization/entities" element={<OperatingEntityListPage />} />
        <Route path="/app/organization/entities/:id" element={<OperatingEntityDetailPage />} />
        <Route path="/app/organization/brands" element={<BrandListPage />} />
        <Route
          path="/app/organization/brands/:id"
          element={
            <BrandAdministrationWorkspace
              {...(brandClient === undefined ? {} : { client: brandClient })}
              {...(state.kind === "Ready" && !state.switching
                ? {
                    topologyCsrf: state.csrf,
                    topologyStoreReference: state.workspace.selectedScope.storeReference,
                  }
                : {})}
            />
          }
        />
        <Route path="/app/customers" element={<CustomerListPage />} />
        <Route path="/app/customers/loyalty-programs" element={<LoyaltyProgramListPage />} />
        <Route path="/app/customers/loyalty-programs/:id" element={<LoyaltyProgramEditorPage />} />
        <Route path="/app/customers/loyalty-accounts/:id" element={<LoyaltyAccountDetailPage />} />
        <Route path="/app/customers/loyalty-exceptions" element={<PointsReviewPage />} />
        <Route path="/app/customers/consents/:customerId" element={<ConsentPreferencePage />} />
        <Route path="/app/customers/communications" element={<CommunicationHistoryPage />} />
        <Route path="/app/customers/templates" element={<CommunicationTemplatePage />} />
        <Route path="/app/customers/templates/:id" element={<CommunicationTemplatePage />} />
        <Route path="/app/compliance/privacy-requests" element={<PrivacyRequestPage />} />
        <Route
          path="/app/customers/merge-reviews/:reviewId"
          element={<CustomerMergeReviewPage />}
        />
        <Route path="/app/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/app/supply/suppliers" element={<SupplierListPage />} />
        <Route path="/app/supply/suppliers/:id" element={<SupplierDetailPage />} />
        <Route path="/app/supply/offerings" element={<OfferingListPage />} />
        <Route path="/app/supply/offerings/:id" element={<OfferingEditorPage />} />
        <Route
          path="/operations/orders/:id"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo !== null ? (
                  <CurrentOrderDetailRoute
                    storeLabel={demo.demoStore.storeLabel}
                    csrf="local-demo"
                    timeZone={demo.demoStore.timeZone}
                    fetcher={demo.merchantFetch}
                  />
                ) : state.kind === "Ready" && !state.switching ? (
                  <CurrentOrderDetailRoute
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    storeLabel={state.workspace.selectedScope.storeLabel}
                    csrf={state.csrf}
                    timeZone={state.workspace.selectedScope.timeZone}
                  />
                ) : (
                  <StatePanel heading={t("Order unavailable")} status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        {["/app/operations/payments/:id", "/app/operations/payments/:id/refund"].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <SessionPending pending={sessionPending}>
                {state.kind === "Ready" && !state.switching ? (
                  <RefundPaymentPage
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    csrf={state.csrf}
                    storeLabel={state.workspace.selectedScope.storeLabel}
                  />
                ) : (
                  <StatePanel heading={t("Payment unavailable")} status>
                    <p>{t("Sign in and select a Store to continue.")}</p>
                  </StatePanel>
                )}
              </SessionPending>
            }
          />
        ))}
        <Route path="/operations/orders/:id/amend" element={<OrderAmendmentPage />} />
        <Route
          path="/operations/kitchen"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo?.kitchenBoard ? (
                  <KitchenBoardPage client={demo.kitchenBoard} />
                ) : state.kind === "Ready" && !state.switching ? (
                  <KitchenBoardPage
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    csrf={state.csrf}
                    storeReference={state.workspace.selectedScope.storeReference}
                    storeLabel={state.workspace.selectedScope.storeLabel}
                    soldOutHref={
                      state.workspace.navigation.find(
                        (item) => item.screenId === "CAT-AVAILABILITY",
                      )?.href
                    }
                    workspaceFrame={workspaceFrame}
                    knownOperator={knownKitchenOperator}
                    onKnownOperator={onKnownKitchenOperator}
                  />
                ) : (
                  <StatePanel heading={t("Kitchen unavailable")}>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route path="/operations/production-batches" element={<ProductionBatchPage />} />
        <Route
          path="/operations/dining"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <DiningSessionWorkspace
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                  timeZone={state.workspace.selectedScope.timeZone}
                  canTakeOrders={state.workspace.navigation.some(
                    (item) => item.screenId === "OPS-ORDER-ENTRY",
                  )}
                  tableQrHref={
                    state.workspace.navigation.find((item) => item.screenId === "DIN-TABLE-LIST")
                      ?.href
                  }
                />
              ) : (
                <StatePanel heading={t("Dining unavailable")}>
                  <p>{t("A current merchant session and Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        <Route path="/operations/reservations/calendar" element={<ReservationCalendarPage />} />
        <Route path="/operations/reservations/:id" element={<ReservationDetailPage />} />
        <Route path="/operations/reservations" element={<ReservationListPage />} />
        <Route path="/operations/waitlist" element={<WaitlistBoardPage />} />
        <Route path="/app/operations/reservation-capacity" element={<CapacityPolicyPage />} />
        <Route
          path="/operations/kitchen/work-items/:id"
          element={
            <SessionPending pending={sessionPending}>
              <LocalDemoRoute notice={demo?.Notice ?? null}>
                {demo?.kitchenBoard ? (
                  <KitchenWorkItemPage client={demo.kitchenBoard} />
                ) : state.kind === "Ready" && !state.switching ? (
                  <KitchenWorkItemPage
                    key={state.workspace.selectedScope.storeReference + state.csrf}
                    csrf={state.csrf}
                    storeReference={state.workspace.selectedScope.storeReference}
                    storeLabel={state.workspace.selectedScope.storeLabel}
                    workspaceFrame={workspaceFrame}
                    knownOperator={knownKitchenOperator}
                    onKnownOperator={onKnownKitchenOperator}
                  />
                ) : (
                  <StatePanel heading={t("Kitchen work item unavailable")}>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                )}
              </LocalDemoRoute>
            </SessionPending>
          }
        />
        <Route
          path="/operations/pickup"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <PickupQueuePage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                  storeReference={state.workspace.selectedScope.storeReference}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                />
              ) : (
                <StatePanel heading={t("Pickup Queue unavailable")}>
                  <p>{t("A current merchant session and Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        <Route path="/app/integrations/kds-profiles" element={<KdsProfilePage />} />
        {/* WP-2423 Q11: table QR codes (Section 88 DIN-TABLE-LIST). */}
        <Route
          path="/app/operations/tables"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <TableQrCodesPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                  timeZone={state.workspace.selectedScope.timeZone}
                />
              ) : (
                <WorkspacePage title={t("Table QR codes")}>
                  <StatePanel heading={t("Table QR codes unavailable")} tone="error" status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                </WorkspacePage>
              )}
            </SessionPending>
          }
        />
        {/* WP-2423 Q5: Section 88 APPROVAL-INBOX — refunds awaiting an Owner/Finance approval. */}
        <Route
          path="/app/approvals"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <RefundApprovalsPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                />
              ) : (
                <WorkspacePage title={t("Approvals")}>
                  <StatePanel heading={t("Approvals unavailable")} tone="error" status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                </WorkspacePage>
              )}
            </SessionPending>
          }
        />
        <Route
          path="/app/operations/payment-reconciliation"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <SettlementPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                  timeZone={state.workspace.selectedScope.timeZone}
                />
              ) : (
                <WorkspacePage title={t("Settlement")}>
                  <StatePanel heading={t("Settlement unavailable")} tone="error" status>
                    <p>{t("A current merchant session and Store are required.")}</p>
                  </StatePanel>
                </WorkspacePage>
              )}
            </SessionPending>
          }
        />
        <Route
          path="/operations/order-exceptions"
          element={
            <SessionPending pending={sessionPending}>
              {state.kind === "Ready" && !state.switching ? (
                <OrderExceptionPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                />
              ) : (
                <StatePanel heading={t("Exceptions unavailable")} tone="error" status>
                  <p>{t("A current merchant session and Store are required.")}</p>
                </StatePanel>
              )}
            </SessionPending>
          }
        />
        {/* WP-2423 (design "A"): staff switch to themselves with their PIN; no sign-in needed. */}
        <Route path="/operations/switch-staff" element={<StaffSwitchPage />} />
        {/* WP-2423 DEC-COGNITO-STORE-STAFF: staff sign in with their own account; no sign-in needed. */}
        <Route path="/operations/sign-in" element={<StaffSignInPage />} />
        {/* The kitchen display sign-in comes back here; the server started a kitchen display. */}
        <Route
          path="/operations/kitchen/start"
          element={<Navigate replace to="/operations/kitchen" />}
        />
        {/* Where the "confirm it is you" sign-in window ends; tells the page that opened it. */}
        <Route path="/app/identity/step-up-complete" element={<StepUpCompletePage />} />
        {/* WP-2423 (design "A"): Section 88 IAM-SESSION-LIST — shared tablets and staff PINs. */}
        <Route
          path="/app/organization/sessions"
          element={
            <SessionPending pending={sessionPending}>
              {demo === null && state.kind === "Ready" && !state.switching ? (
                <StoreDevicesPage
                  key={state.workspace.selectedScope.storeReference + state.csrf}
                  csrf={state.csrf}
                  storeLabel={state.workspace.selectedScope.storeLabel}
                  timeZone={state.workspace.selectedScope.timeZone}
                />
              ) : (
                <WorkspacePage title={t("Shared tablets & PINs")}>
                  <StaffSignedOutPanel
                    message={t("Sign in to manage this store's shared tablets and staff PINs.")}
                  />
                </WorkspacePage>
              )}
            </SessionPending>
          }
        />
        <Route path="*" element={<Navigate replace to="/app" />} />
      </Routes>
    </Suspense>
  );
  // v15 aa3d9fac D3 (pilot rule "no reachable stubs"): a screen still without real sources is a
  // local-demo layout review; in the workspace its address goes to the nearest working screen.
  const hiddenTo =
    demo === null
      ? pilotHiddenRedirect(
          pathname,
          state.kind === "Ready" ? state.workspace.navigation.map((item) => item.screenId) : null,
        )
      : null;
  // A screen whose code did not arrive offers "Try again" in place of the page.
  const routes =
    hiddenTo !== null ? (
      <Navigate replace to={hiddenTo} />
    ) : (
      <PageChunkBoundary resetKey={pathname}>{routeTree}</PageChunkBoundary>
    );
  // WP-2423 Q18: a staff page opened without a Session offers the sign-in that works here.
  const staffPage =
    pathname !== "/operations/kitchen/start" &&
    (isOperationalScreen(pathname) || pathname.startsWith("/app/operations/"));
  // Pages shown without a sign-in, or in the sign-in window: no session watch, no store warnings.
  const sessionless = sessionlessPaths.has(pathname);
  return (
    <StoreTimeZoneContext.Provider
      value={state.kind === "Ready" ? state.workspace.selectedScope.timeZone : undefined}
    >
      <StoreBusinessDayProvider
        initialBusinessDate={state.kind === "Ready" ? state.workspace.businessDate : null}
        scopeKey={
          state.kind === "Ready" ? state.workspace.selectedScope.storeReference + state.csrf : ""
        }
        enabled={state.kind === "Ready" && !state.switching && demo === null && sessionLive}
      >
        {/* WP-2423 "Warn before timeouts": above every screen, before its own header. */}
        {refundRead !== null && !sessionless ? (
          <RefundDeadlineWatch
            key={(watchStoreReference ?? "") + (watchCsrf ?? "")}
            read={refundRead}
            ordersHref={watchOrdersHref}
            onOrdersPage={pathname === "/operations/orders"}
            signedOut={coverSlot !== null}
            {...(tabletRecheck === undefined ? {} : { recheck: tabletRecheck })}
            portal={coverSlot}
            timeZone={state.kind === "Ready" ? state.workspace.selectedScope.timeZone : undefined}
            remember
            onDeadlines={onRefundDeadlines}
          />
        ) : remembered !== null ? (
          <RefundDeadlineWatch
            read={null}
            ordersHref={null}
            onOrdersPage={false}
            signedOut
            canAccept={remembered.canAccept}
            initial={remembered}
            {...(tabletRecheck === undefined ? {} : { recheck: tabletRecheck })}
            timeZone={remembered.timeZone ?? undefined}
            remember
          />
        ) : null}
        {state.kind === "Ready" && usesWorkspaceLayout(pathname) && !soldOutFromKitchen ? (
          workspaceFrame(routes)
        ) : state.kind === "SignedOut" && demo === null && staffPage ? (
          <AppFrame title={t("Operations")} description={t("Store workspace")}>
            <StaffSignedOutPanel />
          </AppFrame>
        ) : (
          routes
        )}
        {/* WP-2423 Q18: keep the Session alive while staff work; warn before it ends. */}
        {state.kind === "Ready" && demo === null && !sessionless ? (
          <StaffSessionGuard
            key={state.csrf}
            csrf={state.csrf}
            path={pathname}
            timeZone={state.workspace.selectedScope.timeZone}
            awaitingAcceptance={refundRead !== null && awaitingAcceptance}
            onCover={setCoverSlot}
          />
        ) : null}
      </StoreBusinessDayProvider>
    </StoreTimeZoneContext.Provider>
  );
}
