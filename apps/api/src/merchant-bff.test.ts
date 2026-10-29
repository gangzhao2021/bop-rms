import {
  MerchantSoleOperatorBasisError,
  MerchantSoleOperatorGateError,
} from "./merchant-sole-operator.js";
import { MerchantStepUpError } from "./merchant-mfa-step-up.js";
import { MerchantRefundApprovalError } from "./merchant-ordinary-refund-approval.js";
import { MerchantSoleOperatorError } from "./merchant-sole-operator-setting.js";
import { BrandStoreTopologyError } from "@bop/tenant";
import {
  parsePublishingOptionSetPublicationOperation,
  parsePublishingReference,
  parsePublishingInstant,
} from "@bop/publishing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import { AcceptanceHoldRefundError } from "./merchant-order-acceptance-hold-refund.js";
import { MerchantOrderAcceptanceError } from "./merchant-order-acceptance-command.js";
import { StaffOrderCancellationError } from "./merchant-order-staff-cancellation.js";
import { StaffItemCancellationError } from "./merchant-order-item-staff-cancellation.js";
import { CounterOrderError } from "./merchant-counter-order.js";
import { StaffDiningRoundError } from "./merchant-staff-dining-round.js";
import { CounterMenuError } from "./merchant-counter-menu.js";
import { CardMachinePaymentCommandError } from "./merchant-card-machine-payment.js";
import { CardMachineRefundCommandError } from "./merchant-card-machine-refund.js";
import { OrderCloseCommandError } from "./merchant-dining-order-close-command.js";
import { DiningServeReadyError } from "./merchant-dining-serve-ready-command.js";
import { BrowserSessionError } from "@bop/identity";
import { parsePaymentReference, ReconciliationFollowUpError } from "@rms/payment";
import { parsePaymentInstant } from "@rms/payment";
import { DiningClosingError, parseDiningReference } from "@rms/dining";
import { FulfillmentReadinessError } from "@rms/fulfillment";
import { PickupHandoffError, PickupProofError } from "@rms/fulfillment";
import {
  KitchenQueueProjectionError,
  KitchenReworkError,
  KitchenStaleTicketError,
  KitchenWorkLifecycleError,
  parseKitchenWorkLifecycleResult,
} from "@rms/kitchen";
import {
  CatalogError,
  CatalogOptionSetListError,
  buildCatalogProductAuthoringResolution,
  buildCatalogSellingUnitRegistrationResolution,
  materializeFullOptionSetCreation,
  createCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringResolutionCommand,
  parseCatalogInstant,
  parseCatalogReference,
  optionContentReviewValidationCodes,
  parseCatalogOptionSetHistoryResult,
  parseCatalogOptionSetHistoryRequest,
} from "@rms/catalog";
import { PriceBookWorkflowError } from "@rms/pricing";
import { parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parseStoreAdministrationReference } from "@rms/store";
import {
  authorizationCookie,
  createAuthenticationSession,
  merchantSessionCookie,
  parseRawBrowserCredential,
  type BrowserCookieMutation,
  type RawBrowserCredential,
} from "@bop/identity";
import express from "express";
import { MerchantStoreConfigurationWithdrawalError } from "./merchant-store-configuration-withdrawal.js";
import { MerchantStoreHoursNoChangeError } from "./merchant-store-configuration.js";
import { createApp } from "./app.js";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantBffRouter,
  merchantNavigationActions,
  parseMerchantWorkspaceSnapshot,
  type MerchantBffService,
  type MerchantBffRouterOptions,
} from "./merchant-bff.js";

const serverTime = "2026-07-29T12:00:00.000Z";
const secret = (byte: number) =>
  parseRawBrowserCredential(Buffer.alloc(32, byte).toString("base64url"));
const authCookie = secret(1);
const sessionCookie = secret(2);
const csrf = secret(3);
const storeReference = "018f7f9a-ad3e-7a11-8d01-000000000003";
const secondStoreReference = "018f7f9a-ad3e-7a11-8d01-000000000004";
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
    Object.freeze({
      brandLabel: "Synthetic Brand",
      storeLabel: "Second Store",
      storeReference: secondStoreReference,
    }),
  ]),
  businessDate: "2026-07-29",
  storeStatus: "Open",
  freshness: "Current",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: [
    {
      screenId: "OPS-ORDER-EXCEPTION",
      label: "Order exceptions",
      href: "/operations/order-exceptions",
      permission: "operations.order-exception.manage",
    },
  ],
});
const session = createAuthenticationSession({
  sessionReference: "018f7f9a-ad3e-7a11-8d01-000000000001",
  actor: {
    actorType: "User",
    actorReference: "018f7f9a-ad3e-7a11-8d01-000000000002",
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: serverTime,
    recentMfaAt: null,
  },
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: serverTime,
  createdAt: serverTime,
  lastSeenAt: serverTime,
  idleExpiresAt: "2026-07-29T12:30:00.000Z",
  absoluteExpiresAt: "2026-07-30T00:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});

const servers: import("node:http").Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function cookieMutation(
  value: RawBrowserCredential | "",
  descriptor = merchantSessionCookie,
  clear = false,
): BrowserCookieMutation {
  return Object.freeze({ value, descriptor, clear });
}

function fakeService(): MerchantBffService {
  return {
    start: vi.fn(async () => ({
      authorizationUrl: "https://synthetic-idp.invalid/authorize?request=opaque",
      cookie: cookieMutation(authCookie, authorizationCookie),
    })),
    callback: vi.fn(async () => ({
      postLoginPath: "/orders",
      session,
      cookies: [
        cookieMutation("", authorizationCookie, true),
        cookieMutation(sessionCookie, merchantSessionCookie),
      ],
    })),
    bootstrap: vi.fn(async () => ({ session, csrf, workspace })),
    authorize: vi.fn(async () => session),
    logout: vi.fn(async () => cookieMutation("", merchantSessionCookie, true)),
    switchStore: vi.fn(async () => ({
      cookie: cookieMutation(secret(4), merchantSessionCookie),
      workspace: Object.freeze({
        ...workspace,
        selectedScope: workspace.authorizedStores[1],
      }),
    })),
  };
}

async function serve(
  service: MerchantBffService,
  orderExceptions?: MerchantBffRouterOptions["orderExceptions"],
  serviceControl?: MerchantBffRouterOptions["serviceControl"],
  serviceControlState?: MerchantBffRouterOptions["serviceControlState"],
  storeConfiguration?: MerchantBffRouterOptions["storeConfiguration"],
  diningItemService?: MerchantBffRouterOptions["diningItemService"],
  orderAcceptance?: MerchantBffRouterOptions["orderAcceptance"],
  orderQueue?: MerchantBffRouterOptions["orderQueue"],
  priceBooks?: MerchantBffRouterOptions["priceBooks"],
  productLifecycle?: MerchantBffRouterOptions["productLifecycle"],
  productCreation?: MerchantBffRouterOptions["productCreation"],
  menuDraft?: MerchantBffRouterOptions["menuDraft"],
  menuPublication?: MerchantBffRouterOptions["menuPublication"],
  ordinaryRefund?: MerchantBffRouterOptions["ordinaryRefund"],
  productDraft?: MerchantBffRouterOptions["productDraft"],
  kitchenCommand?: MerchantBffRouterOptions["kitchenCommand"],
  kitchenQuery?: MerchantBffRouterOptions["kitchenQuery"],
  pickupHandoff?: MerchantBffRouterOptions["pickupHandoff"],
  pickupProof?: MerchantBffRouterOptions["pickupProof"],
  pickupQuery?: MerchantBffRouterOptions["pickupQuery"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      ...(kitchenCommand ? { kitchenCommand } : {}),
      ...(kitchenQuery ? { kitchenQuery } : {}),
      ...(pickupHandoff ? { pickupHandoff } : {}),
      ...(pickupProof ? { pickupProof } : {}),
      ...(pickupQuery ? { pickupQuery } : {}),
      ...(diningItemService ? { diningItemService } : {}),
      ...(orderAcceptance ? { orderAcceptance } : {}),
      ...(orderQueue ? { orderQueue } : {}),
      ...(priceBooks ? { priceBooks } : {}),
      ...(productLifecycle ? { productLifecycle } : {}),
      ...(productCreation ? { productCreation } : {}),
      ...(productDraft ? { productDraft } : {}),
      ...(menuDraft ? { menuDraft } : {}),
      ...(menuPublication ? { menuPublication } : {}),
      ...(ordinaryRefund ? { ordinaryRefund } : {}),
      ...(orderExceptions ? { orderExceptions } : {}),
      ...(serviceControl ? { serviceControl } : {}),
      ...(storeConfiguration ? { storeConfiguration } : {}),
      ...(serviceControlState ? { serviceControlState } : {}),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  root: string,
  pathname: string,
  options: {
    readonly body?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  } = {},
) {
  return await new Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(pathname, root),
      { method: options.method ?? "GET", headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) headers.append(name, value);
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers,
            json: async () => JSON.parse(body) as unknown,
            text: async () => body,
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

const safeHeaders = {
  Host: "merchant.invalid",
  Origin: "https://merchant.invalid",
  "Sec-Fetch-Site": "same-origin",
};

describe("isolated merchant BFF transport", () => {
  it("sets exact no-store and __Host Cookie attributes across start and callback", async () => {
    const service = fakeService();
    const root = await serve(service);
    const start = await request(root, "/merchant/login?returnTo=%2Forders", {
      headers: safeHeaders,
    });
    expect(start.status).toBe(303);
    expect(start.headers.get("cache-control")).toBe("no-store");
    expect(start.headers.get("set-cookie")).toBe(
      `__Host-bop-auth=${authCookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    expect(start.headers.get("set-cookie")).not.toContain("Domain");

    const callback = await request(
      root,
      `/merchant/callback?code=${secret(8)}&state=${secret(9)}`,
      {
        headers: {
          Host: "merchant.invalid",
          "Sec-Fetch-Site": "cross-site",
          Cookie: `__Host-bop-auth=${authCookie}`,
        },
      },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/orders");
    const setCookies = callback.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies.join("\n")).not.toContain("Domain");
    expect(service.callback).toHaveBeenCalledWith({
      code: secret(8),
      state: secret(9),
      authCookie,
    });
  });

  it("returns CSRF only from no-store bootstrap and requires it for commands", async () => {
    const service = fakeService();
    const root = await serve(service);
    const bootstrap = await request(root, "/merchant/session", {
      headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(await bootstrap.json()).toEqual({
      authenticated: true,
      csrf,
      workspace,
    });
    const command = await request(root, "/merchant/protected", {
      method: "POST",
      headers: {
        ...safeHeaders,
        Cookie: `__Host-bop-merchant=${sessionCookie}`,
        "X-BOP-CSRF": csrf,
      },
    });
    expect(command.status).toBe(200);
    expect(service.authorize).toHaveBeenCalledWith({ sessionCookie, csrf });
  });

  it.each([
    [
      "cross-site Origin",
      {
        Host: "merchant.invalid",
        Origin: "https://evil.invalid",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "wrong Host",
      {
        Host: "evil.invalid",
        Origin: "https://merchant.invalid",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "cross-site Fetch Metadata",
      {
        Host: "merchant.invalid",
        Origin: "https://merchant.invalid",
        "Sec-Fetch-Site": "cross-site",
      },
    ],
  ])("fails closed for %s", async (_label, headers) => {
    const service = fakeService();
    const root = await serve(service);
    const response = await request(root, "/merchant/login", { headers });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "request_denied" });
    expect(service.start).not.toHaveBeenCalled();
  });

  it("accepts a same-site top-level login navigation without Origin", async () => {
    const service = fakeService();
    const root = await serve(service);
    const response = await request(root, "/merchant/login", {
      headers: { Host: "merchant.invalid", "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(303);
  });

  it("switches only through same-origin CSRF POST and returns a fresh closed workspace", async () => {
    const service = fakeService();
    const root = await serve(service);
    const headers = {
      ...safeHeaders,
      Cookie: `__Host-bop-merchant=${sessionCookie}`,
      "Content-Type": "application/json",
      "X-BOP-CSRF": csrf,
    };
    const response = await request(root, "/merchant/store-context", {
      method: "POST",
      headers,
      body: JSON.stringify({ targetStoreReference: secondStoreReference }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-bop-merchant=");
    expect(await response.json()).toMatchObject({
      workspace: { selectedScope: { storeReference: secondStoreReference } },
    });
    expect(service.switchStore).toHaveBeenCalledWith({
      sessionCookie,
      csrf,
      targetStoreReference: secondStoreReference,
    });

    const openBody = await request(root, "/merchant/store-context", {
      method: "POST",
      headers,
      body: JSON.stringify({ targetStoreReference: secondStoreReference, injected: true }),
    });
    expect(openBody.status).toBe(403);
    expect(service.switchStore).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed/open workspace adapter output without exposing it", async () => {
    const service = fakeService();
    vi.mocked(service.bootstrap).mockResolvedValueOnce({
      session,
      csrf,
      workspace: { ...workspace, injected: "denied" },
    });
    const root = await serve(service);
    const response = await request(root, "/merchant/session", {
      headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"request_denied"}');
  });

  it("collapses callback failures, clears auth state, and leaks no query credential", async () => {
    const service = fakeService();
    vi.mocked(service.callback).mockRejectedValueOnce(new Error("synthetic-provider-detail"));
    const root = await serve(service);
    const code = secret(11);
    const response = await request(root, `/merchant/callback?code=${code}&state=${secret(12)}`, {
      headers: {
        Host: "merchant.invalid",
        "Sec-Fetch-Site": "cross-site",
        Cookie: `__Host-bop-auth=${authCookie}`,
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const body = await response.text();
    expect(body).toBe('{"error":"request_denied"}');
    expect(body).not.toContain(code);
    expect(body).not.toContain("synthetic-provider-detail");
  });

  it("revokes through the service and clears the merchant Cookie idempotently", async () => {
    const service = fakeService();
    const root = await serve(service);
    const response = await request(root, "/merchant/logout", {
      method: "POST",
      headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-bop-merchant=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    expect(service.logout).toHaveBeenCalledWith(sessionCookie);
  });
});

describe("merchant order exception read route", () => {
  it("passes only the session cookie to the authorized reader and disables caching", async () => {
    const read = vi.fn(async () => ({
      screenId: "OPS-ORDER-EXCEPTION" as const,
      projectionName: "merchant_order_exception_v1" as const,
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-12",
      projectedAt: "2026-09-12T15:00:00.000Z",
      freshnessStatus: "Stale" as const,
      olderResolvedBefore: null,
      items: [],
    }));
    const root = await serve(fakeService(), read);
    const result = await request(root, "/merchant/order-exceptions", {
      headers: {
        host: "merchant.invalid",
        cookie: "__Host-bop-merchant=" + sessionCookie,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(result.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith(sessionCookie, { resolvedBefore: null });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ olderResolvedBefore: null });
  });
  it("WP-2423: passes only an older-resolved cursor through", async () => {
    const cursor = "0190fa86-0000-7000-8000-000000000030";
    const read = vi.fn(async () => ({
      screenId: "OPS-ORDER-EXCEPTION" as const,
      projectionName: "merchant_order_exception_v1" as const,
      storeLabel: "Synthetic Store",
      businessDate: "2026-09-12",
      projectedAt: "2026-09-12T15:00:00.000Z",
      freshnessStatus: "Fresh" as const,
      olderResolvedBefore: "0190fa86-0000-7000-8000-000000000020",
      items: [],
    }));
    const root = await serve(fakeService(), read);
    const headers = {
      host: "merchant.invalid",
      cookie: "__Host-bop-merchant=" + sessionCookie,
      "sec-fetch-site": "same-origin",
    };
    const result = await request(root, "/merchant/order-exceptions?resolvedBefore=" + cursor, {
      headers,
    });
    expect(result.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith(sessionCookie, { resolvedBefore: cursor });
    expect(await result.json()).toMatchObject({
      olderResolvedBefore: "0190fa86-0000-7000-8000-000000000020",
    });
    for (const path of [
      "/merchant/order-exceptions?resolvedBefore=x",
      `/merchant/order-exceptions?resolvedBefore=${cursor}&resolvedBefore=${cursor}`,
      `/merchant/order-exceptions?resolvedBefore=${cursor}&limit=500`,
    ])
      expect((await request(root, path, { headers })).status).toBe(403);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("D3: returns what each payment reconciliation difference is about", async () => {
    const item = {
      exceptionReference: "0190fa86-0000-7000-8000-000000000020",
      orderReference: null,
      orderNumber: null,
      kind: "PaymentReconciliationDifference" as const,
      severity: "High" as const,
      status: "Resolved" as const,
      providerState: "Confirmed" as const,
      compensationStatus: "NotRequested" as const,
      sourceOwner: "Payment" as const,
      createdAt: "2026-10-10T08:00:04.214Z",
      dueAt: "2026-10-10T08:15:04.214Z",
      ownerStatus: "Unassigned" as const,
      sourceFinal: true,
    };
    const day = {
      type: "BusinessDayTotals" as const,
      businessDate: "2026-10-09",
      captured: { storeMinor: "5650", providerMinor: "5650" },
      refunded: { storeMinor: "0", providerMinor: "2260" },
      checkedAt: "2026-10-10T08:00:04.214Z",
      resolvedAt: "2026-10-15T13:32:56.580Z",
    };
    const read = vi.fn(async () => ({
      screenId: "OPS-ORDER-EXCEPTION" as const,
      projectionName: "merchant_order_exception_v1" as const,
      storeLabel: "Synthetic Store",
      businessDate: "2026-10-15",
      projectedAt: "2026-10-15T15:00:00.000Z",
      freshnessStatus: "Fresh" as const,
      olderResolvedBefore: null,
      items: [
        { ...item, reconciliation: day },
        {
          ...item,
          exceptionReference: "0190fa86-0000-7000-8000-000000000021",
          reconciliation: { type: "Unavailable" as const },
        },
        {
          ...item,
          exceptionReference: "0190fa86-0000-7000-8000-000000000022",
          kind: "PaidWithoutFulfillableOrder" as const,
        },
      ],
    }));
    const root = await serve(fakeService(), read);
    const result = await request(root, "/merchant/order-exceptions", {
      headers: {
        host: "merchant.invalid",
        cookie: "__Host-bop-merchant=" + sessionCookie,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]?.reconciliation).toEqual(day);
    expect(body.items[1]?.reconciliation).toEqual({ type: "Unavailable" });
    expect(body.items[2]).not.toHaveProperty("reconciliation");
  });
  it.each([
    {
      path: "/merchant/order-exceptions?store_id=synthetic",
      headers: {
        host: "merchant.invalid",
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-merchant=" + sessionCookie,
      },
    },
    {
      path: "/merchant/order-exceptions",
      headers: {
        host: "merchant.invalid",
        "sec-fetch-site": "cross-site",
        cookie: "__Host-bop-merchant=" + sessionCookie,
      },
    },
    {
      path: "/merchant/order-exceptions",
      headers: {
        host: "merchant.invalid",
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-merchant=a; __Host-bop-merchant=b",
      },
    },
  ])("rejects an unsafe exception request before reading $path", async ({ path, headers }) => {
    const read = vi.fn(async () => {
      throw Error("must not read");
    });
    const root = await serve(fakeService(), read);
    expect((await request(root, path, { headers })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});

it.each(
  [
    [{ ...workspace.navigation[0], href: "https://foreign.example.test" }],
    [{ ...workspace.navigation[0], permission: "merchant.access" }],
    [{ ...workspace.navigation[0], extra: "denied" }],
    [workspace.navigation[0], workspace.navigation[0]],
    [{ ...workspace.navigation[0], screenId: "constructor" }],
  ].map((navigation) => ({ navigation })),
)("rejects unbounded or inconsistent navigation entries", ({ navigation }) => {
  expect(() => parseMerchantWorkspaceSnapshot({ ...workspace, navigation })).toThrow(
    "MERCHANT_WORKSPACE_DENIED",
  );
});

it("protects service-control transport and exposes only bounded results", async () => {
  const control = vi.fn<NonNullable<MerchantBffRouterOptions["serviceControl"]>>(async () => ({
    status: "Applied",
    resultingVersion: 1,
  }));
  const root = await serve(fakeService(), undefined, control);
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/service-control") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ command: "PauseService" }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/service-control?store=other")).status).toBe(403);
  expect(control).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "Applied", resultingVersion: 1 });
  expect(control).toHaveBeenCalledWith({
    sessionCookie,
    csrf,
    command: { command: "PauseService" },
  });
  control.mockRejectedValueOnce(new Error("STORE_SERVICE_VERSION_CONFLICT"));
  expect((await submit()).status).toBe(409);
  control.mockRejectedValueOnce(new Error("synthetic private failure detail"));
  const failed = await submit();
  expect(failed.status).toBe(403);
  expect(await failed.json()).toEqual({ error: "request_denied" });
});

it("protects store-configuration transport and exposes only bounded results", async () => {
  const control = vi.fn<NonNullable<MerchantBffRouterOptions["storeConfiguration"]>>(async () => ({
    status: "Applied",
    resultingVersion: 1,
  }));
  const root = await serve(fakeService(), undefined, undefined, undefined, control);
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/store-configuration") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ command: "SaveDraft" }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/store-configuration?store=other")).status).toBe(403);
  expect(control).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "Applied", resultingVersion: 1 });
  expect(control).toHaveBeenCalledWith({
    sessionCookie,
    csrf,
    command: { command: "SaveDraft" },
  });
  for (const code of [
    "STORE_CONFIGURATION_VERSION_CONFLICT",
    "STORE_CONFIGURATION_LIFECYCLE_CONFLICT",
  ]) {
    control.mockRejectedValueOnce(Object.assign(new Error("safe"), { code }));
    const conflict = await submit();
    expect(conflict.status, code).toBe(409);
    expect(await conflict.json(), code).toEqual({ error: "store_configuration_conflict" });
  }
  for (const rejected of [
    Object.assign(new Error("safe"), { code: "STORE_CONFIGURATION_REFERENCE_INVALID" }),
    Object.assign(new Error("safe"), { code: "STORE_CONFIGURATION_APPROVAL_INVALID" }),
    new Error("STORE_CONFIGURATION_REFERENCE_INVALID"),
  ]) {
    control.mockRejectedValueOnce(rejected);
    const response = await submit();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "store_configuration_rejected" });
  }
  control.mockRejectedValueOnce(new Error("STORE_CONFIGURATION_COMMAND_INVALID"));
  expect((await submit()).status).toBe(403);
  // WP-2423 (2026-10-16 v15): the hours already saved; nothing written.
  control.mockRejectedValueOnce(new MerchantStoreHoursNoChangeError());
  const unchanged = await submit();
  expect(unchanged.status).toBe(409);
  expect(await unchanged.json()).toEqual({ error: "no_change" });
  // WP-2423 (v15): refusals of another person's step or of one's own approval, said plainly.
  for (const [rejected, status, error] of [
    [
      Object.assign(new Error("safe"), { code: "STORE_CONFIGURATION_NOT_YOUR_CHANGE" }),
      409,
      "not_your_change",
    ],
    [
      Object.assign(new Error("safe"), { code: "STORE_CONFIGURATION_SELF_APPROVAL" }),
      409,
      "approval_needs_another_person",
    ],
    [new MerchantSoleOperatorGateError("NotInEffect", "Off"), 403, "sole_operator_off"],
    [
      new MerchantSoleOperatorGateError("NotInEffect", "OtherApprovers"),
      403,
      "sole_operator_not_in_effect",
    ],
    [
      new MerchantSoleOperatorGateError("NeedsReverification"),
      403,
      "sole_operator_needs_verification",
    ],
    // WP-2423 (v15 2026-10-16): approved alone while sole operator was off; not publishable.
    [new MerchantSoleOperatorBasisError(), 409, "sole_operator_approval_invalid"],
  ] as const) {
    control.mockRejectedValueOnce(rejected);
    const response = await submit();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }
  control.mockRejectedValueOnce(new Error("synthetic private failure detail"));
  const failed = await submit();
  expect(failed.status).toBe(403);
  expect(await failed.json()).toEqual({ error: "request_denied" });
});

it("restricts service-control state reads to safe scoped requests", async () => {
  const snapshot = {
    hours: {
      configurationSource: "StoreOverride" as const,
      effectiveFrom: parseCanonicalInstant(serverTime),
      effectiveUntil: null,
      businessDayStartLocalTime: "04:00:00",
      weeklySchedule: [],
      exceptions: [],
    },
    screenId: "STORE-HOURS-SERVICE" as const,
    storeReference: parseStoreReference(storeReference),
    configurationReference: parseStoreAdministrationReference(storeReference),
    timeZone: "America/Toronto",
    enabledServiceModes: ["Pickup" as const],
    expectedVersion: 0,
    activePauses: [],
    observedAt: parseCanonicalInstant(serverTime),
  };
  const read = vi.fn(async () => snapshot);
  const root = await serve(fakeService(), undefined, undefined, read);
  const headers = { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie };
  const response = await request(root, "/merchant/service-control", { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(snapshot);
  expect(read).toHaveBeenCalledExactlyOnceWith(sessionCookie);
  expect((await request(root, "/merchant/service-control?store=other", { headers })).status).toBe(
    403,
  );
  expect(
    (
      await request(root, "/merchant/service-control", {
        headers: { ...headers, Origin: "https://foreign.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValueOnce(new Error("synthetic internal detail"));
  const denied = await request(root, "/merchant/service-control", { headers });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "request_denied" });
});

it("protects Dining serving transport and excludes private record fields", async () => {
  type Result = Awaited<ReturnType<NonNullable<MerchantBffRouterOptions["diningItemService"]>>>;
  const serving = vi.fn<NonNullable<MerchantBffRouterOptions["diningItemService"]>>(
    async () =>
      ({
        status: "Created",
        record: { itemServiceVersion: 1, auditReference: "synthetic-private-audit" },
      }) as unknown as Result,
  );
  const root = await serve(fakeService(), undefined, undefined, undefined, undefined, serving);
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/item-service") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ syntheticCommand: true }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/dining/item-service?store=other")).status).toBe(403);
  expect(serving).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "Created", itemServiceVersion: 1 });
  expect(serving).toHaveBeenCalledWith({
    sessionCookie,
    csrf,
    command: { syntheticCommand: true },
  });
  serving.mockResolvedValueOnce({
    status: "AlreadyCommitted",
    record: { itemServiceVersion: 1 },
  } as unknown as Result);
  expect(await (await submit()).json()).toEqual({
    status: "AlreadyCommitted",
    itemServiceVersion: 1,
  });
  serving.mockRejectedValueOnce(new Error("synthetic private failure"));
  const failure = await submit();
  expect(failure.status).toBe(403);
  expect(await failure.json()).toEqual({ error: "request_denied" });
  const unavailable = await serve(fakeService());
  expect(
    (
      await request(unavailable, "/merchant/dining/item-service", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("protects order acceptance transport and returns only public status/version", async () => {
  const accept = vi.fn<NonNullable<MerchantBffRouterOptions["orderAcceptance"]>>(async () => ({
    status: "Created",
    acceptedOrderVersion: 2,
    sourceDigest: "synthetic-private-source",
  }));
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accept,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/orders/accept") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
    { Cookie: "__Host-bop-merchant=" + sessionCookie + "; __Host-bop-merchant=" + sessionCookie },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/orders/accept?store=other")).status).toBe(403);
  expect(accept).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "Created", acceptedOrderVersion: 2 });
  expect(accept).toHaveBeenCalledWith({ sessionCookie, csrf, command: {} });
  accept.mockResolvedValueOnce({ status: "AlreadyCommitted", acceptedOrderVersion: 2 });
  expect(await (await submit()).json()).toEqual({
    status: "AlreadyCommitted",
    acceptedOrderVersion: 2,
  });
  accept.mockRejectedValueOnce(new Error("synthetic-private-source"));
  const failure = await submit();
  expect(failure.status).toBe(403);
  expect(await failure.json()).toEqual({ error: "request_denied" });
  // WP-2423 D1: an authorized acceptance that did not happen is a conflict, never a refusal.
  for (const [code, error] of [
    ["ORDER_ACCEPTANCE_VERSION_CONFLICT", "order_changed"],
    ["ORDER_ACCEPTANCE_ALREADY_ACCEPTED", "already_accepted"],
    ["ORDER_ACCEPTANCE_NOT_ACCEPTABLE", "order_not_acceptable"],
  ] as const) {
    accept.mockRejectedValueOnce(new MerchantOrderAcceptanceError(code));
    const conflict = await submit();
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    expect(await conflict.json()).toEqual({ error });
  }
  const unconfigured = await serve(fakeService());
  const unavailable = await request(unconfigured, "/merchant/orders/accept", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "order_acceptance_unavailable" });
});

it("protects current order queue reads and bounds cursor authority", async () => {
  const queue = vi.fn<NonNullable<MerchantBffRouterOptions["orderQueue"]>>(async () => ({
    items: [],
    nextAfterOrderReference: null,
    lines: null,
    pickupContact: null,
    paymentPosition: null,
  }));
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
  );
  const headers = { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie };
  expect((await request(root, "/merchant/orders?store=foreign", { headers })).status).toBe(403);
  expect((await request(root, "/merchant/orders?after=invalid", { headers })).status).toBe(403);
  expect(
    (
      await request(root, "/merchant/orders?after=" + storeReference + "&after=" + storeReference, {
        headers,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(root, "/merchant/orders", {
        headers: { ...headers, Origin: "https://foreign.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(root, "/merchant/orders", { headers: { ...headers, Cookie: "" } })).status,
  ).toBe(403);
  expect(queue).not.toHaveBeenCalled();
  const response = await request(root, "/merchant/orders?after=" + storeReference, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    earlierDayItems: [],
    items: [],
    nextAfterOrderReference: null,
  });
  expect(queue).toHaveBeenCalledWith({ sessionCookie, afterOrderReference: storeReference });
  // WP-2423 (2026-10-16 v15): earlier-day Orders come apart from the page, which keeps its size.
  queue.mockResolvedValueOnce({
    items: [
      { orderReference: "earlier", earlierDay: true, batches: [] },
      { orderReference: "paged", earlierDay: false, batches: [] },
    ],
    nextAfterOrderReference: null,
  } as never);
  const split = (await (
    await request(root, "/merchant/orders?after=" + storeReference, { headers })
  ).json()) as {
    earlierDayItems: { orderReference: string }[];
    items: { orderReference: string }[];
  };
  expect(split.earlierDayItems.map((item) => item.orderReference)).toEqual(["earlier"]);
  expect(split.items.map((item) => item.orderReference)).toEqual(["paged"]);
  queue.mockRejectedValueOnce(new Error("synthetic-private-source"));
  const failed = await request(root, "/merchant/orders", { headers });
  expect(failed.status).toBe(403);
  expect(await failed.json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, "/merchant/orders", { headers })).status).toBe(503);
});

it("WP-2423: reads one order's detail with its lines and hides other Stores' orders", async () => {
  const order = "0198a408-0000-7000-8000-000000000123";
  const item = {
    orderReference: order,
    orderNumber: "16",
    orderType: "Pickup" as const,
    // WP-2423 item 8 ⑤: a pickup Order has no table session.
    diningSessionReference: null,
    sourceChannel: "Qr" as const,
    submittedAt: "2026-10-08T21:00:30.000Z",
    initialBatchReference: "0198a408-0000-7000-8000-000000000124",
    canRequestAcceptance: true,
    unfulfillable: null,
    pickupNotCollected: false,
    // WP-2423 Q1: a paid pickup awaiting acceptance carries when it stops being acceptable.
    acceptBy: "2026-10-08T21:30:30.000Z",
    awaitingPayment: false,
    // WP-2423: paid online; staff see it as paid like a card-machine order.
    paidOnline: { amountMinor: "1130", currencyCode: "CAD" as const },
    batches: [
      {
        orderBatchReference: "0198a408-0000-7000-8000-000000000124",
        sequence: 1,
        acceptanceStatus: "NotAccepted" as const,
        canRequestAcceptance: true,
        canCancel: false,
        staffCancellation: null,
        paymentDue: null,
      },
    ],
    currentPhase: "Submitted",
    currentVersion: 1,
    observedAt: "2026-10-08T21:10:00.000Z",
  };
  const lines = { items: [], totals: {} };
  // WP-2423 Q10: the pickup customer's contact for this order, on the detail only.
  const pickupContact = {
    status: "Available",
    name: "Synthetic Guest",
    channel: "Phone",
    value: "+14165550123",
  };
  const queue = vi.fn(async () => ({
    items: [item],
    nextAfterOrderReference: null,
    lines,
    pickupContact: { ...pickupContact },
    // WP-2423: refunds of the online payment, on the detail only.
    paymentPosition: { refundedMinor: "500", refundPendingMinor: "0" },
  }));
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue as never,
  );
  const headers = { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie };
  expect((await request(root, "/merchant/orders/detail", { headers })).status).toBe(403);
  expect((await request(root, "/merchant/orders/detail?order=16", { headers })).status).toBe(403);
  expect(
    (await request(root, "/merchant/orders/detail?order=" + order + "&after=x", { headers }))
      .status,
  ).toBe(403);
  expect(queue).not.toHaveBeenCalled();
  const response = await request(root, "/merchant/orders/detail?order=" + order, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    screenId: "OPS-ORDER-DETAIL",
    order: item,
    lines,
    paymentPosition: { refundedMinor: "500", refundPendingMinor: "0" },
    pickupContact,
  });
  expect(queue).toHaveBeenCalledWith({
    sessionCookie,
    afterOrderReference: null,
    orderReference: order,
  });
  queue.mockResolvedValueOnce({
    items: [],
    nextAfterOrderReference: null,
    lines: null,
    pickupContact: null,
  } as never);
  const missing = await request(root, "/merchant/orders/detail?order=" + order, { headers });
  expect(missing.status).toBe(404);
  // WP-2423: an unpaid round's failed payment and its automatic cancellation time reach staff.
  const due = { status: "Failed", cancelsAt: "2026-10-08T21:30:30.000Z" };
  const batch = item.batches[0];
  queue.mockResolvedValueOnce({
    items: [{ ...item, batches: [{ ...batch, paymentDue: due }] }],
    nextAfterOrderReference: null,
    lines,
    pickupContact: null,
  } as never);
  const warned = await request(root, "/merchant/orders/detail?order=" + order, { headers });
  expect(((await warned.json()) as { order: typeof item }).order.batches[0]).toEqual({
    ...batch,
    paymentDue: due,
  });
  // WP-2423: a list row carries its online payment's refund position (the detail's), so the row
  // says "partly refunded" after an item-cancellation refund as the detail does.
  const position = { refundedMinor: "350", refundPendingMinor: "0" };
  queue.mockResolvedValueOnce({
    items: [{ ...item, paymentPosition: position }],
    nextAfterOrderReference: null,
    lines: null,
    pickupContact: null,
    paymentPosition: null,
  } as never);
  const listed = await request(root, "/merchant/orders", { headers });
  expect(((await listed.json()) as { items: unknown[] }).items[0]).toEqual({
    ...item,
    paymentPosition: position,
  });
});

it("protects price management transport and sanitizes command failures", async () => {
  const result = {
    status: "Applied" as const,
    priceBookReference: "synthetic-book",
    versionReference: "synthetic-version",
    aggregateVersion: 1,
    lifecycle: "Draft" as const,
    snapshotDigest: "sha256:" + "a".repeat(64),
  };
  const write = vi.fn<NonNullable<MerchantBffRouterOptions["priceBooks"]>>(
    async () => result as never,
  );
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    write,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/pricing/price-books") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({ Host: "foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/pricing/price-books?brand=other")).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  for (const [code, status] of [
    ["PRICE_BOOK_INPUT_INVALID", 400],
    ["PRICE_BOOK_APPROVAL_REQUIRED", 403],
    ["PRICE_BOOK_VERSION_CONFLICT", 409],
    ["PRICE_BOOK_COVERAGE_INVALID", 422],
    ["PRICE_BOOK_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    write.mockRejectedValueOnce(new PriceBookWorkflowError(code));
    const failed = await submit();
    expect(failed.status).toBe(status);
    expect(JSON.stringify(await failed.json())).not.toContain(code);
  }
  write.mockRejectedValueOnce(new Error("synthetic-private-error"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/pricing/price-books", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("protects Product lifecycle transport and sanitizes command failures", async () => {
  const result = {
    status: "Applied" as const,
    productReference: "synthetic-product",
    skuReference: null,
    aggregateVersion: 2,
    productLifecycle: "Active" as const,
    skuLifecycle: null,
  };
  const write = vi.fn<NonNullable<MerchantBffRouterOptions["productLifecycle"]>>(
    async () => result as never,
  );
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    write,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "X-BOP-Catalog-Scope": Buffer.from(
      JSON.stringify({
        brandReference: "01902409-0000-7000-8000-000000000001",
        storeReference: "01902409-0000-7000-8000-000000000002",
      }),
    ).toString("base64url"),
  };
  const submit = (
    extra: Record<string, string> = {},
    path = "/merchant/catalog/products/lifecycle",
  ) => request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({ Host: "foreign.invalid" })).status).toBe(403);
  expect((await submit({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await submit({ Cookie: "" })).status).toBe(403);
  expect((await submit({}, "/merchant/catalog/products/lifecycle?brand=other")).status).toBe(403);
  for (const value of [
    "",
    "e30",
    "a".repeat(513),
    headers["X-BOP-Catalog-Scope"] + "," + headers["X-BOP-Catalog-Scope"],
  ])
    expect((await submit({ "X-BOP-Catalog-Scope": value })).status).toBe(403);
  expect(
    (
      await request(root, "/merchant/catalog/products/lifecycle", {
        method: "POST",
        body: "{}",
        headers: {
          ...headers,
          "X-BOP-Catalog-Scope": [headers["X-BOP-Catalog-Scope"], headers["X-BOP-Catalog-Scope"]],
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(root, "/merchant/catalog/products/lifecycle", {
        method: "POST",
        body: "{}",
        headers: { ...safeHeaders, Cookie: headers.Cookie, "X-BOP-CSRF": csrf },
      })
    ).status,
  ).toBe(403);
  expect(write).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedScope: {
        brandReference: "01902409-0000-7000-8000-000000000001",
        storeReference: "01902409-0000-7000-8000-000000000002",
      },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  for (const [code, status] of [
    ["CATALOG_INPUT_INVALID", 400],
    ["CATALOG_PERMISSION_DENIED", 403],
    ["CATALOG_VERSION_CONFLICT", 409],
    ["CATALOG_LIFECYCLE_CONFLICT", 409],
    ["CATALOG_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    write.mockRejectedValueOnce(new CatalogError(code));
    const failed = await submit();
    expect(failed.status).toBe(status);
    expect(JSON.stringify(await failed.json())).not.toContain(code);
  }
  write.mockRejectedValueOnce(new MerchantProductWriteFeatureDisabled());
  const disabled = await submit();
  expect(disabled.status).toBe(409);
  expect(await disabled.json()).toEqual({ error: "product_lifecycle_feature_disabled" });
  write.mockRejectedValueOnce(new Error("synthetic-private-error"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/catalog/products/lifecycle", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it.each(["creation", "draft"] as const)(
  "protects Product %s against foreign origins and missing CSRF with safe errors",
  async (mode) => {
    const route =
      mode === "creation" ? "/merchant/catalog/products" : "/merchant/catalog/products/draft";
    const result = {
      status: "Applied" as const,
      productReference: "synthetic-product",
      versionReference: "synthetic-version",
      aggregateVersion: 1,
      lifecycle: "Draft" as const,
      skus: [],
    };
    const write = vi.fn<NonNullable<MerchantBffRouterOptions["productCreation"]>>(
      async () => result as never,
    );
    const root = await serve(
      fakeService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mode === "creation" ? write : undefined,
      undefined,
      undefined,
      undefined,
      mode === "draft"
        ? (write as unknown as NonNullable<MerchantBffRouterOptions["productDraft"]>)
        : undefined,
    );
    const headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "X-BOP-Catalog-Scope": Buffer.from(
        JSON.stringify({
          brandReference: "01902409-0000-7000-8000-000000000001",
          storeReference: "01902409-0000-7000-8000-000000000002",
        }),
      ).toString("base64url"),
    };
    const submit = (extra: Record<string, string> = {}, path = route) =>
      request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
    for (const extra of [
      { Origin: "https://foreign.invalid" },
      { Host: "foreign.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { "X-BOP-CSRF": "" },
      { Cookie: "" },
      { "X-BOP-Catalog-Scope": "" },
      { "X-BOP-Catalog-Scope": "e30" },
      { "X-BOP-Catalog-Scope": "a".repeat(513) },
    ])
      expect((await submit(extra)).status).toBe(403);
    expect((await submit({}, route + "?brand=other")).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    const response = await submit();
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedScope: {
          brandReference: "01902409-0000-7000-8000-000000000001",
          storeReference: "01902409-0000-7000-8000-000000000002",
        },
      }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    for (const [code, status] of [
      ["CATALOG_INPUT_INVALID", 400],
      ["CATALOG_PERMISSION_DENIED", 403],
      ["CATALOG_CODE_CONFLICT", 409],
      ["CATALOG_IDEMPOTENCY_CONFLICT", 409],
      ["CATALOG_DEPENDENCY_UNAVAILABLE", 503],
    ] as const) {
      write.mockRejectedValueOnce(new CatalogError(code));
      const failed = await submit();
      expect(failed.status).toBe(status);
      expect(JSON.stringify(await failed.json())).not.toContain(code);
    }
    write.mockRejectedValueOnce(new MerchantProductWriteFeatureDisabled());
    const disabled = await submit();
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({
      error:
        mode === "creation"
          ? "product_creation_feature_disabled"
          : "product_draft_feature_disabled",
    });
    write.mockRejectedValueOnce(new Error("synthetic-private-error"));
    expect(await (await submit()).json()).toEqual({ error: "request_denied" });
    const unconfigured = await serve(fakeService());
    expect(
      (
        await request(unconfigured, route, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(503);
  },
);

it("protects complete Menu Draft reads behind the same session and CSRF boundary", async () => {
  const read = vi.fn<NonNullable<MerchantBffRouterOptions["menuDraft"]>>(
    async () => ({ status: "Found" }) as never,
  );
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    read,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/catalog/menus/draft") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/catalog/menus/draft?brand=other")).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  read.mockRejectedValueOnce(new Error("synthetic-private-menu"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  read.mockRejectedValueOnce(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
  expect((await submit()).status).toBe(503);
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/catalog/menus/draft", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("protects Menu publication commands and returns safe status errors", async () => {
  const write = vi.fn<NonNullable<MerchantBffRouterOptions["menuPublication"]>>(
    async () => ({ status: "Applied" }) as never,
  );
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    write,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const submit = (
    extra: Record<string, string> = {},
    path = "/merchant/catalog/menus/publication",
  ) => request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/catalog/menus/publication?brand=other")).status).toBe(403);
  expect(write).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const [code, status] of [
    ["CATALOG_INPUT_INVALID", 400],
    ["CATALOG_PERMISSION_DENIED", 403],
    ["CATALOG_VERSION_CONFLICT", 409],
    ["CATALOG_IDEMPOTENCY_CONFLICT", 409],
    ["CATALOG_LIFECYCLE_CONFLICT", 409],
    ["CATALOG_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    write.mockRejectedValueOnce(new CatalogError(code));
    const failed = await submit();
    expect(failed.status).toBe(status);
    expect(JSON.stringify(await failed.json())).not.toContain(code);
  }
  write.mockRejectedValueOnce(new Error("synthetic-private-menu"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/catalog/menus/publication", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("protects ordinary refund preparation and does not claim Provider success or expose internal facts", async () => {
  const operationReference = "01909974-0000-7000-8000-000000000009";
  const prepare = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefund"]>>(async () => ({
    status: "Created",
    operationReference,
    internalProviderFact: "synthetic-private",
  }));
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    prepare,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/prepare" + suffix, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(prepare).not.toHaveBeenCalled();
  const accepted = await post();
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(await accepted.json()).toEqual({
    status: "PreparationRecorded",
    operationReference,
    replayed: false,
  });
  prepare.mockResolvedValueOnce({ status: "AlreadyCommitted", operationReference });
  expect(await (await post()).json()).toEqual({
    status: "PreparationRecorded",
    operationReference,
    replayed: true,
  });
  prepare.mockRejectedValueOnce(new Error("synthetic-private-provider-detail"));
  expect(await (await post()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/prepare", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("protects Kitchen commands and preserves typed recovery outcomes", async () => {
  const execute = vi.fn<NonNullable<MerchantBffRouterOptions["kitchenCommand"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    execute,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/kitchen/work") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/kitchen/work?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  for (const [code, status] of [
    ["KITCHEN_WORK_INPUT_INVALID", 400],
    ["KITCHEN_WORK_PERMISSION_DENIED", 403],
    ["KITCHEN_WORK_NOT_FOUND", 404],
    ["KITCHEN_WORK_VERSION_CONFLICT", 409],
    ["KITCHEN_WORK_PRECONDITION_FAILED", 422],
    ["KITCHEN_WORK_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    execute.mockRejectedValueOnce(new KitchenWorkLifecycleError(code));
    const result = await submit();
    expect(result.status).toBe(status);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ error: code });
  }
  // WP-2423 (v15 2026-10-16): a step that kept meeting a database conflict (a deadlock with the
  // queue rebuild), a busy pool or a statement timeout is "busy, try again" (503), never 403; a
  // refused row or anything unknown stays a refusal.
  const database = (code: string, sqlState: string | null = null) =>
    Object.assign(new Error("database"), { code, diagnostic: { sqlState } });
  for (const [error, status, body] of [
    [database("TENANT_DATABASE_TRANSACTION_CONFLICT", "40P01"), 503, { error: "retry_later" }],
    [database("TENANT_DATABASE_ACQUIRE_FAILED"), 503, { error: "retry_later" }],
    [database("TENANT_DATABASE_TRANSACTION_FAILED", "57014"), 503, { error: "retry_later" }],
    [database("TENANT_DATABASE_TRANSACTION_FAILED", "42501"), 403, { error: "request_denied" }],
    [new Error("synthetic-private-source"), 403, { error: "request_denied" }],
  ] as const) {
    execute.mockRejectedValueOnce(error);
    const result = await submit();
    expect([result.status, await result.json()]).toEqual([status, body]);
    if (status === 503) expect(result.headers.get("retry-after")).toBe("1");
  }
  const result = parseKitchenWorkLifecycleResult({
    operationReference: "018f7f9a-ad3e-7a11-8d01-000000000011",
    action: "AcceptKitchenWorkItem" as const,
    outcome: "Accepted" as const,
    ticketReference: "018f7f9a-ad3e-7a11-8d01-000000000012",
    workItemReference: "018f7f9a-ad3e-7a11-8d01-000000000013",
    orderItemReference: "018f7f9a-ad3e-7a11-8d01-000000000014",
    ticketVersion: "2",
    workItemVersion: "2",
    workItemStatus: "Queued" as const,
    completedQuantity: 0,
    requiredQuantity: 1,
    occurredAt: serverTime,
    readyResultReference: null,
    readyQuantity: null,
    projectionName: "kitchen_work_queue_v1" as const,
    projectionPending: true as const,
    projectionTriggers: ["KitchenLifecycleEvent"] as const,
  });
  execute.mockResolvedValueOnce(result);
  const success = await submit();
  expect(success.status).toBe(200);
  expect(await success.json()).toEqual(result);
  expect(execute).toHaveBeenLastCalledWith({ sessionCookie, csrf, command: {} });
  const unavailable = await serve(fakeService());
  expect(
    (
      await request(unavailable, "/merchant/kitchen/work", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
  execute.mockRejectedValueOnce(new Error("private adapter details"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
});

it("protects Kitchen queries and exposes only typed public failures", async () => {
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["kitchenQuery"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    query,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/kitchen/query") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/kitchen/query?item=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  for (const [code, status] of [
    ["KITCHEN_QUEUE_INPUT_INVALID", 400],
    ["KITCHEN_QUEUE_PERMISSION_DENIED", 403],
    ["KITCHEN_QUEUE_NOT_FOUND", 404],
    ["KITCHEN_QUEUE_VERSION_CONFLICT", 409],
    ["KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    query.mockRejectedValueOnce(new KitchenQueueProjectionError(code));
    const response = await submit();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: code });
  }
  query.mockRejectedValueOnce(new Error("private SQL"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/kitchen/query", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("protects Pickup handoff and exposes only typed public failures", async () => {
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["pickupHandoff"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    query,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/pickup/handoff") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/pickup/handoff?item=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  for (const [code, status] of [
    ["PICKUP_HANDOFF_INPUT_INVALID", 400],
    ["PICKUP_HANDOFF_PERMISSION_DENIED", 403],
    ["PICKUP_HANDOFF_NOT_READY", 422],
    ["PICKUP_HANDOFF_VERIFICATION_FAILED", 422],
    ["PICKUP_HANDOFF_ALREADY_COMPLETED", 409],
    ["PICKUP_HANDOFF_VERSION_CONFLICT", 409],
  ] as const) {
    query.mockRejectedValueOnce(new PickupHandoffError(code));
    const response = await submit();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: code });
  }
  query.mockRejectedValueOnce(new Error("private SQL"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/pickup/handoff", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("WP-2423: protects the in-person pickup check details and never caches them", async () => {
  const read = vi.fn<NonNullable<MerchantBffRouterOptions["pickupIdentityCheck"]>>();
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      pickupIdentityCheck: read,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/pickup/identity-check") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/pickup/identity-check?order=other")).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce({ status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  const ok = await submit();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual({ status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  for (const [code, status] of [
    ["PICKUP_HANDOFF_INPUT_INVALID", 400],
    ["PICKUP_HANDOFF_PERMISSION_DENIED", 403],
    ["PICKUP_HANDOFF_NOT_READY", 422],
  ] as const) {
    read.mockRejectedValueOnce(new PickupHandoffError(code));
    const response = await submit();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: code });
  }
  read.mockRejectedValueOnce(new Error("private SQL"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/pickup/identity-check", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("protects Pickup proof and exposes only typed public failures", async () => {
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["pickupProof"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    query,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/pickup/proof") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/pickup/proof?item=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  for (const [code, status] of [
    ["PICKUP_PROOF_INPUT_INVALID", 400],
    ["PICKUP_PROOF_NOT_READY", 422],
    ["PICKUP_PROOF_VERSION_CONFLICT", 409],
    ["PICKUP_PROOF_UNAVAILABLE", 422],
  ] as const) {
    query.mockRejectedValueOnce(new PickupProofError(code));
    const response = await submit();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: code });
  }
  query.mockRejectedValueOnce(new Error("private SQL"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/pickup/proof", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("protects Pickup queue and exposes only typed public failures", async () => {
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["pickupQuery"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    query,
  );
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/pickup/query") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/pickup/query?item=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  for (const [code, status] of [
    ["FULFILLMENT_READINESS_INPUT_INVALID", 400],
    ["FULFILLMENT_READINESS_PERMISSION_DENIED", 403],
    ["FULFILLMENT_READINESS_NOT_FOUND", 404],
    ["FULFILLMENT_READINESS_CONFLICT", 409],
    ["FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE", 503],
  ] as const) {
    query.mockRejectedValueOnce(new FulfillmentReadinessError(code));
    const response = await submit();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: code });
  }
  query.mockRejectedValueOnce(new Error("private SQL"));
  expect(await (await submit()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect(
    (
      await request(unconfigured, "/merchant/pickup/query", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("protects Dining progress transport and returns only operational fields", async () => {
  const comboItem = "01a1865e-ed36-75b9-95d6-9b666425aecd";
  type Reader = NonNullable<MerchantBffRouterOptions["diningOrderProgress"]>;
  const current = {
    orderReference: storeReference,
    tableLabel: "T1",
    sessionVersion: 2,
    tableAssignmentVersion: 3,
    orderVersion: 3,
    phase: "Fulfilled",
    observedAt: serverTime,
    brandReference: "private-brand",
    guestSessionReference: "private-guest",
    items: [
      {
        orderItemReference: storeReference,
        orderBatchReference: storeReference,
        displayName: "Meal",
        batchSequence: 1,
        itemOrdinal: 1,
        phase: "Fulfilled",
        orderedQuantity: 2,
        deliveredQuantity: 2,
        remainingQuantity: 0,
        itemServiceVersion: 1,
        auditReference: "private-audit",
      },
      // WP-2423 item 8 ⑥ part 4 (v15 2026-10-29: the reply left a combo's dishes out).
      {
        orderItemReference: comboItem,
        orderBatchReference: storeReference,
        displayName: "Dim sum lunch (TEST)",
        batchSequence: 1,
        itemOrdinal: 2,
        phase: "Ready",
        orderedQuantity: 1,
        deliveredQuantity: 0,
        remainingQuantity: 1,
        itemServiceVersion: 0,
        options: [{ name: "Siu mai (TEST)", quantity: 1 }],
        customerNote: null,
        comboParts: [
          {
            optionReference: storeReference,
            nameZh: "烧卖",
            name: "Siu mai (TEST)",
            done: true,
            served: false,
            auditReference: "private-audit",
          },
        ],
      },
    ],
  };
  const read = vi.fn<Reader>().mockResolvedValue(current as unknown as Awaited<ReturnType<Reader>>);
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      diningOrderProgress: read,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/order-progress") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ orderReference: storeReference }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({ Cookie: "" })).status).toBe(403);
  expect((await submit({}, "/merchant/dining/order-progress?store=other")).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    orderReference: storeReference,
    tableLabel: "T1",
    sessionVersion: 2,
    tableAssignmentVersion: 3,
    orderVersion: 3,
    phase: "Fulfilled",
    observedAt: serverTime,
    items: [
      {
        orderItemReference: storeReference,
        orderBatchReference: storeReference,
        displayName: "Meal",
        batchSequence: 1,
        itemOrdinal: 1,
        phase: "Fulfilled",
        orderedQuantity: 2,
        deliveredQuantity: 2,
        remainingQuantity: 0,
        itemServiceVersion: 1,
      },
      {
        orderItemReference: comboItem,
        orderBatchReference: storeReference,
        displayName: "Dim sum lunch (TEST)",
        batchSequence: 1,
        itemOrdinal: 2,
        phase: "Ready",
        orderedQuantity: 1,
        deliveredQuantity: 0,
        remainingQuantity: 1,
        itemServiceVersion: 0,
        options: [{ name: "Siu mai (TEST)", quantity: 1 }],
        customerNote: null,
        comboParts: [
          {
            optionReference: storeReference,
            nameZh: "烧卖",
            name: "Siu mai (TEST)",
            done: true,
            served: false,
          },
        ],
      },
    ],
  });
  expect(read).toHaveBeenCalledWith({
    sessionCookie,
    csrf,
    query: { orderReference: storeReference },
  });
  read.mockResolvedValueOnce(null);
  expect((await submit()).status).toBe(404);
  read.mockRejectedValueOnce(new Error("private failure"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "request_denied" });
  const unavailable = await serve(fakeService());
  expect(
    (
      await request(unavailable, "/merchant/dining/order-progress", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it("protects the minimal Dining serve command and keeps private facts out of responses", async () => {
  const command = vi
    .fn<NonNullable<MerchantBffRouterOptions["diningServe"]>>()
    .mockResolvedValue({ status: "Created", itemServiceVersion: 2 });
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      diningServe: command,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/serve") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ syntheticIntent: true }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({ Cookie: "" })).status).toBe(403);
  expect((await submit({}, "/merchant/dining/serve?store=other")).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "Created", itemServiceVersion: 2 });
  expect(command).toHaveBeenCalledWith({ sessionCookie, csrf, command: { syntheticIntent: true } });
  command.mockResolvedValueOnce({ status: "AlreadyCommitted", itemServiceVersion: 2 });
  expect(await (await submit()).json()).toEqual({
    status: "AlreadyCommitted",
    itemServiceVersion: 2,
  });
  command.mockRejectedValueOnce(new Error("private details"));
  const failure = await submit();
  expect(failure.status).toBe(403);
  expect(await failure.json()).toEqual({ error: "request_denied" });
  const absent = await serve(fakeService());
  expect(
    (await request(absent, "/merchant/dining/serve", { method: "POST", headers, body: "{}" }))
      .status,
  ).toBe(503);
});

it("WP-2423: protects Serve all ready items and maps whole-request outcomes", async () => {
  const lineReference = "0190a7c6-1111-7000-8000-00000000000a";
  const summary = {
    operationReference: "0190a7c6-1111-7000-8000-000000000001",
    served: 1,
    alreadyServed: 0,
    changed: 0,
    failed: 0,
    lines: [{ orderItemReference: lineReference, outcome: "Served" as const }],
  };
  const command = vi
    .fn<NonNullable<MerchantBffRouterOptions["diningServeReady"]>>()
    .mockResolvedValue(summary);
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      diningServeReady: command,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/serve-ready") =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ syntheticIntent: true }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({ Cookie: "" })).status).toBe(403);
  expect((await submit({}, "/merchant/dining/serve-ready?store=other")).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(summary);
  expect(command).toHaveBeenCalledWith({ sessionCookie, csrf, command: { syntheticIntent: true } });
  const answer = async (error: unknown) => {
    command.mockRejectedValueOnce(error);
    const failure = await submit();
    return [failure.status, await failure.json()];
  };
  expect(await answer(new DiningServeReadyError("PermissionDenied"))).toEqual([
    403,
    { error: "request_denied" },
  ]);
  expect(await answer(new DiningServeReadyError("Invalid"))).toEqual([
    400,
    { error: "dining_serve_ready_invalid" },
  ]);
  expect(await answer(new DiningServeReadyError("NotFound"))).toEqual([
    404,
    { error: "dining_serve_ready_not_found" },
  ]);
  expect(await answer(new Error("private details"))).toEqual([
    503,
    { error: "dining_serve_ready_unavailable" },
  ]);
  const absent = await serve(fakeService());
  expect(
    (await request(absent, "/merchant/dining/serve-ready", { method: "POST", headers, body: "{}" }))
      .status,
  ).toBe(503);
});

async function serveSettlement(settlement?: MerchantBffRouterOptions["settlement"]) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(settlement ? { settlement } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
describe("WP-2423 P1 merchant settlement read route", () => {
  const view = {
    screenId: "PAY-RECONCILIATION" as const,
    storeLabel: "Synthetic Store",
    businessDate: "2026-09-21",
    window: {
      startsAt: "2026-09-21T08:00:00.000Z",
      endsAt: "2026-09-22T08:00:00.000Z",
      timeZone: "America/Toronto",
      status: "Closed" as const,
    },
    captured: { count: 3, amountMinor: "4500", currencyCode: "CAD" as const },
    refunded: null,
    selfApprovedRefunds: { count: 1, amountMinor: "11600", currencyCode: "CAD" as const },
    currentDaySelfApprovedRefunds: null,
    reconciliation: {
      settlement: null,
      operational: {
        runCount: 0,
        latestRun: null,
        paymentCount: 0,
        outcomes: { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
      },
      differences: [],
      differenceCount: 0,
    },
    cardMachine: {
      taken: { count: 2, amountMinor: "2560", currencyCode: "CAD" as const },
      tipMinor: "180",
      recordedAfterOutageCount: 1,
      refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" as const },
    },
    cash: null,
    unpaidWriteOffs: null,
    comps: null,
    unmatchedProviderCharges: null,
    projectedAt: "2026-09-22T09:00:00.000Z",
  };
  const headers = {
    host: "merchant.invalid",
    cookie: "__Host-bop-merchant=" + sessionCookie,
    "sec-fetch-site": "same-origin",
  };
  it("passes the session cookie and an optional business date to the reader, no caching", async () => {
    const read = vi.fn<NonNullable<MerchantBffRouterOptions["settlement"]>>(async () => view);
    const root = await serveSettlement(read);
    const latest = await request(root, "/merchant/settlement", { headers });
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenLastCalledWith({ sessionCookie, businessDate: null });
    const day = await request(root, "/merchant/settlement?businessDate=2026-09-21", { headers });
    expect(day.status).toBe(200);
    expect(await day.json()).toMatchObject({
      screenId: "PAY-RECONCILIATION",
      businessDate: "2026-09-21",
    });
    expect(read).toHaveBeenLastCalledWith({ sessionCookie, businessDate: "2026-09-21" });
  });
  it("refuses a malformed date, extra parameters, a missing session and a cross-site read", async () => {
    const read = vi.fn<NonNullable<MerchantBffRouterOptions["settlement"]>>(async () => view);
    const root = await serveSettlement(read);
    for (const [path, extra] of [
      ["/merchant/settlement?businessDate=2026-9-1", {}],
      ["/merchant/settlement?businessDate=2026-09-21&store=x", {}],
      ["/merchant/settlement", { cookie: "" }],
      ["/merchant/settlement", { "sec-fetch-site": "cross-site" }],
    ] as const) {
      const result = await request(root, path, { headers: { ...headers, ...extra } });
      expect(result.status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
    const absent = await serveSettlement();
    expect((await request(absent, "/merchant/settlement", { headers })).status).toBe(503);
  });
  it("answers a reader failure as denied without leaking the reason", async () => {
    const root = await serveSettlement(async () => {
      throw new Error("MERCHANT_SETTLEMENT_UNAVAILABLE");
    });
    const result = await request(root, "/merchant/settlement", { headers });
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain("SETTLEMENT");
  });
  it("answers records busy with live work as retry-later, never as denied (WP-2423 Q7 v15)", async () => {
    const root = await serveSettlement(async () => {
      throw Object.assign(new Error("MERCHANT_SETTLEMENT_BUSY"), {
        code: "MERCHANT_SETTLEMENT_BUSY",
      });
    });
    const result = await request(root, "/merchant/settlement", { headers });
    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBe("5");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ error: "settlement_busy" });
  });
  it("WP-2423: answers a day before the Store's records begin with its first day, not denied", async () => {
    const root = await serveSettlement(async () => {
      throw Object.assign(new Error("MERCHANT_SETTLEMENT_NOT_COVERED"), {
        code: "MERCHANT_SETTLEMENT_NOT_COVERED",
        firstBusinessDate: "2026-09-20",
      });
    });
    const result = await request(root, "/merchant/settlement?businessDate=2026-09-19", { headers });
    expect(result.status).toBe(404);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({
      error: "settlement_not_covered",
      firstBusinessDate: "2026-09-20",
    });
    const malformed = await serveSettlement(async () => {
      throw Object.assign(new Error("x"), {
        code: "MERCHANT_SETTLEMENT_NOT_COVERED",
        firstBusinessDate: "soon",
      });
    });
    expect((await request(malformed, "/merchant/settlement", { headers })).status).toBe(403);
  });
});
describe("WP-2423 Q14 store reports routes", () => {
  type Reports = NonNullable<MerchantBffRouterOptions["storeReports"]>;
  const headers = {
    host: "merchant.invalid",
    cookie: "__Host-bop-merchant=" + sessionCookie,
    "sec-fetch-site": "same-origin",
  };
  async function serveReports(reports?: Reports) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(reports ? { storeReports: reports } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  const fake = () => {
    const view = { screenId: "RPT-OPS-DASHBOARD", from: "2026-10-13", to: "2026-10-14" };
    return {
      read: vi.fn(async () => view as unknown as Awaited<ReturnType<Reports["read"]>>),
      tonight: vi.fn(
        async () =>
          ({ report: view, openTables: [] }) as unknown as Awaited<ReturnType<Reports["tonight"]>>,
      ),
      export: vi.fn(async () => ({
        fileName: "items-2026-10-13-to-2026-10-14.csv",
        body: "﻿business_date,item\r\n2026-10-14,Muffin\r\n",
      })),
    } satisfies Reports;
  };
  it("reads a range with the session cookie and no caching", async () => {
    const reports = fake();
    const root = await serveReports(reports);
    const today = await request(root, "/merchant/reports", { headers });
    expect(today.status).toBe(200);
    expect(today.headers.get("cache-control")).toBe("no-store");
    expect(reports.read).toHaveBeenLastCalledWith({ sessionCookie, from: null, to: null });
    await request(root, "/merchant/reports?from=2026-10-13&to=2026-10-14", { headers });
    expect(reports.read).toHaveBeenLastCalledWith({
      sessionCookie,
      from: "2026-10-13",
      to: "2026-10-14",
    });
  });
  it("WP-2423 item 8 ②: reads tonight's closing summary with the session cookie and no caching", async () => {
    const reports = fake();
    const root = await serveReports(reports);
    const tonight = await request(root, "/merchant/reports/tonight", { headers });
    expect(tonight.status).toBe(200);
    expect(tonight.headers.get("cache-control")).toBe("no-store");
    expect(reports.tonight).toHaveBeenLastCalledWith({ sessionCookie });
    // Tonight is always the Store's current business day: no range or other parameter.
    expect(
      (await request(root, "/merchant/reports/tonight?from=2026-10-13", { headers })).status,
    ).toBe(403);
    expect(reports.tonight).toHaveBeenCalledOnce();
  });
  it("downloads one report as a UTF-8 CSV attachment under the export permission", async () => {
    const reports = fake();
    const root = await serveReports(reports);
    const file = await request(
      root,
      "/merchant/reports/export?report=items&from=2026-10-13&to=2026-10-14",
      { headers },
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(file.headers.get("content-disposition")).toBe(
      'attachment; filename="items-2026-10-13-to-2026-10-14.csv"',
    );
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(await file.text()).toContain("business_date,item");
    expect(reports.export).toHaveBeenLastCalledWith({
      sessionCookie,
      from: "2026-10-13",
      to: "2026-10-14",
      report: "items",
    });
  });
  it("refuses malformed ranges, unknown reports, extra parameters, no session and cross-site", async () => {
    const reports = fake();
    const root = await serveReports(reports);
    for (const [path, extra] of [
      ["/merchant/reports?from=2026-10-1", {}],
      ["/merchant/reports?from=2026-10-13&store=x", {}],
      ["/merchant/reports/export?report=customers", {}],
      ["/merchant/reports/export", {}],
      ["/merchant/reports", { cookie: "" }],
      ["/merchant/reports", { "sec-fetch-site": "cross-site" }],
    ] as const) {
      const result = await request(root, path, { headers: { ...headers, ...extra } });
      expect(result.status).toBe(403);
    }
    expect(reports.read).not.toHaveBeenCalled();
    expect(reports.export).not.toHaveBeenCalled();
    const absent = await serveReports();
    expect((await request(absent, "/merchant/reports", { headers })).status).toBe(503);
  });
  it("answers a refusal as denied and busy records as retry-later", async () => {
    const denied = fake();
    denied.read.mockRejectedValue(new Error("MERCHANT_STORE_REPORTS_UNAVAILABLE"));
    const refused = await request(await serveReports(denied), "/merchant/reports", { headers });
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("REPORTS");
    const busy = fake();
    busy.export.mockRejectedValue(
      Object.assign(new Error("MERCHANT_STORE_REPORTS_BUSY"), {
        code: "MERCHANT_STORE_REPORTS_BUSY",
      }),
    );
    const later = await request(await serveReports(busy), "/merchant/reports/export?report=tips", {
      headers,
    });
    expect(later.status).toBe(503);
    expect(later.headers.get("retry-after")).toBe("5");
    expect(await later.json()).toEqual({ error: "reports_busy" });
  });
});
describe("WP-2423 Q21 merchant business-day read route", () => {
  const day = {
    businessDate: "2026-10-14",
    startsAt: "2026-10-14T08:00:00.000Z",
    endsAt: "2026-10-15T08:00:00.000Z",
    timeZone: "America/Toronto",
    observedAt: "2026-10-15T05:30:00.000Z",
    // WP-2423 item 8 ③ follow-up: when guests stop ordering in this period.
    lastOrdersAt: "2026-10-15T01:30:00.000Z",
  };
  const headers = {
    cookie: "__Host-bop-merchant=" + sessionCookie,
    "sec-fetch-site": "same-origin",
    host: "merchant.invalid",
  };
  async function serveDay(businessDay?: MerchantBffRouterOptions["businessDay"]) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(businessDay ? { businessDay } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  it("answers the Store's current business day without configuration identity", async () => {
    const read = vi.fn<NonNullable<MerchantBffRouterOptions["businessDay"]>>(async () =>
      Object.freeze({ ...day }),
    );
    const root = await serveDay(read);
    const result = await request(root, "/merchant/business-day", { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(day);
    expect(read).toHaveBeenCalledExactlyOnceWith(sessionCookie);
  });
  it("refuses parameters, a missing session and cross-site reads; hides reader failures", async () => {
    const read = vi.fn<NonNullable<MerchantBffRouterOptions["businessDay"]>>(async () => day);
    const root = await serveDay(read);
    for (const [path, extra] of [
      ["/merchant/business-day?store=x", {}],
      ["/merchant/business-day", { cookie: "" }],
      ["/merchant/business-day", { "sec-fetch-site": "cross-site" }],
    ] as const) {
      const result = await request(root, path, { headers: { ...headers, ...extra } });
      expect(result.status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
    expect((await request(await serveDay(), "/merchant/business-day", { headers })).status).toBe(
      503,
    );
    const failing = await serveDay(async () => {
      throw new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
    });
    const denied = await request(failing, "/merchant/business-day", { headers });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("BUSINESS_DATE");
  });
});
async function serveOrderClose(orderClosure?: MerchantBffRouterOptions["orderClosure"]) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(orderClosure ? { orderClosure } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
it("protects order closure transport, exact retry and bounded response", async () => {
  const close = vi.fn<NonNullable<MerchantBffRouterOptions["orderClosure"]>>(async () => ({
    status: "Committed",
    closedOrderVersion: 3,
    closureVersion: 1,
    privateEvidence: "synthetic-private",
  }));
  const root = await serveOrderClose(close),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/orders/close") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
    { Cookie: "__Host-bop-merchant=" + sessionCookie + "; __Host-bop-merchant=" + sessionCookie },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/orders/close?store=other")).status).toBe(403);
  expect(close).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "Committed",
    closedOrderVersion: 3,
    closureVersion: 1,
  });
  expect(close).toHaveBeenCalledWith({ sessionCookie, csrf, command: {} });
  close.mockResolvedValueOnce({
    status: "AlreadyCommitted",
    closedOrderVersion: 3,
    closureVersion: 1,
  });
  expect(await (await submit()).json()).toEqual({
    status: "AlreadyCommitted",
    closedOrderVersion: 3,
    closureVersion: 1,
  });
  // WP-2423 (B759): only a missing permission is a 403; not ready / changed is a 409 with why.
  close.mockRejectedValueOnce(new Error("synthetic-private"));
  const failed = await submit();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "order_closure_unavailable" });
  close.mockRejectedValueOnce(new OrderCloseCommandError("ORDER_CLOSE_PERMISSION_DENIED"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "order_close_permission_denied" });
  close.mockRejectedValueOnce(
    new OrderCloseCommandError("ORDER_CLOSE_NOT_READY", ["REFUND_PENDING"]),
  );
  const notReady = await submit();
  expect(notReady.status).toBe(409);
  expect(notReady.headers.get("cache-control")).toBe("no-store");
  expect(await notReady.json()).toEqual({ error: "order_not_ready", reasons: ["REFUND_PENDING"] });
  close.mockRejectedValueOnce(new OrderCloseCommandError("ORDER_CLOSE_VERSION_CONFLICT"));
  const conflict = await submit();
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "order_version_conflict" });
  close.mockResolvedValueOnce({ status: "Committed", closedOrderVersion: 0, closureVersion: 1 });
  expect((await submit()).status).toBe(403);
  const unconfigured = await serveOrderClose(),
    unavailable = await request(unconfigured, "/merchant/orders/close", {
      method: "POST",
      headers,
      body: "{}",
    });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "order_closure_unavailable" });
});

async function serveStaffCancellation(
  orderStaffCancellation?: MerchantBffRouterOptions["orderStaffCancellation"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(orderStaffCancellation ? { orderStaffCancellation } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
it("WP-2423 Q6: protects staff cancellation transport and maps owner refusals to stable codes", async () => {
  const result = {
    status: "Cancelled" as const,
    orderReference: "0190fa01-0000-7000-8000-000000000001",
    orderBatchReference: "0190fa01-0000-7000-8000-000000000002",
    cancelledAt: "2026-10-11T12:00:00.000Z",
    refundStatus: "Pending" as const,
    refundMethod: "CardMachine" as const,
    refundAmountMinor: "1280",
  };
  const cancel = vi.fn<NonNullable<MerchantBffRouterOptions["orderStaffCancellation"]>>(
    async () => ({ ...result, privateEvidence: "synthetic-private" }) as typeof result,
  );
  const root = await serveStaffCancellation(cancel),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/orders/cancel") =>
    request(root, path, { method: "POST", body: '{"a":1}', headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/orders/cancel?store=other")).status).toBe(403);
  expect(cancel).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  expect(cancel).toHaveBeenCalledWith({ sessionCookie, csrf, command: { a: 1 } });
  for (const [code, status, error] of [
    ["ORDER_CANCELLATION_INPUT_INVALID", 400, "order_cancellation_input_invalid"],
    ["ORDER_CANCELLATION_PERMISSION_DENIED", 403, "order_cancellation_permission_denied"],
    ["ORDER_CANCELLATION_NOT_FOUND", 404, "order_cancellation_not_found"],
    ["ORDER_CANCELLATION_VERSION_CONFLICT", 409, "order_version_conflict"],
    ["ORDER_CANCELLATION_PREPARATION_STARTED", 409, "order_preparation_started"],
    ["ORDER_CANCELLATION_NOT_CANCELLABLE", 409, "order_not_cancellable"],
    ["ORDER_CANCELLATION_STOCK_NOT_RELEASABLE", 409, "order_stock_not_releasable"],
    ["ORDER_CANCELLATION_UNAVAILABLE", 503, "order_cancellation_unavailable"],
  ] as const) {
    cancel.mockRejectedValueOnce(new StaffOrderCancellationError(code));
    const refused = await submit();
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  cancel.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");
  const unconfigured = await serveStaffCancellation();
  expect(
    (
      await request(unconfigured, "/merchant/orders/cancel", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("WP-2423 v15 2026-10-18: the cancel preview route returns only the refund it reads", async () => {
  const result = {
    orderReference: "0190fa01-0000-7000-8000-000000000001",
    orderBatchReference: "0190fa01-0000-7000-8000-000000000002",
    refundMethod: "Online" as const,
    paidMinor: "1130",
    refundMinor: "0",
    currencyCode: "CAD" as const,
  };
  const preview = vi.fn<NonNullable<MerchantBffRouterOptions["orderStaffCancellationPreview"]>>(
    async () => ({ ...result, privateEvidence: "synthetic-private" }) as typeof result,
  );
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      orderStaffCancellationPreview: preview,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/orders/cancel/preview", {
      method: "POST",
      body: '{"a":1}',
      headers: { ...headers, ...extra },
    });
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
  expect(preview).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  preview.mockRejectedValueOnce(
    new StaffOrderCancellationError("ORDER_CANCELLATION_NOT_CANCELLABLE"),
  );
  const refused = await submit();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "order_not_cancellable" });
});

it("WP-2423 Q9-G1: protects the outage refund decision transport and maps refusals", async () => {
  const result = {
    status: "RefundChosen" as const,
    orderReference: "0190fa01-0000-7000-8000-000000000001",
    decidedAt: "2026-10-14T12:00:00.000Z",
  };
  const refund = vi.fn<NonNullable<MerchantBffRouterOptions["orderAcceptanceHoldRefund"]>>(
    async () => ({ ...result, privateEvidence: "synthetic-private" }) as typeof result,
  );
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      orderAcceptanceHoldRefund: refund,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (
    extra: Record<string, string> = {},
    path = "/merchant/orders/acceptance-hold/refund",
  ) => request(root, path, { method: "POST", body: '{"a":1}', headers: { ...headers, ...extra } });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { "X-BOP-CSRF": "" }, { Cookie: "" }])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/orders/acceptance-hold/refund?x=1")).status).toBe(403);
  expect(refund).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  expect(refund).toHaveBeenCalledWith({ sessionCookie, csrf, command: { a: 1 } });
  for (const [code, status, error] of [
    ["ACCEPTANCE_HOLD_REFUND_INPUT_INVALID", 400, "acceptance_hold_refund_input_invalid"],
    ["ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED", 403, "acceptance_hold_refund_permission_denied"],
    ["ACCEPTANCE_HOLD_REFUND_NOT_HELD", 409, "order_not_held"],
    ["ACCEPTANCE_HOLD_REFUND_UNAVAILABLE", 503, "acceptance_hold_refund_unavailable"],
  ] as const) {
    refund.mockRejectedValueOnce(new AcceptanceHoldRefundError(code));
    const refused = await submit();
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  refund.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");
});

async function serveCounter(
  options: Pick<
    MerchantBffRouterOptions,
    | "counterMenu"
    | "counterOrder"
    | "cardMachinePayment"
    | "cardMachineRefund"
    | "cardMachineOrdinaryRefund"
    | "staffDiningRound"
  > = {},
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...options,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
it("WP-2423 Q7: protects counter order and card-machine transport and maps refusals to stable codes", async () => {
  const order = "0190fa01-0000-7000-8000-000000000001",
    batch = "0190fa01-0000-7000-8000-000000000002";
  const placed = {
    status: "Placed" as const,
    orderReference: order,
    orderBatchReference: batch,
    orderNumber: "12",
    orderVersion: 1,
    orderMinor: "1130",
    tipMinor: "150",
    totalMinor: "1280",
    payBy: "2026-10-13T18:30:00.000Z",
    recordedAfterOutage: false,
  };
  const counterOrder = vi.fn<NonNullable<MerchantBffRouterOptions["counterOrder"]>>(
    async () => ({ ...placed, guestCredential: "synthetic-private" }) as typeof placed,
  );
  const paid = {
    status: "Recorded" as const,
    orderReference: order,
    orderBatchReference: batch,
    amountMinor: "1280",
    recordingReason: "RecordedAfterOutage" as const,
    takenAt: "2026-10-13T16:00:00.000Z",
    recordedAt: "2026-10-13T18:01:00.000Z",
  };
  const cardMachinePayment = vi.fn<NonNullable<MerchantBffRouterOptions["cardMachinePayment"]>>(
    async () => paid,
  );
  const refunded = {
    status: "Recorded" as const,
    orderReference: order,
    orderBatchReference: batch,
    amountMinor: "1280",
    refundedAt: "2026-10-13T18:10:00.000Z",
  };
  const cardMachineRefund = vi.fn<NonNullable<MerchantBffRouterOptions["cardMachineRefund"]>>(
    async () => refunded,
  );
  const menu = { status: "Found" } as never;
  const counterMenu = vi.fn<NonNullable<MerchantBffRouterOptions["counterMenu"]>>(async () => menu);
  const root = await serveCounter({
    counterMenu,
    counterOrder,
    cardMachinePayment,
    cardMachineRefund,
  });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (path: string, extra: Record<string, string> = {}) =>
    request(root, "/merchant" + path, {
      method: "POST",
      body: '{"a":1}',
      headers: { ...headers, ...extra },
    });
  for (const path of [
    "/counter/orders",
    "/orders/card-machine-payment",
    "/orders/card-machine-refund",
  ]) {
    for (const extra of [
      { Origin: "https://foreign.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { "X-BOP-CSRF": "" },
      { Cookie: "" },
    ])
      expect((await submit(path, extra)).status).toBe(403);
    expect((await submit(path + "?store=other")).status).toBe(403);
  }
  expect(counterOrder).not.toHaveBeenCalled();
  expect(cardMachinePayment).not.toHaveBeenCalled();
  expect(cardMachineRefund).not.toHaveBeenCalled();

  const placedResponse = await submit("/counter/orders");
  expect(placedResponse.status).toBe(200);
  expect(placedResponse.headers.get("cache-control")).toBe("no-store");
  expect(await placedResponse.json()).toEqual(placed);
  expect(counterOrder).toHaveBeenCalledWith({ sessionCookie, csrf, command: { a: 1 } });
  for (const [code, status, error] of [
    ["COUNTER_ORDER_INPUT_INVALID", 400, "counter_order_input_invalid"],
    ["COUNTER_ORDER_PERMISSION_DENIED", 403, "counter_order_permission_denied"],
    ["COUNTER_ORDER_STORE_NOT_TAKING_ORDERS", 409, "store_not_taking_pickup_orders"],
    ["COUNTER_ORDER_NOT_PRICED", 409, "order_not_priced"],
    ["COUNTER_ORDER_NOT_FINISHED", 409, "counter_order_not_finished"],
    ["COUNTER_ORDER_IDEMPOTENCY_CONFLICT", 409, "counter_order_conflict"],
    ["COUNTER_ORDER_NO_PICKUP_TIMES", 409, "counter_order_no_pickup_times"],
    ["COUNTER_ORDER_UNAVAILABLE", 503, "counter_order_unavailable"],
  ] as const) {
    counterOrder.mockRejectedValueOnce(new CounterOrderError(code));
    const refused = await submit("/counter/orders");
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  counterOrder.mockRejectedValueOnce(new CounterOrderError("COUNTER_ORDER_ITEM_UNAVAILABLE", 1));
  const soldOut = await submit("/counter/orders");
  expect(soldOut.status).toBe(409);
  expect(await soldOut.json()).toEqual({
    error: "item_unavailable",
    lineIndex: 1,
    sharedStock: false,
  });
  // v15 run: too few in stock is a specific answer naming the line and how many are left.
  counterOrder.mockRejectedValueOnce(new CounterOrderError("COUNTER_ORDER_STOCK_SHORT", 0, 1));
  const short = await submit("/counter/orders");
  expect(short.status).toBe(409);
  expect(short.headers.get("cache-control")).toBe("no-store");
  expect(await short.json()).toEqual({
    error: "item_short",
    lineIndex: 0,
    available: 1,
    sharedStock: false,
  });
  // WP-2423: short only because another item in the order uses the same stock.
  counterOrder.mockRejectedValueOnce(
    new CounterOrderError("COUNTER_ORDER_STOCK_SHORT", 1, 2, true),
  );
  expect(await (await submit("/counter/orders")).json()).toEqual({
    error: "item_short",
    lineIndex: 1,
    available: 2,
    sharedStock: true,
  });

  const paidResponse = await submit("/orders/card-machine-payment");
  expect(paidResponse.status).toBe(200);
  // WP-2423 D1: without a server-side acceptance composed, the page is told to accept in Orders.
  expect(await paidResponse.json()).toEqual({ ...paid, acceptance: "NotAccepted" });
  cardMachinePayment.mockResolvedValueOnce({ ...paid, acceptance: "Accepted" } as never);
  expect(await (await submit("/orders/card-machine-payment")).json()).toEqual({
    ...paid,
    acceptance: "Accepted",
  });
  for (const [code, status, error] of [
    ["CARD_MACHINE_INPUT_INVALID", 400, "card_machine_input_invalid"],
    ["CARD_MACHINE_PERMISSION_DENIED", 403, "card_machine_permission_denied"],
    ["CARD_MACHINE_NOT_FOUND", 404, "counter_order_not_found"],
    ["CARD_MACHINE_NOT_PAYABLE", 409, "order_not_payable"],
    ["CARD_MACHINE_PAYMENT_WINDOW_CLOSED", 409, "payment_window_closed"],
    ["CARD_MACHINE_ALREADY_PAID", 409, "already_paid"],
    ["CARD_MACHINE_IDEMPOTENCY_CONFLICT", 409, "card_machine_conflict"],
    ["CARD_MACHINE_UNAVAILABLE", 503, "card_machine_payment_unavailable"],
  ] as const) {
    cardMachinePayment.mockRejectedValueOnce(new CardMachinePaymentCommandError(code));
    const refused = await submit("/orders/card-machine-payment");
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  cardMachinePayment.mockRejectedValueOnce(
    new CardMachinePaymentCommandError("CARD_MACHINE_AMOUNT_CHANGED", "1310"),
  );
  const changed = await submit("/orders/card-machine-payment");
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: "amount_changed", totalMinor: "1310" });

  const refundResponse = await submit("/orders/card-machine-refund");
  expect(refundResponse.status).toBe(200);
  expect(await refundResponse.json()).toEqual(refunded);
  for (const [code, status, error] of [
    ["CARD_MACHINE_REFUND_INPUT_INVALID", 400, "card_machine_refund_input_invalid"],
    ["CARD_MACHINE_REFUND_PERMISSION_DENIED", 403, "card_machine_refund_permission_denied"],
    ["CARD_MACHINE_REFUND_NOT_FOUND", 404, "card_machine_refund_not_found"],
    ["CARD_MACHINE_REFUND_NOTHING_OWED", 409, "nothing_to_refund"],
    ["CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT", 409, "card_machine_refund_conflict"],
    ["CARD_MACHINE_REFUND_UNAVAILABLE", 503, "card_machine_refund_unavailable"],
  ] as const) {
    cardMachineRefund.mockRejectedValueOnce(new CardMachineRefundCommandError(code));
    const refused = await submit("/orders/card-machine-refund");
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  cardMachineRefund.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit("/orders/card-machine-refund");
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");

  const readHeaders = {
    Host: "merchant.invalid",
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "Sec-Fetch-Site": "same-origin",
  };
  const menuResponse = await request(root, "/merchant/counter/menu", { headers: readHeaders });
  expect(menuResponse.status).toBe(200);
  expect(menuResponse.headers.get("cache-control")).toBe("no-store");
  expect(await menuResponse.json()).toEqual({ screenId: "OPS-ORDER-ENTRY", menu });
  expect(counterMenu).toHaveBeenCalledWith({ sessionCookie, orderType: "Pickup" });
  // WP-2423 Q7 slice 2: a table round reads the dine-in menu; nothing else is accepted.
  expect(
    (await request(root, "/merchant/counter/menu?orderType=DineIn", { headers: readHeaders }))
      .status,
  ).toBe(200);
  expect(counterMenu).toHaveBeenLastCalledWith({ sessionCookie, orderType: "DineIn" });
  expect(
    (await request(root, "/merchant/counter/menu?orderType=Delivery", { headers: readHeaders }))
      .status,
  ).toBe(403);
  counterMenu.mockRejectedValueOnce(new CounterMenuError("COUNTER_MENU_PERMISSION_DENIED"));
  expect((await request(root, "/merchant/counter/menu", { headers: readHeaders })).status).toBe(
    403,
  );
  counterMenu.mockRejectedValueOnce(new CounterMenuError("COUNTER_MENU_UNAVAILABLE"));
  expect((await request(root, "/merchant/counter/menu", { headers: readHeaders })).status).toBe(
    503,
  );
  expect(
    (await request(root, "/merchant/counter/menu?store=other", { headers: readHeaders })).status,
  ).toBe(403);
  const unconfigured = await serveCounter();
  for (const path of [
    "/counter/orders",
    "/orders/card-machine-payment",
    "/orders/card-machine-refund",
  ])
    expect(
      (
        await request(unconfigured, "/merchant" + path, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(503);
});

it("WP-2423 item 4: records an item refund made on the card machine and maps refusals to stable codes", async () => {
  const recorded = {
    status: "Recorded" as const,
    orderReference: "0190fa02-0000-7000-8000-000000000001",
    requestReference: "0190fa02-0000-7000-8000-000000000002",
    amountMinor: "621",
    refundedAt: "2026-10-15T15:02:00.000Z",
    receipt: "NoDigitalReceipt" as const,
  };
  const cardMachineOrdinaryRefund = vi.fn<
    NonNullable<MerchantBffRouterOptions["cardMachineOrdinaryRefund"]>
  >(async () => ({ ...recorded, actorReference: "synthetic-private" }) as typeof recorded);
  const root = await serveCounter({ cardMachineOrdinaryRefund });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "") =>
    request(root, "/merchant/payments/refunds/card-machine-record" + path, {
      method: "POST",
      body: '{"a":1}',
      headers: { ...headers, ...extra },
    });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "?store=other")).status).toBe(403);
  expect(cardMachineOrdinaryRefund).not.toHaveBeenCalled();
  const ok = await submit();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual(recorded);
  expect(cardMachineOrdinaryRefund).toHaveBeenCalledWith({
    sessionCookie,
    csrf,
    command: { a: 1 },
  });
  for (const [code, status, error] of [
    ["CARD_MACHINE_REFUND_INPUT_INVALID", 400, "card_machine_refund_input_invalid"],
    ["CARD_MACHINE_REFUND_PERMISSION_DENIED", 403, "card_machine_refund_permission_denied"],
    ["CARD_MACHINE_REFUND_NOT_FOUND", 404, "card_machine_refund_not_found"],
    ["CARD_MACHINE_REFUND_NOTHING_OWED", 409, "nothing_to_refund"],
    ["CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT", 409, "card_machine_refund_conflict"],
    ["CARD_MACHINE_REFUND_APPROVAL_REQUIRED", 409, "approval_required"],
    ["CARD_MACHINE_REFUND_UNAVAILABLE", 503, "card_machine_refund_unavailable"],
  ] as const) {
    cardMachineOrdinaryRefund.mockRejectedValueOnce(new CardMachineRefundCommandError(code));
    const refused = await submit();
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  cardMachineOrdinaryRefund.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");
  const unconfigured = await serveCounter();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/card-machine-record", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("WP-2423 Q7 slice 2: protects the staff table round transport and maps refusals to stable codes", async () => {
  const placed = {
    status: "Placed" as const,
    orderReference: "0190fa01-0000-7000-8000-000000000011",
    orderBatchReference: "0190fa01-0000-7000-8000-000000000012",
    orderNumber: "7",
    orderVersion: 4,
    tableLabel: "T4",
    orderMinor: "2260",
    tipMinor: "300",
    totalMinor: "2560",
    payBy: "2026-10-15T18:30:00.000Z",
    payLater: false,
    recordedAfterOutage: false,
  };
  const staffDiningRound = vi.fn<NonNullable<MerchantBffRouterOptions["staffDiningRound"]>>(
    async () => ({ ...placed, guestCredential: "synthetic-private" }) as typeof placed,
  );
  const root = await serveCounter({ staffDiningRound });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/staff-rounds") =>
    request(root, path, { method: "POST", body: '{"a":1}', headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/dining/staff-rounds?store=other")).status).toBe(403);
  expect(staffDiningRound).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(placed);
  expect(staffDiningRound).toHaveBeenCalledWith({ sessionCookie, csrf, command: { a: 1 } });
  for (const [code, status, error] of [
    ["STAFF_ROUND_INPUT_INVALID", 400, "staff_round_input_invalid"],
    ["STAFF_ROUND_PERMISSION_DENIED", 403, "staff_round_permission_denied"],
    ["STAFF_ROUND_STORE_NOT_TAKING_ORDERS", 409, "store_not_taking_dine_in_orders"],
    ["STAFF_ROUND_TABLE_UNAVAILABLE", 409, "table_unavailable"],
    ["STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS", 409, "table_checkout_in_progress"],
    ["STAFF_ROUND_NOT_PRICED", 409, "order_not_priced"],
    ["STAFF_ROUND_NOT_FINISHED", 409, "staff_round_not_finished"],
    ["STAFF_ROUND_IN_PROGRESS", 409, "staff_round_in_progress"],
    ["STAFF_ROUND_IDEMPOTENCY_CONFLICT", 409, "staff_round_conflict"],
    ["STAFF_ROUND_UNAVAILABLE", 503, "staff_round_unavailable"],
  ] as const) {
    staffDiningRound.mockRejectedValueOnce(new StaffDiningRoundError(code));
    const refused = await submit();
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  staffDiningRound.mockRejectedValueOnce(
    new StaffDiningRoundError("STAFF_ROUND_ITEM_UNAVAILABLE", 1),
  );
  expect(await (await submit()).json()).toEqual({
    error: "item_unavailable",
    lineIndex: 1,
    sharedStock: false,
  });
  // WP-2423: the round's short item, how many are left and whether it shares stock.
  staffDiningRound.mockRejectedValueOnce(
    new StaffDiningRoundError("STAFF_ROUND_STOCK_SHORT", 0, [], {
      available: 1,
      sharedStock: true,
    }),
  );
  const short = await submit();
  expect(short.status).toBe(409);
  expect(await short.json()).toEqual({
    error: "item_short",
    lineIndex: 0,
    available: 1,
    sharedStock: true,
  });
  staffDiningRound.mockRejectedValueOnce(
    new StaffDiningRoundError("STAFF_ROUND_TABLE_CART_HAS_ITEMS", null, [
      { name: "Iced Latte", quantity: 1 },
    ]),
  );
  expect(await (await submit()).json()).toEqual({
    error: "table_cart_has_items",
    items: [{ name: "Iced Latte", quantity: 1 }],
  });
  staffDiningRound.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");
  const unconfigured = await serveCounter();
  expect(
    (
      await request(unconfigured, "/merchant/dining/staff-rounds", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

async function serveDiningClosing(diningClosing?: MerchantBffRouterOptions["diningClosing"]) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningClosing ? { diningClosing } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
it("protects dining closing transport, exact retry and bounded response", async () => {
  const close = vi.fn<NonNullable<MerchantBffRouterOptions["diningClosing"]>>(async () => ({
    status: "Applied",
    phase: "Closing",
    sessionVersion: 3,
    privateEvidence: "synthetic-private",
  }));
  const root = await serveDiningClosing(close),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/closing") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
    { Cookie: "__Host-bop-merchant=" + sessionCookie + "; __Host-bop-merchant=" + sessionCookie },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/dining/closing?store=other")).status).toBe(403);
  expect(close).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "Applied",
    phase: "Closing",
    sessionVersion: 3,
  });
  expect(close).toHaveBeenCalledWith({ sessionCookie, csrf, command: {} });
  close.mockResolvedValueOnce({
    status: "AlreadyApplied",
    phase: "Closing",
    sessionVersion: 3,
  });
  expect(await (await submit()).json()).toEqual({
    status: "AlreadyApplied",
    phase: "Closing",
    sessionVersion: 3,
  });
  // WP-2423 (B759): a table that cannot close yet is never answered as a permission problem.
  close.mockRejectedValueOnce(new Error("synthetic-private"));
  const failed = await submit();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "dining_closing_unavailable" });
  close.mockRejectedValueOnce(new DiningClosingError("DINING_CLOSING_PERMISSION_DENIED"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "dining_closing_permission_denied" });
  close.mockRejectedValueOnce(new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT"));
  const changed = await submit();
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: "dining_session_changed" });
  close.mockRejectedValueOnce(new DiningClosingError("DINING_CLOSING_TASK_REQUIRED"));
  expect((await submit()).status).toBe(409);
  close.mockResolvedValueOnce({ status: "Applied", phase: "Closing", sessionVersion: 0 });
  expect((await submit()).status).toBe(403);
  const unconfigured = await serveDiningClosing(),
    unavailable = await request(unconfigured, "/merchant/dining/closing", {
      method: "POST",
      headers,
      body: "{}",
    });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "dining_closing_unavailable" });
});

async function serveDiningSessionStart(
  diningSessionStart?: MerchantBffRouterOptions["diningSessionStart"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningSessionStart ? { diningSessionStart } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function serveDiningTableCommand(
  diningTableCommand?: MerchantBffRouterOptions["diningTableCommand"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningTableCommand ? { diningTableCommand } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server unavailable");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

it("protects the Dining table command route and returns only its allowlisted result", async () => {
  const result = {
      status: "Applied" as const,
      tableReference: "0190fad7-0000-7000-8000-000000000005" as never,
      operationalState: "TemporarilyBlocked" as const,
      aggregateVersion: 2,
      privateAudit: "must not be exposed",
    },
    command = vi.fn<NonNullable<MerchantBffRouterOptions["diningTableCommand"]>>(
      async () => result,
    ),
    root = await serveDiningTableCommand(command),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  try {
    expect(
      (
        await request(root.url, "/merchant/dining/tables/availability?store=other", {
          method: "POST",
          body: "{}",
          headers,
        })
      ).status,
    ).toBe(403);
    expect(command).not.toHaveBeenCalled();
    const response = await request(root.url, "/merchant/dining/tables/availability", {
      method: "POST",
      body: "{}",
      headers,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "Applied",
      tableReference: result.tableReference,
      operationalState: result.operationalState,
      aggregateVersion: 2,
    });
    for (const badHeaders of [
      { Origin: "https://foreign.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { Cookie: "" },
      { "X-BOP-CSRF": "" },
    ])
      expect(
        (
          await request(root.url, "/merchant/dining/tables/availability", {
            method: "POST",
            body: "{}",
            headers: { ...headers, ...badHeaders },
          })
        ).status,
      ).toBe(403);
  } finally {
    await new Promise<void>((resolve, reject) =>
      root.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("keeps an unconfigured Dining table command unavailable", async () => {
  const root = await serveDiningTableCommand();
  try {
    const response = await request(root.url, "/merchant/dining/tables/availability", {
      method: "POST",
      body: "{}",
      headers: {
        ...safeHeaders,
        Cookie: "__Host-bop-merchant=" + sessionCookie,
        "X-BOP-CSRF": csrf,
        "Content-Type": "application/json",
      },
    });
    expect(response.status).toBe(503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      root.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("WP-2423 Q11: protects table QR routes, answers a changed table with 409 and stays unavailable unconfigured", async () => {
  const port = {
    list: vi.fn(async () => ({ items: [] })),
    command: vi.fn(async () => {
      throw new Error("TABLE_QR_CONFLICT");
    }),
    sheet: vi.fn(async () => {
      throw new Error("TABLE_QR_PERMISSION_DENIED");
    }),
  } as unknown as NonNullable<MerchantBffRouterOptions["diningTableQr"]>;
  const serve = async (diningTableQr?: MerchantBffRouterOptions["diningTableQr"]) => {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(diningTableQr ? { diningTableQr } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    return { server, url: `http://127.0.0.1:${address.port}` };
  };
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const post = (url: string, path: string, extra: Record<string, string> = {}) =>
    request(url, "/merchant/dining/table-qr" + path, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  const root = await serve(port),
    bare = await serve();
  try {
    const listed = await post(root.url, "");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({ items: [] });
    expect((await post(root.url, "/command")).status).toBe(409);
    expect((await post(root.url, "/sheet")).status).toBe(403);
    for (const bad of [{ "X-BOP-CSRF": "" }, { Origin: "https://foreign.invalid" }, { Cookie: "" }])
      expect((await post(root.url, "", bad)).status).toBe(403);
    expect(port.list).toHaveBeenCalledTimes(1);
    expect((await post(bare.url, "")).status).toBe(503);
  } finally {
    for (const { server } of [root, bare])
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

it("protects session start and returns one-time credentials only for Issued", async () => {
  const result = {
    status: "Issued" as const,
    diningSessionReference: parseDiningReference("01909988-0000-7000-8000-000000000001"),
    tableReference: parseDiningReference("01909988-0000-7000-8000-000000000002"),
    sessionVersion: 1,
    tableAssignmentVersion: 2,
    joinKind: "HumanCode" as const,
    joinCredential: "123456" as never,
  };
  const start = vi.fn<NonNullable<MerchantBffRouterOptions["diningSessionStart"]>>(async () => ({
    ...result,
    privateEvidence: "private",
  }));
  const root = await serveDiningSessionStart(start),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const submit = (extra: Record<string, string> = {}, path = "/merchant/dining/sessions/start") =>
    request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/dining/sessions/start?store=other")).status).toBe(403);
  expect(start).not.toHaveBeenCalled();
  const issued = await submit();
  expect(issued.status).toBe(200);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  expect(await issued.json()).toEqual(result);
  start.mockResolvedValueOnce({ ...result, status: "AlreadyApplied" });
  const retry = await (await submit()).json();
  expect(retry).not.toHaveProperty("joinCredential");
  expect(retry).not.toHaveProperty("privateEvidence");
  start.mockResolvedValueOnce({ ...result, joinCredential: "invalid" as never });
  expect((await submit()).status).toBe(403);
  const unavailable = await serveDiningSessionStart();
  expect(
    (
      await request(unavailable, "/merchant/dining/sessions/start", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

async function serveDiningRegenerate(
  diningJoinRegenerate?: MerchantBffRouterOptions["diningJoinRegenerate"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningJoinRegenerate ? { diningJoinRegenerate } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("regeneration transport never replays plaintext or extra credential material", async () => {
  const command = vi.fn<NonNullable<MerchantBffRouterOptions["diningJoinRegenerate"]>>(
    async () => ({
      status: "Issued",
      generation: 2,
      capabilityVersion: 1,
      joinKind: "HumanCode",
      joinCredential: "123456" as never,
      selectorHash: "private",
    }),
  );
  const root = await serveDiningRegenerate(command),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/dining/sessions/regenerate", {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  expect((await send({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const issued = await send();
  expect(issued.headers.get("cache-control")).toBe("no-store");
  expect(await issued.json()).toEqual({
    status: "Issued",
    generation: 2,
    capabilityVersion: 1,
    joinKind: "HumanCode",
    joinCredential: "123456",
  });
  command.mockResolvedValueOnce({
    status: "AlreadyApplied",
    generation: 2,
    capabilityVersion: 1,
    joinKind: "HumanCode",
    joinCredential: "123456" as never,
  });
  expect(await (await send()).json()).not.toHaveProperty("joinCredential");
});

async function serveRefundRequest(
  ordinaryRefundRequest?: MerchantBffRouterOptions["ordinaryRefundRequest"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(ordinaryRefundRequest ? { ordinaryRefundRequest } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects refund request transport and returns only request evidence", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const data = {
    status: "Created" as const,
    requestReference: id(1),
    operationReference: id(2),
    claimVersion: 1,
    currencyCode: "CAD" as const,
    amountMinor: "1130",
    paymentAttemptReferences: [id(3)],
    approvalRequired: true,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100" as const],
    approveAlone: false,
    internalQuote: "private",
  };
  const command = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundRequest"]>>(
    async () => data,
  );
  const root = await serveRefundRequest(command),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/request" + suffix, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await send(extra)).status).toBe(403);
  expect((await send({}, "?store=other")).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const first = await send();
  expect(first.status).toBe(202);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(await first.json()).toEqual({
    status: "RequestRecorded",
    requestReference: id(1),
    operationReference: id(2),
    claimVersion: 1,
    currencyCode: "CAD",
    amountMinor: "1130",
    paymentAttemptReferences: [id(3)],
    approvalRequired: true,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    approveAlone: false,
    replayed: false,
  });
  command.mockResolvedValueOnce({ ...data, status: "AlreadyCommitted" });
  expect(await (await send()).json()).toMatchObject({ status: "RequestRecorded", replayed: true });
  command.mockRejectedValueOnce(new Error("private"));
  expect(await (await send()).json()).toEqual({ error: "request_denied" });
  const unconfigured = await serveRefundRequest();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/request", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

async function serveRefundItems(
  ordinaryRefundItems?: MerchantBffRouterOptions["ordinaryRefundItems"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(ordinaryRefundItems ? { ordinaryRefundItems } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects refund items transport and strips private nested data", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const item = {
    orderBatchReference: id(2),
    orderItemReference: id(3),
    label: "Latte",
    quantity: 2,
    unclaimedQuantity: 1,
    paymentCaptured: true,
    refundedByCancellation: false,
    paymentIntentReference: id(31),
    paymentMethod: "Online" as const,
  };
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundItems"]>>(async () => ({
    orderReference: id(1),
    canRequest: true,
    orderNumber: "12",
    claimVersion: 1,
    recentRequests: [
      {
        requestReference: id(40),
        operationReference: id(41),
        claimVersion: 1,
        requestedAt: "2026-09-20T12:00:00.000Z",
        reasonCode: "CUSTOMER_REQUEST",
        currencyCode: "CAD",
        amountMinor: "1130",
        decline: {
          reasonCode: "ENTERED_IN_ERROR",
          declinedAt: "2026-09-20T12:05:00.000Z",
          declinerName: "Owner",
          declinedByYou: false,
        },
        progress: "Declined" as const,
        paymentMethod: "Online" as const,
      },
    ],
    items: [{ ...item, customerNote: "private" }],
    guest: "private",
  }));
  const root = await serveRefundItems(query),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/items" + suffix, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(extra)).status).toBe(403);
  expect((await send({}, "?store=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({
    orderReference: id(1),
    orderNumber: "12",
    canRequest: true,
    claimVersion: 1,
    recentRequests: [
      {
        requestReference: id(40),
        operationReference: id(41),
        claimVersion: 1,
        requestedAt: "2026-09-20T12:00:00.000Z",
        reasonCode: "CUSTOMER_REQUEST",
        currencyCode: "CAD",
        amountMinor: "1130",
        decline: {
          reasonCode: "ENTERED_IN_ERROR",
          declinedAt: "2026-09-20T12:05:00.000Z",
          declinerName: "Owner",
          declinedByYou: false,
        },
        progress: "Declined" as const,
        paymentMethod: "Online",
      },
    ],
    items: [item],
  });
  query.mockRejectedValueOnce(new Error("private"));
  expect(await (await send()).json()).toEqual({ error: "request_denied" });
  // v15 2026-10-18 (dd750045): history that changed while the list loaded, or a dependency that
  // could not be read, is never answered as a permission refusal; a refusal still is.
  for (const [message, status, body] of [
    ["ORDINARY_REFUND_HISTORY_UNAVAILABLE", 409, { error: "changed_while_loading" }],
    ["MERCHANT_REFUND_READ_CHANGED", 409, { error: "changed_while_loading" }],
    ["ORDINARY_REFUND_COMMAND_UNAVAILABLE", 503, { error: "retry_later" }],
    ["ORDINARY_REFUND_REQUEST_DENIED", 403, { error: "request_denied" }],
    ["ORDINARY_REFUND_PERMISSION_DENIED", 403, { error: "request_denied" }],
    ["STORE_SERVICE_PERMISSION_DENIED", 403, { error: "request_denied" }],
  ] as const) {
    query.mockRejectedValueOnce(new Error(message));
    const failed = await send();
    expect([failed.status, await failed.json()]).toEqual([status, body]);
    expect(failed.headers.get("cache-control")).toBe("no-store");
  }
  const unconfigured = await serveRefundItems();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/items", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

async function serveRefundPreview(
  ordinaryRefundPreview?: MerchantBffRouterOptions["ordinaryRefundPreview"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(ordinaryRefundPreview ? { ordinaryRefundPreview } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects refund preview transport and whitelists component amounts", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const components = {
    netAmountMinor: "1000",
    taxAmountMinor: "130",
    tipAmountMinor: "0",
    serviceChargeAmountMinor: "0",
    serviceChargeTaxAmountMinor: "0",
  };
  const data = {
    status: "Previewed" as const,
    requestReference: id(1),
    operationReference: id(2),
    claimVersion: 0,
    currencyCode: "CAD" as const,
    amountMinor: "1130",
    paymentAttemptReferences: [id(3)],
    approvalRequired: false,
    escalationReasons: [],
    approveAlone: false,
    components,
  };
  const preview = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundPreview"]>>(
    async () => ({
      ...data,
      sourceDigest: "private",
      components: { ...components, audit: "private" },
    }),
  );
  const root = await serveRefundPreview(preview),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/preview" + suffix, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: "{}",
    });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(extra)).status).toBe(403);
  expect((await send({}, "?store=other")).status).toBe(403);
  expect(preview).not.toHaveBeenCalled();
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(data);
  const unconfigured = await serveRefundPreview();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/preview", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

async function serveRefundContext(
  refundPaymentContext?: MerchantBffRouterOptions["refundPaymentContext"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(refundPaymentContext ? { refundPaymentContext } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects refund payment context and preserves unknown amounts", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const data = {
    paymentIntentReference: id(1),
    paymentAttemptReference: id(2),
    orderReference: id(3),
    orderBatchReference: id(4),
    observedAt: "2026-09-20T12:00:00.000Z",
    paymentState: "Unresolved" as const,
    paymentMethod: "Online" as const,
    currencyCode: null,
    capturedAmountMinor: null,
    confirmedRefundMinor: null,
    pendingRefundMinor: null,
    canRequest: false,
  };
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["refundPaymentContext"]>>(async () => ({
    ...data,
    rawProvider: "private",
  }));
  const root = await serveRefundContext(query),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/context" + suffix, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(extra)).status).toBe(403);
  expect((await send({}, "?store=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(data);
  const unconfigured = await serveRefundContext();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/context", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

async function serveRefundStatus(
  ordinaryRefundStatus?: MerchantBffRouterOptions["ordinaryRefundStatus"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(ordinaryRefundStatus ? { ordinaryRefundStatus } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects refund status and strips private execution details", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const payment = {
    paymentAttemptReference: id(2),
    paymentIntentReference: id(1),
    state: "NotDispatched" as const,
    method: "Online" as const,
    refundedOnCardMachineAt: null,
    cardMachineSlipReference: null,
    executionOperationReference: null,
    executionApprovalReference: null,
    amountMinor: "1130",
    confirmedMinor: "0",
    pendingMinor: "1130",
  };
  // WP-2423 item 4: a refund recorded on the store's card machine carries its slip reference.
  const machine = {
    ...payment,
    paymentAttemptReference: id(7),
    paymentIntentReference: id(6),
    state: "Confirmed" as const,
    method: "CardMachine" as const,
    refundedOnCardMachineAt: "2026-09-20T11:50:00.000Z",
    cardMachineSlipReference: "RF4821",
    amountMinor: "593",
    confirmedMinor: "593",
    pendingMinor: "0",
  };
  const data = {
    orderReference: id(3),
    requestReference: id(4),
    operationReference: id(5),
    observedAt: "2026-09-20T12:00:00.000Z",
    currencyCode: "CAD" as const,
    amountMinor: "1723",
    payments: [payment, machine],
  };
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundStatus"]>>(async () => ({
    ...data,
    rawProvider: "private",
    payments: [{ ...payment, providerRefundReference: "private" }, machine],
  }));
  const root = await serveRefundStatus(query),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/status" + suffix, {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(extra)).status).toBe(403);
  expect((await send({}, "?store=other")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(data);
  const unconfigured = await serveRefundStatus();
  expect(
    (
      await request(unconfigured, "/merchant/payments/refunds/status", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

async function serveDiningHostTransfer(
  diningHostTransfer?: MerchantBffRouterOptions["diningHostTransfer"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningHostTransfer ? { diningHostTransfer } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects Host transfer and whitelists original operation receipt", async () => {
  const reference = (n: number) =>
    parseDiningReference("0190fa41-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
  const result = {
    status: "Applied" as const,
    operationReference: reference(1),
    diningSessionReference: reference(2),
    previousHostParticipantReference: reference(3),
    hostParticipantReference: reference(4),
    sessionVersion: 5,
    transferredAt: "2026-09-21T03:45:00.000Z" as never,
  };
  const command = vi.fn<NonNullable<MerchantBffRouterOptions["diningHostTransfer"]>>(async () => ({
    ...result,
    privateEvidence: "private",
  }));
  const root = await serveDiningHostTransfer(command),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const submit = (
    extra: Record<string, string> = {},
    path = "/merchant/dining/sessions/host-transfer",
  ) => request(root, path, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await submit(extra)).status).toBe(403);
  expect((await submit({}, "/merchant/dining/sessions/host-transfer?store=other")).status).toBe(
    403,
  );
  expect(command).not.toHaveBeenCalled();
  const applied = await submit();
  expect(applied.status).toBe(200);
  expect(applied.headers.get("cache-control")).toBe("no-store");
  expect(await applied.json()).toEqual(result);
  command.mockResolvedValueOnce({ ...result, status: "AlreadyApplied" });
  expect(await (await submit()).json()).toEqual({ ...result, status: "AlreadyApplied" });
  command.mockResolvedValueOnce({
    ...result,
    hostParticipantReference: result.previousHostParticipantReference,
  });
  expect((await submit()).status).toBe(403);
  command.mockRejectedValueOnce(new Error("private"));
  expect((await submit()).status).toBe(403);
  const unavailable = await serveDiningHostTransfer();
  expect(
    (
      await request(unavailable, "/merchant/dining/sessions/host-transfer", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

async function serveDiningHostSelection(
  diningHostSelection?: MerchantBffRouterOptions["diningHostSelection"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(diningHostSelection ? { diningHostSelection } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("protects Host selection and excludes private participant fields", async () => {
  const ref = (n: number) =>
    parseDiningReference("0190fa42-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
  const at = "2026-09-21T03:55:00.000Z" as never;
  const result = {
    diningSessionReference: ref(1),
    sessionVersion: 3,
    phase: "Active" as const,
    hostParticipantReference: ref(2),
    observedAt: at,
    participants: [{ participantReference: ref(3), joinedAt: at, isHost: false }],
  };
  const read = vi.fn<NonNullable<MerchantBffRouterOptions["diningHostSelection"]>>(async () => ({
    ...result,
    participants: result.participants.map((p) => ({ ...p, privateEvidence: "private" })),
  }));
  const root = await serveDiningHostSelection(read),
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/dining/sessions/host-selection", {
      method: "POST",
      body: "{}",
      headers: { ...headers, ...extra },
    });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await send(extra)).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  read.mockResolvedValueOnce({
    ...result,
    participants: [...result.participants, ...result.participants],
  });
  expect((await send()).status).toBe(403);
  const unavailable = await serveDiningHostSelection();
  expect(
    (
      await request(unavailable, "/merchant/dining/sessions/host-selection", {
        method: "POST",
        body: "{}",
        headers,
      })
    ).status,
  ).toBe(503);
});

it.each([
  ["send", "ordinaryRefundSend", "DispatchRecorded"],
  ["reconcile", "ordinaryRefundReconciliation", "ReconciliationRecorded"],
] as const)(
  "protects refund execution %s and hides all internal financial evidence",
  async (path, capability, status) => {
    const receipt = { status: "Existing", version: 1, kind: "Original" };
    const execute = vi.fn(async () => ({ privateEvidence: "do-not-expose", receipt }));
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        [capability]: execute,
      } as MerchantBffRouterOptions),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    const root = `http://127.0.0.1:${address.port}`;
    const headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
    };
    const post = (extra: Record<string, string> = {}, suffix = "") =>
      request(root, "/merchant/payments/refunds/" + path + suffix, {
        method: "POST",
        body: "{}",
        headers: { ...headers, ...extra },
      });
    for (const extra of [
      { Origin: "https://foreign.invalid" },
      { Host: "foreign.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { "X-BOP-CSRF": "" },
      { Cookie: "" },
    ])
      expect((await post(extra)).status).toBe(403);
    expect((await post({}, "?store=other")).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    const accepted = await post();
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toEqual(path === "send" ? { status } : { status, receipt });
    execute.mockRejectedValueOnce(new Error("private-provider-failure"));
    const unknown = await post();
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({ error: "refund_execution_unknown" });
    const unconfigured = await serve(fakeService());
    const unavailable = await request(unconfigured, "/merchant/payments/refunds/" + path, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "refund_execution_unavailable" });
  },
);

it("protects compensation acknowledgment and returns no Case closure or internal evidence", async () => {
  const execute = vi.fn(async () => ({
    status: "Created" as "Created" | "Duplicate",
    reconciledAt: parsePaymentInstant(serverTime),
    privateEvidence: "do-not-expose",
  }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      compensationReconciliation: execute,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/compensations/reconcile";
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const accepted = await post();
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(await accepted.json()).toEqual({
    status: "ReconciliationRecorded",
    replayed: false,
    reconciledAt: parsePaymentInstant(serverTime),
  });
  execute.mockResolvedValueOnce({
    status: "Duplicate",
    reconciledAt: parsePaymentInstant(serverTime),
    privateEvidence: "hidden",
  });
  expect(await (await post()).json()).toEqual({
    status: "ReconciliationRecorded",
    replayed: true,
    reconciledAt: parsePaymentInstant(serverTime),
  });
  execute.mockRejectedValueOnce(new Error("private-failure"));
  const unknown = await post();
  expect(unknown.status).toBe(503);
  expect(await unknown.json()).toEqual({ error: "compensation_reconciliation_unknown" });
  const unconfigured = await serve(fakeService());
  const unavailable = await request(unconfigured, path, { method: "POST", headers, body: "{}" });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "compensation_reconciliation_unavailable" });
});

it("protects reconciliation follow-up and returns no source or employee identifiers", async () => {
  const execute = vi.fn(async () => ({
    status: "Created" as "Created" | "Duplicate",
    version: 2,
    followUpStatus: "Acknowledged" as const,
    updatedAt: parsePaymentInstant(serverTime),
    ownerReference: null,
    acknowledgedByReference: parsePaymentReference("0190fa82-0000-7000-8000-000000000004"),
    privateEvidence: "do-not-expose",
  }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      reconciliationFollowUp: execute,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/order-exceptions/follow-up";
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const accepted = await post();
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(await accepted.json()).toEqual({
    status: "FollowUpRecorded",
    replayed: false,
    version: 2,
    followUpStatus: "Acknowledged" as const,
    updatedAt: parsePaymentInstant(serverTime),
  });
  execute.mockResolvedValueOnce({
    status: "Duplicate",
    version: 2,
    followUpStatus: "Acknowledged" as const,
    updatedAt: parsePaymentInstant(serverTime),
    ownerReference: null,
    acknowledgedByReference: parsePaymentReference("0190fa82-0000-7000-8000-000000000004"),
    privateEvidence: "hidden",
  });
  expect(await (await post()).json()).toEqual({
    status: "FollowUpRecorded",
    replayed: true,
    version: 2,
    followUpStatus: "Acknowledged" as const,
    updatedAt: parsePaymentInstant(serverTime),
  });
  for (const [code, status] of [
    ["RECONCILIATION_FOLLOW_UP_CONFLICT", 409],
    ["RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED", 403],
    ["RECONCILIATION_FOLLOW_UP_INVALID", 400],
  ] as const) {
    execute.mockRejectedValueOnce(new ReconciliationFollowUpError(code));
    expect((await post()).status).toBe(status);
  }
  execute.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  const deniedSession = await post();
  expect(deniedSession.status).toBe(403);
  expect(await deniedSession.json()).toEqual({ error: "request_denied" });
  execute.mockRejectedValueOnce(new Error("private-failure"));
  const unknown = await post();
  expect(unknown.status).toBe(503);
  expect(await unknown.json()).toEqual({ error: "reconciliation_follow_up_unknown" });
  const unconfigured = await serve(fakeService());
  const unavailable = await request(unconfigured, path, { method: "POST", headers, body: "{}" });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "reconciliation_follow_up_unavailable" });
});

it("protects compensation preparation query and hides evidence", async () => {
  const model = {
    caseVersion: 2,
    caseState: "Open" as const,
    refund: { amountMinor: "1130", currencyCode: "CAD", confirmedAt: serverTime },
    acknowledgmentRecorded: false,
  };
  const execute = vi.fn(async () => ({ ...model, privateEvidence: "hidden" }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      compensationQuery: execute,
    } as unknown as MerchantBffRouterOptions),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/compensations/query",
    headers = {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
    };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const result = await post();
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(model);
  execute.mockRejectedValueOnce(new Error("private-source-failure"));
  const failed = await post();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "compensation_reconciliation_unavailable" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, path, { method: "POST", body: "{}", headers })).status).toBe(
    503,
  );
});

it("protects follow-up state query and rejects invalid owner state", async () => {
  const model = {
    version: 1,
    followUpStatus: "Open" as const,
    acknowledged: false,
    assigned: false,
    updatedAt: parsePaymentInstant(serverTime),
    privateEvidence: "hidden",
  };
  const execute = vi.fn(async () => model),
    app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      reconciliationFollowUpQuery: execute,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/order-exceptions/follow-up-query";
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    version: 1,
    followUpStatus: "Open",
    acknowledged: false,
    assigned: false,
    updatedAt: serverTime,
  });
  execute.mockResolvedValueOnce({ ...model, version: 0 });
  expect((await post()).status).toBe(503);
  execute.mockResolvedValueOnce({ ...model, assigned: true });
  expect((await post()).status).toBe(503);
  execute.mockRejectedValueOnce(new Error("private detail"));
  expect(await (await post()).json()).toEqual({ error: "reconciliation_follow_up_unavailable" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, path, { method: "POST", headers, body: "{}" })).status).toBe(
    503,
  );
});

it("protects reconciliation evidence and emits only the validated summary", async () => {
  const model = {
    amountMinor: "2260",
    currencyCode: "CAD" as const,
    environment: "Test" as const,
    occurredAt: parsePaymentInstant("2026-09-20T03:35:37.236Z"),
    observedAt: parsePaymentInstant(serverTime),
    recordedReason: "ProviderCaptureWithoutInternalOperation" as const,
  };
  // Use a fixed observed time later than the original capture regardless of other suite fixtures.
  model.observedAt = parsePaymentInstant("2026-09-22T00:00:00.000Z");
  const execute = vi.fn(async () => ({ ...model, privateEvidence: "hidden" }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      reconciliationEvidenceQuery: execute,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/order-exceptions/follow-up-evidence";
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "X-BOP-CSRF": "" },
    { Cookie: "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?scope=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const result = await post();
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({ evidence: model });
  execute.mockResolvedValueOnce({ ...model, amountMinor: "0", privateEvidence: "hidden" });
  expect((await post()).status).toBe(503);
  execute.mockResolvedValueOnce({
    ...model,
    observedAt: parsePaymentInstant("2026-01-01T00:00:00.000Z"),
    privateEvidence: "hidden",
  });
  expect((await post()).status).toBe(503);
  execute.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  expect((await post()).status).toBe(403);
  execute.mockRejectedValueOnce(new Error("private-query-details"));
  expect(await (await post()).json()).toEqual({ error: "reconciliation_evidence_unavailable" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, path, { method: "POST", headers, body: "{}" })).status).toBe(
    503,
  );
});

it("protects reconciliation assignee directory and bounds public output", async () => {
  const item = { actorReference: "01950000-0000-7000-8000-000000000001", label: "Pilot operator" };
  const model = { items: [item], nextAfterActorReference: null as string | null };
  const execute = vi.fn(async () => ({ ...model, privateIdentity: "hidden" }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      reconciliationAssigneeQuery: execute,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`,
    path = "/merchant/operations/order-exceptions/follow-up-assignees";
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
  };
  const post = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, path + suffix, { method: "POST", body: "{}", headers: { ...headers, ...extra } });
  for (const extra of [
    { Origin: "https://foreign.invalid" },
    { Host: "foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await post(extra)).status).toBe(403);
  expect((await post({}, "?store=other")).status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
  const result = await post();
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual(model);
  for (const invalid of [
    { ...model, items: Array.from({ length: 26 }, () => item) },
    { ...model, items: [item, item] },
    { ...model, items: [{ ...item, label: "private@example.invalid" }] },
    { ...model, items: [{ ...item, actorReference: "invalid" }] },
    { ...model, nextAfterActorReference: "invalid" },
  ]) {
    execute.mockResolvedValueOnce({ ...invalid, privateIdentity: "hidden" });
    expect(await (await post()).json()).toEqual({ error: "reconciliation_assignees_unavailable" });
  }
  execute.mockResolvedValueOnce({
    items: [],
    nextAfterActorReference: item.actorReference,
    privateIdentity: "hidden",
  });
  expect(await (await post()).json()).toEqual({
    items: [],
    nextAfterActorReference: item.actorReference,
  });
  execute.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  expect((await post()).status).toBe(403);
  execute.mockRejectedValueOnce(Error("private identity details"));
  expect(await (await post()).json()).toEqual({ error: "reconciliation_assignees_unavailable" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, path, { method: "POST", headers, body: "{}" })).status).toBe(
    503,
  );
});

it("admits canonical Product navigation without treating a parsed candidate as a grant", () => {
  const item = {
    screenId: "CAT-PRODUCT-LIST",
    label: "Products",
    href: "/app/commerce/products",
    permission: "catalog.manage",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: "/operations/products" },
    { permission: "catalog.read" },
    { permission: "catalog.product.manage" },
    { extra: true },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
});

it("WP-2423 Q8: admits the dining tables board only at its route and dining permission", () => {
  const item = {
    screenId: "DIN-FLOOR-BOARD",
    label: "Tables",
    href: "/operations/dining",
    permission: "dining.operate",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: "/operations/tables" },
    { permission: "ordering.operate" },
    { permission: "dining.table.read" },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
});

it("bounds complete Draft JSON separately and preserves legacy, other route and origin refusal", async () => {
  // Parser/transport only: this synthetic command port deliberately refuses every
  // candidate, so reaching it cannot be mistaken for full source admission.
  const draft = vi.fn<NonNullable<MerchantBffRouterOptions["productDraft"]>>(async () => {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  });
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      productDraft: draft,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    "Content-Type": "application/json",
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "X-BOP-Catalog-Scope": Buffer.from(
      JSON.stringify({ brandReference: storeReference, storeReference }),
    ).toString("base64url"),
  };
  const complete = JSON.stringify({ draft: { editorContent: { description: "茶".repeat(3000) } } });
  expect(Buffer.byteLength(complete)).toBeGreaterThan(8192);
  const send = (
    body: string,
    path = "/merchant/catalog/products/draft",
    extra = {},
    method = "POST",
  ) => request(root, path, { method, body, headers: { ...headers, ...extra } });
  const acceptedTransport = await send(complete);
  expect(acceptedTransport.status).toBe(400);
  expect(await acceptedTransport.json()).toEqual({ error: "product_draft_invalid" });
  expect(draft).toHaveBeenCalledOnce();
  expect(draft.mock.calls[0]?.[0].command).toEqual(JSON.parse(complete));
  draft.mockClear();
  for (const body of [
    JSON.stringify({ draft: { description: "茶".repeat(3000) } }),
    JSON.stringify({ draft: { editorContent: "茶".repeat(22000) } }),
  ]) {
    const rejected = await send(body);
    expect(rejected.status).toBe(413);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(rejected.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await rejected.json()).toEqual({ error: "product_draft_invalid" });
  }
  const malformed = await send('{"draft":');
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "product_draft_invalid" });
  for (const [path, method] of [
    ["/merchant/catalog/products", "POST"],
    ["/merchant/catalog/products/draft/extra", "POST"],
    ["/merchant/catalog/products/draft", "PUT"],
  ]) {
    expect((await send(complete, path, {}, method)).status).toBe(413);
  }
  expect((await send(complete, undefined, { Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await send(complete, undefined, { "X-BOP-CSRF": "" })).status).toBe(403);
  expect(draft).not.toHaveBeenCalled();
});

async function serveAuthoring(
  options: Pick<
    MerchantBffRouterOptions,
    | "productAuthoringResolution"
    | "productAuthoringContext"
    | "productSellingUnitRegistry"
    | "optionSetAuthoring"
    | "optionSetEditor"
    | "optionSetHistory"
    | "optionSetCurrentPublication"
    | "productOptionPicker"
    | "optionSetAuthoringResolution"
    | "optionSetAuthoringContext"
    | "optionSetList"
    | "optionSetPublicationContext"
    | "optionSetPublicationCommand"
    | "optionSetPublicationResolution"
  >,
  application = false,
) {
  const routerOptions = {
    service: fakeService(),
    exactOrigin: "https://merchant.invalid",
    acceptedHost: "merchant.invalid",
    ...options,
  };
  const app = application ? createApp({ merchantBff: routerOptions }) : express();
  if (!application) app.use("/merchant", createMerchantBffRouter(routerOptions));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
const authoringId = (n: number) => "01902421-0016-7000-8000-" + n.toString(16).padStart(12, "0");
const authoringScope = {
  brandReference: authoringId(2),
  storeReference: authoringId(3),
};
const authoringHeaders = {
  ...safeHeaders,
  Cookie: `__Host-bop-merchant=${sessionCookie}`,
  "Content-Type": "application/json",
  "X-BOP-CSRF": csrf,
  "X-BOP-Catalog-Scope": Buffer.from(JSON.stringify(authoringScope)).toString("base64url"),
};
it("Option List HTTP protects scoped current reads, bounded errors and the actual app body budget", async () => {
  let failure: Error | undefined;
  let corrupt = false;
  const filters = {
    locale: "en-CA",
    search: null,
    lifecycle: null,
    selectionType: null,
    includeArchived: false,
    hasProductBinding: null,
    hasPricingReference: null,
    hasConsumptionReference: null,
    hasConflict: null,
    missingTranslationLocale: null,
    publishingStatus: null,
    sort: "updatedAt",
    direction: "DESC",
    limit: 20,
    cursor: null,
  };
  const view = {
    projection: {
      name: "catalog_option_set_search_v1",
      version: 1,
      asOfUtc: serverTime,
      stale: false,
      partial: true,
      sourceGeneration: "sha256:" + "a".repeat(64),
    },
    scope: { tenantReference: authoringId(1), ...authoringScope, actorReference: authoringId(4) },
    locale: "en-CA",
    items: [],
    hasMore: false,
    nextCursor: null,
  };
  const list = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetList"]>>(async () => {
    if (failure) throw failure;
    return {
      ...view,
      projection: { ...view.projection, partial: corrupt ? false : true },
    } as Awaited<ReturnType<NonNullable<MerchantBffRouterOptions["optionSetList"]>>>;
  });
  const root = await serveAuthoring({ optionSetList: list }, true);
  const send = (
    headers: Record<string, string> = authoringHeaders,
    suffix = "",
    body = JSON.stringify(filters),
  ) =>
    request(root, "/merchant/catalog/option-sets/list" + suffix, { method: "POST", headers, body });
  const first = await send();
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(await first.json()).toEqual(view);
  expect(list).toHaveBeenCalledExactlyOnceWith({
    sessionCookie,
    csrf,
    filters,
    expectedScope: authoringScope,
  });
  for (const [code, status, expected] of [
    ["Invalid", 400, "option_set_list_invalid"],
    ["Denied", 403, "request_denied"],
    ["FeatureDisabled", 409, "option_set_list_feature_disabled"],
    ["Stale", 409, "option_set_list_stale"],
    ["DependencyUnavailable", 503, "option_set_list_unavailable"],
  ] as const) {
    failure = new CatalogOptionSetListError(code);
    const denied = await send();
    expect(denied.status).toBe(status);
    expect(await denied.json()).toEqual({ error: expected });
  }
  failure = new Error("SYNTHETIC_PRIVATE_SOURCE");
  expect(await (await send()).json()).toEqual({ error: "option_set_list_unavailable" });
  failure = undefined;
  corrupt = true;
  expect((await send()).status).toBe(503);
  const calls = list.mock.calls.length;
  for (const headers of [
    { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
    { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    { ...authoringHeaders, Origin: "https://foreign.invalid" },
  ])
    expect((await send(headers)).status).toBe(403);
  expect((await send(authoringHeaders, "?scope=untrusted")).status).toBe(403);
  expect(
    (await send(authoringHeaders, "", JSON.stringify({ value: "x".repeat(9000) }))).status,
  ).toBe(413);
  expect(list).toHaveBeenCalledTimes(calls);
  const unavailable = await serveAuthoring({}, true);
  expect(
    (
      await request(unavailable, "/merchant/catalog/option-sets/list", {
        method: "POST",
        headers: authoringHeaders,
        body: JSON.stringify(filters),
      })
    ).status,
  ).toBe(503);
});
const optionHttpBody = {
  internalCode: "SYNTHETIC_OPTIONS",
  draft: {
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic options" },
    localizedDescriptions: {},
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 1,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 1,
    options: [],
  },
  additionalContent: {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: serverTime,
        localDateTime: serverTime.slice(0, 23),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
  },
  operationReference: authoringId(5),
};
const optionHttpPrepared = materializeFullOptionSetCreation(
  {
    ...optionHttpBody,
    occurredAt: serverTime,
    reasonCode: "AUTHORIZED_OPERATION",
  },
  {
    brandReference: authoringScope.brandReference,
    actorReference: authoringId(4),
    allocations: {
      optionSetReference: authoringId(6),
      versionReference: authoringId(7),
      options: [],
    },
  },
);
const optionHttpResolution = createCatalogOptionSetAuthoringResolution({
  outcome: "Abandoned",
  command: parseCatalogOptionSetAuthoringResolutionCommand({
    profile: "CatalogOptionSetAuthoringResolutionCommandV1",
    tenantReference: authoringId(1),
    brandReference: authoringScope.brandReference,
    actorReference: authoringId(4),
    action: "Create",
    reasonCode: "AUTHORIZED_OPERATION",
    operationReference: authoringId(5),
    optionSetReference: null,
    expectedAggregateVersion: null,
  }),
  identity: null,
  recordedAt: parseCatalogInstant(serverTime),
});
it.each(["create", "draft", "current-editor", "authoring/resolve", "authoring/context"] as const)(
  "Option authoring HTTP %s forwards scoped requests and sanitizes failures",
  async (mode) => {
    let failure: Error | undefined;
    const create = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetAuthoring"]>["create"]>(
      async () => {
        if (failure) throw failure;
        return {
          profile: "CatalogOptionSetAuthoringCommandResultV1",
          action: "Create",
          status: "Applied",
          storeReference: authoringScope.storeReference,
          operationReference: authoringId(5),
          content: optionHttpPrepared.content,
          contentDigest: optionHttpPrepared.contentDigest,
          configurationDigest: optionHttpPrepared.configurationDigest,
          referenceEligibility: "NotEvaluated",
        };
      },
    );
    const edit = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetAuthoring"]>["edit"]>(
      async () => {
        if (failure) throw failure;
        return {
          profile: "CatalogOptionSetAuthoringCommandResultV1",
          action: "Edit",
          status: "Replayed",
          storeReference: authoringScope.storeReference,
          operationReference: authoringId(5),
          content: optionHttpPrepared.content,
          contentDigest: optionHttpPrepared.contentDigest,
          configurationDigest: optionHttpPrepared.configurationDigest,
          referenceEligibility: "NotEvaluated",
        };
      },
    );
    const read = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetEditor"]>>(async () => {
      if (failure) throw failure;
      return {
        profile: "CatalogOptionSetCurrentEditorResultV1",
        tenantReference: authoringId(1),
        brandReference: authoringScope.brandReference,
        actorReference: authoringId(4),
        storeReference: authoringScope.storeReference,
        content: optionHttpPrepared.content,
        sourceDigest: optionHttpPrepared.sourceDigest,
        contentDigest: optionHttpPrepared.contentDigest,
        configurationDigest: optionHttpPrepared.configurationDigest,
        referenceEligibility: "NotEvaluated",
      };
    });
    const recover = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetAuthoringResolution"]>>(
      async () => {
        if (failure) throw failure;
        return {
          profile: "CatalogOptionSetAuthoringResolutionResultV1",
          storeReference: authoringScope.storeReference,
          resolution: optionHttpResolution,
          content: null,
        };
      },
    );
    const context = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetAuthoringContext"]>>(
      async () => {
        if (failure) throw failure;
        return {
          profile: "CatalogOptionSetAuthoringContextV1",
          action: "Create",
          tenantReference: authoringId(1),
          brandReference: authoringScope.brandReference,
          storeReference: authoringScope.storeReference,
          actorReference: authoringId(4),
          observedAt: serverTime,
          validUntil: new Date(Date.parse(serverTime) + 5000).toISOString(),
        };
      },
    );
    const root = await serveAuthoring({
      optionSetAuthoringContext: context,
      optionSetAuthoring: { create, edit },
      optionSetEditor: read,
      optionSetAuthoringResolution: recover,
    });
    const command =
      mode === "authoring/context"
        ? { action: "Create" }
        : mode === "create"
          ? optionHttpBody
          : mode === "draft"
            ? {
                optionSetReference: authoringId(6),
                expectedAggregateVersion: 1,
                draft: optionHttpBody.draft,
                additionalContent: optionHttpBody.additionalContent,
                archiveOptionReferences: [],
                operationReference: authoringId(5),
              }
            : mode === "current-editor"
              ? { optionSetReference: authoringId(6), expectedAggregateVersion: null }
              : {
                  profile: "CatalogOptionSetAuthoringResolutionRequestV1",
                  tenantReference: authoringId(1),
                  action: "Create",
                  operationReference: authoringId(5),
                  optionSetReference: null,
                  expectedAggregateVersion: null,
                };
    const handler =
      mode === "create"
        ? create
        : mode === "draft"
          ? edit
          : mode === "current-editor"
            ? read
            : mode === "authoring/resolve"
              ? recover
              : context;
    const path = "/merchant/catalog/option-sets/" + mode;
    const send = (headers: Record<string, string> = authoringHeaders, suffix = "") =>
      request(root, path + suffix, {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
    const result = await send();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      sessionCookie,
      csrf,
      command,
      expectedScope: authoringScope,
    });
    for (const headers of [
      { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
      { ...authoringHeaders, Origin: "https://foreign.invalid" },
      { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    ])
      expect((await send(headers)).status).toBe(403);
    expect((await send(authoringHeaders, "?actor=untrusted")).status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
    for (const [error, status, code] of [
      [new CatalogError("CATALOG_INPUT_INVALID"), 400, "option_set_authoring_invalid"],
      [new CatalogError("CATALOG_PERMISSION_DENIED"), 403, "request_denied"],
      [new CatalogError("CATALOG_VERSION_CONFLICT"), 409, "option_set_authoring_conflict"],
      [new CatalogError("CATALOG_CODE_CONFLICT"), 409, "option_set_authoring_conflict"],
      [new MerchantProductWriteFeatureDisabled(), 409, "option_set_authoring_conflict"],
      [new Error("private source detail"), 503, "option_set_authoring_unavailable"],
    ] as const) {
      failure = error;
      const rejected = await send();
      expect(rejected.status).toBe(status);
      expect(await rejected.json()).toEqual({ error: code });
    }
    const unavailableRoot = await serveAuthoring({});
    expect(
      (
        await request(unavailableRoot, path, {
          method: "POST",
          headers: authoringHeaders,
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(503);
  },
);
it.each(["create", "draft", "current-editor", "authoring/resolve", "authoring/context"] as const)(
  "Option authoring HTTP %s applies its exact bounded JSON budget",
  async (mode) => {
    const rejected = vi.fn(async () => {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    });
    const root = await serveAuthoring(
      {
        optionSetAuthoring: { create: rejected, edit: rejected },
        optionSetEditor: rejected,
        optionSetAuthoringResolution: rejected,
        optionSetAuthoringContext: rejected,
      },
      true,
    );
    const path = "/merchant/catalog/option-sets/" + mode;
    const send = (body: string) =>
      request(root, path, { method: "POST", headers: authoringHeaders, body });
    const full = mode === "create" || mode === "draft";
    const options = Array.from({ length: 50 }, (_, index) => ({
      stableCode: "OPTION_" + index,
      lifecycle: "Draft",
      localizedNames: { "en-CA": "Synthetic option " + index },
      localizedDescriptions: { "en-CA": "界".repeat(440) },
      sortOrder: index,
      defaultEligible: false,
      triggeredOptionSetReference: null,
      conflictOptionCodes: [],
    }));
    const largeBody = {
      ...optionHttpBody,
      draft: { ...optionHttpBody.draft, options },
      additionalContent: {
        ...optionHttpBody.additionalContent,
        optionDetails: options.map((option) => ({
          stableCode: option.stableCode,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        })),
      },
    };
    materializeFullOptionSetCreation(
      { ...largeBody, occurredAt: serverTime, reasonCode: "AUTHORIZED_OPERATION" },
      {
        brandReference: authoringScope.brandReference,
        actorReference: authoringId(4),
        allocations: {
          optionSetReference: authoringId(6),
          versionReference: authoringId(7),
          options: options.map((option, index) => ({
            stableCode: option.stableCode,
            optionReference: authoringId(500 + index),
          })),
        },
      },
    );
    const large = JSON.stringify(largeBody);
    expect(Buffer.byteLength(large)).toBeGreaterThan(64 * 1024);
    const within = await send(large);
    expect(within.status).toBe(full ? 400 : 413);
    expect(rejected).toHaveBeenCalledTimes(full ? 1 : 0);
    const oversized = await send(JSON.stringify({ content: "x".repeat(1_048_576) }));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(await oversized.json()).toEqual({ error: "option_set_authoring_invalid" });
    const malformed = await send('{"draft":');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "option_set_authoring_invalid" });
    expect(rejected).toHaveBeenCalledTimes(full ? 1 : 0);
  },
);
it.each(["authoring-context", "authoring-resolution"])(
  "authoring HTTP %s forwards exact current identity and protects the transport",
  async (route) => {
    const resolution = buildCatalogProductAuthoringResolution({
      outcome: "Abandoned",
      command: {
        profile: "CatalogProductAuthoringResolutionCommandV1",
        tenantReference: authoringId(1),
        brandReference: authoringId(2),
        actorReference: authoringId(4),
        action: "Create",
        operationReference: authoringId(5),
        productReference: null,
        expectedAggregateVersion: null,
      },
      productReference: null,
      versionReference: null,
      aggregateVersion: null,
      originalIntentDigest: null,
      recordedAt: serverTime,
    });
    const context = vi.fn<NonNullable<MerchantBffRouterOptions["productAuthoringContext"]>>(
      async () => ({
        profile: "CatalogProductAuthoringContextV1",
        action: "Create",
        tenantReference: authoringId(1),
        brandReference: authoringId(2),
        storeReference: authoringId(3),
        actorReference: authoringId(4),
        observedAt: serverTime,
        validUntil: "2026-07-29T12:00:05.000Z",
      }),
    );
    const recover = vi.fn<NonNullable<MerchantBffRouterOptions["productAuthoringResolution"]>>(
      async () => ({
        profile: "CatalogProductAuthoringResolutionResultV1",
        storeReference: authoringId(3),
        resolution,
      }),
    );
    const root = await serveAuthoring({
        productAuthoringContext: context,
        productAuthoringResolution: recover,
      }),
      body =
        route === "authoring-context"
          ? { action: "Create" }
          : {
              profile: "CatalogProductAuthoringResolutionRequestV1",
              tenantReference: authoringId(1),
              action: "Create",
              operationReference: authoringId(5),
              productReference: null,
              expectedAggregateVersion: null,
            },
      handler = route === "authoring-context" ? context : recover;
    const result = await request(root, "/merchant/catalog/products/" + route, {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      sessionCookie,
      csrf,
      command: body,
      expectedScope: authoringScope,
    });
    for (const headers of [
      { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
      { ...authoringHeaders, Origin: "https://foreign.invalid" },
      { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    ]) {
      const denied = await request(root, "/merchant/catalog/products/" + route, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(403);
    }
    const query = await request(root, "/merchant/catalog/products/" + route + "?actor=untrusted", {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify(body),
    });
    expect(query.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  },
);
it.each(["authoring-context", "authoring-resolution"])(
  "authoring HTTP %s refuses unconfigured sources",
  async (route) => {
    const root = await serveAuthoring({});
    const result = await request(root, "/merchant/catalog/products/" + route, {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify({ action: "Create" }),
    });
    expect(result.status).toBe(503);
    expect(result.headers.get("cache-control")).toBe("no-store");
  },
);

it.each(["context", "resolve", "inspect", "register"] as const)(
  "selling units HTTP %s holds transport scope and sanitizes errors",
  async (mode) => {
    const registry: NonNullable<MerchantBffRouterOptions["productSellingUnitRegistry"]> = {
      context: vi.fn(async () => ({
        profile: "CatalogSellingUnitRegistrationContextV1" as const,
        tenantReference: authoringId(1),
        brandReference: authoringScope.brandReference,
        storeReference: authoringScope.storeReference,
        actorReference: authoringId(4),
        action: "Create" as const,
        observedAt: serverTime,
        validUntil: "2026-07-29T12:00:05.000Z",
      })),
      resolve: vi.fn(async () => ({
        profile: "CatalogSellingUnitRegistrationResolutionResultV1" as const,
        storeReference: authoringScope.storeReference,
        resolution: buildCatalogSellingUnitRegistrationResolution({
          outcome: "Abandoned",
          command: {
            profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
            tenantReference: authoringId(1),
            brandReference: authoringScope.brandReference,
            actorReference: authoringId(4),
            action: "Create",
            operationReference: authoringId(5),
            expectedRegistryVersion: 0,
          },
          registryReference: null,
          versionReference: null,
          registryVersion: null,
          originalIntentDigest: null,
          snapshotDigest: null,
          recordedAt: serverTime,
        }),
      })),
      inspect: vi.fn(async () => ({
        profile: "CatalogProductSellingUnitRegistryViewV1" as const,
        brandReference: authoringScope.brandReference,
        storeReference: authoringScope.storeReference,
        presence: "Absent" as const,
        registryVersion: 0,
        defaultLocale: null,
        units: [],
        assignedHistory: [],
        historyDigest: "sha256:" + "a".repeat(64),
        definitionsDigest: null,
        inspectionDigest: "sha256:" + "b".repeat(64),
        observedAt: serverTime,
        validUntil: "2026-07-29T12:00:05.000Z",
      })),
      register: vi.fn(async () => ({
        profile: "CatalogProductSellingUnitRegistryResultV1" as const,
        status: "Applied" as const,
        operationReference: authoringId(5),
        registryVersion: 1,
        snapshotDigest: "sha256:" + "c".repeat(64),
      })),
    };
    const root = await serveAuthoring({ productSellingUnitRegistry: registry }),
      path = "/merchant/catalog/products/selling-units/" + mode,
      body = { action: "Create" },
      handler = registry[mode];
    const result = await request(root, path, {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      sessionCookie,
      csrf,
      command: body,
      expectedScope: authoringScope,
    });
    for (const headers of [
      { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
      { ...authoringHeaders, Origin: "https://foreign.invalid" },
      { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    ]) {
      expect(
        (await request(root, path, { method: "POST", headers, body: JSON.stringify(body) })).status,
      ).toBe(403);
    }
    expect(
      (
        await request(root, path + "?actor=untrusted", {
          method: "POST",
          headers: authoringHeaders,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
    for (const [code, status] of [
      ["CATALOG_INPUT_INVALID", 400],
      ["CATALOG_PERMISSION_DENIED", 403],
      ["CATALOG_VERSION_CONFLICT", 409],
      ["CATALOG_IDEMPOTENCY_CONFLICT", 409],
      ["CATALOG_DEPENDENCY_UNAVAILABLE", 503],
    ] as const) {
      vi.mocked(handler).mockRejectedValueOnce(new CatalogError(code));
      const failure = await request(root, path, {
        method: "POST",
        headers: authoringHeaders,
        body: JSON.stringify(body),
      });
      expect(failure.status).toBe(status);
      expect(failure.headers.get("cache-control")).toBe("no-store");
      expect(await failure.text()).not.toContain(code);
    }
    const unconfigured = await serveAuthoring({});
    expect(
      (
        await request(unconfigured, path, {
          method: "POST",
          headers: authoringHeaders,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(503);
  },
);

it("admits only canonical Option List navigation in the server workspace", () => {
  const item = {
    screenId: "CAT-OPTIONSET-LIST",
    label: "Option sets",
    href: "/app/commerce/option-sets",
    permission: "catalog.option_set.read",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: "/app/commerce/products" },
    { permission: "catalog.manage" },
    { screenId: "CAT-OPTION-SET-LIST" },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
});

it("Option publication Context HTTP protects current scope, bounded errors and explicit unavailability", async () => {
  let failure: Error | undefined;
  const command = {
      optionSetReference: authoringId(6),
      expectedAggregateVersion: null,
      action: "Inspect",
    },
    rootContent = optionHttpPrepared.content.sourceAggregate,
    view: Awaited<
      ReturnType<NonNullable<MerchantBffRouterOptions["optionSetPublicationContext"]>>
    > = {
      profile: "CatalogOptionSetPublicationContextV1",
      action: "Inspect",
      tenantReference: authoringId(1),
      brandReference: authoringScope.brandReference,
      storeReference: authoringScope.storeReference,
      actorReference: authoringId(4),
      observedAt: serverTime,
      validUntil: new Date(Date.parse(serverTime) + 5000).toISOString(),
      draft: {
        optionSetReference: rootContent.optionSetReference,
        versionReference: rootContent.draft.versionReference,
        aggregateVersion: rootContent.aggregateVersion,
        sourceOperationReference: authoringId(7),
        sourceDigest: optionHttpPrepared.sourceDigest,
        contentDigest: optionHttpPrepared.contentDigest,
        configurationDigest: optionHttpPrepared.configurationDigest,
        sourceSnapshotTuple: {
          tenantReference: parseCatalogReference(authoringId(1)),
          brandReference: rootContent.brandReference,
          optionSetReference: rootContent.optionSetReference,
          versionReference: rootContent.draft.versionReference,
          aggregateVersion: rootContent.aggregateVersion,
          sourceDigest: optionHttpPrepared.sourceDigest,
          contentDigest: optionHttpPrepared.contentDigest,
          configurationDigest: optionHttpPrepared.configurationDigest,
        },
      },
      review: { kind: "AbsentForCurrentDraft" },
    },
    endpoint = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetPublicationContext"]>>(
      async () => {
        if (failure) throw failure;
        return view;
      },
    ),
    root = await serveAuthoring({ optionSetPublicationContext: endpoint }),
    path = "/merchant/catalog/option-sets/publication/context",
    send = (headers: Record<string, string> = authoringHeaders, suffix = "") =>
      request(root, path + suffix, { method: "POST", headers, body: JSON.stringify(command) });
  const actual = await send();
  expect(actual.status).toBe(200);
  expect(await actual.json()).toEqual(view);
  expect(actual.headers.get("cache-control")).toBe("no-store");
  expect(endpoint).toHaveBeenCalledExactlyOnceWith({
    sessionCookie,
    csrf,
    command,
    expectedScope: authoringScope,
  });
  for (const headers of [
    { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
    { ...authoringHeaders, Origin: "https://foreign.invalid" },
    { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    { ...authoringHeaders, Cookie: "" },
  ])
    expect((await send(headers)).status).toBe(403);
  expect((await send(authoringHeaders, "?actor=untrusted")).status).toBe(403);
  expect(endpoint).toHaveBeenCalledTimes(1);
  for (const [error, status, code] of [
    [new CatalogError("CATALOG_INPUT_INVALID"), 400, "option_set_publication_context_invalid"],
    [new CatalogError("CATALOG_PERMISSION_DENIED"), 403, "request_denied"],
    [new CatalogError("CATALOG_VERSION_CONFLICT"), 409, "option_set_publication_context_conflict"],
    [new MerchantProductWriteFeatureDisabled(), 409, "option_set_publication_feature_disabled"],
    [
      new Error("private context dependency detail"),
      503,
      "option_set_publication_context_unavailable",
    ],
  ] as const) {
    failure = error;
    const result = await send();
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: code });
  }
  const unavailable = await serveAuthoring({});
  const absent = await request(unavailable, path, {
    method: "POST",
    headers: authoringHeaders,
    body: JSON.stringify(command),
  });
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({ error: "option_set_publication_context_unavailable" });
});
it("Option publication Context HTTP retains the small authenticated app JSON budget", async () => {
  const endpoint = vi.fn(async () => {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }),
    root = await serveAuthoring({ optionSetPublicationContext: endpoint }, true),
    path = "/merchant/catalog/option-sets/publication/context";
  const tooLarge = await request(root, path, {
    method: "POST",
    headers: authoringHeaders,
    body: JSON.stringify({ padding: "x".repeat(9000) }),
  });
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toEqual({ error: "option_set_publication_context_invalid" });
  expect(endpoint).not.toHaveBeenCalled();
  const invalid = await request(root, path, {
    method: "POST",
    headers: authoringHeaders,
    body: "{broken",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "option_set_publication_context_invalid" });
  expect(endpoint).not.toHaveBeenCalled();
});

it("Option publication write HTTP exposes compact originals and protects both command and Resolve admission", async () => {
  const command = parsePublishingOptionSetPublicationOperation({
      profile: "PublishingOptionSetPublicationOperationV1",
      tenantReference: authoringId(1),
      brandReference: authoringScope.brandReference,
      selectedStoreReference: authoringScope.storeReference,
      actorReference: authoringId(4),
      reasonCode: "PUBLISHING_REVIEW_SUBMITTED",
      action: "SubmitReview",
      operationReference: authoringId(70),
      optionSetReference: authoringId(6),
      versionReference: authoringId(7),
      expectedAggregateVersion: 1,
      sourceDigest: optionHttpPrepared.sourceDigest,
      contentDigest: optionHttpPrepared.contentDigest,
      configurationDigest: optionHttpPrepared.configurationDigest,
      expectedReview: null,
      expectedLifecycle: null,
    }),
    resolution = {
      outcome: "Abandoned" as const,
      command,
      recordedAt: parsePublishingInstant(serverTime),
      auditReference: parsePublishingReference(authoringId(71)),
    };
  const commandEndpoint = vi.fn<
    NonNullable<MerchantBffRouterOptions["optionSetPublicationCommand"]>
  >(async () => ({
    profile: "CatalogOptionSetPublicationCommandResultV1",
    storeReference: authoringScope.storeReference,
    resolution,
  }));
  const resolveEndpoint = vi.fn<
    NonNullable<MerchantBffRouterOptions["optionSetPublicationResolution"]>
  >(async () => ({
    profile: "CatalogOptionSetPublicationResolutionResultV1",
    storeReference: authoringScope.storeReference,
    resolution,
  }));
  const root = await serveAuthoring({
    optionSetPublicationCommand: commandEndpoint,
    optionSetPublicationResolution: resolveEndpoint,
  });
  for (const [mode, endpoint] of [
    ["command", commandEndpoint],
    ["resolve", resolveEndpoint],
  ] as const) {
    const path = "/merchant/catalog/option-sets/publication/" + mode,
      body = { action: command.action, operationReference: command.operationReference };
    const send = (
      headers: Record<string, string> = authoringHeaders,
      suffix = "",
      original = body,
    ) => request(root, path + suffix, { method: "POST", headers, body: JSON.stringify(original) });
    const actual = await send();
    expect(actual.status).toBe(200);
    expect(actual.headers.get("cache-control")).toBe("no-store");
    expect(await actual.json()).toEqual({
      profile: "CatalogOptionSetPublicationReceiptV1",
      storeReference: authoringScope.storeReference,
      operationReference: command.operationReference,
      action: "SubmitReview",
      outcome: "Abandoned",
      recordedAt: serverTime,
    });
    expect(endpoint).toHaveBeenCalledExactlyOnceWith({
      sessionCookie,
      csrf,
      command: body,
      expectedScope: authoringScope,
    });
    for (const headers of [
      { ...authoringHeaders, Cookie: "" },
      { ...authoringHeaders, Origin: "https://foreign.invalid" },
      { ...authoringHeaders, "X-BOP-CSRF": "invalid" },
      { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
    ])
      expect((await send(headers)).status).toBe(403);
    expect((await send(authoringHeaders, "?actor=untrusted")).status).toBe(403);
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(
      (
        await send(authoringHeaders, "", {
          ...body,
          operationReference: parsePublishingReference(authoringId(72)),
        })
      ).status,
    ).toBe(503);
    endpoint.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    expect((await send()).status).toBe(403);
    endpoint.mockRejectedValueOnce(new MerchantProductWriteFeatureDisabled());
    const disabled = await send();
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: "option_set_publication_feature_disabled" });
    endpoint.mockRejectedValueOnce(new Error("private original detail"));
    expect(await (await send()).json()).toEqual({ error: "option_set_publication_unavailable" });
  }
});
it("Option publication Validate HTTP preserves the bounded report and future activation without an authority grant", async () => {
  const validation = {
    checks: optionContentReviewValidationCodes.map((code) => ({ code, outcome: "Pass" as const })),
    findings: [],
    decision: "Pass" as const,
    observedAt: parseCatalogInstant(serverTime),
    qualifiedActivationAt: parseCatalogInstant("2026-07-30T12:00:00.000Z"),
    independentApproval: "NotEvaluated" as const,
    saleEligibility: "NotEvaluated" as const,
  };
  const endpoint = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetPublicationCommand"]>>(
    async () => ({
      profile: "CatalogOptionSetPublicationCommandResultV1",
      storeReference: authoringScope.storeReference,
      outcome: "Validated",
      validation,
    }),
  );
  const root = await serveAuthoring({ optionSetPublicationCommand: endpoint });
  const send = (action: string) =>
    request(root, "/merchant/catalog/option-sets/publication/command", {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify({ action }),
    });
  const result = await send("Validate");
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({
    profile: "CatalogOptionSetPublicationCommandResultV1",
    storeReference: authoringScope.storeReference,
    outcome: "Validated",
    validation,
  });
  const mismatched = await send("SubmitReview");
  expect(mismatched.status).toBe(503);
  expect(await mismatched.json()).toEqual({ error: "option_set_publication_unavailable" });
});
it("Option publication write HTTP keeps unconfigured routes unavailable and their app body budget bounded", async () => {
  const endpoint = vi.fn(async () => {
      throw new CatalogError("CATALOG_INPUT_INVALID");
    }),
    root = await serveAuthoring(
      { optionSetPublicationCommand: endpoint, optionSetPublicationResolution: endpoint },
      true,
    ),
    absent = await serveAuthoring({});
  for (const mode of ["command", "resolve"]) {
    const path = "/merchant/catalog/option-sets/publication/" + mode;
    const result = await request(absent, path, {
      method: "POST",
      headers: authoringHeaders,
      body: "{}",
    });
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "option_set_publication_unavailable" });
    const oversized = await request(root, path, {
      method: "POST",
      headers: authoringHeaders,
      body: JSON.stringify({ filler: "x".repeat(9000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "option_set_publication_invalid" });
  }
  expect(endpoint).not.toHaveBeenCalled();
});

it("ordinary Option history HTTP enforces origin, scoped Session, bounded body and explicit failure states", async () => {
  let failure: Error | undefined;
  const command = {
    action: "List",
    command: {
      optionSetReference: authoringId(6),
      expectedAggregateVersion: null,
      before: null,
      limit: 20,
    },
  };
  const view = parseCatalogOptionSetHistoryResult(
    {
      profile: "CatalogOptionSetHistoryV1",
      tenantReference: authoringId(1),
      brandReference: authoringScope.brandReference,
      optionSetReference: authoringId(6),
      currentAggregateVersion: 1,
      entries: [],
      nextBefore: null,
      observedAt: serverTime,
      validUntil: new Date(Date.parse(serverTime) + 5000).toISOString(),
      publicationStatus: "NotEvaluated",
    },
    parseCatalogOptionSetHistoryRequest(command.command),
  );
  const read = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetHistory"]>>(async () => {
    if (failure) throw failure;
    return {
      profile: "CatalogOptionSetHistoryQueryResultV1",
      action: "List",
      storeReference: authoringScope.storeReference,
      actorReference: authoringId(4),
      view,
    };
  });
  const root = await serveAuthoring({ optionSetHistory: read }, true);
  const send = (
    headers: Record<string, string> = authoringHeaders,
    body = JSON.stringify(command),
    suffix = "",
  ) =>
    request(root, "/merchant/catalog/option-sets/history" + suffix, {
      method: "POST",
      headers,
      body,
    });
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ action: "List", view: { entries: [] } });
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie,
    csrf,
    command,
    expectedScope: authoringScope,
  });
  read.mockClear();
  for (const headers of [
    { ...authoringHeaders, Origin: "https://foreign.invalid" },
    { ...authoringHeaders, Cookie: "" },
    { ...authoringHeaders, "X-BOP-CSRF": "" },
    { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
  ])
    expect((await send(headers)).status).toBe(403);
  expect((await send(authoringHeaders, JSON.stringify(command), "?actor=untrusted")).status).toBe(
    403,
  );
  expect((await send(authoringHeaders, "{")).status).toBe(400);
  expect((await send(authoringHeaders, JSON.stringify({ extra: "a".repeat(8192) }))).status).toBe(
    413,
  );
  expect(read).not.toHaveBeenCalled();
  for (const [error, status, code] of [
    [new CatalogError("CATALOG_PERMISSION_DENIED"), 403, "request_denied"],
    [new CatalogError("CATALOG_INPUT_INVALID"), 400, "option_set_history_invalid"],
    [new CatalogError("CATALOG_VERSION_CONFLICT"), 409, "option_set_history_conflict"],
    [new MerchantProductWriteFeatureDisabled(), 409, "option_set_history_feature_disabled"],
    [new Error("private synthetic diagnostic"), 503, "option_set_history_unavailable"],
  ] as const) {
    failure = error;
    const failed = await send();
    expect(failed.status).toBe(status);
    expect(await failed.json()).toEqual({ error: code });
  }
  const absent = await serveAuthoring({}, true);
  const unavailable = await request(absent, "/merchant/catalog/option-sets/history", {
    method: "POST",
    headers: authoringHeaders,
    body: JSON.stringify(command),
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "option_set_history_unavailable" });
});

it("ordinary Option current Published HTTP is independent from history and bounds read controls", async () => {
  let failure: Error | undefined;
  const view = {
    profile: "CatalogOptionSetCurrentPublicationResultV1",
    tenantReference: authoringId(1),
    brandReference: authoringScope.brandReference,
    actorReference: authoringId(4),
    storeReference: authoringScope.storeReference,
    optionSetReference: authoringId(6),
    currentAggregateVersion: 1,
    publicationState: "Absent",
    currentLifecycleReference: null,
    lastReleaseReference: null,
    release: null,
    published: null,
    observedAt: serverTime,
    validUntil: new Date(Date.parse(serverTime) + 5000).toISOString(),
  } as const;
  const endpoint = vi.fn<NonNullable<MerchantBffRouterOptions["optionSetCurrentPublication"]>>(
    async () => {
      if (failure) throw failure;
      return view;
    },
  );
  const root = await serveAuthoring({ optionSetCurrentPublication: endpoint }, true);
  const body = { optionSetReference: authoringId(6), expectedAggregateVersion: null };
  const send = (
    headers: Record<string, string> = authoringHeaders,
    text = JSON.stringify(body),
    suffix = "",
  ) =>
    request(root, "/merchant/catalog/option-sets/current-published" + suffix, {
      method: "POST",
      headers,
      body: text,
    });
  const reply = await send();
  expect(reply.status).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(await reply.json()).toEqual(view);
  expect(endpoint).toHaveBeenCalledExactlyOnceWith({
    sessionCookie,
    csrf,
    command: body,
    expectedScope: authoringScope,
  });
  endpoint.mockClear();
  for (const headers of [
    { ...authoringHeaders, Origin: "https://foreign.invalid" },
    { ...authoringHeaders, Cookie: "" },
    { ...authoringHeaders, "X-BOP-CSRF": "" },
    { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
  ])
    expect((await send(headers)).status).toBe(403);
  expect((await send(authoringHeaders, JSON.stringify(body), "?family=untrusted")).status).toBe(
    403,
  );
  expect((await send(authoringHeaders, "{")).status).toBe(400);
  expect((await send(authoringHeaders, JSON.stringify({ content: "x".repeat(9000) }))).status).toBe(
    413,
  );
  expect(endpoint).not.toHaveBeenCalled();
  for (const [error, status, code] of [
    [new CatalogError("CATALOG_PERMISSION_DENIED"), 403, "request_denied"],
    [new CatalogError("CATALOG_VERSION_CONFLICT"), 409, "option_set_current_publication_conflict"],
    [
      new MerchantProductWriteFeatureDisabled(),
      409,
      "option_set_current_publication_feature_disabled",
    ],
    [
      new Error("private synthetic source diagnostic"),
      503,
      "option_set_current_publication_unavailable",
    ],
  ] as const) {
    failure = error;
    const failed = await send();
    expect(failed.status).toBe(status);
    expect(await failed.json()).toEqual({ error: code });
  }
  const absent = await serveAuthoring({}, true);
  const unavailable = await request(absent, "/merchant/catalog/option-sets/current-published", {
    method: "POST",
    headers: authoringHeaders,
    body: JSON.stringify(body),
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "option_set_current_publication_unavailable" });
});

it("ordinary Product Option picker HTTP preserves scoped origin and bounded source failures", async () => {
  let failure: Error = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const endpoint = vi.fn<NonNullable<MerchantBffRouterOptions["productOptionPicker"]>>(async () => {
    throw failure;
  });
  const root = await serveAuthoring({ productOptionPicker: endpoint }, true),
    body = { optionSetReference: authoringId(6), versionReference: null };
  const send = (
    headers: Record<string, string> = authoringHeaders,
    text = JSON.stringify(body),
    suffix = "",
  ) =>
    request(root, "/merchant/catalog/products/option-binding-picker" + suffix, {
      method: "POST",
      headers,
      body: text,
    });
  const first = await send();
  expect(first.status).toBe(503);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(endpoint).toHaveBeenCalledExactlyOnceWith({
    sessionCookie,
    csrf,
    command: body,
    expectedScope: authoringScope,
  });
  endpoint.mockClear();
  for (const headers of [
    { ...authoringHeaders, Origin: "https://foreign.invalid" },
    { ...authoringHeaders, Cookie: "" },
    { ...authoringHeaders, "X-BOP-CSRF": "" },
    { ...authoringHeaders, "X-BOP-Catalog-Scope": "invalid" },
  ])
    expect((await send(headers)).status).toBe(403);
  expect((await send(authoringHeaders, JSON.stringify(body), "?version=untrusted")).status).toBe(
    403,
  );
  expect((await send(authoringHeaders, "{")).status).toBe(400);
  expect((await send(authoringHeaders, JSON.stringify({ content: "x".repeat(9000) }))).status).toBe(
    413,
  );
  expect(endpoint).not.toHaveBeenCalled();
  for (const [error, status, code] of [
    [new CatalogError("CATALOG_INPUT_INVALID"), 400, "product_option_picker_invalid"],
    [new CatalogError("CATALOG_PERMISSION_DENIED"), 403, "request_denied"],
    [new CatalogError("CATALOG_VERSION_CONFLICT"), 409, "product_option_picker_conflict"],
    [new MerchantProductWriteFeatureDisabled(), 409, "product_option_picker_feature_disabled"],
    [new Error("private synthetic source diagnostic"), 503, "product_option_picker_unavailable"],
  ] as const) {
    failure = error;
    const reply = await send();
    expect(reply.status).toBe(status);
    expect(await reply.json()).toEqual({ error: code });
  }
  const absent = await serveAuthoring({}, true);
  const unavailable = await request(absent, "/merchant/catalog/products/option-binding-picker", {
    method: "POST",
    headers: authoringHeaders,
    body: JSON.stringify(body),
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "product_option_picker_unavailable" });
});

it("anchors Store Setup navigation to selected Store and canonical organization permission", () => {
  const item = {
    screenId: "STORE-SETUP",
    label: "Store setup",
    href: "/app/organization/stores/" + storeReference + "/setup",
    permission: "organization.manage",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: "/app/organization/stores/018f7f9a-ad3e-7a11-8d01-000000000099/setup" },
    { href: item.href + "?actor=x" },
    { permission: "merchant.access" },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
});

it("accepts closed Brand navigation and rejects malformed authority paths without evaluating getters", () => {
  const item = {
    screenId: "ORG-BRAND-DETAIL",
    label: "Brand administration",
    href: "/app/organization/brands/018f7f9a-ad3e-7a11-8d01-000000000002",
    permission: "organization.manage",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: item.href + "?scope=x" },
    { href: item.href + "#fragment" },
    { href: item.href + "/../x" },
    { href: item.href.replace("brands/", "brands/%") },
    { href: item.href.toUpperCase() },
    { permission: "merchant.access" },
    { extra: true },
    { label: "" },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
  expect(() => parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item, item] })).toThrow(
    "MERCHANT_WORKSPACE_DENIED",
  );
  const read = vi.fn(() => item.href);
  const accessor = { ...item };
  Object.defineProperty(accessor, "href", { enumerable: true, get: read });
  expect(() => parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [accessor] })).toThrow(
    "MERCHANT_WORKSPACE_DENIED",
  );
  expect(read).not.toHaveBeenCalled();
});

it("keeps unavailable Brand navigation distinct from rejected session authority", async () => {
  const service = fakeService();
  const root = await serve(service);
  vi.mocked(service.bootstrap).mockRejectedValueOnce(
    new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE"),
  );
  const missing = await request(root, "/merchant/session", {
    headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
  });
  expect(missing.status).toBe(503);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect(await missing.json()).toEqual({ error: "merchant_workspace_unavailable" });
  vi.mocked(service.bootstrap).mockRejectedValueOnce(
    new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED"),
  );
  const denied = await request(root, "/merchant/session", {
    headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "request_denied" });
});

it("WP-2423 Q4: anchors Hours & ordering navigation to the selected Store", () => {
  const item = {
    screenId: "STORE-HOURS-SERVICE",
    label: "Hours & ordering",
    href: "/app/organization/stores/" + storeReference + "/service",
    permission: "store.service.read",
  };
  expect(parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [item] }).navigation).toEqual([
    item,
  ]);
  for (const change of [
    { href: "/app/organization/stores/018f7f9a-ad3e-7a11-8d01-000000000099/service" },
    { permission: "organization.manage" },
  ])
    expect(() =>
      parseMerchantWorkspaceSnapshot({ ...workspace, navigation: [{ ...item, ...change }] }),
    ).toThrow("MERCHANT_WORKSPACE_DENIED");
});

it("WP-2423 Q6 step 2a: protects item cancellation transport and maps owner refusals to stable codes", async () => {
  const preview = vi.fn(async () => ({
    scope: "Items" as const,
    refund: {
      amountMinor: "565",
      currencyCode: "CAD" as const,
      includesTip: false,
      netAmountMinor: "500",
      taxAmountMinor: "65",
    },
  }));
  const cancel = vi.fn();
  const refund = vi.fn(async () => ({
    refund: { status: "Refunded" as const, amountMinor: "565", currencyCode: "CAD" as const },
  }));
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      orderItemStaffCancellation: { preview, cancel, refund } as unknown as NonNullable<
        MerchantBffRouterOptions["orderItemStaffCancellation"]
      >,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (path: string, extra: Record<string, string> = {}) =>
    request(root, "/merchant/orders/cancel-items" + path, {
      method: "POST",
      body: '{"a":1}',
      headers: { ...headers, ...extra },
    });
  for (const extra of [{ Origin: "https://foreign.invalid" }, { "X-BOP-CSRF": "" }, { Cookie: "" }])
    expect((await submit("/preview", extra)).status).toBe(403);
  expect(preview).not.toHaveBeenCalled();
  const previewed = await submit("/preview");
  expect(previewed.status).toBe(200);
  expect(previewed.headers.get("cache-control")).toBe("no-store");
  expect(((await previewed.json()) as { refund: { amountMinor: string } }).refund.amountMinor).toBe(
    "565",
  );
  expect(preview).toHaveBeenCalledWith({ sessionCookie, csrf, command: { a: 1 } });
  expect(
    ((await (await submit("/refund")).json()) as { refund: { status: string } }).refund.status,
  ).toBe("Refunded");
  for (const [code, status, error] of [
    ["ORDER_CANCELLATION_PREPARATION_STARTED", 409, "order_preparation_started"],
    ["ORDER_ITEM_CANCELLATION_STOCK_LEGACY", 409, "order_item_stock_legacy"],
    ["ORDER_CANCELLATION_PERMISSION_DENIED", 403, "order_cancellation_permission_denied"],
    ["ORDER_CANCELLATION_UNAVAILABLE", 503, "order_cancellation_unavailable"],
  ] as const) {
    cancel.mockRejectedValueOnce(new StaffItemCancellationError(code));
    const refused = await submit("");
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error });
  }
  cancel.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit("");
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("synthetic");
});

async function serveRefundEscalation(extra: Partial<MerchantBffRouterOptions> = {}) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: fakeService(),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...extra,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

it("WP-2423 Q5: verifies a step-up code for the session only and never echoes the code", async () => {
  type StepUp = NonNullable<MerchantBffRouterOptions["mfaStepUp"]>;
  const command = vi.fn<(...args: Parameters<StepUp>) => ReturnType<StepUp>>(async () => ({
    status: "Verified" as const,
    stepUpReference: "01909974-0000-7000-8000-000000000001",
    verifiedAt: "2026-10-12T15:00:00.000Z",
    validUntil: "2026-10-12T15:15:00.000Z",
  }));
  const status = vi.fn<StepUp["status"]>(async () => ({
    observedAt: "2026-10-12T15:01:00.000Z",
    validUntil: "2026-10-12T15:15:00.000Z",
  }));
  const root = await serveRefundEscalation({ mfaStepUp: Object.assign(command, { status }) });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/identity/step-up", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ purpose: "RefundApproval", code: "123456" }),
    });
  for (const bad of [
    { Origin: "https://foreign.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { Cookie: "" },
    { "X-BOP-CSRF": "" },
  ])
    expect((await send(bad)).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const ok = await send();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual({
    status: "Verified",
    verifiedAt: "2026-10-12T15:00:00.000Z",
    validUntil: "2026-10-12T15:15:00.000Z",
  });
  expect(command.mock.calls[0]?.[0]).toMatchObject({ sessionCookie, csrf });
  command.mockResolvedValueOnce({ status: "Rejected", reason: "CodeMismatch" });
  const rejected = await send();
  expect(rejected.status).toBe(422);
  expect(await rejected.text()).not.toContain("123456");
  command.mockResolvedValueOnce({ status: "Rejected", reason: "CodeReused" });
  expect(await (await send()).json()).toEqual({ error: "code_already_used" });
  command.mockResolvedValueOnce({ status: "Locked", retryAfterSeconds: 120 });
  const locked = await send();
  expect(locked.status).toBe(429);
  expect(await locked.json()).toEqual({ error: "too_many_attempts", retryAfterSeconds: 120 });
  command.mockRejectedValueOnce(new MerchantStepUpError("NotSetUp"));
  expect((await send()).status).toBe(503);
  command.mockRejectedValueOnce(new Error("private detail"));
  const failed = await send();
  expect(failed.status).toBe(403);
  expect(await failed.text()).not.toContain("private");
  // The same server-computed recency is readable by the signed-in member (no code involved).
  const read = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/identity/step-up", {
      headers: { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie, ...extra },
    });
  expect((await read({ Origin: "https://foreign.invalid" })).status).toBe(403);
  const current = await read();
  expect(current.status).toBe(200);
  expect(current.headers.get("cache-control")).toBe("no-store");
  expect(await current.json()).toEqual({ validUntil: "2026-10-12T15:15:00.000Z" });
  expect(status.mock.calls[0]?.[0]).toEqual({ sessionCookie });
  const unconfigured = await serveRefundEscalation();
  expect(
    (
      await request(unconfigured, "/merchant/identity/step-up", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(503);
});

it("WP-2423 Q5: approves through the session and names who must re-verify", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  type Approve = NonNullable<MerchantBffRouterOptions["ordinaryRefundApproval"]>;
  const command = vi.fn<Approve>(async () => ({
    status: "Approved" as const,
    approvalReference: id(1),
    replayed: false,
    payments: [
      { paymentAttemptReference: id(2), operationReference: id(3), state: "SendRecorded" as const },
    ],
  }));
  const root = await serveRefundEscalation({ ordinaryRefundApproval: command });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/payments/refunds/approve", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: "{}",
    });
  for (const bad of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(bad)).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const ok = await send();
  expect(ok.status).toBe(202);
  expect(await ok.json()).toEqual({
    status: "Approved",
    approvalReference: id(1),
    replayed: false,
    payments: [
      { paymentAttemptReference: id(2), operationReference: id(3), state: "SendRecorded" },
    ],
  });
  command.mockRejectedValueOnce(new MerchantRefundApprovalError("SamePerson"));
  const same = await send();
  expect([same.status, await same.json()]).toEqual([422, { error: "same_person" }]);
  command.mockRejectedValueOnce(
    new MerchantRefundApprovalError("NeedsReverification", "Requester"),
  );
  const stale = await send();
  expect([stale.status, await stale.json()]).toEqual([
    409,
    { error: "needs_reverification", party: "Requester" },
  ]);
  command.mockRejectedValueOnce(new MerchantRefundApprovalError("Changed"));
  expect((await send()).status).toBe(409);
  command.mockRejectedValueOnce(new Error("private"));
  expect((await send()).status).toBe(403);
});

it("WP-2423 Q5: lists refunds awaiting approval as a same-origin read", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const entry = {
    orderReference: id(1),
    orderNumber: "A-0042",
    requestReference: id(2),
    paymentIntentReferences: [id(3)],
    currencyCode: "CAD",
    amountMinor: "12500",
    reasonCode: "WRONG_ITEM",
    note: null,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    requestedAt: "2026-10-12T15:00:00.000Z",
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: "2026-10-12T15:15:00.000Z",
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: true,
    soleOperatorApproval: false,
  };
  type Approvals = NonNullable<MerchantBffRouterOptions["ordinaryRefundApprovals"]>;
  const read = vi.fn<Approvals>(
    async () =>
      ({
        observedAt: "2026-10-12T15:01:00.000Z",
        canApprove: true,
        soleOperator: null,
        entries: [{ ...entry, requesterReference: id(9) }],
      }) as never,
  );
  const root = await serveRefundEscalation({ ordinaryRefundApprovals: read });
  const get = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/payments/refunds/approvals" + suffix, {
      headers: { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie, ...extra },
    });
  expect((await get({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await get({}, "?store=x")).status).toBe(403);
  expect((await get({ Cookie: "" })).status).toBe(403);
  const ok = await get();
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  const body = await ok.json();
  expect(body).toEqual({
    observedAt: "2026-10-12T15:01:00.000Z",
    canApprove: true,
    soleOperator: null,
    entries: [entry],
  });
  expect(JSON.stringify(body)).not.toContain(id(9));
});

it("WP-2423 Q19: a self-approval without sole operator in effect is named, not a sign-in", async () => {
  type Approve = NonNullable<MerchantBffRouterOptions["ordinaryRefundApproval"]>;
  const command = vi.fn<Approve>(async () => {
    throw new MerchantRefundApprovalError("SoleOperatorNotInEffect");
  });
  const root = await serveRefundEscalation({ ordinaryRefundApproval: command });
  const failed = await request(root, "/merchant/payments/refunds/approve", {
    method: "POST",
    headers: {
      ...safeHeaders,
      Cookie: "__Host-bop-merchant=" + sessionCookie,
      "X-BOP-CSRF": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ approvalMode: "SoleOperator" }),
  });
  expect([failed.status, await failed.json()]).toEqual([
    409,
    { error: "sole_operator_not_in_effect" },
  ]);
  expect(command.mock.calls[0]?.[0].command).toEqual({ approvalMode: "SoleOperator" });
});

it("WP-2423 Q19: the Brand Owner reads and changes the sole-operator setting", async () => {
  type SoleOperator = NonNullable<MerchantBffRouterOptions["soleOperator"]>;
  const view = {
    observedAt: "2026-10-13T12:00:00.000Z",
    state: "On" as const,
    version: 1,
    changeCount: 1,
    history: [],
    refundApproval: {
      status: "OtherApprovers" as const,
      youHoldApproval: true,
      otherApprovers: [{ displayName: "Mia" }],
    },
    verifiedUntil: null,
    reasons: { On: ["OWNER_RUNS_STORE_ALONE"], Off: ["OWNER_CHOICE"] },
  };
  const readView = vi.fn(async () => view as never);
  const change = vi.fn(async () => ({
    status: "Created" as const,
    state: "Off" as const,
    version: 2,
    recordedAt: "2026-10-13T12:01:00.000Z",
  }));
  const soleOperator = Object.assign(change, { read: readView }) as unknown as SoleOperator;
  const root = await serveRefundEscalation({ soleOperator });
  const get = (extra: Record<string, string> = {}, suffix = "") =>
    request(root, "/merchant/organization/sole-operator" + suffix, {
      headers: { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie, ...extra },
    });
  expect((await get({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await get({}, "?brand=x")).status).toBe(403);
  expect((await get({ Cookie: "" })).status).toBe(403);
  const ok = await get();
  expect([ok.status, ok.headers.get("cache-control")]).toEqual([200, "no-store"]);
  expect(await ok.json()).toEqual(view);
  expect(readView).toHaveBeenLastCalledWith({ sessionCookie });
  readView.mockRejectedValueOnce(new MerchantSoleOperatorError("Denied"));
  const notOwner = await get();
  expect([notOwner.status, await notOwner.json()]).toEqual([
    403,
    { error: "brand_owner_required" },
  ]);
  // WP-2423: a Store Manager on the Approvals page is told there is nothing to show (no 403).
  readView.mockRejectedValueOnce(new MerchantSoleOperatorError("NotOwner"));
  const manager = await get();
  expect([manager.status, manager.headers.get("cache-control"), await manager.json()]).toEqual([
    200,
    "no-store",
    { brandOwner: false },
  ]);
  const post = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/organization/sole-operator", {
      method: "POST",
      headers: {
        ...safeHeaders,
        Cookie: "__Host-bop-merchant=" + sessionCookie,
        "X-BOP-CSRF": csrf,
        "Content-Type": "application/json",
        ...extra,
      },
      body: "{}",
    });
  for (const bad of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await post(bad)).status).toBe(403);
  expect(change).not.toHaveBeenCalled();
  const changed = await post();
  expect([changed.status, await changed.json()]).toEqual([
    200,
    { status: "Created", state: "Off", version: 2, recordedAt: "2026-10-13T12:01:00.000Z" },
  ]);
  for (const [error, status, body] of [
    [new MerchantSoleOperatorError("Denied"), 403, { error: "brand_owner_required" }],
    [new MerchantSoleOperatorError("NeedsReverification"), 409, { error: "needs_reverification" }],
    [new MerchantSoleOperatorError("VersionConflict"), 409, { error: "setting_changed" }],
    [new MerchantSoleOperatorError("NoChange"), 409, { error: "no_change" }],
    [new MerchantSoleOperatorError("Invalid"), 422, { error: "invalid_request" }],
    [new Error("private"), 403, { error: "request_denied" }],
  ] as const) {
    change.mockRejectedValueOnce(error);
    const failed = await post();
    expect([failed.status, await failed.json()]).toEqual([status, body]);
  }
  const unconfigured = await serveRefundEscalation();
  expect(
    (
      await request(unconfigured, "/merchant/organization/sole-operator", {
        headers: { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie },
      })
    ).status,
  ).toBe(503);
});

it("WP-2423 Q5: declines through the session and names why a decline was refused", async () => {
  type Decline = NonNullable<MerchantBffRouterOptions["ordinaryRefundDecline"]>;
  const command = vi.fn<Decline>(async () => ({
    status: "Declined" as const,
    declinedAt: "2026-10-12T15:05:00.000Z",
    replayed: false,
  }));
  const root = await serveRefundEscalation({ ordinaryRefundDecline: command });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/payments/refunds/decline", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: "{}",
    });
  for (const bad of [{ Origin: "https://foreign.invalid" }, { Cookie: "" }, { "X-BOP-CSRF": "" }])
    expect((await send(bad)).status).toBe(403);
  expect(command).not.toHaveBeenCalled();
  const ok = await send();
  expect([ok.status, await ok.json()]).toEqual([
    200,
    { status: "Declined", declinedAt: "2026-10-12T15:05:00.000Z", replayed: false },
  ]);
  for (const [error, status, body] of [
    [new MerchantRefundApprovalError("SamePerson"), 422, { error: "same_person" }],
    [new MerchantRefundApprovalError("AlreadyPrepared"), 409, { error: "refund_already_prepared" }],
    [new MerchantRefundApprovalError("AlreadyDeclined"), 409, { error: "refund_already_declined" }],
    [
      new MerchantRefundApprovalError("NeedsReverification", "Approver"),
      409,
      { error: "needs_reverification", party: "Approver" },
    ],
    [new Error("private"), 403, { error: "request_denied" }],
  ] as const) {
    command.mockRejectedValueOnce(error);
    const failed = await send();
    expect([failed.status, await failed.json()]).toEqual([status, body]);
  }
});

it("WP-2423 Q5: a role refusal names the missing role; any other failure stays a plain denial", async () => {
  type Approve = NonNullable<MerchantBffRouterOptions["ordinaryRefundApproval"]>;
  const command = vi.fn<Approve>();
  const root = await serveRefundEscalation({ ordinaryRefundApproval: command });
  const send = () =>
    request(root, "/merchant/payments/refunds/approve", {
      method: "POST",
      headers: {
        ...safeHeaders,
        Cookie: "__Host-bop-merchant=" + sessionCookie,
        "X-BOP-CSRF": csrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  for (const [error, status, body] of [
    [new MerchantRefundApprovalError("Denied"), 403, { error: "refund_role_required" }],
    [
      new MerchantRefundApprovalError("RequesterNotEligible"),
      409,
      { error: "requester_not_eligible" },
    ],
    [new Error("STORE_SERVICE_PERMISSION_DENIED"), 403, { error: "request_denied" }],
  ] as const) {
    command.mockRejectedValueOnce(error);
    const response = await send();
    expect([response.status, await response.json()]).toEqual([status, body]);
  }
});

it("WP-2423 Q5: reads one request's progress through the session without private facts", async () => {
  const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  type Progress = NonNullable<MerchantBffRouterOptions["ordinaryRefundProgress"]>;
  const read = vi.fn<Progress>(
    async () =>
      ({
        requestReference: id(2),
        progress: "Sending",
        observedAt: "2026-10-13T04:38:00.000Z",
        actorReference: "private",
      }) as never,
  );
  const root = await serveRefundEscalation({ ordinaryRefundProgress: read });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const send = (extra: Record<string, string> = {}) =>
    request(root, "/merchant/payments/refunds/progress", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ orderReference: id(1), requestReference: id(2) }),
    });
  for (const bad of [{ Origin: "https://foreign.invalid" }, { "X-BOP-CSRF": "" }])
    expect((await send(bad)).status).toBe(403);
  const ok = await send();
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual({
    requestReference: id(2),
    progress: "Sending",
    observedAt: "2026-10-13T04:38:00.000Z",
  });
  read.mockRejectedValueOnce(new Error("private"));
  expect((await send()).status).toBe(403);
});

it("WP-2423 Q19: a refund read retries a transaction conflict and never calls it a refusal", async () => {
  const conflict = () =>
    Object.assign(new Error("conflict"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
  type Progress = NonNullable<MerchantBffRouterOptions["ordinaryRefundProgress"]>;
  const progress = vi.fn<Progress>();
  const root = await serveRefundEscalation({ ordinaryRefundProgress: progress });
  const send = () =>
    request(root, "/merchant/payments/refunds/progress", {
      method: "POST",
      headers: {
        ...safeHeaders,
        Cookie: "__Host-bop-merchant=" + sessionCookie,
        "X-BOP-CSRF": csrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  progress.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({
    requestReference: "01909974-0000-7000-8000-000000000002",
    progress: "Sending",
    observedAt: "2026-10-13T12:00:00.000Z",
  } as never);
  const recovered = await send();
  expect(recovered.status).toBe(200);
  expect(progress).toHaveBeenCalledTimes(2);
  progress.mockReset();
  progress.mockImplementation(async () => {
    throw conflict();
  });
  const busy = await send();
  expect([busy.status, await busy.json()]).toEqual([503, { error: "retry_later" }]);
  expect(progress).toHaveBeenCalledTimes(4);
  progress.mockReset();
  progress.mockRejectedValue(new Error("STORE_SERVICE_PERMISSION_DENIED"));
  expect((await send()).status).toBe(403);
});

async function serveSessionContinuity(
  service: MerchantBffService,
  signInEntry?: MerchantBffRouterOptions["signInEntry"],
) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(signInEntry ? { signInEntry } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

describe("WP-2423 Q18 staff session continuity routes", () => {
  const extended = createAuthenticationSession({
    sessionReference: session.sessionReference,
    actor: session.actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: session.authenticatedAt,
    createdAt: session.createdAt,
    lastSeenAt: new Date(Date.parse(session.createdAt) + 20 * 60_000).toISOString(),
    idleExpiresAt: new Date(Date.parse(session.createdAt) + 50 * 60_000).toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt,
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const authorized = {
    ...safeHeaders,
    Cookie: `__Host-bop-merchant=${sessionCookie}`,
    "X-BOP-CSRF": csrf,
  };

  it("records activity only through a same-origin CSRF POST and returns deadlines only", async () => {
    const service = { ...fakeService(), recordActivity: vi.fn(async () => extended) };
    const root = await serveSessionContinuity(service);
    const response = await request(root, "/merchant/session/activity", {
      method: "POST",
      headers: authorized,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "absoluteExpiresAt",
      "idleExpiresAt",
      "idleTimeoutMinutes",
      "serverTime",
    ]);
    expect(body).toMatchObject({
      idleExpiresAt: extended.idleExpiresAt,
      absoluteExpiresAt: extended.absoluteExpiresAt,
      idleTimeoutMinutes: 30,
    });
    expect(JSON.stringify(body)).not.toContain(session.sessionReference);
    expect(service.recordActivity).toHaveBeenCalledWith({ sessionCookie, csrf }, true);

    const crossSite = await request(root, "/merchant/session/activity", {
      method: "POST",
      headers: { ...authorized, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(service.recordActivity).toHaveBeenCalledTimes(1);
  });

  it("reads deadlines without extending them; only a genuinely ended Session is 401", async () => {
    const service = { ...fakeService(), recordActivity: vi.fn(async () => session) };
    const root = await serveSessionContinuity(service);
    const response = await request(root, "/merchant/session/expiry", { headers: authorized });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idleExpiresAt: session.idleExpiresAt });
    expect(service.recordActivity).toHaveBeenCalledWith({ sessionCookie, csrf }, false);
    vi.mocked(service.recordActivity).mockRejectedValueOnce(
      new BrowserSessionError("BROWSER_SESSION_ENDED"),
    );
    const ended = await request(root, "/merchant/session/expiry", { headers: authorized });
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "session_ended" });
    const noCookie = await request(root, "/merchant/session/expiry", {
      headers: { ...safeHeaders, "X-BOP-CSRF": csrf },
    });
    expect(noCookie.status).toBe(401);
  });

  it("never reports a busy or unreachable Session as ended", async () => {
    const service = { ...fakeService(), recordActivity: vi.fn(async () => extended) };
    const root = await serveSessionContinuity(service);
    for (const failure of [
      new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE"),
      new Error("TENANT_DATABASE_TRANSACTION_CONFLICT"),
    ]) {
      vi.mocked(service.recordActivity).mockRejectedValueOnce(failure);
      const busy = await request(root, "/merchant/session/activity", {
        method: "POST",
        headers: authorized,
      });
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("30");
      expect(await busy.json()).toEqual({ error: "session_check_unavailable" });
    }
    vi.mocked(service.recordActivity).mockRejectedValueOnce(
      new BrowserSessionError("BROWSER_SESSION_DENIED"),
    );
    const wrongCsrf = await request(root, "/merchant/session/activity", {
      method: "POST",
      headers: authorized,
    });
    expect(wrongCsrf.status).toBe(403);
  });

  it("falls back to authorization where the store keeps a fixed deadline", async () => {
    const service = fakeService();
    const root = await serveSessionContinuity(service);
    const response = await request(root, "/merchant/session/activity", {
      method: "POST",
      headers: authorized,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idleExpiresAt: session.idleExpiresAt });
  });

  it("tells staff when signing in is unavailable (the identity provider's pool check) and records nothing", async () => {
    const service = fakeService();
    vi.mocked(service.start).mockRejectedValue(
      new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE"),
    );
    const root = await serveSessionContinuity(service, {
      path: "/operations/sign-in",
      testOnly: false,
    });
    const page = await request(root, "/merchant/login?returnTo=/app", {
      headers: { ...safeHeaders, "Sec-Fetch-Dest": "document" },
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/operations/sign-in?signIn=unavailable");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("set-cookie")).toBeNull();
    // Not a page navigation, or another refusal: the ordinary denial.
    expect((await request(root, "/merchant/login", { headers: safeHeaders })).status).toBe(403);
    vi.mocked(service.start).mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
    expect(
      (
        await request(root, "/merchant/login", {
          headers: { ...safeHeaders, "Sec-Fetch-Dest": "document" },
        })
      ).status,
    ).toBe(403);
  });

  it("ends a step-up window as unavailable when the identity provider refuses to start", async () => {
    const start = vi.fn(async () => {
      throw new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE");
    });
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        providerStepUp: { start, callback: vi.fn(), status: vi.fn() } as never,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    const root = `http://127.0.0.1:${address.port}`;
    const path =
      "/merchant/identity/step-up/start?purpose=RefundApproval&returnTo=%2Fapp%2Fapprovals";
    const response = await request(root, path, {
      headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/app/identity/step-up-complete?result=unavailable&returnTo=%2Fapp%2Fapprovals",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    start.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
    expect(
      (
        await request(root, path, {
          headers: { ...safeHeaders, Cookie: `__Host-bop-merchant=${sessionCookie}` },
        })
      ).headers.get("location"),
    ).toBe("/app/identity/step-up-complete?result=failed&returnTo=%2Fapp%2Fapprovals");
  });

  it("names the production sign-in by default and the labelled pilot sign-in when configured", async () => {
    const production = await serveSessionContinuity(fakeService());
    const entry = await request(production, "/merchant/sign-in-entry", { headers: safeHeaders });
    expect(entry.status).toBe(200);
    expect(await entry.json()).toEqual({ path: "/merchant/login?returnTo=/app", testOnly: false });
    const pilot = await serveSessionContinuity(fakeService(), {
      path: "/internal-test/staff",
      testOnly: true,
    });
    expect(
      await (await request(pilot, "/merchant/sign-in-entry", { headers: safeHeaders })).json(),
    ).toEqual({ path: "/internal-test/staff", testOnly: true });
    const unsafe = await serveSessionContinuity(fakeService(), {
      path: "//evil.invalid/login",
      testOnly: true,
    });
    expect(
      (await request(unsafe, "/merchant/sign-in-entry", { headers: safeHeaders })).status,
    ).toBe(503);
  });
});

describe("WP-2423 Q26 Kitchen remake routes", () => {
  async function serveRework(kitchenRework?: MerchantBffRouterOptions["kitchenRework"]) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(kitchenRework ? { kitchenRework } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  const headers = () => ({
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  });
  it("maps typed failures to statuses, never leaks other errors, and is absent when unwired", async () => {
    const command = vi.fn();
    const query = vi.fn();
    const root = await serveRework({ command, query } as unknown as NonNullable<
      MerchantBffRouterOptions["kitchenRework"]
    >);
    const post = (path: string, body = "{}", extra: Record<string, string> = {}) =>
      request(root, path, { method: "POST", body, headers: { ...headers(), ...extra } });
    expect(
      (await post("/merchant/kitchen/rework/command", "{}", { "X-BOP-CSRF": "" })).status,
    ).toBe(403);
    expect((await post("/merchant/kitchen/rework/query", '{"store":"x"}')).status).toBe(403);
    expect(command).not.toHaveBeenCalled();
    for (const [code, status] of [
      ["KITCHEN_REWORK_INPUT_INVALID", 400],
      ["KITCHEN_REWORK_PERMISSION_DENIED", 403],
      ["KITCHEN_REWORK_NOT_FOUND", 404],
      ["KITCHEN_REWORK_CONFLICT", 409],
      ["KITCHEN_REWORK_PRECONDITION_FAILED", 422],
      ["KITCHEN_REWORK_WINDOW_CLOSED", 422],
      ["KITCHEN_REWORK_UNAVAILABLE", 503],
    ] as const) {
      command.mockRejectedValueOnce(new KitchenReworkError(code));
      const result = await post("/merchant/kitchen/rework/command");
      expect(result.status).toBe(status);
      expect(await result.json()).toEqual({ error: code });
    }
    command.mockRejectedValueOnce(new Error("private details"));
    expect(await (await post("/merchant/kitchen/rework/command")).json()).toEqual({
      error: "request_denied",
    });
    query.mockResolvedValueOnce({ items: [] });
    expect(await (await post("/merchant/kitchen/rework/query")).json()).toEqual({ items: [] });
    const unwired = await serveRework();
    expect(
      (
        await request(unwired, "/merchant/kitchen/rework/query", {
          method: "POST",
          body: "{}",
          headers: headers(),
        })
      ).status,
    ).toBe(503);
  });
});

describe("DEC-KITCHEN-STALE-TICKETS close route", () => {
  async function serve(kitchenStaleClose?: MerchantBffRouterOptions["kitchenStaleClose"]) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(kitchenStaleClose ? { kitchenStaleClose } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  const headers = () => ({
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  });
  it("passes the browser intent only, maps typed failures to codes and is absent when unwired", async () => {
    const close = vi.fn();
    const root = await serve(
      close as unknown as NonNullable<MerchantBffRouterOptions["kitchenStaleClose"]>,
    );
    const post = (body = '{"reasonCode":"ALREADY_SERVED"}', extra: Record<string, string> = {}) =>
      request(root, "/merchant/kitchen/stale-ticket/close", {
        method: "POST",
        body,
        headers: { ...headers(), ...extra },
      });
    expect((await post(undefined, { "X-BOP-CSRF": "" })).status).toBe(403);
    expect(close).not.toHaveBeenCalled();
    close.mockResolvedValueOnce({ status: "Closed" });
    expect(await (await post()).json()).toEqual({ status: "Closed" });
    expect(close.mock.calls[0]?.[0]).toMatchObject({ command: { reasonCode: "ALREADY_SERVED" } });
    for (const [code, status] of [
      ["KITCHEN_STALE_TICKET_INPUT_INVALID", 400],
      ["KITCHEN_STALE_TICKET_PERMISSION_DENIED", 403],
      ["KITCHEN_STALE_TICKET_NOT_FOUND", 404],
      ["KITCHEN_STALE_TICKET_CONFLICT", 409],
      ["KITCHEN_STALE_TICKET_NOT_EARLIER_DAY", 422],
      ["KITCHEN_STALE_TICKET_NOTHING_OPEN", 422],
      ["KITCHEN_STALE_TICKET_UNAVAILABLE", 503],
    ] as const) {
      close.mockRejectedValueOnce(new KitchenStaleTicketError(code));
      const result = await post();
      expect(result.status).toBe(status);
      expect(await result.json()).toEqual({ error: code });
    }
    close.mockRejectedValueOnce(new Error("private details"));
    expect(await (await post()).json()).toEqual({ error: "request_denied" });
    const unwired = await serve();
    expect(
      (
        await request(unwired, "/merchant/kitchen/stale-ticket/close", {
          method: "POST",
          body: "{}",
          headers: headers(),
        })
      ).status,
    ).toBe(503);
  });
});

it("WP-2423: the Orders list and pickup queue rerun a deadlocked read and never call it a refusal", async () => {
  // On a first load both reads fence the same Orders in different orders and may deadlock.
  const conflict = () =>
    Object.assign(new Error("conflict"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
  const view = {
    items: [],
    nextAfterOrderReference: null,
    lines: null,
    pickupContact: null,
    paymentPosition: null,
  };
  const queue = vi.fn<NonNullable<MerchantBffRouterOptions["orderQueue"]>>();
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["pickupQuery"]>>();
  const root = await serve(
    fakeService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    query,
  );
  const headers = { ...safeHeaders, Cookie: "__Host-bop-merchant=" + sessionCookie };
  queue.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(view);
  const orders = await request(root, "/merchant/orders", { headers });
  expect(orders.status).toBe(200);
  expect(queue).toHaveBeenCalledTimes(2);
  queue.mockReset();
  queue.mockImplementation(async () => {
    throw conflict();
  });
  const busy = await request(root, "/merchant/orders", { headers });
  expect([busy.status, await busy.json()]).toEqual([503, { error: "retry_later" }]);
  const pickupResult = { items: [] } as unknown as Awaited<
    ReturnType<NonNullable<MerchantBffRouterOptions["pickupQuery"]>>
  >;
  query.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(pickupResult);
  const pickup = await request(root, "/merchant/pickup/query", {
    method: "POST",
    body: "{}",
    headers: { ...headers, "X-BOP-CSRF": csrf, "Content-Type": "application/json" },
  });
  expect(pickup.status).toBe(200);
  expect(query).toHaveBeenCalledTimes(2);
  // Anything else stays a plain refusal.
  query.mockRejectedValueOnce(new Error("synthetic-private-source"));
  const refused = await request(root, "/merchant/pickup/query", {
    method: "POST",
    body: "{}",
    headers: { ...headers, "X-BOP-CSRF": csrf, "Content-Type": "application/json" },
  });
  expect(refused.status).toBe(403);
}, 15000);
describe("WP-2423 Q13 operations alerts read route", () => {
  type Read = NonNullable<MerchantBffRouterOptions["operationsAlerts"]>;
  async function serve(read?: Read) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...(read ? { operationsAlerts: read } : {}),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  const headers = {
    host: "merchant.invalid",
    cookie: "__Host-bop-merchant=" + sessionCookie,
    "sec-fetch-site": "same-origin",
  };
  const view = {
    monitor: "Reporting" as const,
    observedAt: "2026-10-15T08:00:00.000Z",
    active: [],
    recentlyCleared: [],
    outbound: { email: false, webhooks: 0, heartbeat: false },
    lastSuccessfulBackupAt: null,
    plannedUpdate: null,
  };
  it("passes only the session cookie and answers without caching", async () => {
    const read = vi.fn<Read>(async () => view);
    const root = await serve(read);
    const result = await request(root, "/merchant/operations-alerts", { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(view);
    expect(read).toHaveBeenCalledWith({ sessionCookie });
  });
  it("refuses parameters, a missing session and a cross-site read; 503 when not composed", async () => {
    const read = vi.fn<Read>(async () => view);
    const root = await serve(read);
    for (const [path, extra] of [
      ["/merchant/operations-alerts?store=x", {}],
      ["/merchant/operations-alerts", { cookie: "" }],
      ["/merchant/operations-alerts", { "sec-fetch-site": "cross-site" }],
    ] as const) {
      const result = await request(root, path, { headers: { ...headers, ...extra } });
      expect(result.status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
    const absent = await serve();
    expect((await request(absent, "/merchant/operations-alerts", { headers })).status).toBe(503);
  });
  it("WP-2423: tells a role without store system alerts so in an ordinary answer", async () => {
    const root = await serve(async () => ({ permitted: false as const }));
    const result = await request(root, "/merchant/operations-alerts", { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ permitted: false });
  });
  it("answers a refusal or unreadable board as denied without the reason", async () => {
    const root = await serve(async () => {
      throw new Error("MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE");
    });
    const result = await request(root, "/merchant/operations-alerts", { headers });
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain("OPERATIONS");
  });
});

describe("v15 finding: Store setup navigation for the Store Manager", () => {
  it("admits Store setup for staff who read the Store profile; only the Owner changes it", () => {
    // The pilot entry carries organization.manage (the Owner); a Store Manager holds
    // organization.store.read and reaches the same page read-only (screen registry STORE-SETUP:
    // Owner / Store Manager, restricted steps permission-trimmed).
    expect(
      merchantNavigationActions({ screenId: "STORE-SETUP", permission: "organization.manage" }),
    ).toEqual(["organization.manage", "organization.store.read"]);
  });
});

it("WP-2423 Q4: protects the hours draft transport and answers its refusals plainly", async () => {
  const hours = vi.fn<NonNullable<MerchantBffRouterOptions["storeHoursDraft"]>>(async () => ({
    status: "Applied",
    resultingVersion: 3,
  }));
  const root = await serveRefundEscalation({ storeHoursDraft: hours });
  const headers = {
    ...safeHeaders,
    Cookie: "__Host-bop-merchant=" + sessionCookie,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const submit = (
    extra: Record<string, string> = {},
    path = "/merchant/store-configuration/hours-draft",
  ) =>
    request(root, path, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2 }),
      headers: { ...headers, ...extra },
    });
  expect((await submit({ Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await submit({}, "/merchant/store-configuration/hours-draft?x=1")).status).toBe(403);
  expect(hours).not.toHaveBeenCalled();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "Applied", resultingVersion: 3 });
  expect(hours).toHaveBeenCalledWith({ sessionCookie, csrf, command: { expectedVersion: 2 } });
  for (const [code, status, error] of [
    ["STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES", 409, "store_setup_has_unpublished_changes"],
    ["STORE_CONFIGURATION_VERSION_CONFLICT", 409, "store_configuration_conflict"],
    ["STORE_SETUP_OPERATION_VERSION_CONFLICT", 409, "store_configuration_conflict"],
    ["STORE_CONFIGURATION_LIFECYCLE_CONFLICT", 409, "store_configuration_conflict"],
    ["STORE_CONFIGURATION_COMMAND_INVALID", 422, "store_configuration_rejected"],
    ["STORE_CONFIGURATION_PERMISSION_DENIED", 403, "request_denied"],
    ["CATALOG_DEPENDENCY_UNAVAILABLE", 403, "request_denied"],
  ] as const) {
    hours.mockRejectedValueOnce(Object.assign(new Error("safe"), { code }));
    const refused = await submit();
    expect(refused.status, code).toBe(status);
    expect(await refused.json(), code).toEqual({ error });
  }
  // WP-2423 (2026-10-16 v15): the hours already saved; nothing written.
  hours.mockRejectedValueOnce(new MerchantStoreHoursNoChangeError());
  const unchanged = await submit();
  expect(unchanged.status).toBe(409);
  expect(await unchanged.json()).toEqual({ error: "no_change" });
  const absent = await serveRefundEscalation();
  const unavailable = await request(absent, "/merchant/store-configuration/hours-draft", {
    method: "POST",
    body: "{}",
    headers,
  });
  expect(unavailable.status).toBe(503);
});

describe("WP-2423 (2026-10-16 v15) Store configuration withdrawal", () => {
  async function serveWithdrawal(options: Partial<MerchantBffRouterOptions>) {
    const app = express();
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service: fakeService(),
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        ...options,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener unavailable");
    return `http://127.0.0.1:${address.port}`;
  }
  const headers = {
    ...safeHeaders,
    Cookie: `__Host-bop-merchant=${sessionCookie}`,
    "X-BOP-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const auditReference = "01a7e100-0000-7000-8000-000000000042";
  const body = JSON.stringify({
    configurationReference: "01a7e100-0000-7000-8000-000000000041",
    configurationVersion: 3,
    auditReference,
  });
  it("returns Store setup's hours to the published hours after the withdrawal, and says so", async () => {
    const withdrawal = vi.fn<NonNullable<MerchantBffRouterOptions["storeConfigurationWithdrawal"]>>(
      async () => ({ status: "Applied", kind: "Withdrawn" }) as never,
    );
    const restore = vi.fn<NonNullable<MerchantBffRouterOptions["storeHoursRestore"]>>(async () => ({
      status: "Restored",
    }));
    const root = await serveWithdrawal({
      storeConfigurationWithdrawal: withdrawal,
      storeHoursRestore: restore,
    });
    const response = await request(root, "/merchant/store-configuration/withdrawal", {
      method: "POST",
      headers,
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "Applied",
      kind: "Withdrawn",
      setupHoursRestored: true,
    });
    expect(restore).toHaveBeenCalledWith({
      sessionCookie,
      csrf,
      withdrawalReference: auditReference,
    });
    // The withdrawal stands when the restore fails or was not needed.
    restore.mockRejectedValueOnce(new Error("synthetic-restore-failure"));
    const failed = await request(root, "/merchant/store-configuration/withdrawal", {
      method: "POST",
      headers,
      body,
    });
    expect(await failed.json()).toEqual({
      status: "Applied",
      kind: "Withdrawn",
      setupHoursRestored: false,
    });
    restore.mockResolvedValueOnce({ status: "NotNeeded" });
    const notNeeded = await request(root, "/merchant/store-configuration/withdrawal", {
      method: "POST",
      headers,
      body,
    });
    expect(await notNeeded.json()).toMatchObject({ setupHoursRestored: false });
    // A refused withdrawal restores nothing.
    withdrawal.mockRejectedValueOnce(new MerchantStoreConfigurationWithdrawalError("Conflict"));
    const refused = await request(root, "/merchant/store-configuration/withdrawal", {
      method: "POST",
      headers,
      body,
    });
    expect(refused.status).toBe(409);
    expect(restore).toHaveBeenCalledTimes(3);
  });
});
