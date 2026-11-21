import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  host: vi.fn(),
  participant: vi.fn(),
  cart: vi.fn(),
  transactions: [] as unknown[],
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresFencedGuestSessionEntryStore: (runner: {
    run(action: (tx: unknown) => unknown): unknown;
  }) => ({
    resolve: async () =>
      runner.run((tx) => {
        mocks.transactions.push(tx);
        return mocks.resolve();
      }),
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningHostParticipationFence: (runner: {
    run(action: (tx: unknown) => unknown): unknown;
  }) => ({
    readCurrent: async () =>
      runner.run((tx) => {
        mocks.transactions.push(tx);
        return mocks.host();
      }),
  }),
  createPostgresDiningParticipantFence: (runner: {
    run(action: (tx: unknown) => unknown): unknown;
  }) => ({
    readCurrent: async () =>
      runner.run((tx) => {
        mocks.transactions.push(tx);
        return mocks.participant();
      }),
  }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresCartQueryStore: (runner: { run(action: (tx: unknown) => unknown): unknown }) => ({
    load: async () =>
      runner.run((tx) => {
        mocks.transactions.push(tx);
        return mocks.cart();
      }),
  }),
}));
import {
  createGuestSessionRecord,
  parseGuestRawCredential,
  parseGuestSelectorHash,
} from "@bop/identity";
import { createDiningCartReplacementAuthorization } from "./dining-cart-replacement-authorization.js";
const id = (n: number) => "0190eda1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-20T13:00:00.000Z",
  end = "2026-09-20T17:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const command = {
  operationReference: id(4),
  brandReference: id(2),
  storeReference: id(3),
  diningSessionReference: id(5),
  participantReference: id(6),
  guestSessionReference: id(7),
  previousCartReference: id(8),
  expectedCartVersion: 2,
  observedAt: at,
};
function record() {
  return createGuestSessionRecord({
    session: {
      sessionReference: id(7),
      status: "Active",
      version: 1,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(9),
      publicTableReference: id(10),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(11),
      qrRevocationVersion: 1,
      diningState: "DiningBound",
      diningSessionReference: id(5),
      diningParticipantReference: id(6),
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: end,
      absoluteExpiresAt: "2026-09-21T13:00:00.000Z",
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: "1".repeat(64),
    csrfSelectorHash: "2".repeat(64),
    operationReference: id(12),
    operationIntentHash: "3".repeat(64),
  });
}
function fixture() {
  const validate = vi.fn(async () => "Current" as "Current" | "Unavailable"),
    now = vi.fn(() => at),
    hash = vi.fn((purpose: "Session" | "Csrf") =>
      parseGuestSelectorHash((purpose === "Session" ? "1" : "2").repeat(64)),
    );
  const authorize = createDiningCartReplacementAuthorization({
    scope,
    sessionCredential: "A".repeat(43),
    csrfCredential: "B".repeat(43),
    binding: () => ({ validate }),
    now,
    credentials: {
      generateCredential: () => parseGuestRawCredential("C".repeat(43)),
      generateSessionReference: () => id(15),
      hashCredential: hash,
      hashOperationIntent: () => parseGuestSelectorHash("4".repeat(64)),
      equals: (a, b) => a === b,
    },
  });
  return {
    authorize,
    validate,
    now,
    hash,
    tx: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactions.length = 0;
  mocks.resolve.mockResolvedValue(record());
  mocks.host.mockResolvedValue({});
  mocks.participant.mockResolvedValue({});
  mocks.cart.mockResolvedValue(previousCart("Abandoned"));
});
function previousCart(status: "Active" | "Abandoned" | "Expired", session = id(5)) {
  return { diningSessionReference: session, lifecycle: { status } };
}
it("uses actual credential/CSRF service and same transaction for Guest then Host", async () => {
  const f = fixture();
  expect(await f.authorize(f.tx, command)).toBe(true);
  expect(mocks.transactions).toEqual([f.tx, f.tx, f.tx]);
  expect(f.validate).toHaveBeenCalledTimes(2);
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("rejects wrong CSRF before Dining access", async () => {
  const f = fixture();
  f.hash.mockReturnValue(parseGuestSelectorHash("9".repeat(64)));
  expect(await f.authorize(f.tx, command)).toBe(false);
  expect(mocks.host).not.toHaveBeenCalled();
});
it.each([
  "guestSessionReference",
  "diningSessionReference",
  "participantReference",
  "brandReference",
  "storeReference",
])("rejects mismatched %s", async (field) => {
  const f = fixture();
  expect(await f.authorize(f.tx, { ...command, [field]: id(99) })).toBe(false);
  expect(mocks.host).not.toHaveBeenCalled();
});
it("reports ineligible Host participation distinctly from dependency failure", async () => {
  mocks.host.mockResolvedValue(null);
  const f = fixture();
  await expect(f.authorize(f.tx, command)).rejects.toMatchObject({
    code: "CART_REPLACEMENT_FORBIDDEN",
  });
});
it("rejects current binding loss after Host lock", async () => {
  const f = fixture();
  f.validate.mockResolvedValueOnce("Current").mockResolvedValueOnce("Unavailable");
  expect(await f.authorize(f.tx, command)).toBe(false);
});
it("rejects Guest expiry while awaiting Host", async () => {
  const f = fixture();
  mocks.host.mockImplementation(async () => {
    f.now.mockReturnValue(end);
    return {};
  });
  expect(await f.authorize(f.tx, command)).toBe(false);
});
it("rejects expiry while rechecking binding", async () => {
  const f = fixture();
  f.validate.mockResolvedValueOnce("Current").mockImplementationOnce(async () => {
    f.now.mockReturnValue(end);
    return "Current";
  });
  expect(await f.authorize(f.tx, command)).toBe(false);
});
it("bounds dependency failure", async () => {
  mocks.resolve.mockRejectedValue(new Error("private"));
  const f = fixture();
  expect(await f.authorize(f.tx, command)).toBe(false);
});

it("does not label a failed Host dependency as permission refusal", async () => {
  const f = fixture();
  mocks.host.mockRejectedValue(new Error("private"));
  expect(await f.authorize(f.tx, command)).toBe(false);
});

it("WP-2423: lets any current participant replace an Expired cart, and only the Host an Abandoned one", async () => {
  mocks.cart.mockResolvedValue(previousCart("Expired"));
  mocks.host.mockResolvedValue(null);
  const f = fixture();
  expect(await f.authorize(f.tx, command)).toBe(true);
  expect(mocks.participant).toHaveBeenCalledTimes(1);
  expect(mocks.host).not.toHaveBeenCalled();
  // A former or removed participant is refused.
  mocks.participant.mockResolvedValue(null);
  await expect(f.authorize(f.tx, command)).rejects.toMatchObject({
    code: "CART_REPLACEMENT_FORBIDDEN",
  });
  // Abandoned stays Host-only: the participant fence is never consulted.
  mocks.participant.mockClear();
  mocks.participant.mockResolvedValue({});
  mocks.cart.mockResolvedValue(previousCart("Abandoned"));
  await expect(f.authorize(f.tx, command)).rejects.toMatchObject({
    code: "CART_REPLACEMENT_FORBIDDEN",
  });
  expect(mocks.participant).not.toHaveBeenCalled();
});
it("WP-2423: an expiry not yet recorded is retryable, and another session's cart is refused", async () => {
  const f = fixture();
  mocks.cart.mockResolvedValue(previousCart("Active"));
  await expect(f.authorize(f.tx, command)).rejects.toMatchObject({
    code: "CART_LIFECYCLE_UNAVAILABLE",
  });
  mocks.cart.mockResolvedValue(previousCart("Expired", id(99)));
  expect(await f.authorize(f.tx, command)).toBe(false);
  mocks.cart.mockResolvedValue(null);
  expect(await f.authorize(f.tx, command)).toBe(false);
  expect(mocks.participant).not.toHaveBeenCalled();
  expect(mocks.host).not.toHaveBeenCalled();
});
