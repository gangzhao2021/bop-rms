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
import { StoreDetailPage, StoreListPage, StoreSetupPage } from "./StoreAdminPages.js";
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
      <Route path="/operations/order-entry" element={<StaffOrderEntryPage />} />
      <Route path="/operations/inventory" element={<StockOverviewPage />} />
      <Route path="/app/supply/items" element={<InventoryItemListPage />} />
      <Route path="/app/supply/items/new" element={<InventoryItemCreatePage />} />
      <Route path="/app/supply/items/:id/edit" element={<InventoryItemEditPage />} />
      <Route path="/app/supply/items/:id/movements" element={<InventoryItemStockHistoryPage />} />
      <Route path="/app/supply/items/:id" element={<InventoryItemDetailPage />} />
      <Route path="/app/supply/movements" element={<InventoryMovementListPage />} />
      <Route path="/app/supply/movements/:id" element={<InventoryMovementDetailPage />} />
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
