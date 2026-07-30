import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { guestSessionCookie, type GuestRawCredential } from "@bop/identity";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerEntryHandler,
  type CustomerEntryPort,
  type CustomerEntryPortInput,
  type CustomerEntryPortResult,
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
    publicStoreReference: STORE_REFERENCE,
    publicTableReference: TABLE_REFERENCE,
    channel: "DineIn",
    locale: "en-CA",
    contextExpiresAt: "2026-07-30T06:00:00.000Z",
    sessionCredential: SESSION_CREDENTIAL,
    csrfCredential: CSRF_CREDENTIAL,
    cookie: guestSessionCookie,
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
): CustomerEntryHandler {
  return new CustomerEntryHandler({
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
      `__Host-bop-guest=${SESSION_CREDENTIAL}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      status: "Established",
      publicStoreReference: STORE_REFERENCE,
      publicTableReference: TABLE_REFERENCE,
      channel: "DineIn",
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
      { ...established(), cookie: { ...guestSessionCookie, secure: false } },
      { ...established(), contextExpiresAt: "2026-07-30T04:00:00.000Z" },
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
    expect(JSON.stringify(port.calls)).not.toContain("X".repeat(43));
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
