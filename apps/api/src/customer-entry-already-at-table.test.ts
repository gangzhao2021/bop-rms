import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GuestSession } from "@bop/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  CustomerEntryHandler,
  type CustomerEntryPort,
  type CustomerEntryPortInput,
  type CustomerEntryPortResult,
  type CustomerEntryPresentedTable,
} from "./customer-entry.js";
import { createCustomerEntryComposition } from "./customer-entry-composition.js";
import { createCustomerEntryPresentedTable } from "./customer-entry-presented-table.js";
import { fixture, id } from "../test-support/customer-entry-composition-fixture.js";

// WP-2423 shared-table-checkout (b): a phone already seated at a table that scans the same table
// code again is told it is already there. It never becomes a second participant whose cart lines
// nobody holds (live guest-cart-checkout minor). Anything else is an ordinary entry, as before.

const ORIGIN = "https://customer.example.test";
const STORE = "018f0000-0000-7000-8000-000000000101";
const TABLE = "018f0000-0000-7000-8000-000000000102";
const COOKIE = "K".repeat(43);
const TOKEN = [
  Buffer.from('{"alg":"ES256","kid":"synthetic"}').toString("base64url"),
  Buffer.from('{"synthetic":true}').toString("base64url"),
  Buffer.alloc(64, 7).toString("base64url"),
].join(".");
const references = () => {
  let n = 0x200;
  return () => `018f0000-0000-7000-8000-${(n++).toString(16).padStart(12, "0")}`;
};
const seated: CustomerEntryPresentedTable = Object.freeze({
  publicStoreReference: STORE,
  publicTableReference: TABLE,
  qrReference: "018f0000-0000-7000-8000-000000000103",
  qrRevocationVersion: 1,
});

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

async function listen(handler: CustomerEntryHandler): Promise<number> {
  const server = createServer(createApp({ customerEntry: handler }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function post(port: number, cookie?: string) {
  return fetch(`http://127.0.0.1:${port}/bff/customer/entry`, {
    method: "POST",
    body: JSON.stringify({ qrToken: TOKEN }),
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
}

describe("Entry handler: a phone already at this table", () => {
  const already = {
    status: "AlreadyAtTable",
    brandDisplayName: "BOP Kitchen",
    storeDisplayName: "Synthetic Market Store",
    publicStoreReference: STORE,
    publicTableReference: TABLE,
    locale: "en-CA",
  } as const;

  it("passes the seated table of the presented cookie and answers 200 with no session cookie", async () => {
    const calls: CustomerEntryPortInput[] = [];
    const port: CustomerEntryPort = {
      establish: async (input) => {
        calls.push(input);
        return already as CustomerEntryPortResult;
      },
    };
    const presentedTable = vi.fn(async () => seated);
    const serverPort = await listen(
      new CustomerEntryHandler({
        allowedOrigin: ORIGIN,
        now: () => "2026-07-30T05:00:00.000Z",
        port,
        uuidV7Factory: references(),
        requestAdmission: { consume: async () => ({ status: "Allowed" }) },
        presentedTable,
      }),
    );
    const response = await post(serverPort, `__Host-bop-guest=${COOKIE}`);
    expect(response.status).toBe(200);
    expect(
      response.headers.getSetCookie().filter((value) => value.startsWith("__Host-bop-guest=")),
    ).toEqual([]);
    expect(await response.json()).toEqual({
      schemaVersion: 2,
      status: "AlreadyAtTable",
      brandDisplayName: "BOP Kitchen",
      storeDisplayName: "Synthetic Market Store",
      publicStoreReference: STORE,
      publicTableReference: TABLE,
      channel: "DineIn",
      locale: "en-CA",
    });
    expect(presentedTable).toHaveBeenCalledWith(COOKIE, "2026-07-30T05:00:00.000Z");
    expect(calls[0]?.presentedTable).toEqual(seated);
  });

  it.each([
    ["no cookie", undefined, async () => seated],
    ["a malformed cookie", "__Host-bop-guest=short", async () => seated],
    ["a session that is not seated", `__Host-bop-guest=${COOKIE}`, async () => null],
    [
      "a read that failed (outage)",
      `__Host-bop-guest=${COOKIE}`,
      async () => Promise.reject(new Error("db")),
    ],
  ])("with %s, the scan is an ordinary entry", async (_name, cookie, read) => {
    const calls: CustomerEntryPortInput[] = [];
    const serverPort = await listen(
      new CustomerEntryHandler({
        allowedOrigin: ORIGIN,
        now: () => "2026-07-30T05:00:00.000Z",
        port: {
          establish: async (input) => {
            calls.push(input);
            return { status: "EntryUnavailable" };
          },
        },
        uuidV7Factory: references(),
        requestAdmission: { consume: async () => ({ status: "Allowed" }) },
        presentedTable: read,
      }),
    );
    await post(serverPort, cookie);
    expect(calls).toHaveLength(1);
    expect(Object.hasOwn(calls[0] as object, "presentedTable")).toBe(false);
  });
});

describe("Entry composition: a re-scan of the table this phone is seated at", () => {
  const openTable = { isOpen: vi.fn(async () => true) };
  const presentedFor = (f: ReturnType<typeof fixture>): CustomerEntryPresentedTable => ({
    publicStoreReference: String(f.context.publicStoreReference),
    publicTableReference: String(f.context.publicTableReference),
    qrReference: String(f.payload.qrReference),
    qrRevocationVersion: f.context.revocationVersion,
  });

  it("answers AlreadyAtTable and creates no session and consumes no admission", async () => {
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: openTable,
    }).establish({ ...f.input(), presentedTable: presentedFor(f) });
    expect(result).toMatchObject({
      status: "AlreadyAtTable",
      publicTableReference: String(f.context.publicTableReference),
    });
    expect(Object.hasOwn(result, "sessionCredential")).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  });

  it.each([
    ["another table", { publicTableReference: id(90) }],
    ["a replaced code (newer revocation version)", { qrRevocationVersion: 2 }],
    ["another code", { qrReference: id(91) }],
    ["another Store", { publicStoreReference: id(92) }],
  ])("a session seated at %s joins as an ordinary entry", async (_name, change) => {
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: openTable,
    }).establish({ ...f.input(), presentedTable: { ...presentedFor(f), ...change } });
    expect(result.status).toBe("Established");
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("a guest starting a new party after them is never told they are already there", async () => {
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: openTable,
    }).establish({ ...f.input(), intent: "NewParty", presentedTable: presentedFor(f) });
    expect(result.status).toBe("Established");
  });
});

describe("The presented cookie's seated table", () => {
  const session = (changes: Partial<GuestSession> = {}) =>
    ({
      status: "Active",
      diningState: "DiningBound",
      channel: "DineIn",
      publicStoreReference: STORE,
      publicTableReference: TABLE,
      qrReference: seated.qrReference,
      qrRevocationVersion: 1,
      ...changes,
    }) as unknown as GuestSession;

  it("is read in the background (no idle renewal) and gives the table facts only", async () => {
    const resolve = vi.fn(async () => session());
    const read = createCustomerEntryPresentedTable({ resolve });
    expect(await read(COOKIE, "2026-07-30T05:00:00.000Z")).toEqual(seated);
    expect(resolve).toHaveBeenCalledWith({
      sessionCredential: COOKIE,
      activity: "Background",
      observedAt: "2026-07-30T05:00:00.000Z",
    });
  });

  it.each([
    ["context only (not yet at the table)", { diningState: "ContextOnly" }],
    ["pickup", { channel: "Pickup", publicTableReference: null }],
  ] as const)("is none for a session that is %s", async (_name, change) => {
    const read = createCustomerEntryPresentedTable({
      resolve: async () => session(change as Partial<GuestSession>),
    });
    expect(await read(COOKIE, "2026-07-30T05:00:00.000Z")).toBeNull();
  });

  it("is none for a phone staff removed (the binding check refuses its participant)", async () => {
    // The Dining binding query answers null for a participant that is not Active (Left), so the
    // Guest Session read throws GUEST_SESSION_UNAVAILABLE; the scan then joins as usual.
    const read = createCustomerEntryPresentedTable({
      resolve: async () => Promise.reject(new Error("GUEST_SESSION_UNAVAILABLE")),
    });
    expect(await read(COOKIE, "2026-07-30T05:00:00.000Z")).toBeNull();
  });
});
