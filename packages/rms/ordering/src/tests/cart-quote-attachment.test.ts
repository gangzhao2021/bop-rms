import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type { PriceQuoteSnapshot } from "@rms/pricing";
import { describe, expect, it } from "vitest";
import { createCartQuoteAttachmentService } from "../application/cart-quote-attachment-service.js";
import type {
  CartQuoteAttachmentPorts,
  PricingCartInput,
} from "../application/ports/cart-quote-attachment-ports.js";
import type { CartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import { CartError, parseCartAggregate, type CartAggregate } from "../domain/cart.js";

const id = (n: number) => `018f5200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const ids = {
  cart: id(1),
  brand: id(2),
  store: id(3),
  session: id(4),
  publicStore: id(5),
  qr: id(6),
  item: id(7),
  sellable: id(8),
  productVersion: id(9),
  menuVersion: id(10),
  binding: id(11),
  optionSetVersion: id(12),
  quote: id(13),
  currencyVersion: id(14),
  operation: id(15),
  audit: id(16),
  correlation: id(17),
};
const requestedAt = "2026-08-02T15:00:00.000Z";

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
    lastSeenAt: "2026-08-02T14:00:00.000Z" as never,
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
    aggregateVersion: 4,
    createdAt: "2026-08-02T14:00:00.000Z",
    updatedAt: "2026-08-02T14:30:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: digest("c"),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:30:00.000Z",
      absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: ids.item,
        cartReference: ids.cart,
        sellableReference: ids.sellable,
        quantity: 2,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: {
          menuVersionReference: ids.menuVersion,
          productVersionReference: ids.productVersion,
          catalogChannelCode: "PILOT_CHANNEL",
          catalogOrderTypeCode: "PILOT_ORDER_TYPE",
          ruleEvidence: [
            {
              bindingReference: ids.binding,
              optionSetVersionReference: ids.optionSetVersion,
            },
          ],
          validatedAt: "2026-08-02T14:30:00.000Z",
        },
        addedByActorReference: ids.session,
        addedByParticipantReference: null,
        addedAt: "2026-08-02T14:30:00.000Z",
      },
    ],
    ...overrides,
  });
}

function money(amountMinor: bigint) {
  return { amountMinor, currencyCode: "CAD" };
}

function quote(overrides: Record<string, unknown> = {}): PriceQuoteSnapshot {
  return {
    quoteReference: ids.quote,
    quoteVersion: 1,
    brandReference: ids.brand,
    storeReference: ids.store,
    cartReference: ids.cart,
    cartVersion: 4,
    inputDigest: digest("a"),
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: ids.currencyVersion,
      metadataDigest: digest("b"),
    },
    subtotal: money(2000n),
    discount: money(0n),
    tax: money(260n),
    fee: money(0n),
    total: money(2260n),
    lines: [
      {
        lineReference: ids.item,
        sellableReference: ids.sellable,
        productVersionReference: ids.productVersion,
        menuVersionReference: ids.menuVersion,
        quantity: 2,
        unitPrice: money(1000n),
        subtotal: money(2000n),
        discount: money(0n),
        tax: money(260n),
        fee: money(0n),
        total: money(2260n),
        resolvedPrice: {},
        taxResolution: {},
        taxLines: [],
      },
    ],
    appliedPromotionReferences: [],
    warnings: ["SYNTHETIC_WARNING"],
    blockingReasons: [],
    createdAt: requestedAt,
    expiresAt: "2026-08-02T15:05:00.000Z",
    ...overrides,
  } as unknown as PriceQuoteSnapshot;
}

function audit(overrides: Partial<AppendAuditRecordInput> = {}): AppendAuditRecordInput {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    storeId: ids.store,
    actor: { type: "System" },
    actionCode: "ORDERING_CART_ATTACH_QUOTE",
    targetType: "OrderingCart",
    targetId: ids.cart,
    reasonCode: "AUTHORIZED_CART_QUOTE",
    correlationId: ids.correlation,
    occurredAt: requestedAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    ...overrides,
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
    guest?: GuestSession;
    denied?: boolean;
    audit?: AppendAuditRecordInput;
    quote?: PriceQuoteSnapshot;
    pricingFailure?: boolean;
  } = {},
) {
  let attachment: CartQuoteAttachment | null = null;
  let pricingCalls = 0;
  let pricingInput: PricingCartInput | null = null;
  const currentCart = options.cart === undefined ? cart() : options.cart;
  const ports: CartQuoteAttachmentPorts = {
    pricing: {
      async quoteCart(input) {
        pricingCalls += 1;
        pricingInput = input;
        if (options.pricingFailure) throw new Error("synthetic Pricing failure");
        return options.quote ?? quote();
      },
    },
    authorization: {
      async authorize() {
        if (options.denied) return null;
        return { guestSession: options.guest ?? guest(), audit: options.audit ?? audit() };
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async resolveOperation(reference) {
        return attachment?.operationReference === reference ? attachment : null;
      },
      async loadCart(reference) {
        return currentCart?.cartReference === reference ? currentCart : null;
      },
      async attach(input) {
        if (currentCart?.aggregateVersion !== input.expectedCartVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        attachment = input.attachment;
        return input.attachment;
      },
    },
  };
  return {
    service: createCartQuoteAttachmentService(ports),
    pricingCalls: () => pricingCalls,
    pricingInput: () => pricingInput,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    cartReference: ids.cart,
    expectedCartVersion: 4,
    operationReference: ids.operation,
    requestedAt,
    ...overrides,
  };
}

describe("WP-1203 Cart Quote attachment", () => {
  it("attaches an exact server Quote and replays without reloading Pricing", async () => {
    const state = fixture();
    const first = await state.service.attach(input());
    const replay = await state.service.attach(input());
    expect(first.status).toBe("Attached");
    expect(replay.status).toBe("AlreadyAttached");
    expect(replay.attachment).toEqual(first.attachment);
    expect(first.attachment).toMatchObject({
      cartReference: ids.cart,
      cartVersion: 4,
      quoteReference: ids.quote,
      currencyCode: "CAD",
      total: { amountMinor: 2260n, currencyCode: "CAD" },
      warnings: ["SYNTHETIC_WARNING"],
    });
    expect(state.pricingCalls()).toBe(1);
    expect(state.pricingInput()).toMatchObject({
      brandReference: ids.brand,
      storeReference: ids.store,
      cartVersion: 4,
      lines: [
        {
          lineReference: ids.item,
          catalogSelectionEvidence: { menuVersionReference: ids.menuVersion },
        },
      ],
    });
  });

  it("rejects client financial fields, stale Cart version and idempotency-key reuse", async () => {
    const state = fixture();
    await expect(state.service.attach(input({ total: "0.01" }))).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    await expect(state.service.attach(input({ expectedCartVersion: 3 }))).rejects.toMatchObject({
      code: "CART_VERSION_CONFLICT",
    });
    await state.service.attach(input());
    await expect(
      state.service.attach(input({ requestedAt: "2026-08-02T15:00:01.000Z" })),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed for empty or legacy unvalidated Carts", async () => {
    await expect(
      fixture({ cart: cart({ items: [] }) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
    const legacy = cart({
      items: [{ ...cart().items[0], catalogSelectionEvidence: null }] as never,
    });
    await expect(fixture({ cart: legacy }).service.attach(input())).rejects.toMatchObject({
      code: "CART_QUOTE_INVALID",
    });
  });

  it("fails closed for legacy, due and terminal Cart lifecycle", async () => {
    await expect(
      fixture({ cart: cart({ lifecycle: null }) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_LIFECYCLE_UNAVAILABLE" });
    const due = cart({
      lifecycle: { ...cart().lifecycle, idleExpiresAt: requestedAt } as never,
    });
    await expect(fixture({ cart: due }).service.attach(input())).rejects.toMatchObject({
      code: "CART_EXPIRED",
    });
    const abandoned = cart({
      aggregateVersion: 5,
      updatedAt: "2026-08-02T14:59:00.000Z" as never,
      lifecycle: {
        ...cart().lifecycle,
        status: "Abandoned",
        terminalAt: "2026-08-02T14:59:00.000Z",
        terminalReason: "CUSTOMER_ABANDONED",
      } as never,
    });
    await expect(
      fixture({ cart: abandoned }).service.attach(input({ expectedCartVersion: 5 })),
    ).rejects.toMatchObject({ code: "CART_ABANDONED" });
  });

  it.each([
    ["Brand scope", { brandReference: id(80) }],
    ["Cart Version", { cartVersion: 3 }],
    ["line identity", { lines: [{ ...quote().lines[0], lineReference: id(81) }] }],
    ["Catalog version", { lines: [{ ...quote().lines[0], menuVersionReference: id(82) }] }],
    ["Currency", { total: { amountMinor: 2260n, currencyCode: "USD" } }],
    ["arithmetic", { total: money(2261n) }],
    ["line arithmetic", { lines: [{ ...quote().lines[0], subtotal: money(1999n) }] }],
    ["blocker", { blockingReasons: ["SYNTHETIC_BLOCKER"] }],
  ])("rejects a mismatched %s Quote", async (_label, overrides) => {
    await expect(
      fixture({ quote: quote(overrides as Record<string, unknown>) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
  });

  it("rejects the exact expiry boundary and a future-created Quote", async () => {
    await expect(
      fixture({ quote: quote({ expiresAt: requestedAt }) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_QUOTE_EXPIRED" });
    await expect(
      fixture({ quote: quote({ createdAt: "2026-08-02T15:00:01.000Z" }) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
  });

  it("maps authorization, Audit and Pricing failures to safe errors", async () => {
    await expect(fixture({ denied: true }).service.attach(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    await expect(
      fixture({ audit: audit({ storeId: id(83) }) }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    await expect(fixture({ pricingFailure: true }).service.attach(input())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rejects accessor-bearing Pricing results without executing accessors", async () => {
    let executed = false;
    const hostile = Object.defineProperty({ ...quote() }, "total", {
      enumerable: true,
      get() {
        executed = true;
        return money(2260n);
      },
    });
    await expect(
      fixture({ quote: hostile as unknown as PriceQuoteSnapshot }).service.attach(input()),
    ).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
    expect(executed).toBe(false);
  });
});
