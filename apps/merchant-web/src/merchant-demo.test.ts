import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMenuListView } from "./catalog-menu.js";
import { parseComplianceDashboardView } from "./compliance-dashboard-page.js";
import { parseKitchenBoardView } from "./kitchen-board.js";
import { loadLocalMerchantDemo, shouldUseLocalMerchantDemoEntry } from "./merchant-demo-entry.js";
import {
  enabledMerchantDemoClients,
  localMerchantWorkspace,
  sanitizedSupportCaseFixture,
} from "./merchant-demo.js";
import { LocalDemoNotice } from "./merchant-demo-ui.js";
import { parseOrderQueueView } from "./order-queue.js";
import { parseStoreListView } from "./store-admin.js";
import { parseSupportCasePageView } from "./support-case-pages.js";

describe("local-only Merchant core workflow preview", () => {
  it("labels local preview data without implying authority or publication", () => {
    const html = renderToStaticMarkup(createElement(LocalDemoNotice));
    expect(html).toContain("Local synthetic preview");
    expect(html).toContain("Read-only training data");
    expect(html).toContain("No API, permission, business fact, or publication is implied");
    expect(html).toContain('role="status"');
  });

  it("selects only the exact development entry and fails closed when loading fails", async () => {
    expect(shouldUseLocalMerchantDemoEntry("serve", "1")).toBe(true);
    expect(shouldUseLocalMerchantDemoEntry("build", "1")).toBe(false);
    expect(shouldUseLocalMerchantDemoEntry("serve", "true")).toBe(false);
    expect(shouldUseLocalMerchantDemoEntry("serve", undefined)).toBe(false);
    await expect(loadLocalMerchantDemo(async () => ({ enabledMerchantDemoClients }))).resolves.toBe(
      enabledMerchantDemoClients,
    );
    await expect(
      loadLocalMerchantDemo(async () => Promise.reject(new Error("load failed"))),
    ).resolves.toBeNull();
  });

  it("serves strict deterministic fixtures for every primary preview", async () => {
    const clients = enabledMerchantDemoClients;
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
    const clients = enabledMerchantDemoClients;
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
