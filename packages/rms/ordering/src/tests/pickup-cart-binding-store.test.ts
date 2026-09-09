import { describe, expect, it, vi } from "vitest";
import { createGuestSession } from "@bop/identity";
import {
  createPostgresPickupCartBindingStore,
  createPostgresPickupCartBindingReader,
} from "../infrastructure/persistence/pickup-cart-binding-store.js";
const id = (n: number) => `018f5500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-08T12:00:00.000Z";
const later = "2026-09-08T12:05:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
const policy = {
  policyVersionReference: id(10),
  policyDigest: `sha256:${"a".repeat(64)}`,
  idleTimeoutSeconds: 3600,
  absoluteTimeoutSeconds: 86400,
  validFrom: at,
  validUntil: "2026-09-09T12:00:00.000Z",
};
function setup() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const run = vi.fn();
  const runner = {
    async run<T>(action: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
      run();
      return action({ query });
    },
  };
  const generateReference = vi.fn(() => id(20));
  const audit = vi.fn();
  const options = {
    ...scope,
    policy,
    sourceChannel: "Qr" as const,
    generateReference,
    audit,
    now: () => at,
  };
  return {
    query,
    run,
    runner,
    generateReference,
    audit,
    options,
    store: createPostgresPickupCartBindingStore(runner, options),
  };
}
const prepare = {
  ...scope,
  operationReference: id(11),
  targetReference: id(12),
  sessionReference: id(13),
  predecessorSessionReference: id(14),
  acknowledgedAt: at,
  validUntil: later,
  observedAt: at,
};
const session = createGuestSession({
  ...scope,
  sessionReference: id(14),
  status: "Active",
  version: 1,
  publicStoreReference: id(4),
  publicTableReference: null,
  channel: "Pickup",
  locale: "en-CA",
  qrReference: id(5),
  qrRevocationVersion: 1,
  diningState: "ContextOnly",
  diningSessionReference: null,
  diningParticipantReference: null,
  createdAt: at,
  lastSeenAt: at,
  idleExpiresAt: "2026-09-08T16:00:00.000Z",
  absoluteExpiresAt: "2026-09-09T12:00:00.000Z",
  orderClosedAt: null,
  closureExpiresAt: null,
  rotatedFromGuestSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
describe("initial Pickup binding owner boundary", () => {
  it.each([
    null,
    {},
    { ...prepare, secret: "synthetic" },
    { ...prepare, storeReference: id(99) },
    { ...prepare, sessionReference: id(14) },
    { ...prepare, observedAt: later },
    { ...prepare, observedAt: "2026-09-08T11:59:59.000Z" },
    { ...prepare, validUntil: "2026-09-08T12:15:01.000Z" },
  ])("rejects malformed or unauthorized preparation before SQL", async (input) => {
    const f = setup();
    const error = await f.store.prepare(input as never).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each([0, 1.5, 31536001])(
    "requires a bounded versioned lifecycle policy (%s)",
    (idleTimeoutSeconds) => {
      const f = setup();
      expect(() =>
        createPostgresPickupCartBindingStore(f.runner, {
          ...f.options,
          policy: { ...policy, idleTimeoutSeconds },
        }),
      ).toThrow();
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it("reserves a target without writing or generating Audit", async () => {
    const f = setup();
    const receipt = await f.store.reserveTarget({
      session,
      operationReference: id(11),
      observedAt: at as never,
    });
    expect(receipt).toMatchObject({ ...scope, targetReference: id(20), expectedVersion: 1 });
    expect(f.query.mock.calls.every(([sql]) => String(sql).startsWith("SELECT"))).toBe(true);
    expect(f.audit).not.toHaveBeenCalled();
  });
  it("does not reserve another target for an active binding", async () => {
    const f = setup();
    f.query.mockResolvedValue({ rows: [{ operation_id: id(11) }] });
    expect(
      await f.store.reserveTarget({ session, operationReference: id(11), observedAt: at as never }),
    ).toBeNull();
    expect(f.generateReference).not.toHaveBeenCalled();
  });
  it("rejects foreign, expired and future sessions before lookup", async () => {
    const f = setup();
    for (const value of [
      { ...session, storeReference: id(99) },
      { ...session, status: "Revoked" },
    ]) {
      await expect(f.store.current(value as never, at)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    }
    await expect(f.store.current(session, "2026-09-08T11:59:59.000Z")).rejects.toThrow();
    await expect(f.store.current(session, session.idleExpiresAt)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("validates activation scope and time before locking", async () => {
    const f = setup();
    const completion = {
      ...scope,
      operationReference: id(11),
      targetReference: id(12),
      sessionReference: id(13),
      activatedAt: later,
    };
    await expect(f.store.activate(completion as never)).rejects.toThrow();
    await expect(
      f.store.activate({ ...completion, storeReference: id(99), activatedAt: at } as never),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("bounds driver errors without leaking payloads", async () => {
    const f = setup();
    f.query.mockRejectedValue(new Error("synthetic restricted driver payload"));
    const error = await f.store.current(session, at).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});

describe("independent Pickup binding reader", () => {
  it("needs no creation policy, audit or reference provider and exposes no writes", async () => {
    const f = setup();
    const reader = createPostgresPickupCartBindingReader(f.runner, scope);
    expect(f.run).not.toHaveBeenCalled();
    expect(Object.keys(reader)).toEqual(["current"]);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(await reader.current(session, at)).toBeNull();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.query.mock.calls[0]?.[1]).toEqual([scope.brandReference, scope.storeReference]);
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      session.sessionReference,
      at,
    ]);
    expect(f.query.mock.calls.every(([sql]) => String(sql).startsWith("SELECT"))).toBe(true);
    expect(f.audit).not.toHaveBeenCalled();
  });
  it.each([
    { ...session, brandReference: id(99) },
    { ...session, storeReference: id(99) },
    { ...session, status: "Revoked" },
    { ...session, channel: "DineIn" },
  ])("denies invalid or foreign Guest evidence before SQL", async (value) => {
    const f = setup();
    await expect(
      createPostgresPickupCartBindingReader(f.runner, scope).current(value as never, at),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("bounds duplicate bindings and driver failures", async () => {
    const f = setup();
    const reader = createPostgresPickupCartBindingReader(f.runner, scope);
    f.query.mockResolvedValue({ rows: [{ cart_id: id(20) }, { cart_id: id(21) }] });
    await expect(reader.current(session, at)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    f.query.mockRejectedValue(new Error("synthetic restricted driver payload"));
    const error = await reader.current(session, at).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
