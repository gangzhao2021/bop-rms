import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { describe, expect, it } from "vitest";
import { createCartItemCommandService } from "../application/cart-item-command-service.js";
import type {
  CartItemCommandPorts,
  CartItemOperationAction,
  CartItemOperationRecord,
} from "../application/ports/cart-item-command-ports.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";

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

function audit(action: CartItemOperationAction, at = requestedAt): AppendAuditRecordInput {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    storeId: ids.store,
    actor: { type: "System" },
    actionCode: `ORDERING_CART_ITEM_${action.toUpperCase()}`,
    targetType: "OrderingCart",
    targetId: ids.cart,
    reasonCode: "AUTHORIZED_CART_MUTATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}

function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}

function fixture(
  options: {
    aggregate?: CartAggregate;
    session?: GuestSession;
    auditOverride?: Partial<AppendAuditRecordInput>;
    denied?: boolean;
    catalogMode?: "Rejected" | "Mismatch" | "Failure";
  } = {},
) {
  let aggregate = options.aggregate ?? cart();
  const operations = new Map<string, CartItemOperationRecord>();
  let generated = 0;
  let validations = 0;
  const ports: CartItemCommandPorts = {
    catalog: {
      async validateSelection(input) {
        validations += 1;
        if (options.catalogMode === "Failure") throw new Error("synthetic Catalog failure");
        if (options.catalogMode === "Rejected")
          return { status: "Rejected", reason: "OPTION_NOT_ENABLED" };
        return {
          status: "Accepted",
          ...input,
          storeReference:
            options.catalogMode === "Mismatch" ? (id(90) as never) : input.storeReference,
          menuVersionReference: ids.menuVersion as never,
          productVersionReference: ids.productVersion as never,
          catalogChannelCode: "PILOT_CHANNEL",
          catalogOrderTypeCode: "PILOT_ORDER_TYPE",
          ruleEvidence: [
            {
              bindingReference: ids.binding as never,
              optionSetVersionReference: ids.optionSetVersion as never,
            },
          ],
          validatedAt: input.observedAt,
        };
      },
    },
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          guestSession: options.session ?? guest(),
          audit: { ...audit(input.action, input.observedAt), ...options.auditOverride },
        } as never;
      },
    },
    references: {
      generate() {
        generated += 1;
        return ids.item;
      },
      hashIntent: digest,
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return reference === aggregate.cartReference ? aggregate : null;
      },
      async commit(input) {
        if (aggregate.aggregateVersion !== input.expectedAggregateVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        aggregate = input.record.result;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return {
    service: createCartItemCommandService(ports),
    current: () => aggregate,
    generated: () => generated,
    operations: () => operations.size,
    validations: () => validations,
  };
}

function addInput(overrides: Record<string, unknown> = {}) {
  return {
    cartReference: ids.cart,
    expectedAggregateVersion: 1,
    sellableReference: ids.sellable,
    quantity: 2,
    optionSelections: [{ optionReference: ids.option, quantity: 1 }],
    customerNote: "Extra napkins",
    operationReference: ids.operation,
    requestedAt,
    ...overrides,
  };
}

describe("Cart Item Add / Update / Remove commands", () => {
  it("adds exactly once and returns the original result for an exact idempotent retry", async () => {
    const state = fixture();
    const first = await state.service.add(addInput());
    const retry = await state.service.add(addInput());
    expect(first).toMatchObject({ status: "Applied", cartItemReference: ids.item });
    expect(retry).toMatchObject({ status: "AlreadyApplied", cartItemReference: ids.item });
    expect(retry.aggregate).toEqual(first.aggregate);
    expect(state.current()).toMatchObject({ aggregateVersion: 2 });
    expect(state.current().lifecycle?.idleExpiresAt).toBe("2026-08-02T15:01:00.000Z");
    expect(state.current().items).toHaveLength(1);
    expect(state.current().items[0]?.catalogSelectionEvidence).toMatchObject({
      menuVersionReference: ids.menuVersion,
      productVersionReference: ids.productVersion,
      ruleEvidence: [{ bindingReference: ids.binding }],
    });
    expect(state.generated()).toBe(1);
    expect(state.validations()).toBe(1);
  });

  it("rejects one idempotency key reused with changed intent", async () => {
    const state = fixture();
    await state.service.add(addInput());
    await expect(state.service.add(addInput({ quantity: 3 }))).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });

  it("updates mutable configuration then removes the Item without changing stable attribution", async () => {
    const state = fixture();
    const added = await state.service.add(addInput());
    const updated = await state.service.update({
      cartReference: ids.cart,
      cartItemReference: ids.item,
      expectedAggregateVersion: 2,
      quantity: 3,
      optionSelections: [],
      customerNote: "  No cutlery  ",
      operationReference: ids.secondOperation,
      requestedAt: "2026-08-02T14:02:00.000Z",
    });
    expect(updated.aggregate.items[0]).toMatchObject({
      cartItemReference: ids.item,
      sellableReference: ids.sellable,
      addedByActorReference: ids.session,
      addedAt: requestedAt,
      quantity: 3,
      customerNote: "No cutlery",
    });
    expect(updated.aggregate.items[0]?.sellableReference).toBe(
      added.aggregate.items[0]?.sellableReference,
    );
    const removed = await state.service.remove({
      cartReference: ids.cart,
      cartItemReference: ids.item,
      expectedAggregateVersion: 3,
      operationReference: ids.thirdOperation,
      requestedAt: "2026-08-02T14:03:00.000Z",
    });
    expect(removed.aggregate).toMatchObject({ aggregateVersion: 4, items: [] });
  });

  it("fails closed on stale version, missing Item and forbidden client price", async () => {
    const state = fixture();
    await expect(
      state.service.add(addInput({ expectedAggregateVersion: 2 })),
    ).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
    await expect(
      state.service.remove({
        cartReference: ids.cart,
        cartItemReference: ids.item,
        expectedAggregateVersion: 1,
        operationReference: ids.secondOperation,
        requestedAt,
      }),
    ).rejects.toMatchObject({ code: "CART_ITEM_NOT_FOUND" });
    await expect(state.service.add(addInput({ clientPrice: 100 }))).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
  });

  it("fails closed for legacy, due and terminal Cart lifecycle", async () => {
    await expect(
      fixture({ aggregate: cart({ lifecycle: null }) }).service.add(addInput()),
    ).rejects.toMatchObject({
      code: "CART_LIFECYCLE_UNAVAILABLE",
    });
    const due = cart({
      lifecycle: {
        ...cart().lifecycle,
        idleExpiresAt: requestedAt,
      } as never,
    });
    await expect(fixture({ aggregate: due }).service.add(addInput())).rejects.toMatchObject({
      code: "CART_EXPIRED",
    });
    const abandonedAt = "2026-08-02T14:00:30.000Z";
    const abandoned = cart({
      aggregateVersion: 2,
      updatedAt: abandonedAt as never,
      lifecycle: {
        ...cart().lifecycle,
        status: "Abandoned",
        terminalAt: abandonedAt,
        terminalReason: "CUSTOMER_ABANDONED",
      } as never,
    });
    await expect(
      fixture({ aggregate: abandoned }).service.add(addInput({ expectedAggregateVersion: 2 })),
    ).rejects.toMatchObject({ code: "CART_ABANDONED" });
  });

  it("rejects wrong Store, expired session and mismatched Audit", async () => {
    await expect(
      fixture({ session: guest({ storeReference: id(30) as never }) }).service.add(addInput()),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    await expect(
      fixture({
        session: guest({
          createdAt: "2026-08-01T15:00:00.000Z" as never,
          lastSeenAt: "2026-08-02T10:01:00.000Z" as never,
          idleExpiresAt: requestedAt as never,
          absoluteExpiresAt: "2026-08-02T15:00:00.000Z" as never,
        }),
      }).service.add(addInput()),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    await expect(
      fixture({ auditOverride: { storeId: id(31) } }).service.add(addInput()),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
  });

  it("allows a Dine-in Participant to change only their own Item", async () => {
    const ownItem = {
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
    };
    const diningCart = cart({
      orderType: "DineIn",
      diningSessionReference: ids.diningSession as never,
      items: [ownItem] as never,
    });
    const diningGuest = guest({
      channel: "DineIn",
      diningState: "DiningBound",
      diningSessionReference: ids.diningSession as never,
      diningParticipantReference: ids.participant as never,
      publicTableReference: id(32) as never,
    });
    const own = fixture({ aggregate: diningCart, session: diningGuest });
    await expect(
      own.service.remove({
        cartReference: ids.cart,
        cartItemReference: ids.item,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        requestedAt,
      }),
    ).resolves.toMatchObject({ status: "Applied", aggregate: { items: [] } });

    const other = fixture({
      aggregate: diningCart,
      session: guest({
        ...diningGuest,
        sessionReference: ids.otherSession as never,
        diningParticipantReference: ids.otherParticipant as never,
      }),
    });
    await expect(
      other.service.remove({
        cartReference: ids.cart,
        cartItemReference: ids.item,
        expectedAggregateVersion: 1,
        operationReference: ids.operation,
        requestedAt,
      }),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
  });

  it("bounds sensitive Customer Note and rejects accessor-bearing commands", async () => {
    await expect(
      fixture().service.add(addInput({ customerNote: "x".repeat(501) })),
    ).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    const input = addInput();
    const hostile = Object.defineProperty({ ...input }, "quantity", {
      enumerable: true,
      get: () => 2,
    });
    await expect(fixture().service.add(hostile)).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    const hostileOption = Object.defineProperty(
      { optionReference: ids.option, quantity: 1 },
      "quantity",
      { enumerable: true, get: () => 1 },
    );
    await expect(
      fixture().service.add(addInput({ optionSelections: [hostileOption] })),
    ).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
  });

  it("fails closed when Catalog rejects, mismatches or cannot validate the selection", async () => {
    await expect(
      fixture({ catalogMode: "Rejected" }).service.add(addInput()),
    ).rejects.toMatchObject({ code: "CART_SELECTION_INVALID" });
    await expect(
      fixture({ catalogMode: "Mismatch" }).service.add(addInput()),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    await expect(fixture({ catalogMode: "Failure" }).service.add(addInput())).rejects.toMatchObject(
      { code: "CART_DEPENDENCY_UNAVAILABLE" },
    );
  });
});

describe("WP-2026 concurrent Cart update scenario", () => {
  it("commits one winner, rejects the stale contender and replays only the winner", async () => {
    const state = fixture();
    const firstInput = addInput();
    const secondInput = addInput({
      operationReference: ids.secondOperation,
      quantity: 3,
      customerNote: "No cutlery",
      requestedAt: "2026-08-02T14:01:01.000Z",
    });

    const results = await Promise.allSettled([
      state.service.add(firstInput),
      state.service.add(secondInput),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof state.service.add>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({
      status: "Applied",
      aggregate: { aggregateVersion: 2 },
    });
    expect(rejected[0]?.reason).toEqual(new CartError("CART_VERSION_CONFLICT"));
    expect(state.current()).toEqual(fulfilled[0]?.value.aggregate);
    expect(state.current().items).toHaveLength(1);
    expect(state.operations()).toBe(1);
    expect(state.validations()).toBe(2);

    const winnerInput = results[0]?.status === "fulfilled" ? firstInput : secondInput;
    const loserInput = results[0]?.status === "rejected" ? firstInput : secondInput;
    await expect(state.service.add(winnerInput)).resolves.toMatchObject({
      status: "AlreadyApplied",
      aggregate: { aggregateVersion: 2 },
    });
    await expect(state.service.add(loserInput)).rejects.toEqual(
      new CartError("CART_VERSION_CONFLICT"),
    );
    expect(state.operations()).toBe(1);
    expect(state.validations()).toBe(2);
  });
});
