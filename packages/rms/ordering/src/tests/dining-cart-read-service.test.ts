import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningCartReadService,
  type DiningCartReadPorts,
} from "../application/dining-cart-read-service.js";
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
    publicTableReference: id(60) as never,
    channel: "DineIn",
    locale: "en-CA" as never,
    qrReference: ids.qr,
    qrRevocationVersion: 1,
    diningState: "DiningBound",
    diningSessionReference: ids.diningSession as never,
    diningParticipantReference: ids.participant as never,
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
    orderType: "DineIn",
    sourceChannel: "Qr",
    diningSessionReference: ids.diningSession as never,
    createdByActorReference: ids.otherSession,
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
    items: [
      {
        cartItemReference: ids.item,
        cartReference: ids.cart,
        sellableReference: ids.sellable,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: null,
        addedByActorReference: ids.session,
        addedByParticipantReference: ids.participant,
        addedAt: createdAt,
      },
      {
        cartItemReference: id(50),
        cartReference: ids.cart,
        sellableReference: ids.sellable,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: null,
        addedByActorReference: ids.otherSession,
        addedByParticipantReference: ids.otherParticipant,
        addedAt: createdAt,
      },
    ],
    ...overrides,
  });
}

const credential = "x".repeat(43);
function membership() {
  return {
    schemaVersion: 1,
    brandReference: ids.brand,
    storeReference: ids.store,
    diningSessionReference: ids.diningSession,
    participantReference: ids.participant,
    tableReference: id(61),
    tableAssignmentVersion: 1,
    diningSessionVersion: 1,
    participantVersion: 1,
    observedAt: requestedAt,
  };
}
function fixture() {
  const scope = { brandReference: ids.brand, storeReference: ids.store };
  const resolve = vi.fn<DiningCartReadPorts["sessions"]["resolve"]>(async () => guest());
  const current = vi.fn(async (): Promise<CartAggregate | null> => cart());
  const now = vi.fn(() => requestedAt);
  const participate = vi.fn(async (): Promise<unknown> => ({ ...membership(), observedAt: now() }));
  return {
    scope,
    resolve,
    current,
    now,
    participate,
    service: createDiningCartReadService({
      scope,
      sessions: { resolve },
      participation: { resolve: participate },
      carts: { current },
      now,
    }),
  };
}

describe("current-authorized shared Dining Cart read", () => {
  it("lets two current participants read the same Cart without rewriting attribution", async () => {
    const first = fixture();
    const second = fixture();
    second.resolve.mockResolvedValue(
      guest({
        sessionReference: ids.otherSession as never,
        diningParticipantReference: ids.otherParticipant as never,
      }),
    );
    second.participate.mockResolvedValue({
      ...membership(),
      participantReference: ids.otherParticipant,
    });
    const a = await first.service.read({ sessionCredential: credential });
    const b = await second.service.read({ sessionCredential: "y".repeat(43) });
    expect(a?.cart).toEqual(b?.cart);
    expect(a?.cart.createdByActorReference).toBe(ids.otherSession);
    expect(a?.cart.items.map((item) => item.addedByParticipantReference)).toEqual([
      ids.participant,
      ids.otherParticipant,
    ]);
    expect(Object.isFrozen(a?.cart.items)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
    expect(first.resolve).toHaveBeenCalledTimes(4);
    expect(first.participate).toHaveBeenCalledTimes(2);
    for (const [input] of first.resolve.mock.calls)
      expect(input).toMatchObject({ sessionCredential: credential, activity: "Background" });
    expect(first.current).toHaveBeenCalledWith({
      brandReference: ids.brand,
      storeReference: ids.store,
      diningSessionReference: ids.diningSession,
      observedAt: requestedAt,
    });
    expect(first.resolve.mock.invocationCallOrder[1]).toBeLessThan(
      first.current.mock.invocationCallOrder[0] ?? 0,
    );
    expect(first.resolve.mock.invocationCallOrder[2]).toBeGreaterThan(
      first.current.mock.invocationCallOrder[0] ?? 0,
    );
    expect(first.participate).toHaveBeenCalledWith({
      purpose: "Cart",
      diningSessionReference: ids.diningSession,
      participantReference: ids.participant,
    });
  });
  it.each([
    null,
    {},
    { sessionCredential: "bad" },
    { sessionCredential: credential, tableReference: id(60) },
    { sessionCredential: credential, cartReference: null },
    { sessionCredential: credential, cartReference: id(1), extra: true },
  ])("rejects closed input violations before dependencies", async (input) => {
    const f = fixture();
    await expect(f.service.read(input)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.current).not.toHaveBeenCalled();
  });
  it("does not invoke input getters or accept symbols", async () => {
    const f = fixture();
    const get = vi.fn(() => credential);
    await expect(
      f.service.read(Object.defineProperty({}, "sessionCredential", { get, enumerable: true })),
    ).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    await expect(
      f.service.read({ sessionCredential: credential, [Symbol()]: true }),
    ).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    { brandReference: id(99) },
    { storeReference: id(99) },
    { channel: "Pickup" },
    { diningState: "ContextOnly" },
    { diningParticipantReference: null },
    { diningSessionReference: null },
    { publicTableReference: null },
    { status: "Revoked", revocationReason: "BindingChanged", revokedAt: requestedAt },
    { idleExpiresAt: requestedAt },
  ])(
    "rejects unusable or differently scoped Guest before Dining or Cart reads",
    async (overrides) => {
      const f = fixture();
      f.resolve.mockResolvedValue({ ...guest(), ...overrides } as GuestSession);
      await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.participate).not.toHaveBeenCalled();
      expect(f.current).not.toHaveBeenCalled();
    },
  );
  it.each([2, 3, 4])(
    "rejects changed current identity at authorization call %s",
    async (changed) => {
      const f = fixture();
      let calls = 0;
      f.resolve.mockImplementation(async () =>
        guest(++calls === changed ? { sessionReference: ids.otherSession as never } : {}),
      );
      await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.current).toHaveBeenCalledTimes(changed === 2 ? 0 : 1);
    },
  );
  it.each([
    "version",
    "publicTableReference",
    "qrReference",
    "qrRevocationVersion",
    "diningParticipantReference",
    "locale",
  ] as const)("denies final %s drift", async (field) => {
    const f = fixture();
    let count = 0;
    f.resolve.mockImplementation(async () => {
      const source = guest();
      if (++count === 4)
        return {
          ...source,
          [field]:
            field === "version" || field === "qrRevocationVersion"
              ? 2
              : field === "locale"
                ? "fr-CA"
                : id(99),
        } as GuestSession;
      return source;
    });
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it.each([
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "participantReference",
  ] as const)("denies foreign %s participation before Cart access", async (field) => {
    const f = fixture();
    f.participate.mockResolvedValue({ ...membership(), [field]: id(99) });
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.current).not.toHaveBeenCalled();
  });
  it.each([
    "tableReference",
    "tableAssignmentVersion",
    "diningSessionVersion",
    "participantVersion",
  ] as const)("denies changed %s after the Cart read", async (field) => {
    const f = fixture();
    f.participate
      .mockResolvedValueOnce(membership())
      .mockResolvedValue({ ...membership(), [field]: field === "tableReference" ? id(99) : 2 });
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it.each([
    null,
    { ...membership(), schemaVersion: 2 },
    { ...membership(), participantVersion: 0 },
    { ...membership(), diningSessionVersion: 1.5 },
    { ...membership(), extra: true },
    { ...membership(), observedAt: createdAt },
    { ...membership(), observedAt: "2026-08-02T14:02:00.000Z" },
  ])("denies absent, malformed or stale participation", async (source) => {
    const f = fixture();
    f.participate.mockResolvedValue(source);
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: source === null ? "CART_PERMISSION_DENIED" : "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.current).not.toHaveBeenCalled();
  });
  it("rechecks authority for absence and uses the same null outcome for foreign locators", async () => {
    const f = fixture();
    expect(
      await f.service.read({ sessionCredential: credential, cartReference: id(99) }),
    ).toBeNull();
    const absent = fixture();
    absent.current.mockResolvedValue(null);
    expect(await absent.service.read({ sessionCredential: credential })).toBeNull();
    expect(absent.resolve).toHaveBeenCalledTimes(4);
    const revoked = fixture();
    revoked.current.mockResolvedValue(null);
    revoked.resolve
      .mockResolvedValueOnce(guest())
      .mockResolvedValueOnce(guest())
      .mockRejectedValue(new Error("private"));
    await expect(revoked.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it.each([
    { brandReference: id(99) },
    { storeReference: id(99) },
    { orderType: "Pickup" },
    { diningSessionReference: id(99) },
    { sourceChannel: "Pos" },
    { lifecycle: null },
    { updatedAt: "2026-08-02T14:02:00.000Z" },
  ])("rejects a wrong or unsupported current Cart", async (overrides) => {
    const f = fixture();
    f.current.mockResolvedValue({ ...cart(), ...overrides } as CartAggregate);
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("captures mutable Cart data before final authorization callbacks", async () => {
    const f = fixture();
    const original = cart();
    const source = { ...original, items: original.items.map((item) => ({ ...item })) };
    f.current.mockResolvedValue(source);
    let count = 0;
    f.resolve.mockImplementation(async () => {
      if (++count === 3) {
        const item = source.items[0];
        if (item) item.quantity = 99;
      }
      return guest();
    });
    const result = await f.service.read({ sessionCredential: credential });
    expect(result?.cart.items[0]?.quantity).toBe(1);
    expect(source.items[0]?.quantity).toBe(99);
  });
  it("captures the first membership snapshot before subsequent dependency mutation", async () => {
    const f = fixture();
    const source = membership();
    f.participate.mockResolvedValue(source);
    let count = 0;
    f.resolve.mockImplementation(async () => {
      if (++count === 2) source.tableAssignmentVersion = 2;
      return guest();
    });
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it("captures input and constructor scope before asynchronous work", async () => {
    const f = fixture();
    const input = { sessionCredential: credential, cartReference: ids.cart };
    f.resolve.mockImplementation(async () => {
      input.sessionCredential = "z".repeat(43);
      input.cartReference = id(99);
      f.scope.storeReference = id(99);
      return guest();
    });
    expect((await f.service.read(input))?.cart.cartReference).toBe(ids.cart);
    for (const [request] of f.resolve.mock.calls)
      expect(request).toMatchObject({ sessionCredential: credential });
    expect(f.current).toHaveBeenCalledWith(expect.objectContaining({ storeReference: ids.store }));
  });
  it("computes expiry without mutating persisted lifecycle", async () => {
    const f = fixture();
    const source = cart();
    f.current.mockResolvedValue(source);
    f.now.mockReturnValue("2026-08-02T15:01:00.000Z");
    const result = await f.service.read({ sessionCredential: credential });
    expect(result?.effectiveStatus).toBe("Expired");
    expect(source.lifecycle?.status).toBe("Active");
  });
  it("denies a backwards clock before Cart access", async () => {
    const f = fixture();
    f.now.mockReturnValueOnce(requestedAt).mockReturnValue(createdAt);
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.current).not.toHaveBeenCalled();
  });
  it.each(["participate", "current"] as const)("bounds %s dependency errors", async (key) => {
    const f = fixture();
    f[key].mockRejectedValue(new Error("private source detail"));
    await expect(f.service.read({ sessionCredential: credential })).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
});
