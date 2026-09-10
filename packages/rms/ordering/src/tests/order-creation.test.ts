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
    clock: { now: () => at },
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
      "authorize",
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
    expect(replay.calls).toEqual(["authorize", "resolve", "authorize"]);
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
    expect(conflict.calls).toEqual(["authorize", "resolve", "authorize"]);
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

describe("WP-2345 exact submission evidence", () => {
  it.each([{ cartReference: id(90) }, { expectedCartVersion: 6 }, { quoteReference: id(90) }])(
    "rejects Checkout evidence for another requested tuple %j",
    async (patch) => {
      const fixture = ports();
      await expectCode(
        createOrderCreationService(fixture.implementation).create(command(patch)),
        "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      );
      expect(fixture.calls).toEqual(["authorize", "resolve", "checkout"]);
    },
  );
  it("rejects a different validation operation before loading source facts", async () => {
    const fixture = ports({ checkoutOverride: evidence({ validationReference: id(90) }) });
    await expectCode(
      createOrderCreationService(fixture.implementation).create(command()),
      "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    );
    expect(fixture.calls).toEqual(["authorize", "resolve", "checkout"]);
  });
  it.each(["item name", "creator", "business configuration"])(
    "does not accept substituted saved %s",
    async (kind) => {
      const fixture = ports();
      const commit = fixture.implementation.repository.commit;
      fixture.implementation.repository.commit = async (input) => {
        const original = await commit(input);
        const item = original.items[0];
        if (item === undefined) throw new Error("fixture");
        if (kind === "item name")
          return {
            ...original,
            items: [
              {
                ...item,
                catalog: {
                  ...item.catalog,
                  localizedNames: { "en-CA": "Different synthetic item" },
                },
              },
            ],
          } as never;
        if (kind === "creator")
          return {
            ...original,
            order: { ...original.order, createdByActorReference: id(90) },
          } as never;
        return {
          ...original,
          orderNumberAllocation: createOrderNumberAllocation({
            orderReference: original.order.orderReference,
            allocatedAt: original.createdAt,
            sequence: original.orderNumberAllocation.sequence,
            businessDateResolution: {
              ...original.orderNumberAllocation.businessDateResolution,
              configurationVersion: 2,
            },
          }),
        };
      };
      await expectCode(
        createOrderCreationService(fixture.implementation).create(command()),
        "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      );
      expect(fixture.calls.filter((value) => value === "commit")).toHaveLength(1);
    },
  );
  it.each([
    ["brandReference", id(90)],
    ["storeReference", id(90)],
    ["businessDate", "2026-08-01"],
    ["orderNumber", "999"],
  ])("rejects contradictory number allocation %s", async (field, value) => {
    const fixture = ports();
    const result = await createOrderCreationService(fixture.implementation).create(command());
    expect(() =>
      parseOrderCreationRecord({
        ...result.record,
        orderNumberAllocation: {
          ...result.record.orderNumberAllocation,
          [field]: value,
        },
      }),
    ).toThrow(OrderCreationError);
  });
  it.each(["sparse", "accessor", "decorated"])(
    "rejects %s snapshot arrays without executing code",
    async (kind) => {
      const fixture = ports();
      const result = await createOrderCreationService(fixture.implementation).create(command());
      const item = result.record.items[0];
      let executed = 0;
      const items: unknown[] = kind === "sparse" ? new Array(1) : [item];
      if (kind === "accessor")
        Object.defineProperty(items, "0", {
          enumerable: true,
          get() {
            executed++;
            return item;
          },
        });
      if (kind === "decorated") Object.assign(items, { unexpected: true });
      expect(() => parseOrderCreationRecord({ ...result.record, items })).toThrow(
        OrderCreationError,
      );
      expect(executed).toBe(0);
    },
  );
});

describe("WP-2346 current-time submission fences", () => {
  it.each(["checkout", "source", "business-date", "audit", "reauthorize"])(
    "blocks evidence expiry across %s wait",
    async (stage) => {
      const f = ports();
      let now = at;
      f.implementation.clock.now = () => now;
      const expire = () => {
        now = "2026-08-02T18:05:00.000Z";
      };
      if (stage === "checkout") {
        const original = f.implementation.checkout.validate;
        f.implementation.checkout.validate = async (value) => {
          const result = await original(value);
          expire();
          return result;
        };
      }
      if (stage === "source") {
        const original = f.implementation.source.load;
        f.implementation.source.load = async (value) => {
          const result = await original(value);
          expire();
          return result;
        };
      }
      if (stage === "business-date") {
        const original = f.implementation.businessDate.resolve;
        f.implementation.businessDate.resolve = async (value) => {
          const result = await original(value);
          expire();
          return result;
        };
      }
      if (stage === "audit") {
        const original = f.implementation.audit.create;
        f.implementation.audit.create = async (value) => {
          const result = await original(value);
          expire();
          return result;
        };
      }
      if (stage === "reauthorize") {
        let calls = 0;
        const original = f.implementation.authorization.authorize;
        f.implementation.authorization.authorize = async (value) => {
          const result = await original(value);
          if (++calls === 2) expire();
          return result;
        };
      }
      await expectCode(
        createOrderCreationService(f.implementation).create(command()),
        "ORDER_CREATE_VALIDATION_EXPIRED",
      );
      expect(f.calls).not.toContain("commit");
    },
  );
  it.each(["authorization", "lookup"])("blocks Guest expiry across %s wait", async (stage) => {
    const f = ports();
    let now = at;
    f.implementation.clock.now = () => now;
    f.implementation.authorization.authorize = async () => {
      if (stage === "authorization") now = "2026-08-02T18:01:01.000Z";
      return { guestSession: guest({ idleExpiresAt: "2026-08-02T18:01:01.000Z" as never }) };
    };
    if (stage === "lookup")
      f.implementation.repository.resolveSubmission = async () => {
        now = "2026-08-02T18:01:01.000Z";
        return null;
      };
    await expectCode(
      createOrderCreationService(f.implementation).create(command()),
      "ORDER_CREATE_PERMISSION_DENIED",
    );
    expect(f.calls).not.toContain("checkout");
  });
  it.each(["revoked", "version", "session", "store"])(
    "denies %s authority at final commit gate",
    async (kind) => {
      const f = ports();
      let count = 0;
      f.implementation.authorization.authorize = async () => {
        if (++count === 1) return { guestSession: guest() };
        if (kind === "revoked") return null;
        return {
          guestSession: guest(
            kind === "version"
              ? { version: 2 }
              : kind === "session"
                ? { sessionReference: id(99) as GuestSession["sessionReference"] }
                : { storeReference: id(99) as GuestSession["storeReference"] },
          ),
        };
      };
      await expectCode(
        createOrderCreationService(f.implementation).create(command()),
        "ORDER_CREATE_PERMISSION_DENIED",
      );
      expect(f.calls).not.toContain("commit");
    },
  );
  it("checks the Cart deadline again after Audit", async () => {
    const f = ports();
    let now = at;
    f.implementation.clock.now = () => now;
    const source = f.implementation.source.load;
    f.implementation.source.load = async (value) => {
      const loaded = await source(value);
      const original = cart();
      return {
        ...loaded,
        cart: {
          ...original,
          lifecycle: { ...original.lifecycle, idleExpiresAt: "2026-08-02T18:01:01.000Z" },
        },
      };
    };
    const audit = f.implementation.audit.create;
    f.implementation.audit.create = async (value) => {
      const result = await audit(value);
      now = "2026-08-02T18:01:01.000Z";
      return result;
    };
    await expectCode(
      createOrderCreationService(f.implementation).create(command()),
      "ORDER_CREATE_VALIDATION_EXPIRED",
    );
    expect(f.calls).not.toContain("commit");
  });
  it.each(["malformed", "backward", "throw"])(
    "fails closed on %s clock after Audit",
    async (kind) => {
      const f = ports();
      let late = false;
      f.implementation.clock.now = () => {
        if (!late) return at;
        if (kind === "throw") throw new Error("private clock");
        return kind === "backward" ? "2026-08-02T18:00:59.999Z" : "invalid";
      };
      const original = f.implementation.audit.create;
      f.implementation.audit.create = async (value) => {
        const result = await original(value);
        late = true;
        return result;
      };
      await expectCode(
        createOrderCreationService(f.implementation).create(command()),
        "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
      );
      expect(f.calls).not.toContain("commit");
    },
  );
  it("rejects future request time for new work", async () => {
    const f = ports();
    await expectCode(
      createOrderCreationService(f.implementation).create(
        command({ requestedAt: "2026-08-02T18:02:00.000Z" }),
      ),
      "ORDER_CREATE_INPUT_INVALID",
    );
    expect(f.calls).toEqual(["authorize", "resolve"]);
  });
  it("accepts the last valid millisecond without changing submission timestamps", async () => {
    const f = ports();
    f.implementation.clock.now = () => "2026-08-02T18:04:59.999Z";
    const result = await createOrderCreationService(f.implementation).create(command());
    expect(result.status).toBe("Created");
    expect(result.record.createdAt).toBe(at);
  });
  it("recovers original submission after Checkout expiry with current authorization", async () => {
    const first = ports();
    await createOrderCreationService(first.implementation).create(command());
    const f = ports({ prior: first.stored() });
    f.implementation.clock.now = () => "2026-08-02T18:06:00.000Z";
    const result = await createOrderCreationService(f.implementation).create(
      command({ requestedAt: "2026-08-02T18:06:00.000Z" }),
    );
    expect(result.status).toBe("AlreadyCreated");
    expect(result.record.createdAt).toBe(at);
    expect(f.calls).toEqual(["authorize", "resolve", "authorize"]);
  });
  it("refuses replay when authority is revoked during lookup", async () => {
    const first = ports();
    await createOrderCreationService(first.implementation).create(command());
    const f = ports({ prior: first.stored() });
    let count = 0;
    f.implementation.authorization.authorize = async () =>
      ++count === 1 ? { guestSession: guest() } : null;
    await expectCode(
      createOrderCreationService(f.implementation).create(command()),
      "ORDER_CREATE_PERMISSION_DENIED",
    );
  });
  it("retains a verified durable result when the commit response arrives after expiry", async () => {
    const f = ports();
    let now = at;
    f.implementation.clock.now = () => now;
    const commit = f.implementation.repository.commit;
    f.implementation.repository.commit = async (value) => {
      const result = await commit(value);
      now = "2026-08-02T18:06:00.000Z";
      return result;
    };
    expect((await createOrderCreationService(f.implementation).create(command())).status).toBe(
      "Created",
    );
    expect(f.calls.filter((value) => value === "commit")).toHaveLength(1);
  });
});

describe("WP-2346 authorization context fence", () => {
  it.each(["public store", "QR revision"])(
    "rejects changed %s without a second commit",
    async (kind) => {
      const f = ports();
      let calls = 0;
      f.implementation.authorization.authorize = async () => ({
        guestSession:
          ++calls === 1
            ? guest()
            : guest(
                kind === "public store"
                  ? { publicStoreReference: id(99) as GuestSession["publicStoreReference"] }
                  : { qrRevocationVersion: 2 },
              ),
      });
      await expectCode(
        createOrderCreationService(f.implementation).create(command()),
        "ORDER_CREATE_PERMISSION_DENIED",
      );
      expect(f.calls).not.toContain("commit");
    },
  );
  it("supplies the latest server instant to final authorization", async () => {
    const f = ports();
    let now = at;
    const observed: string[] = [];
    f.implementation.clock.now = () => now;
    f.implementation.authorization.authorize = async (value) => {
      observed.push(value.observedAt);
      return { guestSession: guest() };
    };
    const audit = f.implementation.audit.create;
    f.implementation.audit.create = async (value) => {
      const result = await audit(value);
      now = "2026-08-02T18:02:00.000Z";
      return result;
    };
    expect((await createOrderCreationService(f.implementation).create(command())).status).toBe(
      "Created",
    );
    expect(observed).toEqual([at, "2026-08-02T18:02:00.000Z"]);
  });
});

describe("WP-2349 stored Order consistency", () => {
  async function record() {
    return (await createOrderCreationService(ports().implementation).create(command())).record;
  }
  async function pair() {
    const original = await record();
    const first = original.items[0];
    if (!first) throw new Error("fixture");
    const second = {
      ...first,
      orderItemReference: id(90),
      cartItemReference: id(91),
      pricing: { ...first.pricing, lineReference: id(91) },
    };
    return {
      ...original,
      items: [first, second],
      order: {
        ...original.order,
        batches: [
          {
            ...original.order.batches[0],
            items: [
              ...original.order.batches[0].items,
              {
                orderItemReference: second.orderItemReference,
                orderBatchReference: second.orderBatchReference,
                cartItemReference: second.cartItemReference,
              },
            ],
          },
        ],
      },
    };
  }
  it("retains complete ordered multi-line history without querying current sources", async () => {
    const original = await pair();
    expect(parseOrderCreationRecord(original)).toEqual(original);
  });
  it.each(["brand", "store", "quote"])("rejects a foreign snapshot %s", async (kind) => {
    const original = await record();
    const item = original.items[0];
    if (!item) throw new Error("fixture");
    const changed =
      kind === "quote"
        ? { ...item, pricing: { ...item.pricing, quoteReference: id(90) } }
        : { ...item, catalog: { ...item.catalog, [kind + "Reference"]: id(90) } };
    expect(() => parseOrderCreationRecord({ ...original, items: [changed] })).toThrow(
      OrderCreationError,
    );
  });
  it.each(["duplicate", "reversed", "quote digest"])(
    "rejects inconsistent %s lines",
    async (kind) => {
      const original = await pair();
      const [first, second] = original.items;
      if (!first || !second) throw new Error("fixture");
      const items =
        kind === "duplicate"
          ? [first, first]
          : kind === "reversed"
            ? [second, first]
            : [first, { ...second, pricing: { ...second.pricing, quoteInputDigest: digest("f") } }];
      expect(() => parseOrderCreationRecord({ ...original, items })).toThrow(OrderCreationError);
    },
  );
  it.each(["batch", "identity"])("rejects executable and malformed %s arrays", async (level) => {
    const original = await record();
    for (const kind of ["sparse", "accessor", "decorated", "map", "subclass"]) {
      let executed = 0;
      const entry =
        level === "batch" ? original.order.batches[0] : original.order.batches[0].items[0];
      const values: unknown[] = kind === "sparse" ? new Array(1) : [entry];
      if (kind === "accessor")
        Object.defineProperty(values, "0", {
          enumerable: true,
          get() {
            executed++;
            return entry;
          },
        });
      if (kind === "decorated") Object.assign(values, { extra: true });
      if (kind === "map")
        Object.assign(values, {
          map() {
            executed++;
            return [entry];
          },
        });
      if (kind === "subclass") Object.setPrototypeOf(values, Object.create(Array.prototype));
      const order = {
        ...original.order,
        batches:
          level === "batch"
            ? values
            : [
                {
                  ...original.order.batches[0],
                  items: values,
                },
              ],
      };
      expect(() => parseOrderCreationRecord({ ...original, order })).toThrow(OrderCreationError);
      expect(executed).toBe(0);
    }
  });
  it.each(["orderType", "sourceChannel"])("rejects executable %s coercion", async (field) => {
    const original = await record();
    let executed = 0;
    const value = {
      toString() {
        executed++;
        return original.order[field as "orderType" | "sourceChannel"];
      },
    };
    expect(() =>
      parseOrderCreationRecord({ ...original, order: { ...original.order, [field]: value } }),
    ).toThrow(OrderCreationError);
    expect(executed).toBe(0);
  });
});
