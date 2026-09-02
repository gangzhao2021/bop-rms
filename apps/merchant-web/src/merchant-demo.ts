import { menuBuilderFixture, menuListFixture } from "./catalog-menu.fixtures.js";
import {
  CatalogMenuClientError,
  unavailableCatalogMenuClient,
  type CatalogMenuClient,
} from "./catalog-menu.js";
import { complianceDashboardFixture } from "./compliance-dashboard.fixtures.js";
import {
  unavailableComplianceDashboardClient,
  type ComplianceDashboardClient,
} from "./compliance-dashboard-page.js";
import { KITCHEN_REFS, kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import {
  KitchenBoardClientError,
  unavailableKitchenBoardClient,
  type KitchenBoardClient,
} from "./kitchen-board.js";
import { orderDetailFixture, orderQueueFixture } from "./order-queue.fixtures.js";
import {
  OrderQueueClientError,
  unavailableOrderQueueClient,
  type OrderQueueClient,
} from "./order-queue.js";
import {
  parseMerchantWorkspace,
  type MerchantWorkspaceClient,
  type MerchantWorkspaceSnapshot,
} from "./merchant-workspace.js";
import {
  detailView,
  hoursServiceView,
  listView,
  setupView,
  STORE_REFERENCE,
} from "./store-admin.fixtures.js";
import {
  StoreAdminClientError,
  unavailableStoreAdminClient,
  type StoreAdminClient,
} from "./store-admin.js";
import {
  unavailableSupportCasePageClient,
  type SupportCasePageClient,
} from "./support-case-pages.js";

export interface LocalMerchantDemoEnvironment {
  readonly development: boolean;
  readonly flag: string | undefined;
}

export function isLocalMerchantDemoEnabled(environment: LocalMerchantDemoEnvironment): boolean {
  return environment.development && environment.flag === "1";
}

const localStoreAdminClient: StoreAdminClient = Object.freeze({
  async listStores() {
    return listView();
  },
  async loadStore(storeReference: string) {
    if (storeReference !== STORE_REFERENCE) throw new StoreAdminClientError("NotFound");
    return detailView();
  },
  async loadSetup(storeReference: string) {
    if (storeReference !== STORE_REFERENCE) throw new StoreAdminClientError("NotFound");
    return setupView();
  },
  async loadHoursService(storeReference: string) {
    if (storeReference !== STORE_REFERENCE) throw new StoreAdminClientError("NotFound");
    return hoursServiceView();
  },
});

const localCatalogMenuClient: CatalogMenuClient = Object.freeze({
  async listMenus() {
    return menuListFixture();
  },
  async loadBuilder(menuReference: string) {
    const fixture = menuBuilderFixture();
    if (menuReference !== fixture.menuReference) throw new CatalogMenuClientError("NotFound");
    return fixture;
  },
});

const localOrderQueueClient: OrderQueueClient = Object.freeze({
  async loadQueue() {
    return orderQueueFixture();
  },
  async loadDetail(orderReference: string) {
    const fixture = orderDetailFixture();
    if (orderReference !== fixture.order.orderReference)
      throw new OrderQueueClientError("NotFound");
    return fixture;
  },
});

const localKitchenBoardClient: KitchenBoardClient = Object.freeze({
  async loadQueue() {
    return kitchenBoardFixture();
  },
  async loadWorkItem(reference: string) {
    if (reference !== KITCHEN_REFS.work) throw new KitchenBoardClientError("NotFound");
    return kitchenItemFixture();
  },
});

const localComplianceDashboardClient: ComplianceDashboardClient = Object.freeze({
  async load() {
    return complianceDashboardFixture();
  },
});

export function sanitizedSupportCaseFixture() {
  return {
    screenId: "PLT-SUPPORT-CASE",
    sourceAsOf: "2026-08-15T16:00:00.000Z",
    freshness: "Fresh",
    completeness: "Complete",
    environment: "NonProduction",
    actor: "Synthetic training operator",
    purpose: "Local synthetic preview",
    recentMfa: false,
    mayCreate: false,
    cases: [
      {
        caseReference: "018f9916-0000-7000-8000-000000000001",
        caseCode: "DEMO-CASE-0001",
        tenant: "Synthetic Tenant",
        store: "Synthetic Store",
        caseType: "Training",
        purpose: "Local read-only preview",
        requesterVerified: false,
        assignedRole: null,
        status: "Open",
        dueAt: "2026-08-16T16:00:00.000Z",
        accessExpiresAt: null,
        actionCount: 0,
        evidenceReferences: [],
        mayAssign: false,
        mayGrant: false,
        mayRecordAction: false,
        mayRevoke: false,
        mayClose: false,
      },
    ],
  };
}

const localSupportCasePageClient: SupportCasePageClient = Object.freeze({
  async loadCases() {
    return sanitizedSupportCaseFixture();
  },
});

export const localMerchantWorkspace: MerchantWorkspaceSnapshot = parseMerchantWorkspace({
  screenId: "HOME-OVERVIEW",
  selectedScope: {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: STORE_REFERENCE,
  },
  authorizedStores: [
    {
      brandLabel: "Synthetic Brand",
      storeLabel: "Training Store",
      storeReference: STORE_REFERENCE,
    },
  ],
  businessDate: "2026-08-28",
  storeStatus: "Open",
  freshness: "Current",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: [
    { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
    {
      screenId: "ORG-STORE-LIST",
      label: "Stores",
      href: "/app/organization/stores",
      permission: "organization.store.read",
    },
    {
      screenId: "CAT-MENU-LIST",
      label: "Menus",
      href: "/app/commerce/menus",
      permission: "catalog.read",
    },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.read",
    },
    {
      screenId: "KIT-KITCHEN-QUEUE",
      label: "Kitchen",
      href: "/operations/kitchen",
      permission: "kitchen.operate",
    },
  ],
});

const localMerchantWorkspaceClient: MerchantWorkspaceClient = Object.freeze({
  async bootstrap() {
    return { csrf: "d".repeat(43), workspace: localMerchantWorkspace };
  },
  async switchStore(_csrf: string, targetStoreReference: string) {
    if (targetStoreReference !== STORE_REFERENCE) throw new Error("MERCHANT_STORE_SWITCH_DENIED");
    return { csrf: "d".repeat(43), workspace: localMerchantWorkspace };
  },
});

export interface MerchantDemoClients {
  readonly enabled: boolean;
  readonly storeAdmin: StoreAdminClient;
  readonly catalogMenu: CatalogMenuClient;
  readonly orderQueue: OrderQueueClient;
  readonly kitchenBoard: KitchenBoardClient;
  readonly complianceDashboard: ComplianceDashboardClient;
  readonly supportCase: SupportCasePageClient;
  readonly workspace: MerchantWorkspaceClient | null;
}

const enabledClients: MerchantDemoClients = Object.freeze({
  enabled: true,
  storeAdmin: localStoreAdminClient,
  catalogMenu: localCatalogMenuClient,
  orderQueue: localOrderQueueClient,
  kitchenBoard: localKitchenBoardClient,
  complianceDashboard: localComplianceDashboardClient,
  supportCase: localSupportCasePageClient,
  workspace: localMerchantWorkspaceClient,
});

const disabledClients: MerchantDemoClients = Object.freeze({
  enabled: false,
  storeAdmin: unavailableStoreAdminClient,
  catalogMenu: unavailableCatalogMenuClient,
  orderQueue: unavailableOrderQueueClient,
  kitchenBoard: unavailableKitchenBoardClient,
  complianceDashboard: unavailableComplianceDashboardClient,
  supportCase: unavailableSupportCasePageClient,
  workspace: null,
});

export function merchantDemoClientsForEnvironment(
  environment: LocalMerchantDemoEnvironment,
): MerchantDemoClients {
  return isLocalMerchantDemoEnabled(environment) ? enabledClients : disabledClients;
}
