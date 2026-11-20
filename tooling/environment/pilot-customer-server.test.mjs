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
            response.on("end", () =>
              resolve({ status: response.statusCode, body, headers: response.headers }),
            );
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
    // M106: every customer page (the shell at any address, and its offline page) is served under
    // the customer Content-Security-Policy; the staff app keeps its own answer.
    const { customerContentSecurityPolicy } =
      await import("../../apps/customer-pwa/scripts/content-security-policy.mjs");
    for (const path of ["/", "/menu", "/cart", "/offline.html"]) {
      const page = await get(path);
      expect(page.status, path).toBe(200);
      expect(page.headers["content-security-policy"], path).toBe(customerContentSecurityPolicy);
    }
    expect((await get("/app")).headers["content-security-policy"]).not.toBe(
      customerContentSecurityPolicy,
    );
    expect(customerContentSecurityPolicy).toMatch(/(?:^|; )script-src 'self'[^;]*(?:;|$)/u);
    expect(customerContentSecurityPolicy).not.toContain("unsafe-inline");
    expect(customerContentSecurityPolicy).toContain("frame-ancestors 'none'");
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
                setCookie: response.headers["set-cookie"],
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
      // Neither an unframed code nor a replay is given a waiting-scan cookie here.
      expect(answer.setCookie).toBeUndefined();
    }
    // WP-2423 live minor 25: a fresh scan framed as a Store's entry accepts it keeps its code
    // for a reload during the outage, with exactly the cookie that Store's entry sets.
    const framedCode =
      Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url") +
      "." +
      Buffer.from(
        JSON.stringify({ publicStoreReference: "0190aa21-0000-7000-8000-000000000006" }),
      ).toString("base64url") +
      "." +
      Buffer.alloc(64, 9).toString("base64url");
    const kept = await enter({ qrToken: framedCode });
    expect(kept.status).toBe(503);
    expect(JSON.parse(kept.text)).toEqual({ code: "CUSTOMER_STORE_UNAVAILABLE" });
    expect(kept.setCookie).toEqual([
      `__Secure-bop-scan=${framedCode}; Max-Age=1800; Path=/bff/customer/entry; Secure; HttpOnly; SameSite=Strict`,
    ]);
    const replayed = await enter({ resume: true }, "__Secure-bop-scan=" + framedCode);
    expect(replayed.status).toBe(503);
    expect(replayed.setCookie).toBeUndefined();
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
          // The member port checks its references are real identifiers when it is built.
          publicProfile: { binding: { tenantReference: "01900000-0000-7000-8000-000000000001" } },
          credentials: { reference: () => "reference" },
        },
        providerAccountReference: "provider",
        access: {
          scope: {
            brandReference: "01900000-0000-7000-8000-000000000002",
            storeReference:
              store === "store-1"
                ? "01900000-0000-7000-8000-000000000003"
                : "01900000-0000-7000-8000-000000000004",
          },
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

// WP-2423 batch 33 (v15 b32 live): at an installation of several merchants, the waiting page's
// "is the table open now?" answered 404 CUSTOMER_STORE_NOT_FOUND at every table: the server's real
// Store routing read the Store from the body of the entry only.
test("batch 33: the entry and the waiting check both reach the scanned Store's own customer API", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await mkdtemp(join(tmpdir(), "bop-table-wait-route-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const { createServer } = await import("node:http");
  const certificates = await createTestCertificates(directory, { hostname: "localhost" });
  const origin = "https://localhost";
  const reached = [];
  // Each Store's own customer API: a stand-in on a real local port that says which Store it is.
  const api = async (name) => {
    const upstream = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += String(chunk)));
      req.on("end", () => {
        reached.push({ store: name, path: req.url, body: text });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ schemaVersion: 1, status: "Waiting" }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    return upstream;
  };
  const apis = [await api("store-1"), await api("store-2")];
  const publicOf = (n) => "0190aa21-0000-7000-8000-00000000010" + n;
  // Two merchants (two Tenants): nothing that names no Store goes to either.
  const resourcesOf = (n) => ({
    scope: {
      storeReference: "0190aa21-0000-7000-8000-00000000000" + n,
      brandReference: "0190aa21-0000-7000-8000-00000000002" + n,
    },
    publicProfile: {
      binding: {
        tenantReference: "0190aa21-0000-7000-8000-00000000003" + n,
        publicStoreReference: publicOf(n),
      },
    },
    credentials: { sessions: { hashCredential: () => "selector" } },
    transactions: {},
    close: vi.fn(async () => undefined),
  });
  const stack = {
    createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
    createInternalCustomerEntry: async () => ({ dining: {} }),
    createInternalTestItems: async () => ({ catalogCartItems: [] }),
    createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
    createInternalOrder: async () => ({}),
    createInternalDiningCheckout: () => ({ preparation: {} }),
    createInternalChannelPayment: async () => ({}),
    createInternalPaymentTerminal: () => ({}),
  };
  const merchant = async () => ({
    staffSignInMode: "cognito",
    persistence: { transactions: {}, identity: { hasher: {} }, now: () => "" },
    bff: { exactOrigin: origin, acceptedHost: "localhost" },
  });
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: origin,
      listenPort: 0,
      apiPort: apis[0].address().port,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({ environment: "InternalTest" }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      diningEntries: [],
      createInternalTestResources: async () => resourcesOf(1),
      createInternalMerchant: merchant,
      ...stack,
      additionalStores: [
        {
          storeReference: "0190aa21-0000-7000-8000-000000000002",
          apiPort: apis[1].address().port,
          createInternalTestResources: async () => resourcesOf(2),
          createInternalMerchant: merchant,
        },
      ],
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const post = (path, payload, cookie) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path,
            method: "POST",
            servername: "localhost",
            ca: [certificates.root],
            headers: {
              host: "localhost",
              origin,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(cookie === undefined ? {} : { cookie }),
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
    const code = (n) =>
      "x." +
      Buffer.from(JSON.stringify({ publicStoreReference: publicOf(n) })).toString("base64url") +
      ".y";
    for (const path of ["/bff/customer/entry", "/bff/customer/entry/table-wait"])
      for (const n of [1, 2]) {
        for (const [payload, cookie] of [
          [{ qrToken: code(n) }, undefined],
          [{ resume: true }, "__Secure-bop-scan=" + code(n)],
        ]) {
          reached.length = 0;
          const answer = await post(path, payload, cookie);
          const at = path + " store-" + n + " " + JSON.stringify(payload);
          expect(answer.status, at).toBe(200);
          // The Store's own API answered, with the body exactly as the phone sent it.
          expect(reached, at).toEqual([
            { store: "store-" + n, path, body: JSON.stringify(payload) },
          ]);
        }
      }
    // A code naming no Store of this installation reaches no merchant, on either path.
    for (const path of ["/bff/customer/entry", "/bff/customer/entry/table-wait"]) {
      reached.length = 0;
      const answer = await post(path, { qrToken: "a.b.c" });
      expect(answer.status, path).toBe(404);
      expect(JSON.parse(answer.text), path).toEqual({ code: "CUSTOMER_STORE_NOT_FOUND" });
      expect(reached, path).toEqual([]);
    }
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    for (const upstream of apis) await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// WP-2423 batch 34: at an installation of several merchants, the one-time order link (its token
// names no Store), SES feedback and the Stripe webhook (provider callbacks) reached no merchant:
// 404 CUSTOMER_STORE_NOT_FOUND. Each must reach the Store that issued it, from that Store's own
// facts and only after the provider's signature verifies.
test("batch 34: the order link, SES feedback and Stripe webhook each reach their own Store", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await mkdtemp(join(tmpdir(), "bop-callback-route-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const { createServer } = await import("node:http");
  const { chmod } = await import("node:fs/promises");
  const { createHmac, createSign, generateKeyPairSync, randomBytes } = await import("node:crypto");
  const { createSnsSignatureVerifier } =
    await import("../../packages/bop/notification/src/index.ts");
  const { createPilotStripeWebhookClaim } = await import("./pilot-stripe-webhook.mjs");
  const certificates = await createTestCertificates(directory, { hostname: "localhost" });
  const origin = "https://localhost";
  const reached = [];
  const api = async (name) => {
    const upstream = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        reached.push({ store: name, path: req.url, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" }).end('{"store":"' + name + '"}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    return upstream;
  };
  const apis = [await api("store-1"), await api("store-2")];
  // Each merchant's own facts: the links it issued, its SES topic and configuration set, and its
  // own Stripe account's webhook endpoint secret (a 0600 file in its own runtime directory).
  const linkOf = (n) => String(n).repeat(43);
  const topicOf = (n) => "arn:aws:sns:ca-central-1:12345678901" + n + ":store-" + n + "-events";
  const secretOf = (n) => "whsec_" + "synthetic" + n + "SECRET0000000000";
  for (const n of [1, 2]) {
    const file = join(directory, "stripe-webhook-secret-" + n);
    await writeFile(file, secretOf(n), { mode: 0o600 });
    await chmod(file, 0o600);
  }
  const resourcesOf = (n) => ({
    scope: {
      storeReference: "0190aa21-0000-7000-8000-00000000000" + n,
      brandReference: "0190aa21-0000-7000-8000-00000000002" + n,
    },
    publicProfile: {
      binding: {
        tenantReference: "0190aa21-0000-7000-8000-00000000003" + n,
        publicStoreReference: "0190aa21-0000-7000-8000-00000000010" + n,
      },
    },
    credentials: { sessions: { hashCredential: () => "selector" }, reference: () => "unused" },
    transactions: {},
    now: () => new Date().toISOString(),
    orderMessaging: {
      issuedOrderLink: vi.fn(async (token) => token === linkOf(n)),
      feedbackRoute: { topicArn: topicOf(n), configurationSetName: "store-" + n },
    },
    close: vi.fn(async () => undefined),
  });
  const stack = {
    createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
    createInternalCustomerEntry: async () => ({ dining: {} }),
    createInternalTestItems: async () => ({ catalogCartItems: [] }),
    createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
    createInternalOrder: async () => ({}),
    createInternalDiningCheckout: () => ({ preparation: {} }),
    createInternalChannelPayment: async () => ({}),
    createInternalPaymentTerminal: () => ({}),
  };
  const claimOf = (n) => async (resources) =>
    createPilotStripeWebhookClaim(resources, {
      directory,
      stripe: { webhookSecretFile: "stripe-webhook-secret-" + n, nextWebhookSecret: null },
    });
  const merchant = async () => ({
    staffSignInMode: "cognito",
    persistence: { transactions: {}, identity: { hasher: {} }, now: () => "" },
    bff: { exactOrigin: origin, acceptedHost: "localhost" },
  });
  // A local SNS signing key stands in for AWS's certificate (no provider is called).
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const snsSignatures = createSnsSignatureVerifier({
    fetchCertificate: async () => "PEM",
    clock: { now: () => "2026-11-19T12:00:00.000Z" },
    parseCertificate: () => ({
      subject: "CN=sns.amazonaws.com",
      validFrom: "Jan  1 00:00:00 2026 GMT",
      validTo: "Jan  1 00:00:00 2027 GMT",
      publicKey,
    }),
  });
  const lines = [];
  const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: origin,
      listenPort: 0,
      apiPort: apis[0].address().port,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({ environment: "InternalTest" }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      diningEntries: [],
      createInternalTestResources: async () => resourcesOf(1),
      createInternalMerchant: merchant,
      createPaymentWebhookClaim: claimOf(1),
      snsSignatures,
      ...stack,
      additionalStores: [
        {
          storeReference: "0190aa21-0000-7000-8000-000000000002",
          apiPort: apis[1].address().port,
          customer: { ...stack, createPaymentWebhookClaim: claimOf(2) },
          createInternalTestResources: async () => resourcesOf(2),
          createInternalMerchant: merchant,
        },
      ],
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const post = (path, body, headers = {}) =>
      new Promise((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path,
            method: "POST",
            servername: "localhost",
            ca: [certificates.root],
            headers: {
              host: "localhost",
              "content-length": Buffer.byteLength(body),
              ...headers,
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
    const expectReached = async (path, body, headers, store) => {
      reached.length = 0;
      const answer = await post(path, body, headers);
      expect(answer.status, path + " " + store).toBe(200);
      // That Store's own API answered, with the bytes exactly as they were sent.
      expect(reached, path + " " + store).toEqual([{ store, path, body }]);
    };

    // 1. The one-time order link: the Store whose records hold it, with or without a guest cookie.
    const link = "/api/v1/customer/order-recovery";
    const guest = {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    for (const n of [2, 1])
      await expectReached(link, JSON.stringify({ token: linkOf(n) }), guest, "store-" + n);
    // A link no Store issued: the installation's own first Store answers it on its own budget.
    await expectReached(link, JSON.stringify({ token: "Z".repeat(43) }), guest, "store-1");

    // 2. SES feedback: signature first, then the signed topic names the Store.
    const sns = (fields) => {
      const pairs = [
        "Message",
        "MessageId",
        "SubscribeURL",
        "Timestamp",
        "Token",
        "TopicArn",
        "Type",
      ]
        .filter((key) => fields[key] !== undefined)
        .map((key) => key + "\n" + fields[key] + "\n")
        .join("");
      const signer = createSign("RSA-SHA256");
      signer.update(pairs);
      return JSON.stringify({
        ...fields,
        SignatureVersion: "2",
        Signature: signer.sign(privateKey, "base64"),
        SigningCertURL:
          "https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-" +
          "a".repeat(32) +
          ".pem",
      });
    };
    const bounce = (topic, set) =>
      sns({
        Type: "Notification",
        MessageId: "018faa00-0000-4000-8000-000000000001",
        TopicArn: topic,
        Message: JSON.stringify({
          eventType: "Bounce",
          mail: {
            messageId: "synthetic-provider-message-1",
            timestamp: "2026-11-19T11:59:00.000Z",
            destination: ["synthetic-recipient@example.test"],
            tags: { "ses:configuration-set": [set] },
          },
          bounce: { bounceType: "Permanent" },
        }),
        Timestamp: "2026-11-19T12:00:00.000Z",
      });
    const feedback = "/api/v1/provider/ses-feedback";
    const snsHeaders = (type) => ({
      "content-type": "text/plain; charset=UTF-8",
      "x-amz-sns-message-type": type,
    });
    await expectReached(
      feedback,
      bounce(topicOf(2), "store-2"),
      snsHeaders("Notification"),
      "store-2",
    );
    await expectReached(
      feedback,
      sns({
        Type: "SubscriptionConfirmation",
        MessageId: "018faa00-0000-4000-8000-000000000002",
        TopicArn: topicOf(1),
        Message: "You have chosen to subscribe.",
        Timestamp: "2026-11-19T12:00:00.000Z",
        Token: "T".repeat(43),
        SubscribeURL: "https://sns.ca-central-1.amazonaws.com/?Action=ConfirmSubscription",
      }),
      snsHeaders("SubscriptionConfirmation"),
      "store-1",
    );
    // Verified, but no served Store subscribes this topic: acknowledged, logged, nothing reached.
    reached.length = 0;
    const stranger = await post(
      feedback,
      bounce("arn:aws:sns:ca-central-1:999999999999:someone-else", "store-1"),
      snsHeaders("Notification"),
    );
    expect([stranger.status, JSON.parse(stranger.text)]).toEqual([200, { outcome: "Ignored" }]);
    // Forged (signed for another topic): refused before any Store is chosen.
    const forged = JSON.parse(bounce(topicOf(1), "store-1"));
    const refused = await post(
      feedback,
      JSON.stringify({ ...forged, TopicArn: topicOf(2) }),
      snsHeaders("Notification"),
    );
    expect([refused.status, JSON.parse(refused.text)]).toEqual([403, { outcome: "rejected" }]);
    expect(reached).toEqual([]);

    // 3. The Stripe webhook: the Store whose own account's endpoint secret signed it.
    const webhook = "/api/v1/payment-provider/stripe/webhook";
    const event = JSON.stringify({
      id: "evt_SYNTHETIC",
      object: "event",
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "pi_SYNTHETIC", object: "payment_intent", metadata: {} } },
    });
    const signed = (secret) => {
      const t = Math.floor(Date.now() / 1000);
      return {
        "content-type": "application/json",
        "stripe-signature":
          "t=" +
          t +
          ",v1=" +
          createHmac("sha256", secret)
            .update(t + "." + event)
            .digest("hex"),
      };
    };
    for (const n of [2, 1]) await expectReached(webhook, event, signed(secretOf(n)), "store-" + n);
    reached.length = 0;
    const unsigned = await post(webhook, event, signed("whsec_" + randomBytes(16).toString("hex")));
    expect(unsigned.status).toBe(400);
    expect(JSON.parse(unsigned.text).error.code).toBe("webhook_rejected");
    expect(reached).toEqual([]);

    // Level 40 with a code, never a token, signature, topic or body.
    const logged = lines.filter((line) => line.includes("customer_callback_routing"));
    expect(
      logged
        .map((line) => JSON.parse(line))
        .map(({ level, code, provider, reason }) => ({
          level,
          code,
          provider,
          reason,
        })),
    ).toEqual([
      { level: 40, code: "PILOT_CALLBACK_UNCLAIMED", provider: "ses", reason: "NoStore" },
      {
        level: 40,
        code: "PILOT_CALLBACK_REFUSED",
        provider: "ses",
        reason: "SES_SNS_SIGNATURE_INVALID",
      },
      { level: 40, code: "PILOT_CALLBACK_REFUSED", provider: "stripe", reason: "NoStoreSecret" },
    ]);
    for (const line of logged)
      for (const secret of [linkOf(1), "someone-else", "v1=", "synthetic-recipient", "whsec_"])
        expect(line).not.toContain(secret);
  } finally {
    log.mockRestore();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    for (const upstream of apis) await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// WP-2423 batch 35 (v15 b34 live): at an installation of several merchants a malformed order link,
// or one asked while a Store's records can't be read, was answered without any Store's per-address
// budget being spent, so guessing links there was not limited as at one Store.
test("batch 35: guessing order links at two merchants spends the same per-address budget", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await mkdtemp(join(tmpdir(), "bop-link-budget-"));
  const { createTestCertificates } = await import("./pilot-test-certificates.mjs");
  const { createServer } = await import("node:http");
  const { createApp } = await import("../../apps/api/dist/app.js");
  const { createCustomerOrderRecoveryHandler } =
    await import("../../apps/api/dist/customer-order-messaging-http.js");
  const {
    createGuestSessionCredentialProvider,
    createOrderRecoveryService,
    createOrderRecoveryTokenHasher,
  } = await import("../../packages/bop/identity/src/index.ts");
  const certificates = await createTestCertificates(directory, { hostname: "localhost" });
  const origin = "https://localhost";
  const id = (n) => "0190aa21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  // Each merchant's own Identity order-link service: its own pepper, its own records and its own
  // per-address budget (§87.4.2: 5 an hour per Order or, with no Order, per address).
  const merchants = [1, 2].map((n) => {
    const records = [];
    const buckets = new Map();
    const spent = [];
    let next = 100 * n;
    const service = createOrderRecoveryService({
      hasher: createOrderRecoveryTokenHasher([{ version: 1, key: new Uint8Array(32).fill(n) }]),
      store: {
        appendAuthorization: async (input) => (records.push(input), "Created"),
        peekOrder: async ({ candidates }) =>
          records.find((r) => candidates.some((c) => c.tokenHash === r.tokenHash))
            ?.orderReference ?? null,
        consumeAndRekey: async ({ candidates }) => {
          const found = records.find(
            (r) => !r.consumed && candidates.some((c) => c.tokenHash === r.tokenHash),
          );
          if (found === undefined) return null;
          found.consumed = true;
          return { orderReference: found.orderReference };
        },
      },
      budget: {
        consume: async ({ orderReference, peerAddress }) => {
          const bucket = (orderReference ?? "unknown") + "|" + peerAddress;
          const count = (buckets.get(bucket) ?? 0) + 1;
          buckets.set(bucket, count);
          spent.push(bucket);
          return count <= 5
            ? { status: "Allowed" }
            : { status: "RateLimited", retryAfterSeconds: 1800 };
        },
      },
      credentials: createGuestSessionCredentialProvider(new Uint8Array(32).fill(10 + n)),
      references: { generate: () => id(next++) },
      clock: { now: () => new Date().toISOString() },
    });
    return { n, service, spent, unreadable: false };
  });
  const mint = (merchant) =>
    merchant.service.mint({
      orderReference: id(10 + merchant.n),
      guestSessionReference: id(20 + merchant.n),
      notificationAttemptReference: id(30 + merchant.n),
    });
  const links = [await mint(merchants[0]), await mint(merchants[1])].map((m) => m.token);
  // Each Store's real customer API answers the link (the same handler a single Store runs).
  const apis = [];
  for (const merchant of merchants) {
    const upstream = createServer(
      createApp({
        customerOrderRecovery: createCustomerOrderRecoveryHandler({
          allowedOrigin: origin,
          port: (input) => merchant.service.consume(input),
        }),
      }),
    );
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    apis.push(upstream);
  }
  const resourcesOf = (merchant) => ({
    scope: { storeReference: id(merchant.n), brandReference: id(40 + merchant.n) },
    publicProfile: {
      // Two merchants: two Tenants.
      binding: { tenantReference: id(50 + merchant.n), publicStoreReference: id(60 + merchant.n) },
    },
    credentials: { sessions: { hashCredential: () => "selector" }, reference: () => "unused" },
    transactions: {},
    now: () => new Date().toISOString(),
    orderMessaging: {
      issuedOrderLink: async (token) => {
        if (merchant.unreadable) throw new Error("records unreadable");
        return merchant.service.issued(token);
      },
      spendOrderLinkAttempt: (input) => merchant.service.spendUnclaimed(input),
      feedbackRoute: null,
    },
    close: vi.fn(async () => undefined),
  });
  const stack = {
    createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
    createInternalCustomerEntry: async () => ({ dining: {} }),
    createInternalTestItems: async () => ({ catalogCartItems: [] }),
    createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
    createInternalOrder: async () => ({}),
    createInternalDiningCheckout: () => ({ preparation: {} }),
    createInternalChannelPayment: async () => ({}),
    createInternalPaymentTerminal: () => ({}),
  };
  const merchant = async () => ({
    staffSignInMode: "cognito",
    persistence: { transactions: {}, identity: { hasher: {} }, now: () => "" },
    bff: { exactOrigin: origin, acceptedHost: "localhost" },
  });
  let server;
  try {
    server = await startInternalCustomerServer({
      publicOrigin: origin,
      listenPort: 0,
      apiPort: apis[0].address().port,
      keyFile: certificates.keyFile,
      certificateFile: certificates.certificateFile,
      loadProfile: async () => ({ environment: "InternalTest" }),
      loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
      diningEntries: [],
      createInternalTestResources: async () => resourcesOf(merchants[0]),
      createInternalMerchant: merchant,
      ...stack,
      additionalStores: [
        {
          storeReference: id(2),
          apiPort: apis[1].address().port,
          customer: stack,
          createInternalTestResources: async () => resourcesOf(merchants[1]),
          createInternalMerchant: merchant,
        },
      ],
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const { request } = await import("node:https");
    const browser = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const post = (body, headers = browser) =>
      new Promise((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/v1/customer/order-recovery",
            method: "POST",
            servername: "localhost",
            ca: [certificates.root],
            headers: { host: "localhost", "content-length": Buffer.byteLength(body), ...headers },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                retryAfter: response.headers["retry-after"] ?? null,
                code: JSON.parse(text).error?.code ?? null,
              }),
            );
          },
        );
        call.on("error", reject);
        call.end(body);
      });
    const link = (token) => JSON.stringify({ token });
    const refused = { status: 400, retryAfter: null, code: "order_link_unavailable" };

    // A guest's own link opens at the merchant that sent it.
    expect((await post(link(links[1]))).status).toBe(200);

    // Five guesses of every kind a page could send, from one address: each one is refused the
    // same way and spends the first Store's budget for links no Order holds, as at one Store.
    const guesses = [
      link("Z".repeat(43)),
      link("short"),
      JSON.stringify({ token: "Y".repeat(43), extra: true }),
      link(7),
      link("X".repeat(43)),
    ];
    for (const body of guesses) expect(await post(body)).toEqual(refused);
    expect(merchants[0].spent).toEqual(Array(5).fill("unknown|127.0.0.1"));
    // Not JSON at all: the same budget (the Store's API names the parse failure, as at one Store).
    const notJson = await post("{not json");
    expect([notJson.status, notJson.retryAfter]).toEqual([429, "1800"]);
    expect(notJson.code).toBe("order_link_rate_limited");
    // Spent: every further guess, of any kind, is told to wait, with when.
    for (const body of [link("W".repeat(43)), link("short")])
      expect(await post(body)).toEqual({
        status: 429,
        retryAfter: "1800",
        code: "order_link_rate_limited",
      });
    // While another merchant's records can't be read, the answer is a retry, but a guess there
    // still spends the budget: once spent it is told to wait, never an unlimited "try again".
    merchants[1].unreadable = true;
    expect(await post(link("V".repeat(43)))).toEqual({
      status: 429,
      retryAfter: "1800",
      code: "order_link_rate_limited",
    });
    merchants[1].unreadable = false;
    // The second merchant's budget is its own: guesses never reached or spent it.
    expect(merchants[1].spent).toEqual(["0190aa21-0000-7000-8000-00000000000c|127.0.0.1"]);
    // A guest's own link from the same address still opens (its Order's own bucket, as at one Store).
    expect((await post(link(links[0]))).status).toBe(200);
    // A request a browser page of another site could send never asks any Store, spends nothing.
    const before = merchants[0].spent.length;
    expect(await post(link("U".repeat(43)), { "content-type": "application/json" })).toEqual(
      refused,
    );
    expect(merchants[0].spent.length).toBe(before);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    for (const upstream of apis) await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
