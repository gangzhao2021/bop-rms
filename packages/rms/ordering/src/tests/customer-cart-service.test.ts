import { createHash } from "node:crypto";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it } from "vitest";
import { createCustomerCartService } from "../application/customer-cart-service.js";
import type {
  CustomerCartPorts,
  CustomerCartCreationRecord,
} from "../application/ports/customer-cart-ports.js";
import { CartError, type CartAggregate } from "../domain/cart.js";
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

function fixture() {
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
const input = (n = 30, at = createdAt) => ({ operationReference: id(n), requestedAt: at });

describe("Customer Cart creation/current ownership", () => {
  it("reads without creation and creates an empty policy-pinned version-1 Pickup cart", async () => {
    const f = fixture();
    expect(await f.service.current({ requestedAt: createdAt })).toEqual({ status: "NotFound" });
    const result = await f.service.create(input());
    expect(result.status).toBe("Created");
    expect(result.aggregate).toMatchObject({
      createdByActorReference: ids.session,
      orderType: "Pickup",
      aggregateVersion: 1,
      items: [],
      lifecycle: { status: "Active", idleExpiresAt: "2026-08-02T15:00:00.000Z" },
    });
    expect(await f.service.current({ requestedAt: createdAt })).toEqual({
      status: "Found",
      aggregate: result.aggregate,
    });
    expect(f.counts()).toMatchObject({ carts: 1, operations: 1, audits: 1 });
  });
  it("replays the immutable original result without a second audit or policy lookup", async () => {
    const f = fixture();
    const first = await f.service.create(input());
    f.ports.policy.resolve = async () => {
      throw new Error();
    };
    expect(await f.service.create(input(30, "2026-08-02T16:00:00.000Z"))).toEqual({
      status: "AlreadyApplied",
      aggregate: first.aggregate,
    });
    expect(f.counts()).toMatchObject({ carts: 1, operations: 1, audits: 1 });
  });
  it("converges concurrent identical and different keys on one current Cart", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.create(input()),
      f.service.create(input()),
      f.service.create(input(31)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["Created", "AlreadyApplied", "Current"]);
    expect(new Set(results.map((r) => r.aggregate.cartReference)).size).toBe(1);
    expect(f.counts()).toMatchObject({ carts: 1, operations: 2, audits: 2 });
  });
  it("shares a DiningBound Cart across Participants, retaining its original creator", async () => {
    const f = fixture();
    const dining = {
      channel: "DineIn",
      publicTableReference: id(40) as never,
      diningState: "DiningBound",
      diningSessionReference: id(41) as never,
      diningParticipantReference: id(42) as never,
    } as Partial<GuestSession>;
    f.session(guest(dining));
    const first = await f.service.create(input());
    f.session(
      guest({
        ...dining,
        sessionReference: id(43) as never,
        diningParticipantReference: id(44) as never,
      }),
    );
    const second = await f.service.create(input(31));
    expect(second.status).toBe("Current");
    expect(second.aggregate).toEqual(first.aggregate);
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });
  it.each([
    null,
    guest({
      status: "Revoked",
      revokedAt: createdAt as never,
      revocationReason: "CUSTOMER_LOGOUT" as never,
    }),
    guest({ channel: "DineIn", publicTableReference: id(40) as never }),
    guest({ idleExpiresAt: createdAt as never }),
  ])("denies unusable or unbound Sessions before repository access", async (session) => {
    const f = fixture();
    f.session(session);
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    await expect(f.service.current({ requestedAt: createdAt })).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.counts().reads).toBe(0);
  });
  it("isolates Pickup Sessions and Stores and rejects cross-owner operation reuse", async () => {
    const f = fixture();
    await f.service.create(input());
    f.session(guest({ sessionReference: id(60) as never }));
    expect(await f.service.current({ requestedAt: createdAt })).toEqual({ status: "NotFound" });
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
    await f.service.create(input(31));
    f.session(guest({ storeReference: id(61) as never }));
    expect(await f.service.current({ requestedAt: createdAt })).toEqual({ status: "NotFound" });
  });
  it("re-authorizes replay after Session expiry", async () => {
    const f = fixture();
    await f.service.create(input());
    f.session(null);
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.counts().reads).toBe(2);
  });
  it("denies an expired retained operation record", async () => {
    const f = fixture();
    const result = await f.service.create(input());
    const run = f.ports.repository.run;
    f.ports.repository.run = (owner, operation, action) =>
      run(owner, operation, (tx) =>
        action({
          ...tx,
          async resolveOperation(reference) {
            const prior = await tx.resolveOperation(reference);
            return prior === null ? null : { ...prior, expiresAt: createdAt as never };
          },
        }),
      );
    expect(result.status).toBe("Created");
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });
  it("does not renew or silently replace an elapsed current Cart", async () => {
    const f = fixture();
    await f.service.create(input());
    await expect(
      f.service.current({ requestedAt: "2026-08-02T15:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "CART_EXPIRED" });
    await expect(f.service.create(input(31, "2026-08-02T15:00:00.000Z"))).rejects.toMatchObject({
      code: "CART_EXPIRED",
    });
    expect(f.counts()).toMatchObject({ carts: 1, operations: 1, audits: 1 });
  });
  it.each(["scope", "legacy", "future"])(
    "fails closed on invalid current %s evidence",
    async (kind) => {
      const f = fixture();
      await f.service.create(input());
      f.corrupt((cart) =>
        kind === "scope"
          ? { ...cart, storeReference: id(70) as never }
          : kind === "legacy"
            ? { ...cart, lifecycle: null }
            : { ...cart, updatedAt: "2026-08-02T14:01:00.000Z" as never },
      );
      await expect(f.service.current({ requestedAt: createdAt })).rejects.toBeInstanceOf(CartError);
    },
  );
  it("rolls back Cart, operation and audit on failure and sanitizes dependency errors", async () => {
    const f = fixture();
    f.fail();
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(f.counts()).toMatchObject({ carts: 0, operations: 0, audits: 0 });
  });
  it("rejects mismatched audit scope before committing", async () => {
    const f = fixture();
    const prepare = f.ports.audit.prepare;
    f.ports.audit.prepare = async (input) => ({ ...(await prepare(input)), storeId: id(80) });
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(f.counts()).toMatchObject({ carts: 0, operations: 0, audits: 0 });
  });
  it("requires an explicit lifecycle source and rejects client scope and hostile accessors", async () => {
    const f = fixture();
    await expect(
      f.service.create({ ...input(), storeReference: id(90) as never }),
    ).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    let touched = false;
    await expect(
      f.service.create({
        operationReference: id(30),
        get requestedAt() {
          touched = true;
          return createdAt;
        },
      }),
    ).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(touched).toBe(false);
    f.ports.policy.resolve = async () => null;
    await expect(f.service.create(input())).rejects.toMatchObject({
      code: "CART_LIFECYCLE_UNAVAILABLE",
    });
    expect(f.counts()).toMatchObject({ carts: 0, operations: 0, audits: 0 });
  });
});
