import { describe, expect, it } from "vitest";
import { parseMenuListView } from "./catalog-menu.js";
import { parseComplianceDashboardView } from "./compliance-dashboard-page.js";
import { parseKitchenBoardView } from "./kitchen-board.js";
import {
  isLocalMerchantDemoEnabled,
  localMerchantWorkspace,
  merchantDemoClientsForEnvironment,
  sanitizedSupportCaseFixture,
} from "./merchant-demo.js";
import { parseOrderQueueView } from "./order-queue.js";
import { parseStoreListView, unavailableStoreAdminClient } from "./store-admin.js";
import {
  parseSupportCasePageView,
  unavailableSupportCasePageClient,
} from "./support-case-pages.js";

describe("local-only Merchant core workflow preview", () => {
  it("requires both Vite development mode and the exact local flag", () => {
    expect(isLocalMerchantDemoEnabled({ development: true, flag: "1" })).toBe(true);
    expect(isLocalMerchantDemoEnabled({ development: false, flag: "1" })).toBe(false);
    expect(isLocalMerchantDemoEnabled({ development: true, flag: "true" })).toBe(false);
    expect(isLocalMerchantDemoEnabled({ development: true, flag: undefined })).toBe(false);
  });

  it("keeps production and unflagged development failed closed", () => {
    const production = merchantDemoClientsForEnvironment({ development: false, flag: "1" });
    const unflagged = merchantDemoClientsForEnvironment({ development: true, flag: undefined });
    expect(production.enabled).toBe(false);
    expect(production.storeAdmin).toBe(unavailableStoreAdminClient);
    expect(production.supportCase).toBe(unavailableSupportCasePageClient);
    expect(unflagged.enabled).toBe(false);
  });

  it("serves strict deterministic fixtures for every primary preview", async () => {
    const clients = merchantDemoClientsForEnvironment({ development: true, flag: "1" });
    expect(clients.enabled).toBe(true);
    expect(parseStoreListView(await clients.storeAdmin.listStores()).items).toHaveLength(1);
    expect(parseMenuListView(await clients.catalogMenu.listMenus()).items).toHaveLength(1);
    expect(parseOrderQueueView(await clients.orderQueue.loadQueue()).items).toHaveLength(1);
    expect(parseKitchenBoardView(await clients.kitchenBoard.loadQueue()).items).toHaveLength(1);
    expect(
      parseComplianceDashboardView(await clients.complianceDashboard.load()).signals,
    ).toHaveLength(1);
    expect(parseSupportCasePageView(await clients.supportCase.loadCases()).cases).toHaveLength(1);
  });

  it("sanitizes Support data and grants no local authority", () => {
    const view = parseSupportCasePageView(sanitizedSupportCaseFixture());
    expect(view.environment).toBe("NonProduction");
    expect(view.recentMfa).toBe(false);
    expect(view.mayCreate).toBe(false);
    expect(view.cases[0]).toMatchObject({
      tenant: "Synthetic Tenant",
      store: "Synthetic Store",
      status: "Open",
      requesterVerified: false,
      assignedRole: null,
      accessExpiresAt: null,
      actionCount: 0,
      evidenceReferences: [],
      mayAssign: false,
      mayGrant: false,
      mayRecordAction: false,
      mayRevoke: false,
      mayClose: false,
    });
  });

  it("bootstraps one canonical synthetic Store workspace and rejects another Store", async () => {
    const clients = merchantDemoClientsForEnvironment({ development: true, flag: "1" });
    const workspaceClient = clients.workspace;
    if (workspaceClient === null) throw new Error("synthetic workspace client missing");
    const bootstrap = await workspaceClient.bootstrap();
    expect(bootstrap?.workspace).toBe(localMerchantWorkspace);
    expect(bootstrap?.workspace.navigation.map((item) => item.screenId)).toEqual([
      "HOME-OVERVIEW",
      "ORG-STORE-LIST",
      "CAT-MENU-LIST",
      "OPS-ORDER-QUEUE",
      "KIT-KITCHEN-QUEUE",
    ]);
    await expect(
      workspaceClient.switchStore("d".repeat(43), "018f8100-0000-7000-8000-000000000002"),
    ).rejects.toThrow("MERCHANT_STORE_SWITCH_DENIED");
  });
});
