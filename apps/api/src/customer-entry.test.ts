import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GuestRawCredential, GuestSessionCookieDescriptor } from "@bop/identity";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerEntryHandler,
  type CustomerEntryPort,
  type CustomerEntryPortInput,
  type CustomerEntryPortResult,
  type CustomerEntryRequestAdmission,
} from "./customer-entry.js";

const ORIGIN = "https://customer.example.test";
const STORE_REFERENCE = "018f0000-0000-7000-8000-000000000101";
const TABLE_REFERENCE = "018f0000-0000-7000-8000-000000000102";
const ENTRY_REFERENCE = "018f0000-0000-7000-8000-000000000103";
const OPERATION_REFERENCE = "018f0000-0000-7000-8000-000000000104";
const NEXT_ENTRY_REFERENCE = "018f0000-0000-7000-8000-000000000105";
const NEXT_OPERATION_REFERENCE = "018f0000-0000-7000-8000-000000000106";
const SESSION_CREDENTIAL = "S".repeat(43) as GuestRawCredential;
const CSRF_CREDENTIAL = "C".repeat(43) as GuestRawCredential;
const GUEST_SESSION_COOKIE: GuestSessionCookieDescriptor = Object.freeze({
  name: "__Host-bop-guest",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  domain: null,
});
const TOKEN = [
  Buffer.from('{"alg":"ES256","kid":"synthetic"}').toString("base64url"),
  Buffer.from('{"synthetic":true}').toString("base64url"),
  Buffer.alloc(64, 7).toString("base64url"),
].join(".");

const servers: Server[] = [];

afterEach(async () => {
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

function established(
  overrides: Partial<Extract<CustomerEntryPortResult, { status: "Established" }>> = {},
): Extract<CustomerEntryPortResult, { status: "Established" }> {
  return {
    status: "Established",
    brandDisplayName: "BOP Kitchen",
    storeDisplayName: "Synthetic Market Store",
    publicStoreReference: STORE_REFERENCE,
    publicTableReference: TABLE_REFERENCE,
    channel: "DineIn",
    operatingState: "Open",
    availableServiceModes: ["DineIn", "Pickup"],
    locale: "en-CA",
    contextExpiresAt: "2026-07-30T06:00:00.000Z",
    sessionCredential: SESSION_CREDENTIAL,
    csrfCredential: CSRF_CREDENTIAL,
    cookie: GUEST_SESSION_COOKIE,
    ...overrides,
  };
}

class MutablePort implements CustomerEntryPort {
  readonly calls: CustomerEntryPortInput[] = [];
  result: unknown = established();
  error: unknown;

  async establish(input: Readonly<CustomerEntryPortInput>): Promise<CustomerEntryPortResult> {
    this.calls.push({ ...input });
    if (this.error !== undefined) throw this.error;
    return this.result as CustomerEntryPortResult;
  }
}

function referenceFactory(): () => string {
  const references = [
    ENTRY_REFERENCE,
    OPERATION_REFERENCE,
    NEXT_ENTRY_REFERENCE,
    NEXT_OPERATION_REFERENCE,
  ];
  return () => {
    const reference = references.shift();
    if (reference === undefined) throw new Error("synthetic reference sequence exhausted");
    return reference;
  };
}

function customerEntry(
  port: MutablePort,
  uuidV7Factory = referenceFactory(),
  requestAdmission: CustomerEntryRequestAdmission | null = {
    consume: async () => ({ status: "Allowed" }),
  },
): CustomerEntryHandler {
  return new CustomerEntryHandler({
    ...(requestAdmission === null ? {} : { requestAdmission }),
    allowedOrigin: ORIGIN,
    now: () => "2026-07-30T05:00:00.000Z",
    port,
    uuidV7Factory,
  });
}

async function listen(handler?: CustomerEntryHandler): Promise<number> {
  const server = createServer(
    createApp({ ...(handler === undefined ? {} : { customerEntry: handler }) }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function requestHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: ORIGIN,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...overrides,
  };
}

async function post(
  port: number,
  body: unknown = { qrToken: TOKEN },
  headers = requestHeaders(),
  path = "/bff/customer/entry",
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

async function rawPost(
  port: number,
  headers: Record<string, string>,
  body = JSON.stringify({ qrToken: TOKEN }),
): Promise<{ body: unknown; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        host: "127.0.0.1",
        method: "POST",
        path: "/bff/customer/entry",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

/** The Guest Session cookies an answer sets (a visit), apart from the waiting-scan cookie. */
function visitCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith("__Host-bop-guest="));
}
const SCAN_COOKIE = `__Secure-bop-scan=${TOKEN}; Max-Age=1800; Path=/bff/customer/entry; Secure; HttpOnly; SameSite=Strict`;
const FORGET_SCAN =
  "__Secure-bop-scan=; Max-Age=0; Path=/bff/customer/entry; Secure; HttpOnly; SameSite=Strict";
const tableNotOpen = {
  status: "TableNotOpen",
  brandDisplayName: "BOP Kitchen",
  storeDisplayName: "Synthetic Market Store",
  publicStoreReference: STORE_REFERENCE,
  locale: "en-CA",
};

async function responseSnapshot(response: Response): Promise<{
  body: unknown;
  status: number;
}> {
  return { body: await response.json(), status: response.status };
}

describe("WP-1004 Customer-entry contract", () => {
  it("establishes the exact public context, fixed Guest Cookie and page-memory CSRF", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));

    const response = await post(serverPort);

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBe(
      `__Host-bop-guest=${SESSION_CREDENTIAL}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(await response.json()).toEqual({
      schemaVersion: 2,
      status: "Established",
      brandDisplayName: "BOP Kitchen",
      storeDisplayName: "Synthetic Market Store",
      publicStoreReference: STORE_REFERENCE,
      publicTableReference: TABLE_REFERENCE,
      channel: "DineIn",
      operatingState: "Open",
      availableServiceModes: ["DineIn", "Pickup"],
      locale: "en-CA",
      contextExpiresAt: "2026-07-30T06:00:00.000Z",
      csrfToken: CSRF_CREDENTIAL,
    });
    expect(port.calls).toEqual([
      {
        entryRequestReference: ENTRY_REFERENCE,
        operationReference: OPERATION_REFERENCE,
        qrToken: TOKEN,
        requestedAt: "2026-07-30T05:00:00.000Z",
      },
    ]);
  });

  it("says whether a party is seated at the scanned table, and only at a table", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    port.result = established({ tableOpen: false });
    const response = await post(serverPort);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { tableOpen?: unknown }).tableOpen).toBe(false);
    port.result = established({ tableOpen: true });
    expect(((await (await post(serverPort)).json()) as { tableOpen?: unknown }).tableOpen).toBe(
      true,
    );
    // A pickup code carries no table state; a malformed one is refused, not passed on.
    port.result = established({
      channel: "Pickup",
      publicTableReference: null,
      tableOpen: false,
    });
    expect((await post(serverPort)).status).toBe(503);
    port.result = established({ tableOpen: "no" as never });
    expect((await post(serverPort)).status).toBe(503);
  });

  it("sets no-store, non-index and referrer controls without CORS or retry invention", async () => {
    const response = await post(await listen(customerEntry(new MutablePort())));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("rejects Origin, Fetch Metadata and media-type failures before dependency access", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    const cases = [
      requestHeaders({ origin: "https://evil.example.test" }),
      requestHeaders({ origin: "null" }),
      requestHeaders({ "sec-fetch-site": "cross-site" }),
      requestHeaders({ "content-type": "text/plain" }),
    ];

    for (const headers of cases) {
      expect(await responseSnapshot(await post(serverPort, { qrToken: TOKEN }, headers))).toEqual({
        status: 400,
        body: {
          schemaVersion: 1,
          code: "entry_request_invalid",
          messageKey: "customer.entry.request_invalid",
          recovery: { action: "Rescan", storeSelection: "Hidden" },
        },
      });
    }
    expect(await rawPost(serverPort, requestHeaders({ "sec-fetch-mode": "navigate" }))).toEqual({
      status: 400,
      body: {
        schemaVersion: 1,
        code: "entry_request_invalid",
        messageKey: "customer.entry.request_invalid",
        recovery: { action: "Rescan", storeSelection: "Hidden" },
      },
    });
    expect(port.calls).toHaveLength(0);
  });

  it("rejects missing, extra, bounded and compact-framing body failures before the port", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    const invalidBodies = [
      {},
      { qrToken: TOKEN, storeReference: STORE_REFERENCE },
      { qrToken: "" },
      { qrToken: "x".repeat(2049) },
      { qrToken: "not-a-compact-token" },
      { qrToken: `a.b.${Buffer.alloc(63).toString("base64url")}` },
      { qrToken: 7 },
      ["qrToken", TOKEN],
    ];

    for (const body of invalidBodies) {
      const response = await post(serverPort, body);
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(port.calls).toHaveLength(0);
  });

  it("maps malformed and globally oversized JSON to the same closed request error", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    for (const body of [
      '{"qrToken":"unterminated"',
      JSON.stringify({ value: "x".repeat(70_000) }),
    ]) {
      expect(await rawPost(serverPort, requestHeaders(), body)).toEqual({
        status: 400,
        body: {
          schemaVersion: 1,
          code: "entry_request_invalid",
          messageKey: "customer.entry.request_invalid",
          recovery: { action: "Rescan", storeSelection: "Hidden" },
        },
      });
    }
    expect(port.calls).toHaveLength(0);
  });

  it("rejects prototype, accessor and symbol body shapes in the transport validator", async () => {
    const port = new MutablePort();
    const handler = customerEntry(port).handler();
    const bodies: unknown[] = [
      Object.assign(Object.create({ inherited: true }) as object, { qrToken: TOKEN }),
      Object.defineProperty({}, "qrToken", { enumerable: true, get: () => TOKEN }),
      { qrToken: TOKEN, [Symbol("hidden")]: true },
    ];

    for (const body of bodies) {
      let status = 0;
      let responseBody: unknown;
      const response = {
        setHeader: () => response,
        status: (value: number) => {
          status = value;
          return response;
        },
        json: (value: unknown) => {
          responseBody = value;
          return response;
        },
      };
      await handler(
        {
          body,
          originalUrl: "/bff/customer/entry",
          get: (name: string) => requestHeaders()[name.toLowerCase()],
          is: () => "application/json",
        } as never,
        response as never,
        (() => undefined) as never,
      );
      expect(status).toBe(400);
      expect(responseBody).toMatchObject({ code: "entry_request_invalid" });
    }
    expect(port.calls).toHaveLength(0);
  });

  it("maps every composition-denied cause to one non-oracular unavailable response", async () => {
    const snapshots: unknown[] = [];
    for (const syntheticCause of [
      "expired",
      "revoked",
      "bad-signature",
      "unknown-store",
      "copied",
      "abuse",
      "admission-denied",
    ]) {
      const port = new MutablePort();
      port.result = { status: "EntryUnavailable" };
      const response = await post(await listen(customerEntry(port)));
      const snapshot = await responseSnapshot(response);
      expect(JSON.stringify(snapshot)).not.toContain(syntheticCause);
      snapshots.push(snapshot);
    }
    for (const snapshot of snapshots) {
      expect(snapshot).toEqual({
        status: 422,
        body: {
          schemaVersion: 1,
          code: "entry_unavailable",
          messageKey: "customer.entry.unavailable",
          recovery: { action: "RescanOrAskStaff", storeSelection: "Hidden" },
        },
      });
    }
  });

  it("WP-2423 Q4: says a closed Store is not taking orders, with today's hours, and sets no cookie", async () => {
    const port = new MutablePort();
    port.result = {
      status: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      operatingState: "Closed",
      todayHours: [{ startLocalTime: "11:00:00", endLocalTime: "21:30:00", endsNextDay: false }],
      // Decision 16: a holiday today, and when the Store opens next.
      todayKind: "Holiday",
      nextOpening: { localDate: "2026-12-26", startLocalTime: "11:00:00" },
      localDate: "2026-12-25",
    };
    const response = await post(await listen(customerEntry(port)));
    expect(response.status).toBe(409);
    expect(visitCookies(response)).toEqual([]);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      code: "entry_not_accepting",
      messageKey: "customer.entry.not_accepting",
      recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
      store: {
        storeDisplayName: "Synthetic Store",
        operatingState: "Closed",
        todayHours: [{ startLocalTime: "11:00:00", endLocalTime: "21:30:00", endsNextDay: false }],
        todayKind: "Holiday",
        nextOpening: { localDate: "2026-12-26", startLocalTime: "11:00:00" },
        localDate: "2026-12-25",
      },
    });
    // WP-2423 item 13 ②: the platform paused this merchant's new guests; the page is told.
    port.result = { ...(port.result as object), newGuestsPaused: true };
    expect(
      ((await (await post(await listen(customerEntry(port)))).json()) as { store: unknown }).store,
    ).toMatchObject({
      newGuestsPaused: true,
    });
    port.result = { ...(port.result as object), newGuestsPaused: false };
    expect((await post(await listen(customerEntry(port)))).status).toBe(503);
    port.result = { ...(port.result as object), storeDisplayName: "<script>" };
    expect((await post(await listen(customerEntry(port)))).status).toBe(503);
  });

  it("WP-2423 item 8 ⑦ 1b: says the Store takes dine-in orders only, and sets no cookie", async () => {
    const port = new MutablePort();
    port.result = { status: "ServiceNotOffered", storeDisplayName: "Synthetic Store" };
    const response = await post(await listen(customerEntry(port)));
    expect(response.status).toBe(409);
    expect(visitCookies(response)).toEqual([]);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      code: "entry_service_not_offered",
      messageKey: "customer.entry.pickup_not_offered",
      recovery: { action: "AskStaff", storeSelection: "Hidden" },
      store: { storeDisplayName: "Synthetic Store" },
    });
    port.result = { status: "ServiceNotOffered", storeDisplayName: "<script>" };
    expect((await post(await listen(customerEntry(port)))).status).toBe(503);
  });

  it("a table no party is seated at starts no visit (no cookie) and gives the menu's public context", async () => {
    const port = new MutablePort();
    port.result = {
      status: "TableNotOpen",
      brandDisplayName: "BOP Kitchen",
      storeDisplayName: "Synthetic Market Store",
      publicStoreReference: STORE_REFERENCE,
      locale: "en-CA",
    };
    const response = await post(await listen(customerEntry(port)));
    expect(response.status).toBe(409);
    expect(visitCookies(response)).toEqual([]);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      code: "entry_table_not_open",
      messageKey: "customer.entry.table_not_open",
      recovery: { action: "AskStaff", storeSelection: "Hidden" },
      store: {
        brandDisplayName: "BOP Kitchen",
        storeDisplayName: "Synthetic Market Store",
        publicStoreReference: STORE_REFERENCE,
        locale: "en-CA",
      },
    });
    port.result = { ...(port.result as object), storeDisplayName: "<script>" };
    expect((await post(await listen(customerEntry(port)))).status).toBe(503);
  });

  it.each([
    ["TableMayStart", "entry_table_may_start", "customer.entry.table_may_start", "StartTable"],
    [
      "TableBeingCleaned",
      "entry_table_being_cleaned",
      "customer.entry.table_being_cleaned",
      "AskStaff",
    ],
    [
      "TableAskNewParty",
      "entry_table_ask_new_party",
      "customer.entry.table_ask_new_party",
      "AnswerNewParty",
    ],
  ])(
    "DEC-DINING-GUEST-TABLE-START: %s starts no visit (no cookie) and answers with its own code",
    async (status, code, messageKey, action) => {
      const port = new MutablePort();
      port.result = {
        status,
        brandDisplayName: "BOP Kitchen",
        storeDisplayName: "Synthetic Market Store",
        publicStoreReference: STORE_REFERENCE,
        locale: "en-CA",
      } as never;
      const response = await post(await listen(customerEntry(port)));
      expect(response.status).toBe(409);
      expect(visitCookies(response)).toEqual([]);
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        code,
        messageKey,
        recovery: { action, storeSelection: "Hidden" },
        store: {
          brandDisplayName: "BOP Kitchen",
          storeDisplayName: "Synthetic Market Store",
          publicStoreReference: STORE_REFERENCE,
          locale: "en-CA",
        },
      });
    },
  );

  it("WP-2423 Q11: tells a guest with a replaced or turned-off table code to ask staff, with no cookie", async () => {
    const port = new MutablePort();
    for (const [reason, messageKey] of [
      ["Replaced", "customer.entry.qr_replaced"],
      ["TurnedOff", "customer.entry.qr_turned_off"],
    ] as const) {
      port.result = { status: "QrRetired", reason };
      const response = await post(await listen(customerEntry(port)));
      expect(response.status).toBe(410);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        code: "entry_qr_retired",
        messageKey,
        recovery: { action: "AskStaff", storeSelection: "Hidden" },
      });
    }
    port.result = { status: "QrRetired", reason: "Stolen" };
    expect((await post(await listen(customerEntry(port)))).status).toBe(503);
  });

  it("maps a strict port InvalidRequest without reflecting the QR", async () => {
    const port = new MutablePort();
    port.result = { status: "InvalidRequest" };
    const response = await post(await listen(customerEntry(port)));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(400);
    expect(serialized).toContain("entry_request_invalid");
    expect(serialized).not.toContain(TOKEN);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("maps dependency exceptions and malformed closed results to one bounded 503", async () => {
    const snapshots: unknown[] = [];
    const malformedResults: unknown[] = [
      { status: "EntryUnavailable", reason: "database-secret" },
      { status: "Unknown" },
      { ...established(), internalStoreReference: "internal-secret" },
      { ...established(), cookie: { ...GUEST_SESSION_COOKIE, secure: false } },
      { ...established(), contextExpiresAt: "2026-07-30T04:00:00.000Z" },
      { ...established(), brandDisplayName: "<script>" },
      { ...established(), storeDisplayName: " Synthetic Store " },
      { ...established(), operatingState: "Closed" },
      { ...established(), availableServiceModes: ["DineIn", "DineIn"] },
      { ...established(), availableServiceModes: ["Pickup"] },
      Object.assign(Object.create({ inherited: true }) as object, established()),
      Object.defineProperty({}, "status", { get: () => "Established" }),
      { ...established(), [Symbol("hidden")]: true },
    ];
    for (const result of malformedResults) {
      const port = new MutablePort();
      port.result = result;
      snapshots.push(await responseSnapshot(await post(await listen(customerEntry(port)))));
    }
    const throwingPort = new MutablePort();
    throwingPort.error = new Error("upstream-provider-secret");
    snapshots.push(await responseSnapshot(await post(await listen(customerEntry(throwingPort)))));

    for (const snapshot of snapshots) {
      expect(snapshot).toEqual({
        status: 503,
        body: {
          schemaVersion: 1,
          code: "entry_service_unavailable",
          messageKey: "customer.entry.service_unavailable",
          recovery: { action: "RetryOrAskStaff", storeSelection: "Hidden" },
        },
      });
      expect(JSON.stringify(snapshot)).not.toContain("secret");
    }
  });

  it("fails closed when the Customer-entry port is absent", async () => {
    const response = await post(await listen());

    expect(await responseSnapshot(response)).toEqual({
      status: 503,
      body: {
        schemaVersion: 1,
        code: "entry_service_unavailable",
        messageKey: "customer.entry.service_unavailable",
        recovery: { action: "RetryOrAskStaff", storeSelection: "Hidden" },
      },
    });
  });

  it("does not accept GET, query, path or OPTIONS token transports", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    for (const [path, init] of [
      [`/bff/customer/entry?qrToken=${encodeURIComponent(TOKEN)}`, { method: "POST" }],
      [`/bff/customer/entry/${encodeURIComponent(TOKEN)}`, { method: "POST" }],
      ["/bff/customer/entry", { method: "GET" }],
      ["/bff/customer/entry", { method: "OPTIONS" }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
        ...init,
        headers: requestHeaders(),
      });
      expect(response.status).not.toBe(201);
    }
    expect(port.calls).toHaveLength(0);
  });

  it("ignores existing Cookie/fixation fields and creates fresh server references per attempt", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    const hostileHeaders = requestHeaders({
      cookie: `__Host-bop-guest=${"X".repeat(43)}`,
      "x-operation-reference": STORE_REFERENCE,
    });

    expect((await post(serverPort, { qrToken: TOKEN }, hostileHeaders)).status).toBe(201);
    expect((await post(serverPort, { qrToken: TOKEN }, hostileHeaders)).status).toBe(201);
    expect(port.calls.map(({ entryRequestReference }) => entryRequestReference)).toEqual([
      ENTRY_REFERENCE,
      NEXT_ENTRY_REFERENCE,
    ]);
    expect(port.calls.map(({ operationReference }) => operationReference)).toEqual([
      OPERATION_REFERENCE,
      NEXT_OPERATION_REFERENCE,
    ]);
    expect(JSON.stringify(port.calls)).not.toContain("x-operation-reference");
    // M104/M105: the phone's own visit cookie is passed on, only as the visit it presents.
    expect(port.calls.map((call) => call.presentedCredentials)).toEqual([
      [{ source: "Current", credential: "X".repeat(43) }],
      [{ source: "Current", credential: "X".repeat(43) }],
    ]);
  });

  it("fails closed for malformed or reused server reference generation", async () => {
    for (const uuidV7Factory of [() => "not-a-reference", () => ENTRY_REFERENCE]) {
      const port = new MutablePort();
      const response = await post(await listen(customerEntry(port, uuidV7Factory)));
      expect(response.status).toBe(503);
      expect(port.calls).toHaveLength(0);
    }
  });

  it("supports Pickup only with no public Table context", async () => {
    const port = new MutablePort();
    port.result = established({
      channel: "Pickup",
      publicTableReference: null,
    });

    const response = await post(await listen(customerEntry(port)));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      channel: "Pickup",
      publicTableReference: null,
    });
  });
});

describe("Customer entry request admission", () => {
  it("returns generic429 before creating Guest and never issues a cookie", async () => {
    const port = new MutablePort();
    const response = await post(
      await listen(
        customerEntry(port, referenceFactory(), {
          consume: async () => ({ status: "RateLimited", retryAfterSeconds: 37 }),
        }),
      ),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      code: "entry_rate_limited",
      messageKey: "customer.entry.rate_limited",
      recovery: { action: "RetryOrAskStaff", storeSelection: "Hidden" },
    });
    expect(port.calls).toHaveLength(0);
  });
  it("fails closed for absent, unavailable, failing or malformed admission", async () => {
    const admissions: (CustomerEntryRequestAdmission | null)[] = [
      null,
      { consume: async () => ({ status: "Unavailable" }) },
      {
        consume: async () => {
          throw new Error("private limiter detail");
        },
      },
      { consume: async () => ({ status: "RateLimited", retryAfterSeconds: 0 }) },
      { consume: async () => ({ status: "RateLimited", retryAfterSeconds: 86401 }) },
    ];
    for (const admission of admissions) {
      const port = new MutablePort();
      const response = await post(await listen(customerEntry(port, referenceFactory(), admission)));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "entry_service_unavailable" });
      expect(port.calls).toHaveLength(0);
    }
  });
  it("WP-2423: behind the entry only its own header names the guest; loopback never does", async () => {
    const inputs: unknown[] = [];
    await post(
      await listen(
        customerEntry(new MutablePort(), referenceFactory(), {
          consume: async (input) => {
            inputs.push(input);
            return { status: "Allowed" };
          },
        }),
      ),
      { qrToken: TOKEN },
      requestHeaders({ "x-bop-client-address": "198.51.100.20" }),
    );
    expect(inputs).toEqual([
      { remoteAddress: "198.51.100.20", requestedAt: "2026-07-30T05:00:00.000Z" },
    ]);
  });
  it("passes only direct peer address and server time, ignoring forged forwarding headers", async () => {
    const inputs: unknown[] = [];
    const port = new MutablePort();
    const response = await post(
      await listen(
        customerEntry(port, referenceFactory(), {
          consume: async (input) => {
            inputs.push(input);
            return { status: "Allowed" };
          },
        }),
      ),
      { qrToken: TOKEN },
      requestHeaders({
        "x-forwarded-for": "203.0.113.99",
        forwarded: "for=203.0.113.99",
      }),
    );
    expect(response.status).toBe(201);
    expect(inputs).toEqual([{ remoteAddress: null, requestedAt: "2026-07-30T05:00:00.000Z" }]);
    expect(port.calls).toHaveLength(1);
  });
});

// M02 (v15 07b7a1b7): a reload lost the table or Store a guest scanned (the code leaves the
// address bar), and the app then opened the installation's first Store instead.
describe("M02 waiting scan: a reload asks the same Store about the same code", () => {
  it.each([
    ["TableNotOpen", tableNotOpen],
    ["TableMayStart", { ...tableNotOpen, status: "TableMayStart" }],
    ["TableAskNewParty", { ...tableNotOpen, status: "TableAskNewParty" }],
    ["TableBeingCleaned", { ...tableNotOpen, status: "TableBeingCleaned" }],
    ["ServiceNotOffered", { status: "ServiceNotOffered", storeDisplayName: "Synthetic Store" }],
    [
      "NotAccepting",
      {
        status: "NotAccepting",
        storeDisplayName: "Synthetic Store",
        operatingState: "Closed",
        todayHours: [],
        todayKind: null,
        nextOpening: null,
        localDate: null,
      },
    ],
  ])(
    "%s starts no visit and remembers the scanned code for the entry route only",
    async (_, result) => {
      const port = new MutablePort();
      port.result = result;
      const response = await post(await listen(customerEntry(port)));
      expect(response.status).toBe(409);
      expect(response.headers.getSetCookie()).toEqual([SCAN_COOKIE]);
    },
  );

  it("`{resume:true}` replays the remembered code, with the guest's answer, through the normal entry", async () => {
    const port = new MutablePort();
    port.result = tableNotOpen;
    const admitted: unknown[] = [];
    const serverPort = await listen(
      customerEntry(port, referenceFactory(), {
        consume: async (input) => {
          admitted.push(input);
          return { status: "Allowed" };
        },
      }),
    );
    const cookie = requestHeaders({ cookie: `other=1; __Secure-bop-scan=${TOKEN}` });
    const waiting = await post(serverPort, { resume: true }, cookie);
    expect(waiting.status).toBe(409);
    expect(((await waiting.json()) as { code: string }).code).toBe("entry_table_not_open");
    expect(waiting.headers.getSetCookie()).toEqual([SCAN_COOKIE]);
    // Staff opened the table: the same replay starts the visit there, and the scan is forgotten
    // on the same answer as the new visit's cookie (two Set-Cookie headers, neither overwritten).
    port.result = established();
    const opened = await post(serverPort, { resume: true, intent: "Join" }, cookie);
    expect(opened.status).toBe(201);
    expect(opened.headers.getSetCookie()).toEqual([
      `__Host-bop-guest=${SESSION_CREDENTIAL}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
      FORGET_SCAN,
    ]);
    expect(port.calls.map(({ qrToken, intent }) => ({ qrToken, intent }))).toEqual([
      { qrToken: TOKEN, intent: undefined },
      { qrToken: TOKEN, intent: "Join" },
    ]);
    // Each replay is an entry attempt like any other (the same budget).
    expect(admitted).toHaveLength(2);
  });

  it("a fresh scan's visit also forgets an older waiting scan; none sent, none forgotten", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    const fresh = await post(
      serverPort,
      { qrToken: TOKEN },
      requestHeaders({ cookie: `__Secure-bop-scan=${TOKEN}` }),
    );
    expect(fresh.headers.getSetCookie()).toEqual([
      `__Host-bop-guest=${SESSION_CREDENTIAL}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
      FORGET_SCAN,
    ]);
    expect((await post(serverPort)).headers.getSetCookie()).toHaveLength(1);
  });

  it("a retired code is forgotten; a refusal, a busy Store or a limit keeps the scan", async () => {
    const port = new MutablePort();
    const cookie = requestHeaders({ cookie: `__Secure-bop-scan=${TOKEN}` });
    port.result = { status: "QrRetired", reason: "Replaced" };
    const retired = await post(await listen(customerEntry(port)), { resume: true }, cookie);
    expect(retired.status).toBe(410);
    expect(retired.headers.getSetCookie()).toEqual([FORGET_SCAN]);
    for (const result of [{ status: "EntryUnavailable" }, { status: "InvalidRequest" }]) {
      port.result = result;
      const refused = await post(await listen(customerEntry(port)), { resume: true }, cookie);
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    const limited = await post(
      await listen(
        customerEntry(port, referenceFactory(), {
          consume: async () => ({ status: "RateLimited", retryAfterSeconds: 30 }),
        }),
      ),
      { resume: true },
      cookie,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.getSetCookie()).toEqual([]);
  });

  it("with no remembered scan the guest is asked to scan, before any budget or Store is used", async () => {
    const port = new MutablePort();
    let admissions = 0;
    const serverPort = await listen(
      customerEntry(port, referenceFactory(), {
        consume: async () => {
          admissions += 1;
          return { status: "Allowed" };
        },
      }),
    );
    for (const cookie of [
      undefined,
      "__Secure-bop-scan=not-a-code",
      `__Secure-bop-scan=${TOKEN}; __Secure-bop-scan=${TOKEN}`,
    ]) {
      const response = await post(
        serverPort,
        { resume: true },
        cookie === undefined ? requestHeaders() : requestHeaders({ cookie }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        code: "entry_scan_missing",
        messageKey: "customer.entry.scan_missing",
        recovery: { action: "Rescan", storeSelection: "Hidden" },
      });
    }
    expect(admissions).toBe(0);
    expect(port.calls).toEqual([]);
    // Only exactly `{resume:true}` (with an answer) is a replay.
    for (const body of [
      { resume: false },
      { resume: "true" },
      { resume: true, qrToken: TOKEN },
      { resume: true, intent: "Leave" },
    ])
      expect((await post(serverPort, body)).status).toBe(400);
  });

  it("never echoes the remembered code in an answer", async () => {
    const port = new MutablePort();
    port.error = new Error(TOKEN);
    const response = await post(
      await listen(customerEntry(port)),
      { resume: true },
      requestHeaders({ cookie: `__Secure-bop-scan=${TOKEN}` }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(TOKEN);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("M104/M105: a rescan goes on with this phone's visit", () => {
  const EARLIER = "E".repeat(43);
  const visits = (response: Response) =>
    response.headers.getSetCookie().filter((cookie) => cookie.startsWith("__Host-bop-visits="));

  it("passes the current and earlier visits (exact cookie names, well-formed only) to the port", async () => {
    const port = new MutablePort();
    const serverPort = await listen(customerEntry(port));
    await post(
      serverPort,
      { qrToken: TOKEN },
      requestHeaders({
        cookie: `__Host-bop-guest-x=${"Y".repeat(43)}; __Host-bop-guest=${SESSION_CREDENTIAL}; __Host-bop-visits=${EARLIER}.bad.${"F".repeat(43)}.${"G".repeat(43)}`,
      }),
    );
    expect(port.calls[0]?.presentedCredentials).toEqual([
      { source: "Current", credential: SESSION_CREDENTIAL },
      { source: "Earlier", credential: EARLIER },
    ]);
  });

  it("a resumed current visit answers 200 and sets no visit cookie", async () => {
    const port = new MutablePort();
    port.result = established({
      channel: "Pickup",
      publicTableReference: null,
      resumed: true,
      earlierCredentials: [],
    });
    const response = await post(
      await listen(customerEntry(port)),
      { qrToken: TOKEN },
      requestHeaders({ cookie: `__Host-bop-guest=${SESSION_CREDENTIAL}` }),
    );
    expect(response.status).toBe(200);
    expect(visitCookies(response)).toEqual([]);
    expect(visits(response)).toEqual([]);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "Established",
      resumed: true,
      csrfToken: CSRF_CREDENTIAL,
    });
    expect(JSON.stringify(body)).not.toContain(SESSION_CREDENTIAL);
  });

  it("going back to an earlier visit swaps the cookies and keeps the replaced one", async () => {
    const port = new MutablePort();
    port.result = established({
      channel: "Pickup",
      publicTableReference: null,
      sessionCredential: EARLIER as GuestRawCredential,
      resumed: true,
      earlierCredentials: [SESSION_CREDENTIAL],
    });
    const response = await post(
      await listen(customerEntry(port)),
      { qrToken: TOKEN },
      requestHeaders({
        cookie: `__Host-bop-guest=${SESSION_CREDENTIAL}; __Host-bop-visits=${EARLIER}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(visitCookies(response)).toEqual([
      `__Host-bop-guest=${EARLIER}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
    ]);
    expect(visits(response)).toEqual([
      `__Host-bop-visits=${SESSION_CREDENTIAL}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Strict`,
    ]);
  });

  it("a new visit keeps the replaced one and says an earlier visit here ended", async () => {
    const port = new MutablePort();
    port.result = established({
      channel: "Pickup",
      publicTableReference: null,
      sessionCredential: "N".repeat(43) as GuestRawCredential,
      earlierCredentials: [SESSION_CREDENTIAL],
      previousVisit: "EndedReceiptsKept",
    });
    const response = await post(
      await listen(customerEntry(port)),
      { qrToken: TOKEN },
      requestHeaders({ cookie: `__Host-bop-guest=${SESSION_CREDENTIAL}` }),
    );
    expect(response.status).toBe(201);
    expect(visits(response)).toEqual([
      `__Host-bop-visits=${SESSION_CREDENTIAL}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Strict`,
    ]);
    expect(await response.json()).toMatchObject({ previousVisit: "EndedReceiptsKept" });
  });

  it("refuses a port answer that resumes a table visit or keeps too many visits", async () => {
    for (const result of [
      established({ resumed: true }),
      established({ earlierCredentials: ["A".repeat(43), "B".repeat(43), "C".repeat(43)] }),
      established({ earlierCredentials: ["short"] }),
    ]) {
      const port = new MutablePort();
      port.result = result;
      expect((await post(await listen(customerEntry(port)))).status).toBe(503);
    }
  });
});
