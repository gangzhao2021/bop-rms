import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import { createPickupCartReadService } from "../application/pickup-cart-read-service.js";
import { parseCartAggregate, type CartAggregate } from "../domain/cart.js";

const id = (n: number) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  sellable: id(7),
  option: id(8),
  item: id(9),
  operation: id(10),
  secondOperation: id(11),
  thirdOperation: id(12),
  audit: id(13),
  correlation: id(14),
  diningSession: id(15),
  participant: id(16),
  otherParticipant: id(17),
  otherSession: id(18),
  menuVersion: id(19),
  productVersion: id(20),
  binding: id(21),
  optionSetVersion: id(22),
};
const createdAt = "2026-08-02T14:00:00.000Z";
const requestedAt = "2026-08-02T14:01:00.000Z";

function guest(overrides: Partial<GuestSession> = {}): GuestSession {
  return {
    sessionReference: ids.session,
    status: "Active",
    version: 1,
    brandReference: ids.brand,
    storeReference: ids.store,
    publicStoreReference: ids.publicStore,
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: ids.qr,
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-02T13:00:00.000Z" as never,
    lastSeenAt: createdAt as never,
    idleExpiresAt: "2026-08-02T18:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-03T13:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  } as GuestSession;
}

function cart(overrides: Partial<CartAggregate> = {}): CartAggregate {
  return parseCartAggregate({
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: ids.session,
    aggregateVersion: 1,
    createdAt,
    updatedAt: createdAt,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [],
    ...overrides,
  });
}

const credential = "x".repeat(43);
function fixture() {
  const resolve = vi.fn(async () => guest());
  const current = vi.fn(async (): Promise<CartAggregate | null> => cart());
  const now = vi.fn(() => requestedAt);
  return {
    resolve,
    current,
    now,
    service: createPickupCartReadService({
      sessions: { resolve },
      binding: { current },
      now,
      scope: { brandReference: ids.brand, storeReference: ids.store },
    }),
  };
}

describe("authorized Pickup reads", () => {
  it("resolves live credentials twice without interactive renewal and returns an internal snapshot", async () => {
    const f = fixture();
    const result = await f.service.read({ sessionCredential: credential });
    expect(result).toEqual({ cart: cart(), effectiveStatus: "Active", observedAt: requestedAt });
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.resolve).toHaveBeenNthCalledWith(1, {
      sessionCredential: credential,
      activity: "Background",
      observedAt: requestedAt,
    });
    expect(f.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      f.current.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.resolve.mock.invocationCallOrder[1]).toBeGreaterThan(
      f.current.mock.invocationCallOrder[0] ?? 0,
    );
    expect(Object.isFrozen(result?.cart)).toBe(true);
  });
  it("filters only the current binding for reference reads", async () => {
    const f = fixture();
    expect(
      await f.service.read({ sessionCredential: credential, cartReference: ids.otherSession }),
    ).toBeNull();
    expect(f.current).toHaveBeenCalledWith(guest(), requestedAt);
    expect(
      (await f.service.read({ sessionCredential: credential, cartReference: ids.cart }))?.cart
        .cartReference,
    ).toBe(ids.cart);
    f.current.mockResolvedValue(null);
    expect(await f.service.read({ sessionCredential: credential })).toBeNull();
  });
  it.each([
    null,
    [],
    {},
    { sessionCredential: "invalid" },
    { sessionCredential: credential, cartReference: undefined },
    { sessionCredential: credential, observedAt: requestedAt },
    { sessionCredential: credential, storeReference: ids.store },
  ])("rejects closed input violations before dependencies: %s", async (input) => {
    const f = fixture();
    await expect(f.service.read(input)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.current).not.toHaveBeenCalled();
  });
  it("rejects credential accessors without invoking them", async () => {
    const f = fixture();
    const getter = vi.fn(() => {
      throw new Error("must not invoke");
    });
    const input = Object.defineProperty({}, "sessionCredential", { get: getter, enumerable: true });
    await expect(f.service.read(input)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each([
    { brandReference: id(99) },
    { storeReference: id(99) },
    { channel: "DineIn", publicTableReference: id(99) },
    { idleExpiresAt: requestedAt },
    { status: "Revoked", revokedAt: requestedAt, revocationReason: "SecurityRevoked" },
  ])("denies unusable or unsupported Sessions before Cart access: %s", async (override) => {
    const f = fixture();
    f.resolve.mockResolvedValue(guest(override as unknown as Partial<GuestSession>));
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.current).not.toHaveBeenCalled();
  });
  it("denies a dependency failure without exposing its message", async () => {
    const f = fixture();
    f.current.mockRejectedValue(new Error(credential));
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    f.resolve.mockRejectedValue(new Error(credential));
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
      message: "cart is unavailable",
    });
  });
  it("denies revocation while loading, including a missing Cart", async () => {
    for (const loaded of [cart(), null]) {
      const f = fixture();
      f.current.mockResolvedValue(loaded);
      f.resolve.mockResolvedValueOnce(guest()).mockRejectedValueOnce(new Error("revoked"));
      await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
    }
  });
  it.each([
    { sessionReference: ids.otherSession },
    { qrRevocationVersion: 2 },
    { qrReference: id(99) },
    { publicStoreReference: id(99) },
  ])("denies changed identity binding during a read: %s", async (override) => {
    const f = fixture();
    f.resolve
      .mockResolvedValueOnce(guest())
      .mockResolvedValueOnce(guest(override as unknown as Partial<GuestSession>));
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it.each([
    { brandReference: id(99) },
    { storeReference: id(99) },
    { createdByActorReference: ids.otherSession },
    { sourceChannel: "Merchant" },
    { lifecycle: null },
    { updatedAt: "2026-08-02T16:00:00.000Z" },
  ])("denies substituted or incomplete Cart snapshots: %s", async (override) => {
    const f = fixture();
    f.current.mockResolvedValue({ ...cart(), ...override } as CartAggregate);
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("observes exact expiry at return without modifying the stored lifecycle", async () => {
    const f = fixture();
    const snapshot = cart();
    f.current.mockResolvedValue(snapshot);
    f.now
      .mockReturnValueOnce("2026-08-02T14:59:59.999Z")
      .mockReturnValueOnce("2026-08-02T15:00:00.000Z");
    const result = await f.service.read({ sessionCredential: credential });
    expect(result?.effectiveStatus).toBe("Expired");
    expect(result?.cart.lifecycle?.status).toBe("Active");
    expect(snapshot).toEqual(cart());
  });
  it.each(["invalid", "2026-08-02T13:59:59.999Z"])(
    "denies invalid or regressing final server clock: %s",
    async (finalTime) => {
      const f = fixture();
      f.now.mockReturnValueOnce(requestedAt).mockReturnValueOnce(finalTime);
      await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
});

it.each(["Abandoned", "Expired"] as const)(
  "preserves recorded terminal status %s",
  async (status) => {
    const f = fixture();
    const original = cart();
    f.now.mockReturnValue("2026-08-02T15:00:00.000Z");
    f.current.mockResolvedValue(
      parseCartAggregate({
        ...original,
        lifecycle: {
          ...original.lifecycle,
          status,
          terminalAt: "2026-08-02T15:00:00.000Z",
          terminalReason: status === "Abandoned" ? "CUSTOMER_ABANDONED" : "IDLE_TIMEOUT",
        },
        updatedAt: "2026-08-02T15:00:00.000Z",
      }),
    );
    expect((await f.service.read({ sessionCredential: credential }))?.effectiveStatus).toBe(status);
  },
);

it("bounds hostile proxy failures before authorization", async () => {
  const f = fixture();
  const input = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(credential);
      },
    },
  );
  await expect(f.service.read(input)).rejects.toMatchObject({
    code: "CART_INPUT_INVALID",
    message: "cart input is invalid",
  });
  expect(f.resolve).not.toHaveBeenCalled();
});
