import { BrandStoreTopologyError } from "@bop/tenant";
import {
  parsePublishingOptionSetPublicationOperation,
  parsePublishingReference,
  parsePublishingInstant,
} from "@bop/publishing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import { BrowserSessionError } from "@bop/identity";
import { parsePaymentReference, ReconciliationFollowUpError } from "@rms/payment";
import { parsePaymentInstant } from "@rms/payment";
import { parseDiningReference } from "@rms/dining";
import { FulfillmentReadinessError } from "@rms/fulfillment";
import { PickupHandoffError, PickupProofError } from "@rms/fulfillment";
import {
  KitchenQueueProjectionError,
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
import { createApp } from "./app.js";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantBffRouter,
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
    expect(read).toHaveBeenCalledExactlyOnceWith(sessionCookie);
    expect(result.headers.get("cache-control")).toBe("no-store");
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
  control.mockRejectedValueOnce(
    Object.assign(new Error("safe"), { code: "STORE_CONFIGURATION_VERSION_CONFLICT" }),
  );
  expect((await submit()).status).toBe(409);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect(await response.json()).toEqual({ items: [], nextAfterOrderReference: null });
  expect(queue).toHaveBeenCalledWith({ sessionCookie, afterOrderReference: storeReference });
  queue.mockRejectedValueOnce(new Error("synthetic-private-source"));
  const failed = await request(root, "/merchant/orders", { headers });
  expect(failed.status).toBe(403);
  expect(await failed.json()).toEqual({ error: "request_denied" });
  const unconfigured = await serve(fakeService());
  expect((await request(unconfigured, "/merchant/orders", { headers })).status).toBe(503);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  expect((await submit({ "X-BOP-CSRF": "" })).status).toBe(403);
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
  close.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "request_denied" });
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
  close.mockRejectedValueOnce(new Error("synthetic-private"));
  const denied = await submit();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "request_denied" });
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
    paymentIntentReference: id(31),
  };
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundItems"]>>(async () => ({
    orderReference: id(1),
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
      },
    ],
    items: [item],
  });
  query.mockRejectedValueOnce(new Error("private"));
  expect(await (await send()).json()).toEqual({ error: "request_denied" });
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
    currencyCode: null,
    capturedAmountMinor: null,
    confirmedRefundMinor: null,
    pendingRefundMinor: null,
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
    executionOperationReference: null,
    amountMinor: "1130",
    confirmedMinor: "0",
    pendingMinor: "1130",
  };
  const data = {
    orderReference: id(3),
    requestReference: id(4),
    operationReference: id(5),
    observedAt: "2026-09-20T12:00:00.000Z",
    currencyCode: "CAD" as const,
    amountMinor: "1130",
    payments: [payment],
  };
  const query = vi.fn<NonNullable<MerchantBffRouterOptions["ordinaryRefundStatus"]>>(async () => ({
    ...data,
    rawProvider: "private",
    payments: [{ ...payment, providerRefundReference: "private" }],
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
