import { TaxConfigDraftPage } from "./TaxConfigDraftPage.js";
import { StoreSetupDraftPage } from "./StoreSetupDraftPage.js";
import { StoreOptionSetEditPage, StoreOptionSetListPage } from "./StoreOptionSetPages.js";
import { createOptionSetClient } from "./store-option-set-page.js";
import { StoreOptionPricesPage } from "./StoreOptionPricesPage.js";
import { createOptionPriceClient } from "./store-option-prices-page.js";
import { StoreOptionRecipesPage } from "./StoreOptionRecipesPage.js";
import { StoreTaxReviewPage, createTaxReviewClient } from "./StoreTaxReviewPage.js";
import { createOptionRecipeClient } from "./store-option-recipes-page.js";
import { CurrentStoreCapabilityPage } from "./CurrentStoreCapabilityPage.js";
import { RefundPaymentPage } from "./RefundPaymentPage.js";
import { DiningSessionWorkspace } from "./DiningSessionWorkspace.js";
import { CurrentOrderDetailRoute, CurrentOrderQueuePage } from "./CurrentOrderQueuePage.js";
import { StoreServiceControlPanel } from "./StoreServiceControlPanel.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { usesWorkspaceLayout, WorkspaceLayout } from "./WorkspaceLayout.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { MerchantShell } from "./MerchantShell.js";
import { KitchenBoardPage, KitchenWorkItemPage } from "./KitchenBoardPages.js";
import { PickupQueuePage } from "./PickupPages.js";
import { KdsProfilePage } from "./KdsProfilePage.js";
import { OrderExceptionPage } from "./OrderExceptionPage.js";
import { OrderDetailPage, OrderQueuePage } from "./OrderQueuePages.js";
import { OrderAmendmentPage } from "./OrderAmendmentPage.js";
import { StoreMenuBuilderPage, StoreMenuListPage } from "./StoreMenuPages.js";
import { createMenuClient } from "./store-menu-pages.js";
import { StoreAvailabilityPage } from "./StoreAvailabilityPage.js";
import { createAvailabilityClient } from "./store-availability-page.js";
import { BundleEditorPage, BundleListPage } from "./BundlePages.js";
import { StorePriceEditorPage, StorePriceListPage } from "./StorePricePages.js";
import { createPriceClient } from "./store-price-pages.js";
import { AllergenItemPage, AllergenListPage } from "./AllergenDeclarationPages.js";
import { createAllergenClient } from "./allergen-declaration-pages.js";
import { TaxConfigPage } from "./TaxConfigPage.js";
import { PromotionEditorPage, PromotionListPage } from "./PromotionPages.js";
import { RecipeEditorPage, RecipeListPage } from "./RecipePages.js";
import { ProductEditorPage, ProductListPage } from "./ProductPages.js";
import { ProductionBatchPage } from "./ProductionBatchPage.js";
import { DiningTableListPage } from "./DiningPages.js";
import {
  ReservationCalendarPage,
  ReservationDetailPage,
  ReservationListPage,
} from "./ReservationPages.js";
import { WaitlistBoardPage } from "./WaitlistPages.js";
import { CapacityPolicyPage } from "./CapacityPolicyPage.js";
import { StaffOrderEntryPage } from "./StaffOrderEntryPage.js";
import { StockOverviewPage } from "./InventoryPages.js";
import {
  InventoryItemStockHistoryPage,
  InventoryMovementDetailPage,
  InventoryMovementListPage,
} from "./InventoryMovementPages.js";
import {
  InventoryTransferDetailPage,
  InventoryTransferListPage,
} from "./InventoryTransferPages.js";
import { InventoryLotExpiryPage } from "./InventoryLotExpiryPage.js";
import { InventoryReplenishmentPage } from "./InventoryReplenishmentPage.js";
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
import {
  StoreDetailPage,
  StoreHoursServicePage,
  StoreListPage,
  StoreSetupPage,
} from "./StoreAdminPages.js";
import type { MerchantDemoClients } from "./merchant-demo.js";
import { OperationalDashboardPage } from "./OperationalDashboardPage.js";
import { ReportBuilderPage, ReportCatalogPage } from "./ReportPages.js";
import { ReportRunHistoryPage } from "./ReportRunHistoryPage.js";
import { PipelineRunPage } from "./PipelineRunPage.js";
import { TaskInboxPage, TaskInboxStatePanel } from "./TaskInboxPage.js";
import { ComplianceDashboardPage } from "./ComplianceDashboardPage.js";
import { ComplianceCaseDetailPage, ComplianceCaseListPage } from "./ComplianceCasePages.js";
import {
  ComplianceCorrectiveActionPage,
  ComplianceInspectionPage,
} from "./ComplianceInspectionActionPages.js";
import { CleaningLogPage, TemperatureLogPage } from "./ComplianceMonitoringPages.js";
import { ComplianceQualificationPage } from "./ComplianceQualificationPage.js";
import { ComplianceIncidentPage } from "./ComplianceAllergenIncidentPages.js";
import { ComplianceTraceabilityPage } from "./ComplianceTraceabilityPage.js";
import { ComplianceRecallCasePage } from "./ComplianceRecallCasePage.js";
import { CompliancePolicyPage } from "./CompliancePolicyPage.js";
import { DeviceDetailPage, DeviceListPage } from "./DevicePages.js";
import {
  ProviderIntegrationDetailPage,
  ProviderIntegrationListPage,
} from "./ProviderIntegrationPages.js";
import { ApiClientPage } from "./ApiClientPage.js";
import { OperatingEntityDetailPage, OperatingEntityListPage } from "./OperatingEntityPages.js";
import { BrandListPage } from "./BrandAdminPages.js";
import { BrandAdministrationWorkspace } from "./BrandAdministrationWorkspace.js";
import type { MerchantBrandWorkspaceClient } from "./merchant-brand-workspace.js";
import { FeatureFlagListPage } from "./FeatureControlAdminPages.js";
import { PlatformLiveGatePage, StoreLiveGatePage } from "./LiveGatePages.js";
import { RoleEditorPage, RoleListPage } from "./RoleAdministrationPages.js";
import { createRoleAdministrationPageClient } from "./role-administration-pages.js";
import { StaffDetailPage, StaffListPage } from "./StaffAdministrationPages.js";
import { SupplyItemDetailPage, SupplyItemFormPage, SupplyItemListPage } from "./SupplyItemPages.js";
import { createSupplyItemClient } from "./supply-item-pages.js";
import { StockLocationListPage } from "./StockLocationPages.js";
import { createStockLocationClient } from "./stock-location-pages.js";
import { OpeningCountPage } from "./OpeningCountPages.js";
import { createOpeningCountClient } from "./opening-count-pages.js";
import {
  StoreReceiptDetailPage,
  StoreReceiptFormPage,
  StoreReceiptListPage,
} from "./StoreReceiptPages.js";
import { createStoreReceiptClient } from "./store-receipt-pages.js";
import { createRecipeClient } from "./recipe-pages.js";
import { createProductClient } from "./product-pages.js";
import { StockCountListPage, StockCountWorkbenchPage } from "./StockCountPages.js";
import { createStockCountClient } from "./stock-count-pages.js";
import { StoreWasteDetailPage, StoreWasteFormPage, StoreWasteListPage } from "./StoreWastePages.js";
import { createStoreWasteClient } from "./store-waste-pages.js";
import { createStaffPageClient } from "./staff-administration-pages.js";
import { ExportJobListPage } from "./ExportJobPages.js";
import { PlatformTenantDetailPage } from "./PlatformTenantPages.js";
import { PlatformTemplateWorkspace } from "./PlatformTemplateWorkspace.js";
import { SupportCasePage } from "./SupportCasePages.js";
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
  const { pathname } = useLocation();
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

  const routes = (
    <Routes>
      <Route
        path="/app"
        element={
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            <MerchantShell
              overview={DemoOverview === undefined ? null : <DemoOverview />}
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
              <AppFrame title="Tasks" description="TASK-INBOX">
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
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            {demo !== null ? (
              <StoreSetupPage {...clientProps(demo.storeAdmin)} />
            ) : state.kind === "Ready" && !state.switching ? (
              <StoreSetupDraftPage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                storeReference={state.workspace.selectedScope.storeReference}
                csrf={state.csrf}
              />
            ) : (
              <StatePanel heading="Store setup unavailable" status>
                <p>A current merchant session and selected Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      <Route
        path="/app/organization/stores/:id/service"
        element={
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
              <StatePanel heading="Hours and service unavailable" status>
                <p>A current merchant session and Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      <Route
        path="/app/organization/stores/:id/capabilities"
        element={
          state.kind === "Ready" && !state.switching ? (
            <CurrentStoreCapabilityPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              scope={{ storeReference: state.workspace.selectedScope.storeReference }}
              csrf={state.csrf}
              storeLabel={state.workspace.selectedScope.storeLabel}
            />
          ) : (
            <StatePanel heading="Store capabilities unavailable" status>
              <p>A current merchant session and selected Store are required.</p>
            </StatePanel>
          )
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
          state.kind === "Ready" && !state.switching ? (
            <StaffListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStaffPageClient(state.csrf)}
            />
          ) : (
            <StaffListPage />
          )
        }
      />
      <Route
        path="/app/organization/users/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StaffDetailPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStaffPageClient(state.csrf)}
            />
          ) : (
            <StaffDetailPage />
          )
        }
      />
      <Route
        path="/app/organization/roles"
        element={
          state.kind === "Ready" && !state.switching ? (
            <RoleListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createRoleAdministrationPageClient(state.csrf)}
            />
          ) : (
            <RoleListPage />
          )
        }
      />
      <Route
        path="/app/organization/roles/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <RoleEditorPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createRoleAdministrationPageClient(state.csrf)}
            />
          ) : (
            <RoleEditorPage />
          )
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
          state.kind === "Ready" && !state.switching ? (
            <StoreOptionSetListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOptionSetClient(state.csrf)}
            />
          ) : (
            <StoreOptionSetListPage />
          )
        }
      />
      <Route
        path="/app/commerce/option-sets/:optionSetId"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreOptionSetEditPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOptionSetClient(state.csrf)}
            />
          ) : (
            <StoreOptionSetEditPage />
          )
        }
      />
      <Route
        path="/app/commerce/products"
        element={
          state.kind === "Ready" && !state.switching ? (
            <ProductListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createProductClient(state.csrf)}
            />
          ) : (
            <ProductListPage />
          )
        }
      />
      {["/app/commerce/products/new", "/app/commerce/products/:id/edit"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            state.kind === "Ready" && !state.switching ? (
              <ProductEditorPage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                client={createProductClient(state.csrf)}
              />
            ) : (
              <ProductEditorPage />
            )
          }
        />
      ))}
      <Route
        path="/app/commerce/menus"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreMenuListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createMenuClient(state.csrf)}
            />
          ) : (
            <StoreMenuListPage />
          )
        }
      />
      <Route
        path="/app/commerce/menus/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreMenuBuilderPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createMenuClient(state.csrf)}
            />
          ) : (
            <StoreMenuBuilderPage />
          )
        }
      />
      <Route path="/app/commerce/bundles" element={<BundleListPage />} />
      <Route path="/app/commerce/bundles/:id/edit" element={<BundleEditorPage />} />
      <Route
        path="/app/commerce/availability"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreAvailabilityPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createAvailabilityClient(state.csrf)}
            />
          ) : (
            <StoreAvailabilityPage />
          )
        }
      />
      <Route
        path="/app/commerce/tax-review"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreTaxReviewPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createTaxReviewClient(state.csrf)}
            />
          ) : (
            <StoreTaxReviewPage />
          )
        }
      />
      <Route
        path="/app/commerce/option-recipes"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreOptionRecipesPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOptionRecipeClient(state.csrf)}
            />
          ) : (
            <StoreOptionRecipesPage />
          )
        }
      />
      <Route
        path="/app/commerce/option-prices"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreOptionPricesPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOptionPriceClient(state.csrf)}
            />
          ) : (
            <StoreOptionPricesPage />
          )
        }
      />
      <Route
        path="/app/commerce/pricing"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StorePriceListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createPriceClient(state.csrf)}
            />
          ) : (
            <StorePriceListPage />
          )
        }
      />
      <Route
        path="/app/commerce/pricing/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StorePriceEditorPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createPriceClient(state.csrf)}
            />
          ) : (
            <StorePriceEditorPage />
          )
        }
      />
      <Route
        path="/app/commerce/tax"
        element={
          demo !== null ? (
            <TaxConfigPage />
          ) : state.kind === "Ready" && !state.switching ? (
            <TaxConfigDraftPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              storeReference={state.workspace.selectedScope.storeReference}
              csrf={state.csrf}
            />
          ) : (
            <StatePanel heading="Tax Configuration unavailable" status>
              <p>A current merchant session and selected Store are required.</p>
            </StatePanel>
          )
        }
      />
      <Route path="/app/commerce/promotions" element={<PromotionListPage />} />
      <Route path="/app/commerce/promotions/:id/edit" element={<PromotionEditorPage />} />
      <Route
        path="/app/commerce/recipes"
        element={
          state.kind === "Ready" && !state.switching ? (
            <RecipeListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createRecipeClient(state.csrf)}
            />
          ) : (
            <RecipeListPage />
          )
        }
      />
      <Route
        path="/app/commerce/recipes/:id/edit"
        element={
          state.kind === "Ready" && !state.switching ? (
            <RecipeEditorPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createRecipeClient(state.csrf)}
            />
          ) : (
            <RecipeEditorPage />
          )
        }
      />
      <Route
        path="/operations/orders"
        element={
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            {demo !== null ? (
              <OrderQueuePage {...clientProps(demo.orderQueue)} />
            ) : state.kind === "Ready" && !state.switching ? (
              <CurrentOrderQueuePage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                storeLabel={state.workspace.selectedScope.storeLabel}
                csrf={state.csrf}
                timeZone={state.workspace.selectedScope.timeZone}
              />
            ) : (
              <StatePanel heading="Order Queue unavailable" status>
                <p>A current merchant session and Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      <Route path="/operations/delivery" element={<DeliveryDispatchPage />} />
      <Route path="/operations/delivery/:id" element={<DeliveryDetailPage />} />
      <Route path="/operations/delivery/exceptions" element={<DeliveryExceptionPage />} />
      <Route path="/operations/order-entry" element={<StaffOrderEntryPage />} />
      <Route path="/operations/inventory" element={<StockOverviewPage />} />
      <Route
        path="/operations/inventory/counts"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StockCountListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStockCountClient(state.csrf)}
            />
          ) : (
            <StockCountListPage />
          )
        }
      />
      <Route
        path="/operations/inventory/counts/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StockCountWorkbenchPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStockCountClient(state.csrf)}
            />
          ) : (
            <StockCountWorkbenchPage />
          )
        }
      />
      <Route
        path="/operations/inventory/waste"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreWasteListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreWasteClient(state.csrf)}
            />
          ) : (
            <StoreWasteListPage />
          )
        }
      />
      <Route
        path="/operations/inventory/waste/new"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreWasteFormPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreWasteClient(state.csrf)}
            />
          ) : (
            <StoreWasteFormPage />
          )
        }
      />
      <Route
        path="/operations/inventory/waste/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreWasteDetailPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreWasteClient(state.csrf)}
            />
          ) : (
            <StoreWasteDetailPage />
          )
        }
      />
      <Route path="/operations/inventory/transfers" element={<InventoryTransferListPage />} />
      <Route path="/operations/inventory/transfers/:id" element={<InventoryTransferDetailPage />} />
      <Route path="/operations/inventory/lots" element={<InventoryLotExpiryPage />} />
      <Route
        path="/operations/receiving"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreReceiptListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreReceiptClient(state.csrf)}
            />
          ) : (
            <StoreReceiptListPage />
          )
        }
      />
      <Route
        path="/operations/receiving/new"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreReceiptFormPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreReceiptClient(state.csrf)}
            />
          ) : (
            <StoreReceiptFormPage />
          )
        }
      />
      <Route
        path="/operations/receiving/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StoreReceiptDetailPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStoreReceiptClient(state.csrf)}
            />
          ) : (
            <StoreReceiptDetailPage />
          )
        }
      />
      <Route
        path="/app/supply/opening-count"
        element={
          state.kind === "Ready" && !state.switching ? (
            <OpeningCountPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOpeningCountClient(state.csrf)}
            />
          ) : (
            <OpeningCountPage />
          )
        }
      />
      <Route
        path="/app/supply/opening-count/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <OpeningCountPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createOpeningCountClient(state.csrf)}
            />
          ) : (
            <OpeningCountPage />
          )
        }
      />
      <Route
        path="/app/supply/locations"
        element={
          state.kind === "Ready" && !state.switching ? (
            <StockLocationListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createStockLocationClient(state.csrf)}
            />
          ) : (
            <StockLocationListPage />
          )
        }
      />
      <Route
        path="/app/supply/items"
        element={
          state.kind === "Ready" && !state.switching ? (
            <SupplyItemListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createSupplyItemClient(state.csrf)}
            />
          ) : (
            <SupplyItemListPage />
          )
        }
      />
      <Route
        path="/app/supply/items/new"
        element={
          state.kind === "Ready" && !state.switching ? (
            <SupplyItemFormPage
              mode="Create"
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createSupplyItemClient(state.csrf)}
            />
          ) : (
            <SupplyItemFormPage mode="Create" />
          )
        }
      />
      <Route
        path="/app/supply/items/:id/edit"
        element={
          state.kind === "Ready" && !state.switching ? (
            <SupplyItemFormPage
              mode="Edit"
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createSupplyItemClient(state.csrf)}
            />
          ) : (
            <SupplyItemFormPage mode="Edit" />
          )
        }
      />
      <Route path="/app/supply/items/:id/movements" element={<InventoryItemStockHistoryPage />} />
      <Route
        path="/app/supply/items/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <SupplyItemDetailPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createSupplyItemClient(state.csrf)}
            />
          ) : (
            <SupplyItemDetailPage />
          )
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
      <Route path="/app/reports/operations" element={<OperationalDashboardPage />} />
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
          state.kind === "Ready" && !state.switching ? (
            <AllergenListPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createAllergenClient(state.csrf)}
            />
          ) : (
            <AllergenListPage />
          )
        }
      />
      <Route
        path="/app/compliance/allergens/:id"
        element={
          state.kind === "Ready" && !state.switching ? (
            <AllergenItemPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              client={createAllergenClient(state.csrf)}
            />
          ) : (
            <AllergenItemPage />
          )
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
      <Route path="/app/customers/merge-reviews/:reviewId" element={<CustomerMergeReviewPage />} />
      <Route path="/app/customers/:id" element={<CustomerDetailPage />} />
      <Route path="/app/supply/suppliers" element={<SupplierListPage />} />
      <Route path="/app/supply/suppliers/:id" element={<SupplierDetailPage />} />
      <Route path="/app/supply/offerings" element={<OfferingListPage />} />
      <Route path="/app/supply/offerings/:id" element={<OfferingEditorPage />} />
      <Route
        path="/operations/orders/:id"
        element={
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            {demo !== null ? (
              <OrderDetailPage {...clientProps(demo.orderQueue)} />
            ) : state.kind === "Ready" && !state.switching ? (
              <CurrentOrderDetailRoute
                key={state.workspace.selectedScope.storeReference + state.csrf}
                storeLabel={state.workspace.selectedScope.storeLabel}
                csrf={state.csrf}
                timeZone={state.workspace.selectedScope.timeZone}
              />
            ) : (
              <StatePanel heading="Order unavailable" status>
                <p>A current merchant session and Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      {["/app/operations/payments/:id", "/app/operations/payments/:id/refund"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            state.kind === "Ready" && !state.switching ? (
              <RefundPaymentPage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                csrf={state.csrf}
                storeLabel={state.workspace.selectedScope.storeLabel}
              />
            ) : (
              <StatePanel heading="Payment unavailable" status>
                <p>Sign in and select a Store to continue.</p>
              </StatePanel>
            )
          }
        />
      ))}
      <Route path="/operations/orders/:id/amend" element={<OrderAmendmentPage />} />
      <Route
        path="/operations/kitchen"
        element={
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            {demo?.kitchenBoard ? (
              <KitchenBoardPage client={demo.kitchenBoard} />
            ) : state.kind === "Ready" && !state.switching ? (
              <KitchenBoardPage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                csrf={state.csrf}
                storeReference={state.workspace.selectedScope.storeReference}
                storeLabel={state.workspace.selectedScope.storeLabel}
                navigation={state.workspace.navigation.map((item) => (
                  <a
                    key={item.screenId}
                    href={item.href}
                    aria-current={item.screenId === "KIT-KITCHEN-QUEUE" ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                ))}
              />
            ) : (
              <StatePanel heading="Kitchen Board unavailable">
                <p>A current merchant session and Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      <Route path="/operations/production-batches" element={<ProductionBatchPage />} />
      <Route
        path="/operations/dining"
        element={
          state.kind === "Ready" && !state.switching ? (
            <DiningSessionWorkspace
              key={state.workspace.selectedScope.storeReference + state.csrf}
              csrf={state.csrf}
              storeLabel={state.workspace.selectedScope.storeLabel}
              navigation={state.workspace.navigation.map((item) => (
                <a key={item.screenId} href={item.href}>
                  {item.label}
                </a>
              ))}
            />
          ) : (
            <StatePanel heading="Dining unavailable">
              <p>A current merchant session and Store are required.</p>
            </StatePanel>
          )
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
          <LocalDemoRoute notice={demo?.Notice ?? null}>
            {demo?.kitchenBoard ? (
              <KitchenWorkItemPage client={demo.kitchenBoard} />
            ) : state.kind === "Ready" && !state.switching ? (
              <KitchenWorkItemPage
                key={state.workspace.selectedScope.storeReference + state.csrf}
                csrf={state.csrf}
                storeReference={state.workspace.selectedScope.storeReference}
                storeLabel={state.workspace.selectedScope.storeLabel}
                navigation={state.workspace.navigation.map((item) => (
                  <a
                    key={item.screenId}
                    href={item.href}
                    aria-current={item.href === "/operations/kitchen" ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                ))}
              />
            ) : (
              <StatePanel heading="Kitchen work item unavailable">
                <p>A current merchant session and Store are required.</p>
              </StatePanel>
            )}
          </LocalDemoRoute>
        }
      />
      <Route
        path="/operations/pickup"
        element={
          state.kind === "Ready" && !state.switching ? (
            <PickupQueuePage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              csrf={state.csrf}
              storeReference={state.workspace.selectedScope.storeReference}
              storeLabel={state.workspace.selectedScope.storeLabel}
            />
          ) : (
            <StatePanel heading="Pickup Queue unavailable">
              <p>A current merchant session and Store are required.</p>
            </StatePanel>
          )
        }
      />
      <Route path="/app/integrations/kds-profiles" element={<KdsProfilePage />} />
      <Route path="/app/operations/tables" element={<DiningTableListPage />} />
      <Route
        path="/operations/order-exceptions"
        element={
          state.kind === "Ready" && !state.switching ? (
            <OrderExceptionPage
              key={state.workspace.selectedScope.storeReference + state.csrf}
              csrf={state.csrf}
            />
          ) : (
            <StatePanel heading="Order Exception Workbench unavailable" tone="error" status>
              <p>A current merchant session and Store are required.</p>
            </StatePanel>
          )
        }
      />
      <Route path="*" element={<Navigate replace to="/app" />} />
    </Routes>
  );
  return (
    <StoreTimeZoneContext.Provider
      value={state.kind === "Ready" ? state.workspace.selectedScope.timeZone : undefined}
    >
      {state.kind === "Ready" && usesWorkspaceLayout(pathname) ? (
        <WorkspaceLayout
          items={state.workspace.navigation}
          path={pathname}
          storeLabel={state.workspace.selectedScope.storeLabel}
        >
          {routes}
        </WorkspaceLayout>
      ) : (
        routes
      )}
    </StoreTimeZoneContext.Provider>
  );
}
