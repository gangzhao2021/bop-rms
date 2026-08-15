import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { MerchantShell } from "./MerchantShell.js";
import { KitchenBoardPage, KitchenWorkItemPage } from "./KitchenBoardPages.js";
import { PickupQueuePage } from "./PickupPages.js";
import { KdsProfilePage } from "./KdsProfilePage.js";
import { OrderExceptionPage } from "./OrderExceptionPage.js";
import { OrderDetailPage, OrderQueuePage } from "./OrderQueuePages.js";
import { OrderAmendmentPage } from "./OrderAmendmentPage.js";
import { MenuBuilderPage, MenuListPage } from "./CatalogMenuPages.js";
import { BundleEditorPage, BundleListPage } from "./BundlePages.js";
import { AvailabilityWorkbenchPage } from "./AvailabilityWorkbenchPage.js";
import { PriceBookEditorPage, PriceBookListPage } from "./PriceBookPages.js";
import { TaxConfigPage } from "./TaxConfigPage.js";
import { PromotionEditorPage, PromotionListPage } from "./PromotionPages.js";
import { RecipeEditorPage, RecipeListPage } from "./RecipePages.js";
import { ProductionBatchPage } from "./ProductionBatchPage.js";
import { DiningFloorPage, DiningTableListPage } from "./DiningPages.js";
import {
  ReservationCalendarPage,
  ReservationDetailPage,
  ReservationListPage,
} from "./ReservationPages.js";
import { WaitlistBoardPage } from "./WaitlistPages.js";
import { CapacityPolicyPage } from "./CapacityPolicyPage.js";
import { StaffOrderEntryPage } from "./StaffOrderEntryPage.js";
import {
  InventoryItemCreatePage,
  InventoryItemDetailPage,
  InventoryItemEditPage,
  InventoryItemListPage,
  StockOverviewPage,
} from "./InventoryPages.js";
import {
  InventoryItemStockHistoryPage,
  InventoryMovementDetailPage,
  InventoryMovementListPage,
} from "./InventoryMovementPages.js";
import { InventoryCountListPage, InventoryCountWorkbenchPage } from "./InventoryCountPages.js";
import { InventoryWastePage } from "./InventoryWasteWizard.js";
import {
  InventoryTransferDetailPage,
  InventoryTransferListPage,
} from "./InventoryTransferPages.js";
import { InventoryLotExpiryPage } from "./InventoryLotExpiryPage.js";
import { InventoryReplenishmentPage } from "./InventoryReplenishmentPage.js";
import { GoodsReceiptPage } from "./GoodsReceiptPage.js";
import { DiscrepancyPage } from "./DiscrepancyPage.js";
import { SupplierPerformancePage } from "./SupplierPerformancePage.js";
import { CustomerDetailPage, CustomerListPage } from "./CustomerProfilePages.js";
import { CustomerMergeReviewPage } from "./CustomerMergeReviewPage.js";
import { LoyaltyProgramEditorPage, LoyaltyProgramListPage } from "./LoyaltyProgramPages.js";
import { LoyaltyAccountDetailPage, PointsReviewPage } from "./LoyaltyAccountPages.js";
import { ConsentPreferencePage } from "./ConsentPreferencePage.js";
import { CommunicationHistoryPage, CommunicationTemplatePage } from "./CommunicationPages.js";
import { PrivacyRequestPage } from "./PrivacyRequestPage.js";
import { DeliveryDispatchPage } from "./DeliveryDispatchPage.js";
import { DeliveryDetailPage } from "./DeliveryDetailPage.js";
import { DeliveryExceptionPage } from "./DeliveryExceptionPage.js";
import { SupplierDetailPage, SupplierListPage } from "./SupplierPages.js";
import { RequisitionDetailPage, RequisitionListPage } from "./RequisitionPages.js";
import {
  PurchaseOrderDetailPage,
  PurchaseOrderEditorPage,
  PurchaseOrderListPage,
} from "./PurchaseOrderPages.js";
import { OfferingEditorPage, OfferingListPage } from "./OfferingPages.js";
import { StoreDetailPage, StoreListPage, StoreSetupPage } from "./StoreAdminPages.js";
import { OperationalDashboardPage } from "./OperationalDashboardPage.js";
import { ReportBuilderPage, ReportCatalogPage } from "./ReportPages.js";
import { ReportRunHistoryPage } from "./ReportRunHistoryPage.js";
import { PipelineRunPage } from "./PipelineRunPage.js";
import { ComplianceDashboardPage } from "./ComplianceDashboardPage.js";
import { ComplianceCaseDetailPage, ComplianceCaseListPage } from "./ComplianceCasePages.js";
import {
  ComplianceCorrectiveActionPage,
  ComplianceInspectionPage,
} from "./ComplianceInspectionActionPages.js";
import { CleaningLogPage, TemperatureLogPage } from "./ComplianceMonitoringPages.js";
import { ComplianceQualificationPage } from "./ComplianceQualificationPage.js";
import {
  ComplianceAllergenReviewPage,
  ComplianceIncidentPage,
} from "./ComplianceAllergenIncidentPages.js";
import { MetricCatalogPage, MetricDetailPage } from "./MetricPages.js";
import { DataQualityPage, ReconciliationPage } from "./DataQualityPages.js";
import {
  createMerchantWorkspaceClient,
  type MerchantWorkspaceClient,
  type MerchantWorkspaceSnapshot,
} from "./merchant-workspace.js";

type WorkspaceState =
  | { readonly kind: "Loading" }
  | { readonly kind: "SignedOut" }
  | { readonly kind: "Offline" }
  | { readonly kind: "Failure" }
  | {
      readonly kind: "Ready";
      readonly csrf: string;
      readonly switching: boolean;
      readonly switchFailed: boolean;
      readonly workspace: MerchantWorkspaceSnapshot;
    };

export interface AppProps {
  readonly client?: MerchantWorkspaceClient;
}

export function App({ client: injectedClient }: AppProps = {}) {
  const client = useMemo(() => injectedClient ?? createMerchantWorkspaceClient(), [injectedClient]);
  const [state, setState] = useState<WorkspaceState>({ kind: "Loading" });
  const switching = useRef(false);

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
    } catch {
      setState({ ...current, switching: false, switchFailed: true });
    } finally {
      switching.current = false;
    }
  };

  return (
    <Routes>
      <Route path="/app" element={<MerchantShell state={state} onSwitchStore={switchStore} />} />
      <Route path="/app/organization/stores" element={<StoreListPage />} />
      <Route path="/app/organization/stores/:id/setup" element={<StoreSetupPage />} />
      <Route path="/app/organization/stores/:id" element={<StoreDetailPage />} />
      <Route path="/app/commerce/menus" element={<MenuListPage />} />
      <Route path="/app/commerce/menus/:id/edit" element={<MenuBuilderPage />} />
      <Route path="/app/commerce/bundles" element={<BundleListPage />} />
      <Route path="/app/commerce/bundles/:id/edit" element={<BundleEditorPage />} />
      <Route path="/app/commerce/availability" element={<AvailabilityWorkbenchPage />} />
      <Route path="/app/commerce/pricing" element={<PriceBookListPage />} />
      <Route path="/app/commerce/pricing/:id" element={<PriceBookEditorPage />} />
      <Route path="/app/commerce/tax" element={<TaxConfigPage />} />
      <Route path="/app/commerce/promotions" element={<PromotionListPage />} />
      <Route path="/app/commerce/promotions/:id/edit" element={<PromotionEditorPage />} />
      <Route path="/app/commerce/recipes" element={<RecipeListPage />} />
      <Route path="/app/commerce/recipes/:id/edit" element={<RecipeEditorPage />} />
      <Route path="/operations/orders" element={<OrderQueuePage />} />
      <Route path="/operations/delivery" element={<DeliveryDispatchPage />} />
      <Route path="/operations/delivery/:id" element={<DeliveryDetailPage />} />
      <Route path="/operations/delivery/exceptions" element={<DeliveryExceptionPage />} />
      <Route path="/operations/order-entry" element={<StaffOrderEntryPage />} />
      <Route path="/operations/inventory" element={<StockOverviewPage />} />
      <Route path="/operations/inventory/counts" element={<InventoryCountListPage />} />
      <Route path="/operations/inventory/counts/:id" element={<InventoryCountWorkbenchPage />} />
      <Route path="/operations/inventory/waste/new" element={<InventoryWastePage />} />
      <Route path="/operations/inventory/transfers" element={<InventoryTransferListPage />} />
      <Route path="/operations/inventory/transfers/:id" element={<InventoryTransferDetailPage />} />
      <Route path="/operations/inventory/lots" element={<InventoryLotExpiryPage />} />
      <Route path="/operations/receiving/new" element={<GoodsReceiptPage />} />
      <Route path="/app/supply/items" element={<InventoryItemListPage />} />
      <Route path="/app/supply/items/new" element={<InventoryItemCreatePage />} />
      <Route path="/app/supply/items/:id/edit" element={<InventoryItemEditPage />} />
      <Route path="/app/supply/items/:id/movements" element={<InventoryItemStockHistoryPage />} />
      <Route path="/app/supply/items/:id" element={<InventoryItemDetailPage />} />
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
      <Route path="/app/reports/operations" element={<OperationalDashboardPage />} />
      <Route path="/app/reports/metrics" element={<MetricCatalogPage />} />
      <Route path="/app/reports/metrics/:id" element={<MetricDetailPage />} />
      <Route path="/app/reports" element={<ReportCatalogPage />} />
      <Route path="/app/reports/:id/edit" element={<ReportBuilderPage />} />
      <Route path="/app/reports/runs" element={<ReportRunHistoryPage />} />
      <Route path="/app/reports/pipelines" element={<PipelineRunPage />} />
      <Route path="/app/reports/data-quality" element={<DataQualityPage />} />
      <Route path="/app/reports/reconciliation" element={<ReconciliationPage />} />
      <Route path="/app/compliance" element={<ComplianceDashboardPage />} />
      <Route path="/app/compliance/cases" element={<ComplianceCaseListPage />} />
      <Route path="/app/compliance/cases/:id" element={<ComplianceCaseDetailPage />} />
      <Route path="/app/compliance/inspections" element={<ComplianceInspectionPage />} />
      <Route path="/app/compliance/actions" element={<ComplianceCorrectiveActionPage />} />
      <Route path="/operations/compliance/temperature" element={<TemperatureLogPage />} />
      <Route path="/operations/compliance/cleaning" element={<CleaningLogPage />} />
      <Route path="/app/compliance/qualifications" element={<ComplianceQualificationPage />} />
      <Route path="/app/compliance/allergens" element={<ComplianceAllergenReviewPage />} />
      <Route path="/app/compliance/incidents/:id" element={<ComplianceIncidentPage />} />
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
      <Route path="/app/customers/merge-reviews/:reviewId" element={<CustomerMergeReviewPage />} />
      <Route path="/app/customers/:id" element={<CustomerDetailPage />} />
      <Route path="/app/supply/suppliers" element={<SupplierListPage />} />
      <Route path="/app/supply/suppliers/:id" element={<SupplierDetailPage />} />
      <Route path="/app/supply/offerings" element={<OfferingListPage />} />
      <Route path="/app/supply/offerings/:id" element={<OfferingEditorPage />} />
      <Route path="/operations/orders/:id" element={<OrderDetailPage />} />
      <Route path="/operations/orders/:id/amend" element={<OrderAmendmentPage />} />
      <Route path="/operations/kitchen" element={<KitchenBoardPage />} />
      <Route path="/operations/production-batches" element={<ProductionBatchPage />} />
      <Route path="/operations/dining" element={<DiningFloorPage />} />
      <Route path="/operations/reservations/calendar" element={<ReservationCalendarPage />} />
      <Route path="/operations/reservations/:id" element={<ReservationDetailPage />} />
      <Route path="/operations/reservations" element={<ReservationListPage />} />
      <Route path="/operations/waitlist" element={<WaitlistBoardPage />} />
      <Route path="/app/operations/reservation-capacity" element={<CapacityPolicyPage />} />
      <Route path="/operations/kitchen/work-items/:id" element={<KitchenWorkItemPage />} />
      <Route path="/operations/pickup" element={<PickupQueuePage />} />
      <Route path="/app/integrations/kds-profiles" element={<KdsProfilePage />} />
      <Route path="/app/operations/tables" element={<DiningTableListPage />} />
      <Route path="/operations/order-exceptions" element={<OrderExceptionPage />} />
      <Route path="*" element={<Navigate replace to="/app" />} />
    </Routes>
  );
}
