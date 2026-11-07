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
import {
  createCustomerEntryComposition,
  CustomerEntryServiceUnavailableError,
} from "./customer-entry-composition.js";
import {
  createCustomerEntryPresentedTable,
  diningSeatOf,
} from "./customer-entry-presented-table.js";
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
      "a read that threw",
      `__Host-bop-guest=${COOKIE}`,
      async () => Promise.reject(new Error("unexpected")),
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
    expect(Object.hasOwn(calls[0] as object, "presentedTableUnconfirmed")).toBe(false);
  });

  it("when Dining could not confirm the seat, the entry is told so and answers retry", async () => {
    const read = async () => ({ unconfirmed: seated });
    const calls: CustomerEntryPortInput[] = [];
    const serverPort = await listen(
      new CustomerEntryHandler({
        allowedOrigin: ORIGIN,
        now: () => "2026-07-30T05:00:00.000Z",
        port: {
          establish: async (input) => {
            calls.push(input);
            throw new CustomerEntryServiceUnavailableError();
          },
        },
        uuidV7Factory: references(),
        requestAdmission: { consume: async () => ({ status: "Allowed" }) },
        presentedTable: read,
      }),
    );
    const response = await post(serverPort, `__Host-bop-guest=${COOKIE}`);
    expect(calls[0]?.presentedTableUnconfirmed).toEqual(seated);
    expect(Object.hasOwn(calls[0] as object, "presentedTable")).toBe(false);
    // The ordinary store-busy answer: the guest is asked to try again.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "entry_service_unavailable",
      recovery: { action: "RetryOrAskStaff" },
    });
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

  it("a phone whose seat here could not be confirmed is asked to try again, never joined", async () => {
    // Joining would make a second participant for a phone that may be seated here, and with
    // joining by scan paused it would be told it is refused: the store is busy, try again.
    const f = fixture();
    const result = await createCustomerEntryComposition({
      ...f.options,
      table: openTable,
    })
      .establish({ ...f.input(), presentedTableUnconfirmed: presentedFor(f) })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CustomerEntryServiceUnavailableError);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
  });

  it.each([
    ["starts a new party there", { intent: "NewParty" as const }, () => openTable],
    ["scans a table nobody is seated at", {}, () => ({ isOpen: vi.fn(async () => false) })],
  ])(
    "a phone whose seat could not be confirmed that %s goes on as before",
    async (_n, extra, table) => {
      const plain = fixture();
      const before = await createCustomerEntryComposition({
        ...plain.options,
        table: table(),
      }).establish({ ...plain.input(), ...extra });
      const f = fixture();
      const result = await createCustomerEntryComposition({
        ...f.options,
        table: table(),
      }).establish({ ...f.input(), ...extra, presentedTableUnconfirmed: presentedFor(f) });
      expect(result.status).toBe(before.status);
      expect(result.status).not.toBe("EntryUnavailable");
    },
  );

  it("an unconfirmed seat at another table, or on a replaced code, is an ordinary entry", async () => {
    for (const change of [{ publicTableReference: id(90) }, { qrRevocationVersion: 2 }]) {
      const f = fixture();
      const result = await createCustomerEntryComposition({
        ...f.options,
        table: openTable,
      }).establish({ ...f.input(), presentedTableUnconfirmed: { ...presentedFor(f), ...change } });
      expect(result.status).toBe("Established");
    }
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

  const ports = (
    changes: {
      identity?: () => Promise<GuestSession>;
      seated?: () => Promise<GuestSession>;
      participant?: () => Promise<"Seated" | "NotSeated">;
    } = {},
  ) => {
    const identity = vi.fn(changes.identity ?? (async () => session()));
    const seatedRead = vi.fn(changes.seated ?? (async () => session()));
    const participant = vi.fn(changes.participant ?? (async () => "Seated" as const));
    return {
      identity,
      seatedRead,
      participant,
      read: createCustomerEntryPresentedTable({
        identity: { resolve: identity },
        seated: { resolve: seatedRead },
        participant,
      }),
    };
  };
  const at = "2026-07-30T05:00:00.000Z";

  it("is read in the background (no idle renewal) and gives the table facts only", async () => {
    const p = ports();
    expect(await p.read(COOKIE, at)).toEqual(seated);
    for (const resolve of [p.identity, p.seatedRead])
      expect(resolve).toHaveBeenCalledWith({
        sessionCredential: COOKIE,
        activity: "Background",
        observedAt: at,
      });
    expect(p.participant).not.toHaveBeenCalled();
  });

  it.each([
    ["context only (not yet at the table)", { diningState: "ContextOnly" }],
    ["pickup", { channel: "Pickup", publicTableReference: null }],
  ] as const)("is none for a session that is %s", async (_name, change) => {
    const p = ports({ identity: async () => session(change as Partial<GuestSession>) });
    expect(await p.read(COOKIE, at)).toBeNull();
    expect(p.seatedRead).not.toHaveBeenCalled();
  });

  it("is none for a cookie Identity doesn't hold (unknown, revoked, expired, another Store)", async () => {
    const p = ports({
      identity: async () => Promise.reject(new Error("GUEST_SESSION_UNAVAILABLE")),
    });
    expect(await p.read(COOKIE, at)).toBeNull();
  });

  it("is none for a phone staff removed: Dining itself says its participant left", async () => {
    const p = ports({
      seated: async () => Promise.reject(new Error("GUEST_SESSION_UNAVAILABLE")),
      participant: async () => "NotSeated",
    });
    expect(await p.read(COOKIE, at)).toBeNull();
    expect(p.participant).toHaveBeenCalledWith(session(), at);
  });

  it("is unconfirmed, never 'not seated', when Dining could not be read", async () => {
    const p = ports({
      seated: async () => Promise.reject(new Error("GUEST_SESSION_UNAVAILABLE")),
      participant: async () => Promise.reject(new Error("connection reset")),
    });
    expect(await p.read(COOKIE, at)).toEqual({ unconfirmed: seated });
  });

  it("is none when Dining answers seated but the binding check failed otherwise (no retry loop)", async () => {
    // A replaced code or a moved party: the phone goes on as an ordinary entry.
    const p = ports({
      seated: async () => Promise.reject(new Error("GUEST_SESSION_UNAVAILABLE")),
      participant: async () => "Seated",
    });
    expect(await p.read(COOKIE, at)).toBeNull();
  });
});

describe("Dining's own answer whether a phone is still seated", () => {
  const snapshot = (participant: string, phase: string, followedMove: unknown = null) => ({
    participant: { status: participant },
    session: { phase },
    followedMove,
  });
  it.each([
    ["Active participant, Active session", snapshot("Active", "Active"), "Seated"],
    ["Active participant, table paying (Closing)", snapshot("Active", "Closing"), "Seated"],
    ["staff removed the phone (Left)", snapshot("Left", "Active"), "NotSeated"],
    ["the table was closed", snapshot("Active", "Closed"), "NotSeated"],
    ["the party was moved to another table", snapshot("Active", "Active", { at: 1 }), "NotSeated"],
    ["no such participant", null, "NotSeated"],
  ] as const)("%s: %s", (_name, value, expected) => {
    expect(diningSeatOf(value)).toBe(expected);
  });
});
