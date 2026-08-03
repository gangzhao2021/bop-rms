import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import { resolveStoreBusinessDate } from "@rms/store";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrderCreationService } from "../application/order-creation-service.js";
import type { OrderCreationPorts } from "../application/ports/order-creation-ports.js";
import { parseCartAggregate } from "../domain/cart.js";
import { parseCheckoutValidationEvidence } from "../domain/checkout-validation.js";
import {
  OrderCreationError,
  parseOrderCreationRecord,
  type OrderCreationRecord,
} from "../domain/order-creation.js";
import { createOrderNumberAllocation } from "../domain/order-number.js";

const id = (n: number) => `018f6200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const at = "2026-08-02T18:01:00.000Z";
const refs = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  item: id(5),
  sellable: id(6),
  productVersion: id(7),
  menuVersion: id(8),
  quote: id(9),
  submission: id(10),
  validation: id(11),
  fulfillment: id(12),
  order: id(13),
  batch: id(14),
  orderItem: id(15),
  event: id(16),
};

function guest(overrides: Partial<GuestSession> = {}): GuestSession {
  return {
    sessionReference: refs.session,
    status: "Active",
    version: 1,
    brandReference: refs.brand,
    storeReference: refs.store,
    publicStoreReference: id(20),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: id(21),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-02T16:00:00.000Z" as never,
    lastSeenAt: "2026-08-02T18:00:00.000Z" as never,
    idleExpiresAt: "2026-08-02T22:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-03T16:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  } as GuestSession;
}

function cart() {
  return parseCartAggregate({
    cartReference: refs.cart,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: refs.session,
    aggregateVersion: 5,
    createdAt: "2026-08-02T17:00:00.000Z",
    updatedAt: "2026-08-02T17:55:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(22),
      policyDigest: digest("a"),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T19:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T17:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: refs.item,
        cartReference: refs.cart,
        sellableReference: refs.sellable,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: {
          menuVersionReference: refs.menuVersion,
          productVersionReference: refs.productVersion,
          catalogChannelCode: "PILOT_CHANNEL",
          catalogOrderTypeCode: "PILOT_ORDER_TYPE",
          ruleEvidence: [],
          validatedAt: "2026-08-02T17:55:00.000Z",
        },
        addedByActorReference: refs.session,
        addedByParticipantReference: null,
        addedAt: "2026-08-02T17:30:00.000Z",
      },
    ],
  });
}

function evidence(overrides: Record<string, unknown> = {}) {
  return parseCheckoutValidationEvidence({
    validationReference: refs.validation,
    validationIntentHash: digest("b"),
    guestSessionReference: refs.session,
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: 5,
    quoteReference: refs.quote,
    quoteVersion: 1,
    quoteInputDigest: digest("c"),
    orderType: "Pickup",
    sourceChannel: "Qr",
    catalogLines: [
      {
        cartItemReference: refs.item,
        sellableReference: refs.sellable,
        menuVersionReference: refs.menuVersion,
        productVersionReference: refs.productVersion,
        validatedAt: at,
      },
    ],
    fulfillment: {
      status: "Accepted",
      brandReference: refs.brand,
      storeReference: refs.store,
      cartReference: refs.cart,
      cartVersion: 5,
      quoteReference: refs.quote,
      orderType: "Pickup",
      sourceChannel: "Qr",
      evidenceReference: refs.fulfillment,
      evidenceVersion: 1,
      evidenceDigest: digest("d"),
      checkedAt: at,
      validUntil: "2026-08-02T18:05:00.000Z",
    },
    validatedAt: at,
    validUntil: "2026-08-02T18:05:00.000Z",
    ...overrides,
  });
}

function catalog() {
  return {
    snapshotReference: id(30),
    snapshotDigest: digest("e"),
    brandReference: refs.brand,
    storeReference: refs.store,
    sellableReference: refs.sellable,
    sellableType: "Sku" as const,
    productReference: id(31),
    productVersionReference: refs.productVersion,
    skuReference: id(32),
    menuVersionReference: refs.menuVersion,
    localizedNames: { "en-CA": "Synthetic burger" },
    unitOfSale: "EACH",
    unitQuantity: "1",
    taxClassificationReference: id(33),
    options: [],
    capturedAt: at as never,
  };
}

function pricing() {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    quoteReference: refs.quote,
    quoteVersion: 1 as const,
    quoteInputDigest: digest("c"),
    lineReference: refs.item,
    sellableReference: refs.sellable,
    quantity: 2,
    currencyMinorUnitExponent: 2,
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: id(40),
    currencyMetadataDigest: digest("f"),
    unitPrice: money(1000n),
    subtotal: money(2000n),
    discount: money(0n),
    tax: money(260n),
    fee: money(0n),
    total: money(2260n),
    priceResolution: {
      priceBookReference: id(41),
      priceBookVersionReference: id(42),
      priceBookDigest: digest("1"),
      priceEntryReference: id(43),
      unitPrice: money(1000n),
      scopeKind: "Store" as const,
      scopeReference: refs.store,
      channelCode: "PILOT_CHANNEL",
      orderType: "Pickup" as const,
      priority: 0,
      effectiveFrom: "2026-08-01T00:00:00.000Z" as never,
      effectiveUntil: null,
      reasonCode: "BASE_PRICE",
    },
    taxConfigurationReference: id(44),
    taxConfigurationVersionReference: id(45),
    taxConfigurationDigest: digest("2"),
    taxEffectiveFrom: "2026-08-01T00:00:00.000Z" as never,
    taxEffectiveUntil: null,
    taxComponents: [
      {
        ruleVersionReference: id(46),
        ruleVersionDigest: digest("3"),
        jurisdictionCode: "CA_ON",
        taxComponentCode: "HST",
        taxClassificationReference: id(33),
        treatment: "Taxable" as const,
        rate: "0.13",
        priceInclusion: "Exclusive" as const,
        roundingMode: "HalfUp" as const,
        calculationOrder: 1,
        compoundOnPriorTax: false,
        taxAmount: money(260n),
      },
    ],
    quotedAt: "2026-08-02T17:59:00.000Z" as never,
  };
}

function resolution() {
  return resolveStoreBusinessDate({
    occurredAt: at,
    configuration: {
      configurationReference: id(50),
      configurationVersion: 1,
      brandReference: refs.brand,
      storeReference: refs.store,
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
      businessDayStartSource: "PlatformDefault",
      contentDigest: digest("4"),
      effectiveFrom: "2026-08-02T08:00:00.000Z",
      effectiveUntil: null,
    },
  });
}

function audit(orderReference: string): AppendAuditRecordInput {
  return {
    auditId: id(60),
    brandId: refs.brand,
    storeId: refs.store,
    actor: { type: "System" },
    actionCode: "ORDERING_ORDER_CREATE",
    targetType: "OrderingOrder",
    targetId: orderReference,
    reasonCode: "AUTHORIZED_ORDER_CREATE",
    correlationId: id(61),
    occurredAt: at,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  };
}

function ports(
  options: {
    denied?: boolean;
    prior?: OrderCreationRecord | null;
    businessDateOverride?: ReturnType<typeof resolution>;
    checkoutOverride?: unknown;
  } = {},
) {
  let stored = options.prior ?? null;
  let committedEvent: Parameters<OrderCreationPorts["repository"]["commit"]>[0]["event"] | null =
    null;
  const calls: string[] = [];
  const values = {
    CheckoutValidation: [refs.validation],
    Order: [refs.order],
    OrderBatch: [refs.batch],
    OrderItem: [refs.orderItem],
    Event: [refs.event],
  };
  const implementation: OrderCreationPorts = {
    authorization: {
      async authorize() {
        calls.push("authorize");
        return options.denied ? null : { guestSession: guest() };
      },
    },
    audit: {
      async create(input) {
        calls.push("audit");
        return audit(input.order.orderReference);
      },
    },
    checkout: {
      async validate() {
        calls.push("checkout");
        return (options.checkoutOverride ?? evidence()) as never;
      },
    },
    source: {
      async load() {
        calls.push("source");
        return {
          cart: cart(),
          lines: [{ cartItemReference: refs.item, catalog: catalog(), pricing: pricing() }],
        };
      },
    },
    businessDate: {
      async resolve() {
        calls.push("business-date");
        return options.businessDateOverride ?? resolution();
      },
    },
    references: {
      generate(purpose) {
        const next = values[purpose].shift();
        if (next === undefined) throw new Error("unexpected reference request");
        return next;
      },
      hashIntent(value) {
        return `sha256:${createHash("sha256").update(value).digest("hex")}`;
      },
      equals(left, right) {
        return left === right;
      },
    },
    repository: {
      async resolveSubmission() {
        calls.push("resolve");
        return stored;
      },
      async commit(input) {
        calls.push("commit");
        committedEvent = input.event;
        stored = parseOrderCreationRecord({
          ...input.record,
          orderNumberAllocation: createOrderNumberAllocation({
            orderReference: input.record.order.orderReference,
            allocatedAt: input.record.createdAt,
            sequence: 7n,
            businessDateResolution: input.businessDateResolution,
          }),
        });
        return stored;
      },
    },
  };
  return { implementation, calls, stored: () => stored, committedEvent: () => committedEvent };
}

const command = (overrides: Record<string, unknown> = {}) => ({
  submissionReference: refs.submission,
  cartReference: refs.cart,
  expectedCartVersion: 5,
  quoteReference: refs.quote,
  requestedAt: at,
  ...overrides,
});

function expectCode(action: Promise<unknown>, code: string) {
  return expect(action).rejects.toMatchObject({ name: "OrderCreationError", code });
}

describe("WP-1224 Create Order application API", () => {
  it("authorizes and atomically composes immutable snapshots with the allocated number", async () => {
    const fixture = ports();
    const result = await createOrderCreationService(fixture.implementation).create(command());
    expect(result.status).toBe("Created");
    expect(result.record.orderNumberAllocation).toMatchObject({
      orderReference: refs.order,
      businessDate: "2026-08-02",
      sequence: 7n,
      orderNumber: "7",
    });
    expect(result.record.order.batches[0].submissionReference).toBe(refs.submission);
    expect(result.record.items[0]?.pricing.total.amountMinor).toBe(2260n);
    expect(fixture.committedEvent()).toMatchObject({
      eventId: refs.event,
      eventType: "OrderCreated",
      schemaVersion: 1,
      tenantId: refs.brand,
      storeId: refs.store,
      aggregateId: refs.order,
      aggregateVersion: 1n,
      causationId: refs.submission,
      actor: { type: "System" },
      payload: {
        orderReference: refs.order,
        orderBatchReference: refs.batch,
        submissionReference: refs.submission,
        businessDate: "2026-08-02",
        itemCount: 1,
      },
      redactionClassification: "indirect_identifier",
    });
    expect(fixture.calls).toEqual([
      "authorize",
      "resolve",
      "checkout",
      "source",
      "business-date",
      "audit",
      "commit",
    ]);
  });

  it("returns the first durable result without creating another Order", async () => {
    const first = ports();
    await createOrderCreationService(first.implementation).create(command());
    const replay = ports({ prior: first.stored() });
    const result = await createOrderCreationService(replay.implementation).create(
      command({ requestedAt: "2026-08-02T18:02:00.000Z" }),
    );
    expect(result.status).toBe("AlreadyCreated");
    expect(result.record.order.orderReference).toBe(refs.order);
    expect(replay.calls).toEqual(["authorize", "resolve"]);
    expect(replay.committedEvent()).toBeNull();
  });

  it("rejects changed intent under the same permanent Submission reference", async () => {
    const first = ports();
    await createOrderCreationService(first.implementation).create(command());
    const conflict = ports({ prior: first.stored() });
    await expectCode(
      createOrderCreationService(conflict.implementation).create(
        command({ expectedCartVersion: 6 }),
      ),
      "ORDER_CREATE_IDEMPOTENCY_CONFLICT",
    );
    expect(conflict.calls).toEqual(["authorize", "resolve"]);
  });

  it("fails closed before lookup or snapshot reads when authorization is denied", async () => {
    const fixture = ports({ denied: true });
    await expectCode(
      createOrderCreationService(fixture.implementation).create(command()),
      "ORDER_CREATE_PERMISSION_DENIED",
    );
    expect(fixture.calls).toEqual(["authorize"]);
  });

  it("accepts only the closed server command and never client snapshot or amount fields", async () => {
    const fixture = ports();
    await expectCode(
      createOrderCreationService(fixture.implementation).create(command({ total: "0.01" })),
      "ORDER_CREATE_INPUT_INVALID",
    );
    expect(fixture.calls).toEqual([]);
  });

  it("fails closed when a dependency returns scope-mismatched evidence", async () => {
    const fixture = ports({
      businessDateOverride: { ...resolution(), storeReference: id(71) } as never,
    });
    await expectCode(
      createOrderCreationService(fixture.implementation).create(command()),
      "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("classifies malformed Checkout output as dependency failure", async () => {
    const fixture = ports({ checkoutOverride: { ...evidence(), privateField: "not accepted" } });
    await expectCode(
      createOrderCreationService(fixture.implementation).create(command()),
      "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    );
    expect(fixture.calls).toEqual(["authorize", "resolve", "checkout"]);
  });

  it("exposes stable error semantics without private dependency details", () => {
    expect(new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE").message).toBe(
      "order creation is unavailable",
    );
  });
});
