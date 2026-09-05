import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GuestSessionError, type GuestSession } from "@bop/identity";
import {
  createCustomerCartService,
  type CartAggregate,
  type CustomerCartCreationRecord,
  type CustomerCartPorts,
} from "@rms/ordering";
import { createCustomerCartComposition } from "./customer-cart-composition.js";
const id = (n: number) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { session: id(1), brand: id(2), store: id(3), publicStore: id(4), qr: id(5) };
const createdAt = "2026-08-02T14:00:00.000Z";
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

function domainFixture() {
  let session: GuestSession | null = guest();
  let nextId = 100;
  let queue = Promise.resolve();
  let carts = new Map<string, CartAggregate>();
  let operations = new Map<string, CustomerCartCreationRecord>();
  let audits = 0;
  let reads = 0;
  let fail = false;
  const ports: CustomerCartPorts = {
    authorization: {
      async authorize() {
        return session;
      },
    },
    policy: {
      async resolve() {
        return {
          policyVersionReference: id(20),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          sourceChannel: "Qr",
        };
      },
    },
    references: {
      generate: () => id(nextId++),
      hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    audit: {
      async prepare(input) {
        return {
          auditId: id(nextId++),
          brandId: input.owner.brandReference,
          storeId: input.owner.storeReference,
          actor: { type: "System" },
          actionCode: "ORDERING_CART_CREATE",
          targetType: "OrderingCart",
          targetId: input.cartReference,
          reasonCode: "AUTHORIZED_CART_MUTATION",
          correlationId: input.operationReference,
          occurredAt: input.occurredAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        };
      },
    },
    repository: {
      async run(owner, _operationReference, action) {
        const preceding = queue;
        let release: () => void = () => {
          throw new Error("transaction lock was not initialized");
        };
        queue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await preceding;
        const stagedCarts = new Map(carts);
        const stagedOperations = new Map(operations);
        let stagedAudits = audits;
        const key = JSON.stringify(owner);
        try {
          const result = await action({
            async resolveOperation(reference) {
              reads++;
              return stagedOperations.get(reference) ?? null;
            },
            async loadCurrent() {
              reads++;
              return stagedCarts.get(key) ?? null;
            },
            async commit(record) {
              stagedCarts.set(key, record.aggregate);
              stagedOperations.set(record.operationReference, record);
              stagedAudits++;
              if (fail) throw new Error("private dependency payload");
            },
          });
          carts = stagedCarts;
          operations = stagedOperations;
          audits = stagedAudits;
          return result;
        } finally {
          release();
        }
      },
    },
  };
  return {
    ports,
    service: createCustomerCartService(ports),
    session: (value: GuestSession | null) => {
      session = value;
    },
    fail: () => {
      fail = true;
    },
    counts: () => ({ carts: carts.size, operations: operations.size, audits, reads }),
    corrupt: (mutate: (cart: CartAggregate) => CartAggregate) => {
      for (const [key, cart] of carts) carts.set(key, mutate(cart));
    },
    operations,
  };
}

function fixture() {
  const f = domainFixture();
  const authorize = vi.fn(async () => guest());
  const resolve = vi.fn(async () => guest());
  const display = {
    resolve: vi.fn(async (request) => ({
      ...request,
      brandName: "Synthetic Brand",
      storeName: "Synthetic Store",
      serviceMode: request.orderType,
    })),
  };
  const composition = createCustomerCartComposition({
    session: { authorize, resolve },
    ordering: () => f.ports,
    display,
  });
  return { ...f, composition, authorize, resolve, display };
}
const command = {
  guestCredential: "g".repeat(43),
  csrfCredential: "c".repeat(43),
  operationReference: id(30),
  requestedAt: createdAt,
};
describe("Customer Cart public composition", () => {
  it("creates/replays a minimized Ordering DTO with Identity-owned CSRF authorization", async () => {
    const f = fixture();
    const result = await f.composition.createCart(command);
    expect(result.status).toBe("Applied");
    expect(f.authorize).toHaveBeenCalledWith({
      sessionCredential: command.guestCredential,
      csrfCredential: command.csrfCredential,
      observedAt: createdAt,
    });
    expect(await f.composition.createCart(command)).toMatchObject({
      status: "Current",
      view: (result as { view: unknown }).view,
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "brandReference",
      "createdByActorReference",
      "policyDigest",
      command.guestCredential,
      command.csrfCredential,
    ])
      expect(serialized).not.toContain(secret);
    expect(f.counts()).toMatchObject({ carts: 1, operations: 1, audits: 1 });
  });
  it("resolves reads as Background and conceals foreign Cart references", async () => {
    const f = fixture();
    expect(await f.composition.getCurrentCart(command)).toEqual({ status: "NotFound" });
    await f.composition.createCart(command);
    expect((await f.composition.getCurrentCart(command)).status).toBe("Found");
    expect(f.resolve).toHaveBeenCalledWith({
      sessionCredential: command.guestCredential,
      activity: "Background",
      observedAt: createdAt,
    });
    expect(await f.composition.getCart({ ...command, cartReference: id(900) })).toEqual({
      status: "NotFound",
    });
  });
  it("rechecks authorization on replay and never passes raw credentials to display", async () => {
    const f = fixture();
    await f.composition.createCart(command);
    expect(f.display.resolve.mock.calls[0]?.[0]).not.toHaveProperty("guestCredential");
    f.authorize.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
    expect(await f.composition.createCart(command)).toEqual({ status: "SessionExpired" });
    expect(f.counts()).toMatchObject({ carts: 1, audits: 1 });
  });
  it("rejects missing/mismatched display before a write", async () => {
    const f = fixture();
    f.display.resolve.mockImplementation(async (request) => ({
      ...request,
      brandName: "Synthetic",
      storeName: "Synthetic",
      serviceMode: request.orderType,
      storeReference: id(901),
    }));
    expect(await f.composition.createCart(command)).toEqual({ status: "Unavailable" });
    expect(f.counts()).toMatchObject({ carts: 0, audits: 0 });
  });
  it("does not present a changed Cart as an empty Cart", async () => {
    const f = fixture();
    await f.composition.createCart(command);
    f.corrupt((cart) => ({ ...cart, aggregateVersion: 2 }));
    expect(await f.composition.getCurrentCart(command)).toEqual({ status: "Unavailable" });
  });
  it("isolates overlapping authorized Sessions", async () => {
    const f = fixture();
    f.authorize
      .mockResolvedValueOnce(guest())
      .mockResolvedValueOnce(guest({ sessionReference: id(77) as never }));
    const results = await Promise.all([
      f.composition.createCart(command),
      f.composition.createCart({
        ...command,
        operationReference: id(31),
        guestCredential: "x".repeat(43),
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["Applied", "Applied"]);
    expect(f.counts()).toMatchObject({ carts: 2, audits: 2 });
  });
  it("sanitizes dependency failures and leaves unimplemented item commands unavailable", async () => {
    const f = fixture();
    f.fail();
    expect(await f.composition.createCart(command)).toEqual({ status: "Unavailable" });
    expect(
      await f.composition.removeItem({
        ...command,
        cartReference: id(1),
        cartItemReference: id(2),
        expectedCartVersion: 1,
      }),
    ).toEqual({ status: "Unavailable" });
    expect(f.counts()).toMatchObject({ carts: 0, audits: 0 });
  });
});
