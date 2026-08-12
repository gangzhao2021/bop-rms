import { describe, expect, it, vi } from "vitest";
import { createMerchantWorkspaceClient, parseMerchantWorkspace } from "./merchant-workspace.js";

const storeReference = "018f7f9a-ad3e-7a11-8d01-000000000003";
const workspace = Object.freeze({
  screenId: "HOME-OVERVIEW",
  selectedScope: Object.freeze({
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference,
  }),
  authorizedStores: Object.freeze([
    Object.freeze({
      brandLabel: "Synthetic Brand",
      storeLabel: "Training Store",
      storeReference,
    }),
  ]),
  businessDate: "2026-08-12",
  storeStatus: "Open",
  freshness: "Current",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: Object.freeze([
    Object.freeze({
      screenId: "HOME-OVERVIEW",
      label: "Overview",
      href: "/app",
      permission: "merchant.access",
    }),
    Object.freeze({
      screenId: "KIT-KITCHEN-QUEUE",
      label: "Kitchen",
      href: "/operations/kitchen",
      permission: "kitchen.operate",
    }),
  ]),
});

describe("Merchant workspace client boundary", () => {
  it("parses only a closed HOME-OVERVIEW snapshot with selected authorized Store", () => {
    expect(parseMerchantWorkspace(workspace)).toEqual(workspace);
    expect(() => parseMerchantWorkspace({ ...workspace, extra: true })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
    expect(() => parseMerchantWorkspace({ ...workspace, authorizedStores: [] })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
    expect(() => parseMerchantWorkspace({ ...workspace, businessDate: "2026-99-99" })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
    expect(() =>
      parseMerchantWorkspace({
        ...workspace,
        navigation: [
          {
            screenId: "KIT-KITCHEN-QUEUE",
            label: "Kitchen",
            href: "/operations/orders",
            permission: "kitchen.operate",
          },
        ],
      }),
    ).toThrow("MERCHANT_WORKSPACE_INVALID");
  });

  it("treats closed authentication denial as signed out and leaks no error body", async () => {
    const request = vi.fn(async () => new Response('{"error":"provider-detail"}', { status: 403 }));
    await expect(createMerchantWorkspaceClient(request).bootstrap()).resolves.toBeNull();
  });

  it("posts only the selected reference with in-memory CSRF and requires fresh selected scope", async () => {
    const nextCsrf = "D".repeat(43);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ workspace }, { status: 200, headers: { "Cache-Control": "no-store" } }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { authenticated: true, csrf: nextCsrf, workspace },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        ),
      );
    const csrf = "C".repeat(43);
    await expect(
      createMerchantWorkspaceClient(request).switchStore(csrf, storeReference),
    ).resolves.toEqual({ csrf: nextCsrf, workspace });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/merchant/store-context",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-BOP-CSRF": csrf }),
        body: JSON.stringify({ targetStoreReference: storeReference }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/merchant/session",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });
});
