import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it, vi } from "vitest";
import { createCartLifecycleCommandService } from "../application/cart-lifecycle-command-service.js";
import type {
  CartLifecycleAction,
  CartLifecycleCommandPorts,
  CartLifecycleOperationRecord,
} from "../application/ports/cart-lifecycle-command-ports.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";
import {
  advanceCartLifecycle,
  assertCartLifecycleActive,
  createActiveCartLifecycle,
  expireCartLifecycle,
} from "../domain/cart-lifecycle.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  item: id(7),
  sellable: id(8),
  policyVersion: id(9),
  operation: id(10),
  audit: id(11),
  correlation: id(12),
};
const createdAt = "2026-08-02T14:00:00.000Z";
const abandonAt = "2026-08-02T14:10:00.000Z";
const idleDueAt = "2026-08-02T14:30:00.000Z";

function lifecycle() {
  return createActiveCartLifecycle({
    policyVersionReference: ids.policyVersion,
    policyDigest: `sha256:${"a".repeat(64)}`,
    idleTimeoutSeconds: 1800,
    absoluteTimeoutSeconds: 7200,
    startedAt: createdAt,
  });
}

function cart(overrides: Partial<CartAggregate> = {}) {
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
    lifecycle: lifecycle(),
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
        addedByParticipantReference: null,
        addedAt: createdAt,
      },
    ],
    ...overrides,
  });
}

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

function audit(action: CartLifecycleAction, at: string): AppendAuditRecordInput {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    storeId: ids.store,
    actor: { type: "System" },
    actionCode: `ORDERING_CART_${action.toUpperCase()}`,
    targetType: "OrderingCart",
    targetId: ids.cart,
    reasonCode: action === "Abandon" ? "AUTHORIZED_CART_ABANDONMENT" : "CART_DEADLINE_REACHED",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}

function hash(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}

function fixture(
  options: {
    cart?: CartAggregate | null;
    denied?: boolean;
    wrongAuthority?: boolean;
    auditOverride?: Partial<AppendAuditRecordInput>;
  } = {},
) {
  let aggregate = options.cart === undefined ? cart() : options.cart;
  const operations = new Map<string, CartLifecycleOperationRecord>();
  let commits = 0;
  const ports: CartLifecycleCommandPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          guestSession:
            input.action === "Abandon"
              ? options.wrongAuthority
                ? null
                : guest()
              : options.wrongAuthority
                ? guest()
                : null,
          audit: { ...audit(input.action, input.observedAt), ...options.auditOverride },
        };
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.cartReference === reference ? aggregate : null;
      },
      async commit(input) {
        if (aggregate?.aggregateVersion !== input.expectedAggregateVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        aggregate = input.record.result;
        operations.set(input.record.operationReference, input.record);
        commits += 1;
        return input.record;
      },
    },
  };
  return {
    ports,
    service: createCartLifecycleCommandService(ports),
    current: () => aggregate,
    commits: () => commits,
  };
}

describe("WP-1204 Cart lifecycle", () => {
  it("pins policy evidence and applies exact idle/absolute UTC boundaries", () => {
    const active = lifecycle();
    expect(active).toMatchObject({
      status: "Active",
      idleExpiresAt: idleDueAt,
      absoluteExpiresAt: "2026-08-02T16:00:00.000Z",
    });
    expect(() =>
      assertCartLifecycleActive(active, "2026-08-02T14:29:59.999Z" as never),
    ).not.toThrow();
    expect(() => assertCartLifecycleActive(active, idleDueAt as never)).toThrowError(
      expect.objectContaining({ code: "CART_EXPIRED" }),
    );
    expect(expireCartLifecycle(active, idleDueAt as never).terminalReason).toBe("IDLE_TIMEOUT");
    expect(expireCartLifecycle(active, "2026-08-02T16:00:00.000Z" as never).terminalReason).toBe(
      "ABSOLUTE_TIMEOUT",
    );
  });

  it("advances idle activity without passing the absolute deadline", () => {
    let advanced = lifecycle();
    for (const observedAt of [
      "2026-08-02T14:20:00.000Z",
      "2026-08-02T14:40:00.000Z",
      "2026-08-02T15:00:00.000Z",
      "2026-08-02T15:20:00.000Z",
      "2026-08-02T15:40:00.000Z",
    ])
      advanced = advanceCartLifecycle(advanced, observedAt as never);
    expect(advanced.idleExpiresAt).toBe("2026-08-02T16:00:00.000Z");
    expect(advanced.absoluteExpiresAt).toBe("2026-08-02T16:00:00.000Z");
  });

  it("abandons once, retains Cart Items and returns exact replay", async () => {
    const state = fixture();
    const input = {
      cartReference: ids.cart,
      expectedAggregateVersion: 1,
      operationReference: ids.operation,
      requestedAt: abandonAt,
    };
    const first = await state.service.abandon(input);
    const replay = await state.service.abandon(input);
    expect(first.aggregate).toMatchObject({
      aggregateVersion: 2,
      updatedAt: abandonAt,
      lifecycle: {
        status: "Abandoned",
        terminalAt: abandonAt,
        terminalReason: "CUSTOMER_ABANDONED",
      },
    });
    expect(first.aggregate.items).toHaveLength(1);
    expect(replay).toEqual({ status: "AlreadyApplied", aggregate: first.aggregate });
    expect(state.commits()).toBe(1);
  });

  it("expires only at a reached deadline and keeps absolute reason precedence", async () => {
    await expect(
      fixture().service.expire({
        cartReference: ids.cart,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        evaluatedAt: "2026-08-02T14:29:59.999Z",
      }),
    ).rejects.toMatchObject({ code: "CART_EXPIRATION_NOT_DUE" });
    const result = await fixture().service.expire({
      cartReference: ids.cart,
      expectedAggregateVersion: 1,
      operationReference: ids.operation,
      evaluatedAt: "2026-08-02T16:00:00.000Z",
    });
    expect(result.aggregate.lifecycle).toMatchObject({
      status: "Expired",
      terminalReason: "ABSOLUTE_TIMEOUT",
    });
  });

  it("rejects stale version, wrong authority, Audit mismatch and changed idempotent intent", async () => {
    await expect(
      fixture().service.abandon({
        cartReference: ids.cart,
        expectedAggregateVersion: 2,
        operationReference: ids.operation,
        requestedAt: abandonAt,
      }),
    ).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
    await expect(
      fixture({ wrongAuthority: true }).service.abandon({
        cartReference: ids.cart,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        requestedAt: abandonAt,
      }),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    await expect(
      fixture({ auditOverride: { storeId: id(50) } }).service.expire({
        cartReference: ids.cart,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        evaluatedAt: idleDueAt,
      }),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    const state = fixture();
    await state.service.abandon({
      cartReference: ids.cart,
      expectedAggregateVersion: 1,
      operationReference: ids.operation,
      requestedAt: abandonAt,
    });
    await expect(
      state.service.expire({
        cartReference: ids.cart,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        evaluatedAt: abandonAt,
      }),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed for legacy and terminal lifecycle state", async () => {
    const legacy = cart({ lifecycle: null });
    await expect(
      fixture({ cart: legacy }).service.expire({
        cartReference: ids.cart,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        evaluatedAt: idleDueAt,
      }),
    ).rejects.toMatchObject({ code: "CART_LIFECYCLE_UNAVAILABLE" });
    const expiredLifecycle = expireCartLifecycle(lifecycle(), idleDueAt as never);
    const expired = cart({
      aggregateVersion: 2,
      updatedAt: idleDueAt as never,
      lifecycle: expiredLifecycle,
    });
    await expect(
      fixture({ cart: expired }).service.abandon({
        cartReference: ids.cart,
        expectedAggregateVersion: 2,
        operationReference: ids.operation,
        requestedAt: "2026-08-02T14:31:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CART_EXPIRED" });
  });
});

describe("WP-2233 lifecycle authority and delayed retry", () => {
  const input = (
    action: CartLifecycleAction,
    at = action === "Abandon" ? abandonAt : idleDueAt,
  ) => ({
    cartReference: ids.cart,
    expectedAggregateVersion: 1,
    operationReference: ids.operation,
    [action === "Abandon" ? "requestedAt" : "evaluatedAt"]: at,
  });
  const run = (state: ReturnType<typeof fixture>, action: CartLifecycleAction, value: unknown) =>
    action === "Abandon" ? state.service.abandon(value) : state.service.expire(value);

  it.each(["Abandon", "Expire"] as const)(
    "replays delayed %s without rewriting history",
    async (action) => {
      const state = fixture();
      const first = await run(state, action, input(action));
      const replay = await run(state, action, input(action, "2026-08-02T15:00:00.000Z"));
      expect(replay).toEqual({ status: "AlreadyApplied", aggregate: first.aggregate });
      expect(state.commits()).toBe(1);
    },
  );

  it.each(["Abandon", "Expire"] as const)(
    "denies wrong %s authority before reads",
    async (action) => {
      const state = fixture({ wrongAuthority: true });
      const resolve = vi.spyOn(state.ports.repository, "resolveOperation");
      const load = vi.spyOn(state.ports.repository, "load");
      await expect(run(state, action, input(action))).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    },
  );

  it.each(["Revoked", "Expired", "Malformed"])("denies %s Session before reads", async (kind) => {
    const state = fixture();
    const invalidGuest =
      kind === "Revoked"
        ? guest({ status: "Revoked" })
        : kind === "Expired"
          ? guest({ idleExpiresAt: abandonAt as never })
          : { ...guest(), version: 0 };
    vi.spyOn(state.ports.authorization, "authorize").mockResolvedValue({
      guestSession: invalidGuest,
      audit: audit("Abandon", abandonAt),
    });
    const resolve = vi.spyOn(state.ports.repository, "resolveOperation");
    await expect(state.service.abandon(input("Abandon"))).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a substituted Cart before revealing its version", async () => {
    const state = fixture();
    vi.spyOn(state.ports.repository, "load").mockResolvedValue(
      cart({ cartReference: id(90) as never, items: [], aggregateVersion: 2 }),
    );
    await expect(state.service.abandon(input("Abandon"))).rejects.toMatchObject({
      code: "CART_UNAVAILABLE",
    });
    expect(state.commits()).toBe(0);
  });

  it("denies foreign scope before a version conflict", async () => {
    const state = fixture({ cart: cart({ storeReference: id(90) as never, aggregateVersion: 2 }) });
    await expect(state.service.abandon(input("Abandon"))).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
  });

  it.each(["guest", "scope", "time", "items"])("rejects substituted commit %s", async (kind) => {
    const state = fixture();
    const commit = state.ports.repository.commit;
    vi.spyOn(state.ports.repository, "commit").mockImplementation(async (value) => {
      const saved = await commit(value);
      if (kind === "guest") return { ...saved, guestSessionReference: id(90) as never };
      if (kind === "scope")
        return { ...saved, result: { ...saved.result, storeReference: id(90) as never } };
      if (kind === "time")
        return {
          ...saved,
          occurredAt: "2026-08-02T14:11:00.000Z" as never,
          expiresAt: "2026-08-03T14:11:00.000Z" as never,
        };
      return { ...saved, result: { ...saved.result, items: [] } };
    });
    await expect(state.service.abandon(input("Abandon"))).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rejects exact expiry and changed version on delayed replay", async () => {
    const state = fixture();
    await state.service.expire(input("Expire"));
    await expect(
      state.service.expire(input("Expire", "2026-08-03T14:30:00.000Z")),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
    await expect(
      state.service.expire({
        ...input("Expire", "2026-08-02T15:00:00.000Z"),
        expectedAggregateVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
    expect(state.commits()).toBe(1);
  });
  it("checks current Audit and Session authority on delayed replay", async () => {
    const state = fixture();
    await state.service.abandon(input("Abandon"));
    const resolve = vi.spyOn(state.ports.repository, "resolveOperation");
    const authorize = vi.spyOn(state.ports.authorization, "authorize");
    authorize.mockResolvedValue({ guestSession: guest(), audit: audit("Abandon", abandonAt) });
    await expect(
      state.service.abandon(input("Abandon", "2026-08-02T15:00:00.000Z")),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    resolve.mockClear();
    authorize.mockResolvedValue({
      guestSession: guest({ status: "Revoked" }),
      audit: audit("Abandon", abandonAt),
    });
    await expect(state.service.abandon(input("Abandon"))).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(state.commits()).toBe(1);
  });

  it("rejects an operation reader substituting the operation identity", async () => {
    const state = fixture();
    await state.service.expire(input("Expire"));
    const resolve = state.ports.repository.resolveOperation;
    vi.spyOn(state.ports.repository, "resolveOperation").mockImplementation(async (reference) => {
      const saved = await resolve(reference);
      if (saved === null) throw new Error("missing synthetic operation");
      return { ...saved, operationReference: id(90) as never };
    });
    await expect(state.service.expire(input("Expire"))).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });
});
