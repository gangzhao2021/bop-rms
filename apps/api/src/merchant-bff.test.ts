import {
  authorizationCookie,
  createAuthenticationSession,
  merchantSessionCookie,
  parseRawBrowserCredential,
  type BrowserCookieMutation,
  type RawBrowserCredential,
} from "@bop/identity";
import express from "express";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMerchantBffRouter, type MerchantBffService } from "./merchant-bff.js";

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

async function serve(service: MerchantBffService) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
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
    readonly headers?: Readonly<Record<string, string | undefined>>;
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
