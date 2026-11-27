import { menuBuilderFixture, menuListFixture } from "./catalog-menu.fixtures.js";
import { CatalogMenuClientError, type CatalogMenuClient } from "./catalog-menu.js";
import { complianceDashboardFixture } from "./compliance-dashboard.fixtures.js";
import type { ComplianceDashboardClient } from "./compliance-dashboard-page.js";
import { KITCHEN_REFS, kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { KitchenBoardClientError, type KitchenBoardClient } from "./kitchen-board.js";
import { localMerchantFetch } from "./current-order-queue.fixtures.js";
import {
  parseMerchantWorkspace,
  type MerchantWorkspaceClient,
  type MerchantWorkspaceSnapshot,
} from "./merchant-workspace.js";
import { LocalDemoNotice, ShowcaseOverview } from "./merchant-demo-ui.js";
import type { ComponentType } from "react";
import {
  detailView,
  hoursServiceView,
  listView,
  setupView,
  STORE_REFERENCE,
} from "./store-admin.fixtures.js";
import { StoreAdminClientError, type StoreAdminClient } from "./store-admin.js";
import type { SupportCasePageClient } from "./support-case-pages.js";

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

const localKitchenBoardClient: KitchenBoardClient = Object.freeze({
  async loadQueue() {
    return kitchenBoardFixture();
  },
  async loadWorkItem(reference: string) {
    if (reference !== KITCHEN_REFS.work) throw new KitchenBoardClientError("NotFound");
    const board = kitchenBoardFixture();
    return {
      screenId: "KIT-WORK-ITEM" as const,
      projectionName: "kitchen_work_queue_v1" as const,
      projectionVersion: 1 as const,
      storeLabel: board.storeLabel,
      projectedAt: board.projectedAt,
      freshnessStatus: board.freshnessStatus,
      operatorStatus: board.operatorStatus,
      item: kitchenItemFixture(),
    };
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
      permission: "catalog.menu.read",
    },
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
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
  readonly Notice: ComponentType;
  readonly Overview: ComponentType;
  readonly storeAdmin: StoreAdminClient;
  readonly catalogMenu: CatalogMenuClient;
  /** WP-2423 P5: transport for the pilot order pages; serves fixtures, fails everything else closed. */
  readonly merchantFetch: typeof fetch;
  readonly demoStore: { readonly storeLabel: string; readonly timeZone: string };
  readonly kitchenBoard: KitchenBoardClient;
  readonly complianceDashboard: ComplianceDashboardClient;
  readonly supportCase: SupportCasePageClient;
  readonly workspace: MerchantWorkspaceClient | null;
}

export const enabledMerchantDemoClients: MerchantDemoClients = Object.freeze({
  enabled: true,
  Notice: LocalDemoNotice,
  Overview: ShowcaseOverview,
  storeAdmin: localStoreAdminClient,
  catalogMenu: localCatalogMenuClient,
  merchantFetch: localMerchantFetch,
  demoStore: { storeLabel: "Synthetic Training Store", timeZone: "America/Toronto" },
  kitchenBoard: localKitchenBoardClient,
  complianceDashboard: localComplianceDashboardClient,
  supportCase: localSupportCasePageClient,
  workspace: localMerchantWorkspaceClient,
});
