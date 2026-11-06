import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerInternalMember } from "./pilot-member.mjs";
import { startInternalCustomerServer } from "./pilot-customer-server.mjs";

afterEach(() => vi.unstubAllEnvs());

test("production without the Pilot declaration refuses before configuration is loaded", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  const loadProfile = vi.fn();
  await expect(startInternalCustomerServer({ loadProfile })).rejects.toThrow("PILOT_RUNTIME_ONLY");
  expect(loadProfile).not.toHaveBeenCalled();
});

test.each([
  ["Pilot process, InternalTest profile", "production", "Pilot", "InternalTest"],
  ["InternalTest process, Pilot profile", "development", undefined, "Pilot"],
])("%s: the profile must declare the process environment", async (_, node, declared, profile) => {
  vi.stubEnv("NODE_ENV", node);
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", declared);
  const loadInternalPickupQr = vi.fn();
  await expect(
    startInternalCustomerServer({
      loadProfile: async () => ({ environment: profile }),
      loadInternalPickupQr,
    }),
  ).rejects.toThrow("PILOT_RUNTIME_ONLY");
  expect(loadInternalPickupQr).not.toHaveBeenCalled();
});

test("a Pilot Store serves pickup entry on its address but no DEMO launcher, legacy path or test sign-in", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  const directory = await mkdtemp(join(tmpdir(), "bop-https-pilot-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const certificates = await createTestCertificates(directory, {
    hostname: "order.store-pilot.ca",
  });
  const resourceClose = vi.fn(async () => undefined);
  // The API process stand-in: /api and /bff requests the entry does not answer itself go there.
  const { createServer } = await import("node:http");
  const forwarded = [];
  const api = createServer((req, res) => {
    forwarded.push(req.url);
    res.writeHead(404, { "content-type": "application/json" }).end('{"code":"NOT_FOUND"}');
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: "https://order.store-pilot.ca",
      listenPort: 0,
      apiPort: api.address().port,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({
        environment: "Pilot",
        binding: { publicStoreReference: "0190aa21-0000-7000-8000-000000000005" },
      }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      // The DEMO launcher tables are never consulted in a Pilot Store.
      diningEntries: [{ selector: "table-1", label: "Table 1", tableReference: "unused" }],
      createInternalTestResources: async () => ({ close: resourceClose }),
      createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
      createInternalCustomerEntry: async () => ({ dining: {} }),
      createInternalTestItems: async () => ({ catalogCartItems: [] }),
      createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
      createInternalOrder: async () => ({}),
      createInternalDiningCheckout: () => ({ preparation: {} }),
      createInternalChannelPayment: async () => ({}),
      createInternalPaymentTerminal: () => ({}),
      createInternalMerchant: async () => ({
        staffSignInMode: "cognito",
        bff: { exactOrigin: "https://order.store-pilot.ca", acceptedHost: "order.store-pilot.ca" },
      }),
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const get = (path) =>
      new Promise((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path,
            servername: "order.store-pilot.ca",
            ca: [certificates.root],
            headers: { host: "order.store-pilot.ca", "sec-fetch-site": "same-origin" },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode, body }));
          },
        );
        call.on("error", reject);
        call.end();
      });
    const entry = await get("/bff/customer/pickup-entry");
    expect(entry.status).toBe(200);
    expect(JSON.parse(entry.body)).toEqual({ schemaVersion: 1, qrToken: "synthetic.pickup.token" });
    // 2026-11-01: the Store's own pickup link names it; another Store's (not served here) is not found.
    const own = await get("/bff/customer/pickup-entry?store=0190aa21-0000-7000-8000-000000000005");
    expect(JSON.parse(own.body)).toEqual({ schemaVersion: 1, qrToken: "synthetic.pickup.token" });
    const other = await get(
      "/bff/customer/pickup-entry?store=0190aa21-0000-7000-8000-000000000006",
    );
    expect(other.status).toBe(404);
    expect(other.body).not.toContain("synthetic.pickup.token");
    // The InternalTest-only entries are not served here: their /bff paths fall through to the
    // API (which has none), their pages are just the customer app shell.
    for (const path of [
      "/bff/internal-test/pickup-entry",
      "/bff/internal-test/dining-entry?table=table-1",
    ]) {
      const refused = await get(path);
      expect(refused.status, path).toBe(404);
      expect(refused.body).not.toContain("synthetic.pickup.token");
    }
    expect(forwarded).toEqual([
      "/bff/internal-test/pickup-entry",
      "/bff/internal-test/dining-entry?table=table-1",
    ]);
    for (const path of ["/internal-test/dining", "/internal-test/staff"]) {
      const page = await get(path);
      expect(page.body, path).not.toContain("DEMO_STAFF_LOGIN");
      expect(page.body, path).not.toContain("table-1");
      expect(page.body, path).not.toContain("synthetic.pickup.token");
    }
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await new Promise((resolve) => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("v15 2026-10-31: a served Store that cannot start is logged and skipped; the installation's Store keeps serving", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  const directory = await mkdtemp(join(tmpdir(), "bop-https-stores-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const certificates = await createTestCertificates(directory, {
    hostname: "order.store-pilot.ca",
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const brokenClose = vi.fn(async () => undefined);
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: "https://order.store-pilot.ca",
      listenPort: 0,
      apiPort: 4300,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({
        environment: "Pilot",
        binding: { publicStoreReference: "0190aa21-0000-7000-8000-000000000005" },
      }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      diningEntries: [],
      createInternalTestResources: async () => ({
        scope: {
          storeReference: "0190aa21-0000-7000-8000-000000000001",
          brandReference: "0190aa21-0000-7000-8000-000000000002",
        },
        publicProfile: {
          binding: {
            tenantReference: "0190aa21-0000-7000-8000-000000000003",
            publicStoreReference: "0190aa21-0000-7000-8000-000000000005",
          },
        },
        transactions: {},
        credentials: { sessions: { hashCredential: () => "selector" } },
        close: vi.fn(async () => undefined),
      }),
      createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
      createInternalCustomerEntry: async () => ({ dining: {} }),
      createInternalTestItems: async () => ({ catalogCartItems: [] }),
      createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
      createInternalOrder: async () => ({}),
      createInternalDiningCheckout: () => ({ preparation: {} }),
      createInternalChannelPayment: async () => ({}),
      createInternalPaymentTerminal: () => ({}),
      createInternalMerchant: async (served) => {
        // The installation's own staff side is offered no Store it does not serve.
        expect(served.servedStores).toBeUndefined();
        return {
          staffSignInMode: "cognito",
          bff: {
            exactOrigin: "https://order.store-pilot.ca",
            acceptedHost: "order.store-pilot.ca",
          },
        };
      },
      additionalStores: [
        {
          storeReference: "store-2",
          apiPort: 4301,
          // demo-2 as v15 had it: its resources cannot be read.
          createInternalTestResources: async () => {
            throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
          },
          createInternalMerchant: async () => assert.fail("never composed"),
        },
        {
          storeReference: "store-3",
          apiPort: 4302,
          createInternalTestResources: async () => ({ close: brokenClose }),
          createInternalMerchant: async () => {
            throw Object.assign(new Error("STORE_REFERENCE_SOURCE_INVALID"), { code: "55000" });
          },
        },
      ],
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const get = (path) =>
      new Promise((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path,
            servername: "order.store-pilot.ca",
            ca: [certificates.root],
            headers: { host: "order.store-pilot.ca", "sec-fetch-site": "same-origin" },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode, body }));
          },
        );
        call.on("error", reject);
        call.end();
      });
    const own = await get("/bff/customer/pickup-entry?store=0190aa21-0000-7000-8000-000000000005");
    expect(own.status).toBe(200);
    // M02 (v15 07b7a1b7): stores.json names more than one Store, so the bare address belongs to
    // none of them, even while the others are down: never the installation's first merchant.
    const bare = await get("/bff/customer/pickup-entry");
    expect(bare.status).toBe(404);
    expect(JSON.parse(bare.body)).toEqual({ code: "PICKUP_ENTRY_UNKNOWN_STORE" });
    // M02: a table scanned at one of the Stores that failed to start (or a reload replaying it)
    // is a retryable outage, never this Store's refusal of a code it doesn't own.
    const enter = (payload, cookie) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/bff/customer/entry",
            method: "POST",
            servername: "order.store-pilot.ca",
            ca: [certificates.root],
            headers: {
              host: "order.store-pilot.ca",
              origin: "https://order.store-pilot.ca",
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(cookie === undefined ? {} : { cookie }),
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                cache: response.headers["cache-control"],
                text,
              }),
            );
          },
        );
        call.on("error", reject);
        call.end(body);
      });
    const failedStoreCode =
      "x." +
      Buffer.from(
        JSON.stringify({ publicStoreReference: "0190aa21-0000-7000-8000-000000000006" }),
      ).toString("base64url") +
      ".y";
    for (const [payload, cookie] of [
      [{ qrToken: failedStoreCode }, undefined],
      [{ resume: true }, "__Secure-bop-scan=" + failedStoreCode],
    ]) {
      const answer = await enter(payload, cookie);
      expect(answer.status, JSON.stringify(payload)).toBe(503);
      expect(answer.cache).toBe("no-store");
      expect(JSON.parse(answer.text)).toEqual({ code: "CUSTOMER_STORE_UNAVAILABLE" });
    }
    // Each failed Store is logged with its code; the one whose resources opened has them closed.
    expect(
      logged.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .filter((line) => line?.event === "PILOT_CUSTOMER_STORE_UNAVAILABLE")
        .map(({ code, reason }) => ({ code, reason })),
    ).toEqual([
      { code: "PILOT_INSTALLATION_UNAVAILABLE", reason: undefined },
      { code: "55000", reason: "STORE_REFERENCE_SOURCE_INVALID" },
    ]);
    expect(brokenClose).toHaveBeenCalledOnce();
  } finally {
    logged.mockRestore();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["simulator", "entry"])(
  "startup failure at %s releases acquired resources",
  async (stage) => {
    vi.stubEnv("NODE_ENV", "development");
    const directory = await mkdtemp(join(tmpdir(), "bop-https-cleanup-"));
    const keyFile = join(directory, "unused-key");
    const resourceClose = vi.fn(async () => undefined);
    const simulatorClose = vi.fn();
    const failure = new Error("STARTUP_UNAVAILABLE");
    try {
      await writeFile(keyFile, "not-a-key", { mode: 0o600 });
      await expect(
        startInternalCustomerServer({
          loadProfile: async () => ({ environment: "InternalTest" }),
          keyFile,
          loadInternalPickupQr: async () => ({}),
          createInternalTestResources: async () => ({ close: resourceClose }),
          createInternalSimulatedProvider: async () => {
            if (stage === "simulator") throw failure;
            return { close: simulatorClose };
          },
          createInternalCustomerEntry: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(resourceClose).toHaveBeenCalledTimes(1);
      expect(simulatorClose).toHaveBeenCalledTimes(stage === "entry" ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// v15 650d8f50: a mounted Store route the Store routing doesn't name falls through to the API
// proxy, so at a multi-Store installation every guest got the API's generic 404.
test("WP-2423 取舍 18: a guest's member request reaches their own Store's handler, at every Store", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await mkdtemp(join(tmpdir(), "bop-member-route-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const certificates = await createTestCertificates(directory, { hostname: "localhost" });
  const origin = "https://localhost";
  const reached = [];
  const stack = (store) => ({
    createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
    createInternalCustomerEntry: async () => ({ dining: {} }),
    createInternalTestItems: async () => ({ catalogCartItems: [] }),
    createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
    createInternalOrder: async () => ({}),
    createInternalDiningCheckout: () => ({ preparation: {} }),
    createInternalChannelPayment: async () => ({}),
    createInternalPaymentTerminal: () => ({}),
    // The real route, its handler and its port; only this Store's database is a stand-in that
    // says which Store it is.
    registerInternalDiningTablePayment: (router, options) =>
      registerInternalMember(router, {
        directory,
        origin: options.origin,
        resources: {
          ...options.resources,
          publicProfile: { binding: { tenantReference: "tenant" } },
          credentials: { reference: () => "reference" },
        },
        providerAccountReference: "provider",
        access: {
          scope: { brandReference: "brand", storeReference: store },
          transactions: {
            run: async () => {
              reached.push(store);
              throw new Error("DATABASE_STAND_IN");
            },
          },
          now: () => new Date().toISOString(),
        },
      }),
  });
  const resourcesOf = (storeReference) => ({
    scope: { storeReference, brandReference: "brand" },
    publicProfile: { binding: { publicStoreReference: "public-" + storeReference } },
    credentials: { sessions: { hashCredential: () => "selector" } },
    transactions: {},
    close: vi.fn(async () => undefined),
  });
  const merchant = async () => ({
    staffSignInMode: "cognito",
    persistence: { transactions: {}, identity: { hasher: {} }, now: () => "" },
    bff: { exactOrigin: origin, acceptedHost: "localhost" },
  });
  const guests = { ["a".repeat(43)]: "store-1", ["b".repeat(43)]: "store-2" };
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: origin,
      listenPort: 0,
      apiPort: 1,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({ environment: "InternalTest" }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      diningEntries: [],
      createInternalTestResources: async () => resourcesOf("store-1"),
      createInternalMerchant: merchant,
      ...stack("store-1"),
      additionalStores: [
        {
          storeReference: "store-2",
          apiPort: 2,
          customer: {
            ...stack("store-2"),
            createInternalTestResources: undefined,
          },
          createInternalTestResources: async () => resourcesOf("store-2"),
          createInternalMerchant: merchant,
        },
      ],
      // Which Store a guest's Session belongs to is decided by the real routing elsewhere.
      createStoreRouting:
        () =>
        async ({ cookie }) => ({
          storeReference: guests[/__Host-bop-guest=([^;]+)/u.exec(cookie)?.[1]],
        }),
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const ask = (guest) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ action: "State" });
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/bff/customer/member",
            method: "POST",
            servername: "localhost",
            ca: [certificates.root],
            headers: {
              host: "localhost",
              origin,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "x-csrf-token": "c".repeat(43),
              cookie: `__Host-bop-guest=${guest}`,
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () => resolve({ status: response.statusCode, text }));
          },
        );
        call.on("error", reject);
        call.end(body);
      });
    for (const [guest, store] of Object.entries(guests)) {
      reached.length = 0;
      const answer = await ask(guest);
      // The handler answered (its own code), not the API proxy or a generic 404.
      expect(JSON.parse(answer.text).error?.code, store).toBe("member_unavailable");
      expect(answer.status, store).toBe(503);
      expect(reached, store).toEqual([store]);
    }
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
