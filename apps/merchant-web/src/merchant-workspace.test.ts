import { describe, expect, it, vi } from "vitest";
import { createMerchantWorkspaceClient, parseMerchantWorkspace } from "./merchant-workspace.js";

const storeReference = "018f7f9a-ad3e-7a11-8d01-000000000003";
const brandReference = "018f7f9a-ad3e-7a11-8d01-000000000002";
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
  it("accepts one canonical Brand detail entry without extending the selected scope", () => {
    const item = {
      screenId: "ORG-BRAND-DETAIL",
      label: "Brand administration",
      href: "/app/organization/brands/" + brandReference,
      permission: "organization.manage",
    };
    const parsed = parseMerchantWorkspace({
      ...workspace,
      navigation: [...workspace.navigation, item],
    });
    expect(parsed.navigation).toEqual([...workspace.navigation, item]);
    expect(parsed.selectedScope).toEqual(workspace.selectedScope);
    expect(Object.keys(parsed.selectedScope)).toEqual([
      "brandLabel",
      "storeLabel",
      "storeReference",
    ]);
    expect(Object.isFrozen(parsed.navigation.at(-1))).toBe(true);
    expect(() => parseMerchantWorkspace({ ...workspace, navigation: [item, { ...item }] })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
  });

  it("rejects Brand route, permission, label and open-field substitutions", () => {
    const item = {
      screenId: "ORG-BRAND-DETAIL",
      label: "Synthetic Brand",
      href: "/app/organization/brands/" + brandReference,
      permission: "organization.manage",
    };
    for (const change of [
      { href: "/app/organization/stores/" + brandReference },
      { href: "https://example.test" + item.href },
      { href: item.href + "?mode=edit" },
      { href: item.href + "#detail" },
      { href: item.href + "/" },
      { href: "/app/organization/brands/../" + brandReference },
      { href: "/app/organization/brands/%30" + brandReference.slice(1) },
      { href: "/app/organization/brands/" + brandReference.toUpperCase() },
      { href: "/app/organization/brands/" + brandReference.replace("-7a11-", "-4a11-") },
      { href: "/app/organization/brands/" },
      { permission: "organization.store.read" },
      { permission: "merchant.access" },
      { label: "Brand\nsecret" },
      { label: "Brand\u200b" },
      { label: "x".repeat(101) },
      { label: "" },
      { brandReference },
    ]) {
      expect(() =>
        parseMerchantWorkspace({ ...workspace, navigation: [{ ...item, ...change }] }),
      ).toThrow("MERCHANT_WORKSPACE_INVALID");
    }
  });

  it("refuses Brand navigation accessors without evaluating them", () => {
    const read = vi.fn(() => "/app/organization/brands/" + brandReference);
    const item = {
      screenId: "ORG-BRAND-DETAIL",
      label: "Brand administration",
      href: "/app/organization/brands/" + brandReference,
      permission: "organization.manage",
    };
    Object.defineProperty(item, "href", { enumerable: true, get: read });
    expect(() => parseMerchantWorkspace({ ...workspace, navigation: [item] })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
    expect(read).not.toHaveBeenCalled();
    expect(() =>
      parseMerchantWorkspace({
        ...workspace,
        navigation: [Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(item))],
      }),
    ).toThrow("MERCHANT_WORKSPACE_INVALID");
    expect(read).not.toHaveBeenCalled();
  });

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

  it("accepts only the canonical permission-bound Task Inbox navigation entry", () => {
    const taskNavigation = {
      screenId: "TASK-INBOX",
      label: "Tasks",
      href: "/app/tasks",
      permission: "workflow.operate",
    } as const;
    expect(
      parseMerchantWorkspace({
        ...workspace,
        navigation: [...workspace.navigation, taskNavigation],
      }).navigation,
    ).toContainEqual(taskNavigation);
    expect(() =>
      parseMerchantWorkspace({
        ...workspace,
        navigation: [...workspace.navigation, { ...taskNavigation, href: "/app" }],
      }),
    ).toThrow("MERCHANT_WORKSPACE_INVALID");
  });

  it("admits only canonical Product navigation and rejects route/permission substitution", () => {
    const item = {
      screenId: "CAT-PRODUCT-LIST",
      label: "Products",
      href: "/app/commerce/products",
      permission: "catalog.manage",
    };
    expect(parseMerchantWorkspace({ ...workspace, navigation: [item] }).navigation).toEqual([item]);
    for (const change of [
      { href: "/operations/products" },
      { permission: "catalog.read" },
      { permission: "catalog.product.manage" },
      { extra: true },
      { screenId: "constructor", href: undefined, permission: undefined },
    ])
      expect(() =>
        parseMerchantWorkspace({ ...workspace, navigation: [{ ...item, ...change }] }),
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
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(request.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

it("admits canonical Option navigation and refuses Product route or permission substitution", () => {
  const item = {
    screenId: "CAT-OPTIONSET-LIST",
    label: "Option sets",
    href: "/app/commerce/option-sets",
    permission: "catalog.manage",
  };
  expect(parseMerchantWorkspace({ ...workspace, navigation: [item] }).navigation).toEqual([item]);
  for (const change of [
    { href: "/app/commerce/products" },
    { permission: "catalog.option_set.read" },
    { screenId: "CAT-OPTION-SET-LIST" },
    { extra: true },
  ]) {
    expect(() =>
      parseMerchantWorkspace({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_INVALID");
  }
});

it("anchors Store Setup navigation to selected Store and canonical organization permission", () => {
  const item = {
    screenId: "STORE-SETUP",
    label: "Store setup",
    href: "/app/organization/stores/" + storeReference + "/setup",
    permission: "organization.manage",
  };
  expect(parseMerchantWorkspace({ ...workspace, navigation: [item] }).navigation).toEqual([item]);
  for (const change of [
    { href: "/app/organization/stores/018f7f9a-ad3e-7a11-8d01-000000000099/setup" },
    { href: item.href + "?actor=x" },
    { permission: "merchant.access" },
  ])
    expect(() =>
      parseMerchantWorkspace({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_INVALID");
});

it("admits Tax navigation only at its exact permission and canonical route", () => {
  const entry = {
    screenId: "TAX-CONFIG",
    label: "Tax",
    href: "/app/commerce/tax",
    permission: "pricing.tax-config.manage",
  };
  expect(parseMerchantWorkspace({ ...workspace, navigation: [entry] }).navigation).toEqual([entry]);
  for (const wrong of [
    { ...entry, permission: "pricing.price-book.manage" },
    { ...entry, href: "/app/commerce/tax-rules" },
  ])
    expect(() => parseMerchantWorkspace({ ...workspace, navigation: [wrong] })).toThrow(
      "MERCHANT_WORKSPACE_INVALID",
    );
});
