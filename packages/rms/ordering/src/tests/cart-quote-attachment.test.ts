import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type { PriceQuoteSnapshot } from "@rms/pricing";
import { describe, expect, it, vi } from "vitest";
import { createCartQuoteAttachmentService } from "../application/cart-quote-attachment-service.js";
import { createPickupCartQuoteService } from "../application/pickup-cart-quote-service.js";
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
      async authorize(input) {
        if (options.denied) return null;
        return {
          guestSession: options.guest ?? guest(),
          audit: options.audit ?? audit({ occurredAt: input.observedAt }),
        };
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
    ports,
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

function pickupFixture() {
  const state = fixture();
  const scope = { brandReference: ids.brand, storeReference: ids.store };
  const sessions = { authorize: vi.fn(async () => guest()) };
  const binding = { current: vi.fn(async (): Promise<CartAggregate | null> => cart()) };
  const pricing = { quoteCart: vi.fn(state.ports.pricing.quoteCart) };
  const auditFactory = vi.fn((value: { observedAt: string }) =>
    audit({ occurredAt: value.observedAt }),
  );
  const now = vi.fn(() => requestedAt);
  const history = vi.spyOn(state.ports.repository, "resolveOperation");
  const write = vi.spyOn(state.ports.repository, "attach");
  const service = createPickupCartQuoteService({
    scope,
    sessions,
    binding,
    pricing,
    audit: auditFactory,
    repository: state.ports.repository,
    references: state.ports.references,
    now,
  });
  return {
    ...state,
    scope,
    sessions,
    binding,
    pricing,
    auditFactory,
    now,
    history,
    write,
    service,
  };
}
function pickupInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionCredential: "a".repeat(43),
    csrfCredential: "b".repeat(43),
    cartReference: ids.cart,
    expectedCartVersion: 4,
    operationReference: ids.operation,
    ...overrides,
  };
}

describe("WP-2260 authorized Pickup Quote entry", () => {
  it("copies scope without I/O and sends fresh server identity only after authorization", async () => {
    const state = pickupFixture();
    expect(state.sessions.authorize).not.toHaveBeenCalled();
    expect(state.binding.current).not.toHaveBeenCalled();
    expect(state.now).not.toHaveBeenCalled();
    state.scope.storeReference = id(999);
    const checkedAt = "2026-08-02T15:00:01.000Z";
    state.now.mockReturnValueOnce(requestedAt).mockReturnValueOnce(checkedAt);
    const result = await state.service.attach(pickupInput());
    expect(result.status).toBe("Attached");
    expect(result.attachment.attachedAt).toBe(checkedAt);
    expect(state.sessions.authorize).toHaveBeenNthCalledWith(1, {
      sessionCredential: "a".repeat(43),
      csrfCredential: "b".repeat(43),
      observedAt: requestedAt,
    });
    expect(state.sessions.authorize).toHaveBeenNthCalledWith(2, {
      sessionCredential: "a".repeat(43),
      csrfCredential: "b".repeat(43),
      observedAt: checkedAt,
    });
    expect(state.pricing.quoteCart).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAt: checkedAt, storeReference: ids.store }),
      { operationReference: ids.operation, guestSessionReference: ids.session },
    );
    expect(state.auditFactory).toHaveBeenCalledWith({
      action: "AttachQuote",
      brandReference: ids.brand,
      storeReference: ids.store,
      sessionReference: ids.session,
      cartReference: ids.cart,
      operationReference: ids.operation,
      observedAt: checkedAt,
    });
  });

  it.each([
    { expectedCartVersion: 0 },
    { expectedCartVersion: 2147483648 },
    { expectedCartVersion: 1.5 },
    { csrfCredential: "bad" },
    { sessionCredential: "bad" },
    { cartReference: "bad" },
    { operationReference: "bad" },
    { requestedAt },
    { amount: 1 },
  ])("rejects invalid or additional input before I/O (%j)", async (change) => {
    const state = pickupFixture();
    await expect(state.service.attach(pickupInput(change))).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(state.now).not.toHaveBeenCalled();
    expect(state.sessions.authorize).not.toHaveBeenCalled();
    expect(state.history).not.toHaveBeenCalled();
  });

  it("rejects getters without evaluating them and preserves copied input through awaits", async () => {
    const state = pickupFixture();
    const getter = vi.fn(() => ids.cart);
    const accessor = pickupInput();
    Object.defineProperty(accessor, "cartReference", { get: getter, enumerable: true });
    await expect(state.service.attach(accessor)).rejects.toMatchObject({
      code: "CART_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    const raw = pickupInput();
    state.sessions.authorize.mockImplementationOnce(async () => {
      raw.cartReference = id(990);
      raw.csrfCredential = "c".repeat(43);
      raw.operationReference = id(991);
      return guest();
    });
    expect((await state.service.attach(raw)).attachment.operationReference).toBe(ids.operation);
    expect(state.sessions.authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ csrfCredential: "b".repeat(43) }),
    );
  });

  it.each(["first", "second"])(
    "denies %s authorization failure before history access",
    async (stage) => {
      const state = pickupFixture();
      if (stage === "second") state.sessions.authorize.mockResolvedValueOnce(guest());
      state.sessions.authorize.mockRejectedValueOnce(new Error("synthetic private cause"));
      await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
        code: "CART_PERMISSION_DENIED",
      });
      expect(state.history).not.toHaveBeenCalled();
      expect(state.pricing.quoteCart).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sessionReference: id(90) },
    { publicStoreReference: id(90) },
    { qrReference: id(90) },
    { qrRevocationVersion: 2 },
    { brandReference: id(90) },
    { storeReference: id(90) },
  ])("denies changed current Session identity (%j)", async (change) => {
    const state = pickupFixture();
    state.sessions.authorize
      .mockResolvedValueOnce(guest())
      .mockResolvedValueOnce(guest(change as Partial<GuestSession>));
    await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(state.history).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });

  it.each([null, "another"])(
    "reauthorizes missing or another binding before uniform absence (%s)",
    async (kind) => {
      const state = pickupFixture();
      state.binding.current.mockResolvedValue(kind === null ? null : cart());
      await expect(
        state.service.attach(pickupInput(kind === null ? {} : { cartReference: id(901) })),
      ).rejects.toMatchObject({ code: "CART_UNAVAILABLE" });
      expect(state.sessions.authorize).toHaveBeenCalledTimes(2);
      expect(state.history).not.toHaveBeenCalled();
    },
  );

  it.each([
    { brandReference: id(88) },
    { storeReference: id(88) },
    { createdByActorReference: id(88) },
    { updatedAt: "2026-08-02T15:01:00.000Z" },
  ])("rejects untrusted bound Cart facts (%j)", async (change) => {
    const state = pickupFixture();
    state.binding.current.mockResolvedValue({ ...cart(), ...change } as CartAggregate);
    await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(state.history).not.toHaveBeenCalled();
  });

  it.each(["invalid", "backwards", "binding", "audit"])(
    "redacts %s dependency failure",
    async (stage) => {
      const state = pickupFixture();
      if (stage === "invalid") state.now.mockReturnValue("invalid");
      if (stage === "backwards")
        state.now.mockReturnValueOnce(requestedAt).mockReturnValueOnce("2026-08-02T14:59:59.000Z");
      if (stage === "binding")
        state.binding.current.mockRejectedValue(new Error("synthetic private cause"));
      if (stage === "audit")
        state.auditFactory.mockImplementation(() => {
          throw new Error("synthetic private cause");
        });
      const attempt = state.service.attach(pickupInput());
      await expect(attempt).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      await expect(attempt).rejects.not.toThrow("synthetic private cause");
      expect(state.write).not.toHaveBeenCalled();
    },
  );

  it("reauthorizes original history without calling Pricing or renewing Quote expiry", async () => {
    const state = pickupFixture();
    const first = await state.service.attach(pickupInput());
    state.now.mockReturnValue("2026-08-02T15:05:00.000Z");
    const replay = await state.service.attach(pickupInput());
    expect(replay).toEqual({ status: "AlreadyAttached", attachment: first.attachment });
    expect(state.sessions.authorize).toHaveBeenCalledTimes(4);
    expect(state.pricing.quoteCart).toHaveBeenCalledTimes(1);
    state.sessions.authorize.mockRejectedValue(new Error("revoked"));
    await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(state.history).toHaveBeenCalledTimes(2);
  });

  it("retains version and selected-option denial without Pricing calls", async () => {
    const state = pickupFixture();
    await expect(
      state.service.attach(pickupInput({ expectedCartVersion: 3 })),
    ).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
    const selected = cart({
      items: cart().items.map((item) => ({
        ...item,
        optionSelections: [{ optionReference: id(202) as never, quantity: 1 }],
      })),
    });
    vi.spyOn(state.ports.repository, "loadCart").mockResolvedValue(selected);
    state.binding.current.mockResolvedValue(selected);
    await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
      code: "CART_QUOTE_INVALID",
    });
    expect(state.pricing.quoteCart).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });

  it("isolates concurrent Pricing operation identities", async () => {
    const state = pickupFixture();
    const results = await Promise.all([
      state.service.attach(pickupInput()),
      state.service.attach(pickupInput({ operationReference: id(920) })),
    ]);
    expect(results.map((result) => result.attachment.operationReference)).toEqual([
      ids.operation,
      id(920),
    ]);
    const calls = state.pricing.quoteCart.mock.calls as unknown as readonly [
      PricingCartInput,
      { operationReference: string; guestSessionReference: string },
    ][];
    expect(calls.map((call) => call[1].operationReference).sort()).toEqual(
      [ids.operation, id(920)].sort(),
    );
    expect(
      calls.every(
        (call) => Object.isFrozen(call[1]) && call[1].guestSessionReference === ids.session,
      ),
    ).toBe(true);
  });

  it.each(["older", "changed", "future"])(
    "rejects %s repository facts after binding lookup",
    async (kind) => {
      const state = pickupFixture();
      const loaded = cart(
        kind === "older"
          ? { aggregateVersion: 3 }
          : kind === "future"
            ? { updatedAt: "2026-08-02T15:01:00.000Z" as never }
            : { items: cart().items.map((item) => ({ ...item, quantity: 3 })) },
      );
      vi.spyOn(state.ports.repository, "loadCart").mockResolvedValue(loaded);
      await expect(state.service.attach(pickupInput())).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      expect(state.pricing.quoteCart).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
    },
  );
});

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
      state.service.attach(
        input({ expectedCartVersion: 5, requestedAt: "2026-08-02T15:00:01.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
  });

  it("WP-2225 replays the original attachment after time advances without renewing its Quote", async () => {
    const state = fixture();
    const first = await state.service.attach(input());
    expect(first.attachment.operationIntentHash).toBe(
      hash(`AttachQuote:${JSON.stringify(input())}`),
    );
    const original = structuredClone(first.attachment);
    const retry = await state.service.attach(input({ requestedAt: "2026-08-02T15:00:01.000Z" }));
    expect(retry).toEqual({ status: "AlreadyAttached", attachment: original });
    // Replay is historical evidence, not a fresh Quote or an extension of price validity.
    const afterQuoteExpiry = await state.service.attach(
      input({ requestedAt: "2026-08-02T15:05:00.000Z" }),
    );
    expect(afterQuoteExpiry.attachment).toEqual(original);
    expect(state.pricingCalls()).toBe(1);
    await expect(
      state.service.attach(input({ requestedAt: "2026-08-02T18:00:00.000Z" })),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(state.pricingCalls()).toBe(1);
  });

  it("WP-2225 checks current authorization and Audit evidence on delayed replay", async () => {
    const options: { denied?: boolean; audit?: AppendAuditRecordInput } = {};
    const state = fixture(options);
    await state.service.attach(input());
    options.audit = audit();
    await expect(
      state.service.attach(input({ requestedAt: "2026-08-02T15:00:01.000Z" })),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    options.denied = true;
    await expect(
      state.service.attach(input({ requestedAt: "2026-08-02T15:00:01.000Z" })),
    ).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
    expect(state.pricingCalls()).toBe(1);
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

  it.each([1, 2])("WP-2259 denies %i selected options before Pricing or writes", async (count) => {
    const source = cart();
    const selected = cart({
      items: source.items.map((item) => ({
        ...item,
        optionSelections: Array.from({ length: count }, (_, index) => ({
          optionReference: id(200 + index) as never,
          quantity: 1,
        })),
      })),
    });
    const original = structuredClone(selected);
    const state = fixture({ cart: selected });
    const write = vi.spyOn(state.ports.repository, "attach");
    await expect(state.service.attach(input())).rejects.toMatchObject({
      code: "CART_QUOTE_INVALID",
    });
    expect(state.pricingCalls()).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(selected).toEqual(original);
  });

  it("WP-2259 denies the entire mixed Cart without pricing its plain items", async () => {
    const plain = cart().items[0];
    if (plain === undefined) throw new Error("synthetic Cart item missing");
    const selected = cart({
      items: [
        plain,
        {
          ...plain,
          cartItemReference: id(201) as never,
          optionSelections: [{ optionReference: id(202) as never, quantity: 2 }],
        },
      ],
    });
    const state = fixture({ cart: selected });
    const write = vi.spyOn(state.ports.repository, "attach");
    await expect(state.service.attach(input())).rejects.toMatchObject({
      code: "CART_QUOTE_INVALID",
    });
    expect(state.pricingCalls()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["permission", "version"] as const)(
    "WP-2259 preserves %s failure priority",
    async (kind) => {
      const selected = cart({
        items: cart().items.map((item) => ({
          ...item,
          optionSelections: [{ optionReference: id(202) as never, quantity: 1 }],
        })),
      });
      const state = fixture({ cart: selected, denied: kind === "permission" });
      const write = vi.spyOn(state.ports.repository, "attach");
      await expect(
        state.service.attach(input({ expectedCartVersion: kind === "version" ? 3 : 4 })),
      ).rejects.toMatchObject({
        code: kind === "permission" ? "CART_PERMISSION_DENIED" : "CART_VERSION_CONFLICT",
      });
      expect(state.pricingCalls()).toBe(0);
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("WP-2259 keeps original authorized replay when a later Cart has options", async () => {
    const state = fixture();
    const original = await state.service.attach(input());
    const selected = cart({
      aggregateVersion: 5,
      items: cart().items.map((item) => ({
        ...item,
        optionSelections: [{ optionReference: id(202) as never, quantity: 1 }],
      })),
    });
    const load = vi.spyOn(state.ports.repository, "loadCart").mockResolvedValue(selected);
    const write = vi.spyOn(state.ports.repository, "attach");
    const replay = await state.service.attach(input({ requestedAt: "2026-08-02T15:05:00.000Z" }));
    expect(replay).toEqual({ status: "AlreadyAttached", attachment: original.attachment });
    expect(load).not.toHaveBeenCalled();
    expect(state.pricingCalls()).toBe(1);
    await expect(
      state.service.attach(input({ expectedCartVersion: 5, operationReference: id(203) })),
    ).rejects.toMatchObject({ code: "CART_QUOTE_INVALID" });
    expect(write).not.toHaveBeenCalled();
    expect(state.pricingCalls()).toBe(1);
    expect((await state.service.attach(input())).attachment).toEqual(original.attachment);
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

describe("WP-2239 scoped and concurrent Quote persistence", () => {
  it("denies a substituted Cart before revealing version or calling Pricing", async () => {
    const state = fixture();
    vi.spyOn(state.ports.repository, "loadCart").mockResolvedValue(
      cart({ cartReference: id(90) as never, aggregateVersion: 99, items: [] }),
    );
    await expect(state.service.attach(input())).rejects.toMatchObject({ code: "CART_UNAVAILABLE" });
    expect(state.pricingCalls()).toBe(0);
  });
  it("checks scope before version and lifecycle", async () => {
    const state = fixture();
    vi.spyOn(state.ports.repository, "loadCart").mockResolvedValue(
      cart({ storeReference: id(90) as never, aggregateVersion: 99 }),
    );
    await expect(state.service.attach(input())).rejects.toMatchObject({
      code: "CART_PERMISSION_DENIED",
    });
    expect(state.pricingCalls()).toBe(0);
  });
  it("denies a substituted operation on replay", async () => {
    const state = fixture();
    const first = await state.service.attach(input());
    vi.spyOn(state.ports.repository, "resolveOperation").mockResolvedValue({
      ...first.attachment,
      operationReference: id(90) as never,
    });
    await expect(state.service.attach(input())).rejects.toMatchObject({
      code: "CART_IDEMPOTENCY_CONFLICT",
    });
  });
  it("accepts the exact concurrent winner when the losing request generated a different Quote", async () => {
    const state = fixture();
    const first = await state.service.attach(input());
    vi.spyOn(state.ports.repository, "resolveOperation").mockResolvedValue(null);
    vi.spyOn(state.ports.pricing, "quoteCart").mockResolvedValue(quote({ quoteReference: id(90) }));
    vi.spyOn(state.ports.repository, "attach").mockResolvedValue(first.attachment);
    const next = await state.service.attach(input({ requestedAt: "2026-08-02T15:00:01.000Z" }));
    expect(next.attachment).toEqual(first.attachment);
  });
  it.each(["scope", "guest", "line"])("rejects a substituted stored %s", async (kind) => {
    const state = fixture();
    const original = state.ports.repository.attach;
    vi.spyOn(state.ports.repository, "attach").mockImplementation(async (value) => {
      const saved = await original(value);
      if (kind === "scope") return { ...saved, storeReference: id(90) as never };
      if (kind === "guest") return { ...saved, guestSessionReference: id(90) as never };
      return {
        ...saved,
        lines: saved.lines.map((line) => ({ ...line, quantity: line.quantity + 1 })),
      };
    });
    await expect(state.service.attach(input())).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
});
