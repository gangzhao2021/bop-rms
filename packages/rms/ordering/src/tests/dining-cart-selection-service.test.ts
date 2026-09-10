import { createGuestSession, type GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningCartSelectionService,
  type DiningCartSelectionPorts,
} from "../application/dining-cart-selection-service.js";
import { CartError } from "../domain/cart.js";

const id = (n: number) => `018f2317-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (seconds = 0) =>
  new Date(Date.parse("2026-09-09T12:00:00.000Z") + seconds * 1000).toISOString();
const credential = "a".repeat(43);
const input = () => ({ sessionCredential: credential, operationReference: id(10) });
function guest(change: Record<string, unknown> = {}): GuestSession {
  return createGuestSession({
    sessionReference: id(4),
    status: "Active",
    version: 1,
    brandReference: id(2),
    storeReference: id(3),
    publicStoreReference: id(7),
    publicTableReference: id(8),
    channel: "DineIn",
    locale: "en-CA",
    qrReference: id(9),
    qrRevocationVersion: 1,
    diningState: "DiningBound",
    diningSessionReference: id(6),
    diningParticipantReference: id(5),
    createdAt: at(-3600),
    lastSeenAt: at(-60),
    idleExpiresAt: at(14340),
    absoluteExpiresAt: at(82800),
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...change,
  });
}
function membership() {
  return {
    schemaVersion: 1,
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(6),
    participantReference: id(5),
    tableReference: id(12),
    tableAssignmentVersion: 1,
    diningSessionVersion: 1,
    participantVersion: 1,
    observedAt: at(),
  };
}
function receipt() {
  return {
    operationReference: id(10),
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(6),
    guestSessionReference: id(4),
    participantReference: id(5),
    action: "Select",
    cartReference: id(11),
    cartVersion: 4,
    occurredAt: at(),
    expiresAt: at(86400),
  };
}
function fixture() {
  const scope = { brandReference: id(2), storeReference: id(3) };
  const resolve = vi.fn<DiningCartSelectionPorts["sessions"]["resolve"]>(async () => guest());
  const participate = vi.fn(async (): Promise<unknown> => membership());
  const select = vi.fn<DiningCartSelectionPorts["selection"]["select"]>(async () => receipt());
  const now = vi.fn(() => at());
  const service = createDiningCartSelectionService({
    scope,
    sessions: { resolve },
    participation: { resolve: participate },
    selection: { select },
    now,
  });
  return { scope, resolve, participate, select, now, service };
}

describe("current-authorized shared Dining Cart selection", () => {
  it.each(["Create", "Select"])(
    "requires current authority before and after %s",
    async (action) => {
      const f = fixture();
      const result = { ...receipt(), action, cartVersion: action === "Create" ? 1 : 4 };
      f.select.mockResolvedValue(result);
      expect(await f.service.select(input())).toEqual(result);
      expect(f.resolve).toHaveBeenCalledTimes(4);
      expect(f.participate).toHaveBeenCalledTimes(2);
      expect(f.select).toHaveBeenCalledWith({
        operationReference: id(10),
        brandReference: id(2),
        storeReference: id(3),
        diningSessionReference: id(6),
        guestSessionReference: id(4),
        participantReference: id(5),
        observedAt: at(),
      });
      expect(f.resolve.mock.invocationCallOrder[1]).toBeLessThan(
        f.select.mock.invocationCallOrder[0] ?? 0,
      );
      expect(f.resolve.mock.invocationCallOrder[2]).toBeGreaterThan(
        f.select.mock.invocationCallOrder[0] ?? 0,
      );
      expect(f.participate).toHaveBeenCalledWith({
        purpose: "Cart",
        diningSessionReference: id(6),
        participantReference: id(5),
      });
      expect(JSON.stringify(f.select.mock.calls)).not.toContain(credential);
      expect(Object.isFrozen(f.select.mock.calls[0]?.[0])).toBe(true);
    },
  );
  it("derives the exact current Guest and Participant for another member", async () => {
    const f = fixture();
    f.resolve.mockResolvedValue(
      guest({ sessionReference: id(14), diningParticipantReference: id(15) }),
    );
    f.participate.mockResolvedValue({ ...membership(), participantReference: id(15) });
    f.select.mockResolvedValue({
      ...receipt(),
      guestSessionReference: id(14),
      participantReference: id(15),
    });
    expect(await f.service.select(input())).toMatchObject({
      cartReference: id(11),
      guestSessionReference: id(14),
      participantReference: id(15),
    });
    expect(f.select.mock.calls[0]?.[0]).toMatchObject({
      guestSessionReference: id(14),
      participantReference: id(15),
    });
  });
  it("reauthorizes original retries before any historical owner lookup", async () => {
    const f = fixture();
    await f.service.select(input());
    f.participate.mockResolvedValue(null);
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.select).toHaveBeenCalledTimes(1);
  });
  it.each([
    { storeReference: id(99) },
    { brandReference: id(99) },
    { channel: "Pickup" },
    { diningState: "ContextOnly" },
    { diningParticipantReference: null },
    { status: "Revoked", revocationReason: "BindingChanged", revokedAt: at() },
    { idleExpiresAt: at() },
  ])("denies unusable Guest before owner access", async (change) => {
    const f = fixture();
    f.resolve.mockImplementation(async () => guest(change));
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.select).not.toHaveBeenCalled();
  });
  it.each(["brandReference", "storeReference", "diningSessionReference", "participantReference"])(
    "denies foreign %s participation",
    async (key) => {
      const f = fixture();
      f.participate.mockResolvedValue({ ...membership(), [key]: id(99) });
      await expect(f.service.select(input())).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(f.select).not.toHaveBeenCalled();
    },
  );
  it("denies publication after the effect when participation is lost, then permits fresh authorized recovery", async () => {
    const f = fixture();
    f.select.mockImplementationOnce(async () => {
      f.participate.mockResolvedValue(null);
      return receipt();
    });
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.select).toHaveBeenCalledTimes(1);
    f.participate.mockResolvedValue(membership());
    expect(await f.service.select(input())).toEqual(receipt());
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(f.select.mock.calls[0]?.[0].operationReference).toBe(
      f.select.mock.calls[1]?.[0].operationReference,
    );
  });
  it.each([
    "tableReference",
    "tableAssignmentVersion",
    "diningSessionVersion",
    "participantVersion",
  ])("denies post-effect %s drift", async (key) => {
    const f = fixture();
    f.select.mockImplementation(async () => {
      f.participate.mockResolvedValue({
        ...membership(),
        [key]: key === "tableReference" ? id(99) : 2,
      });
      return receipt();
    });
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.select).toHaveBeenCalledTimes(1);
  });
  it("denies a post-effect Guest rotation", async () => {
    const f = fixture();
    f.select.mockImplementation(async () => {
      f.resolve.mockResolvedValue(guest({ sessionReference: id(99) }));
      return receipt();
    });
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });
  it.each([
    "operationReference",
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "guestSessionReference",
    "participantReference",
  ])("rejects substituted receipt %s", async (key) => {
    const f = fixture();
    f.select.mockResolvedValue({ ...receipt(), [key]: id(99) });
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    { occurredAt: at(1), expiresAt: at(86401) },
    { occurredAt: at(-3601), expiresAt: at(82799) },
    { expiresAt: at(100) },
    { action: "Create", cartVersion: 2 },
    { extra: "synthetic restricted detail" },
  ])("rejects invalid historical/time receipt", async (change) => {
    const f = fixture();
    f.select.mockResolvedValue({ ...receipt(), ...change });
    const error = await f.service.select(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(String(error)).not.toContain("synthetic restricted detail");
  });
  it("accepts an earlier original receipt in the same Guest lifetime", async () => {
    const f = fixture();
    const original = { ...receipt(), occurredAt: at(-60), expiresAt: at(86340) };
    f.select.mockResolvedValue(original);
    expect(await f.service.select(input())).toEqual(original);
  });
  it("captures mutable receipt data before final authorization callbacks", async () => {
    const f = fixture();
    const result = receipt();
    f.select.mockResolvedValue(result);
    f.resolve.mockImplementation(async () => {
      if (f.select.mock.calls.length) {
        result.cartReference = id(99);
        result.cartVersion = 99;
      }
      return guest();
    });
    const parsed = await f.service.select(input());
    expect(parsed.cartReference).toBe(id(11));
    expect(parsed.cartVersion).toBe(4);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it("captures input and fixed scope before asynchronous dependencies", async () => {
    const f = fixture();
    const value = input();
    f.resolve.mockImplementation(async () => {
      value.operationReference = id(99);
      value.sessionCredential = "b".repeat(43);
      f.scope.storeReference = id(99);
      return guest();
    });
    await f.service.select(value);
    expect(f.select.mock.calls[0]?.[0]).toMatchObject({
      operationReference: id(10),
      storeReference: id(3),
    });
    expect(f.resolve.mock.calls.every(([call]) => call.sessionCredential === credential)).toBe(
      true,
    );
  });
  it.each([
    null,
    {},
    { ...input(), cartReference: id(11) },
    { ...input(), brandReference: id(2) },
    { ...input(), operationReference: "invalid" },
    { ...input(), sessionCredential: "bad" },
  ])("rejects invalid closed inputs before authority", async (value) => {
    const f = fixture();
    await expect(f.service.select(value)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
  });
  it("does not invoke caller accessors", async () => {
    const f = fixture();
    const getter = vi.fn(() => id(10));
    const value = input();
    Object.defineProperty(value, "operationReference", { get: getter });
    await expect(f.service.select(value)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
  });
  it.each([
    "CART_IDEMPOTENCY_CONFLICT",
    "CART_EXPIRED",
    "CART_ABANDONED",
    "CART_LIFECYCLE_UNAVAILABLE",
  ] as const)("preserves %s without dependency metadata", async (code) => {
    const f = fixture();
    const source = Object.assign(new CartError(code), {
      cause: new Error("synthetic private detail"),
      extra: "synthetic",
    });
    f.select.mockRejectedValue(source);
    const error = await f.service.select(input()).catch((value: unknown) => value);
    expect(error).not.toBe(source);
    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("extra");
  });
  it("bounds unknown owner and participation failures", async () => {
    for (const target of ["select", "participate"] as const) {
      const f = fixture();
      f[target].mockRejectedValue(new Error("synthetic private detail"));
      const error = await f.service.select(input()).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
        message: "cart is unavailable",
      });
      expect(error).not.toHaveProperty("cause");
    }
  });
  it("sanitizes a dependency's permission error", async () => {
    const f = fixture();
    f.participate.mockRejectedValue(
      Object.assign(new CartError("CART_PERMISSION_DENIED"), { cause: "synthetic" }),
    );
    const error = await f.service.select(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(error).not.toHaveProperty("cause");
    expect(f.select).not.toHaveBeenCalled();
  });
  it("denies a backwards clock before owner access", async () => {
    const f = fixture();
    f.now.mockReturnValueOnce(at()).mockReturnValue(at(-1));
    await expect(f.service.select(input())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.select).not.toHaveBeenCalled();
  });
});
