import { describe, expect, it, vi } from "vitest";
import { createGuestSession } from "@bop/identity";
import { createPriceQuote, parsePriceQuoteRequestRecord } from "@rms/pricing";
import { createPickupCartQuoteExpiryService } from "../application/pickup-cart-quote-expiry-service.js";
import { CartError, parseCartAggregate } from "../domain/cart.js";
import { parseCartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import { type CartQuoteExpiryRecord } from "../domain/cart-quote-expiry.js";
import { at, id, quoteInput } from "./pickup-cart-quote-expiry.fixture.js";
const time = (s = 0) => new Date(Date.parse(at) + s * 1000).toISOString();
function fixture() {
  const quote = createPriceQuote(quoteInput());
  const scope = {
    brandReference: String(quote.brandReference),
    storeReference: String(quote.storeReference),
  };
  const input = {
    sessionCredential: "g".repeat(43),
    csrfCredential: "c".repeat(43),
    cartReference: quote.cartReference,
    expectedCartVersion: quote.cartVersion,
    operationReference: id(91),
  };
  const guest = createGuestSession({
    sessionReference: id(92),
    status: "Active",
    version: 1,
    ...scope,
    publicStoreReference: id(93),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA",
    qrReference: id(94),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: time(-120),
    lastSeenAt: time(),
    idleExpiresAt: time(14400),
    absoluteExpiresAt: time(86280),
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const cart = parseCartAggregate({
    ...scope,
    cartReference: quote.cartReference,
    orderType: "Pickup",
    sourceChannel: "Web",
    diningSessionReference: null,
    createdByActorReference: guest.sessionReference,
    aggregateVersion: quote.cartVersion,
    createdAt: time(-60),
    updatedAt: time(),
    lifecycle: {
      status: "Active",
      policyVersionReference: id(95),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: time(3600),
      absoluteExpiresAt: time(86340),
      terminalAt: null,
      terminalReason: null,
    },
    items: quote.lines.map((line) => ({
      cartItemReference: line.lineReference,
      cartReference: quote.cartReference,
      sellableReference: line.sellableReference,
      quantity: line.quantity,
      optionSelections: [],
      customerNote: null,
      catalogSelectionEvidence: {
        menuVersionReference: line.menuVersionReference,
        productVersionReference: line.productVersionReference,
        catalogChannelCode: "SYNTHETIC",
        catalogOrderTypeCode: "PICKUP",
        ruleEvidence: [],
        validatedAt: time(),
      },
      addedByActorReference: guest.sessionReference,
      addedByParticipantReference: null,
      addedAt: time(),
    })),
  });
  const record = parsePriceQuoteRequestRecord({
    ...scope,
    recordVersion: 1,
    operationReference: input.operationReference,
    guestSessionReference: guest.sessionReference,
    cartReference: quote.cartReference,
    cartVersion: quote.cartVersion,
    intentDigest: `sha256:${"b".repeat(64)}`,
    quoteReference: quote.quoteReference,
    quoteOutcome: "Created",
    createdAt: at,
    idempotencyExpiresAt: time(86400),
  });
  const authorize = vi.fn(async () => guest);
  const current = vi.fn(async () => cart as typeof cart | null);
  const resolve = vi.fn(
    async () => ({ record, quote }) as { record: typeof record; quote: typeof quote } | null,
  );
  const expire = vi.fn(
    async ({ record: next }: { record: CartQuoteExpiryRecord }): Promise<unknown> => ({
      status: "Expired",
      record: next,
    }),
  );
  const audit = vi.fn((next: CartQuoteExpiryRecord) => ({
    auditId: id(96),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" as const },
    actionCode: "ORDERING_CART_QUOTE_EXPIRE",
    reasonCode: "QUOTE_VALIDITY_ENDED",
    targetType: "OrderingCart",
    targetId: next.cartReference,
    occurredAt: next.expiredAt,
    correlationId: id(97),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted" as const,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  }));
  const now = vi.fn(() => time(301));
  const options = {
    scope,
    sessions: { authorize },
    binding: { current },
    requests: { resolve },
    expiry: { expire },
    audit,
    now,
  };
  const service = createPickupCartQuoteExpiryService(options);
  return {
    service,
    options,
    input,
    guest,
    cart,
    quote,
    record,
    authorize,
    current,
    resolve,
    expire,
    audit,
    now,
  };
}
describe("current authorized Quote expiry reconciliation", () => {
  it("reauthorizes before history/write/receipt and preserves original source identity", async () => {
    const f = fixture();
    expect(f.authorize).not.toHaveBeenCalled();
    const result = await f.service.reconcile(f.input);
    expect(result).toMatchObject({
      status: "Expired",
      record: {
        operationReference: f.input.operationReference,
        cartVersion: 4,
        quoteReference: f.quote.quoteReference,
        requestCreatedAt: at,
        requestExpiresAt: time(86400),
        expiredAt: time(301),
      },
    });
    expect(f.authorize).toHaveBeenCalledTimes(6);
    expect(f.current).toHaveBeenCalledTimes(3);
    expect(f.expire).toHaveBeenCalledOnce();
    expect(f.resolve.mock.calls[0]).not.toContain(f.input.sessionCredential);
    expect(f.audit).toHaveBeenCalledOnce();
  });
  it.each([null, "current"])(
    "does not invent expiry for absent/unexpired history %s",
    async (mode) => {
      const f = fixture();
      if (mode === null) f.resolve.mockResolvedValue(null);
      else f.now.mockReturnValue(time(299));
      expect(await f.service.reconcile(f.input)).toEqual({ status: "NoExpiredRequest" });
      expect(f.expire).not.toHaveBeenCalled();
      expect(f.audit).not.toHaveBeenCalled();
    },
  );
  it("supports a newer current Cart without renewing original facts", async () => {
    const f = fixture();
    f.current.mockResolvedValue(
      parseCartAggregate({ ...f.cart, aggregateVersion: 5, updatedAt: time(20) }),
    );
    expect(await f.service.reconcile(f.input)).toMatchObject({
      status: "Expired",
      record: { cartVersion: 4, requestCreatedAt: at },
    });
  });
  it.each([1, 2, 3, 4, 5, 6])(
    "denies revocation at authorization checkpoint %s",
    async (failure) => {
      const f = fixture();
      let calls = 0;
      f.authorize.mockImplementation(async () => {
        if (++calls === failure) throw new Error("synthetic revocation");
        return f.guest;
      });
      await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
        code: failure > 4 ? "CART_DEPENDENCY_UNAVAILABLE" : "CART_PERMISSION_DENIED",
      });
      expect(f.expire).toHaveBeenCalledTimes(failure > 4 ? 1 : 0);
    },
  );
  it.each(["missing", "other", "scope", "guest", "future", "regression"])(
    "denies changed Cart %s",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.current.mockResolvedValue(null);
      else if (kind === "regression")
        f.current
          .mockResolvedValueOnce(f.cart)
          .mockResolvedValue(parseCartAggregate({ ...f.cart, aggregateVersion: 3 }));
      else
        f.current.mockResolvedValue(
          parseCartAggregate({
            ...f.cart,
            ...(kind === "other"
              ? { cartReference: id(100), items: [] }
              : kind === "scope"
                ? { storeReference: id(100) }
                : kind === "guest"
                  ? { createdByActorReference: id(100) }
                  : { updatedAt: time(400) }),
          }),
        );
      await expect(f.service.reconcile(f.input)).rejects.toBeInstanceOf(CartError);
      expect(f.expire).not.toHaveBeenCalled();
    },
  );
  it.each([
    "operationReference",
    "guestSessionReference",
    "brandReference",
    "storeReference",
    "cartReference",
    "quoteReference",
  ])("rejects substituted request %s", async (field) => {
    const f = fixture();
    f.resolve.mockResolvedValue({
      record: parsePriceQuoteRequestRecord({ ...f.record, [field]: id(100) }),
      quote: f.quote,
    });
    await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.expire).not.toHaveBeenCalled();
  });
  it.each(["backwards", "retention", "invalid"])("bounds the server clock %s", async (kind) => {
    const f = fixture();
    f.now
      .mockReturnValueOnce(time(301))
      .mockReturnValue(
        kind === "backwards" ? time(300) : kind === "retention" ? time(86400) : "invalid",
      );
    await expect(f.service.reconcile(f.input)).rejects.toBeInstanceOf(CartError);
    expect(f.expire).not.toHaveBeenCalled();
  });
  it("keeps a failed or lost-commit response unknown", async () => {
    const f = fixture();
    f.expire.mockRejectedValue(new Error("synthetic commit acknowledgement lost"));
    await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
  it.each(["operation", "time", "extra", "status"])(
    "rejects substituted persisted receipt %s",
    async (kind) => {
      const f = fixture();
      f.expire.mockImplementation(async ({ record }) =>
        kind === "status"
          ? { status: "Other", attachment: {} }
          : {
              status: "Expired",
              record: {
                ...record,
                ...(kind === "operation"
                  ? { operationReference: id(99) }
                  : kind === "time"
                    ? { expiredAt: time(302) }
                    : { extra: true }),
              },
            },
      );
      await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("returns the original attached result instead of claiming expiry", async () => {
    const f = fixture();
    const q = f.quote;
    const attachment = parseCartQuoteAttachment({
      ...f.options.scope,
      operationReference: f.input.operationReference,
      operationIntentHash: `sha256:${"c".repeat(64)}`,
      guestSessionReference: f.guest.sessionReference,
      cartReference: q.cartReference,
      cartVersion: q.cartVersion,
      quoteReference: q.quoteReference,
      quoteVersion: 1,
      quoteInputDigest: q.inputDigest,
      currencyCode: q.currencyMetadata.currencyCode,
      currencyMetadataVersion: q.currencyMetadata.metadataVersion,
      currencyMetadataVersionReference: q.currencyMetadata.metadataVersionReference,
      subtotal: q.subtotal,
      discount: q.discount,
      tax: q.tax,
      fee: q.fee,
      total: q.total,
      lines: q.lines.map((line) => ({
        lineReference: line.lineReference,
        sellableReference: line.sellableReference,
        productVersionReference: line.productVersionReference,
        menuVersionReference: line.menuVersionReference,
        quantity: line.quantity,
      })),
      warnings: q.warnings,
      quoteCreatedAt: q.createdAt,
      quoteExpiresAt: q.expiresAt,
      attachedAt: at,
      idempotencyExpiresAt: time(86400),
    });
    f.expire.mockResolvedValue({ status: "AlreadyAttached", attachment });
    expect(await f.service.reconcile(f.input)).toEqual({ status: "AlreadyAttached", attachment });
  });
  it("snapshots input before awaits and denies accessors before authorization", async () => {
    const f = fixture();
    const mutable = { ...f.input };
    f.authorize.mockImplementation(async () => {
      mutable.operationReference = id(99);
      return f.guest;
    });
    expect(await f.service.reconcile(mutable)).toMatchObject({
      status: "Expired",
      record: { operationReference: f.input.operationReference },
    });
    const getter = vi.fn();
    const bad = Object.defineProperty({ ...f.input }, "operationReference", {
      get: getter,
      enumerable: true,
    });
    await expect(f.service.reconcile(bad)).rejects.toMatchObject({ code: "CART_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
  });
});

it("does not disclose a committed terminal result after binding replacement", async () => {
  const f = fixture();
  f.current.mockResolvedValueOnce(f.cart).mockResolvedValueOnce(f.cart).mockResolvedValue(null);
  await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.expire).toHaveBeenCalledOnce();
});
it("copies complete Pricing history before subsequent authorization awaits", async () => {
  const f = fixture();
  const quote = structuredClone(f.quote);
  const record = { ...f.record };
  f.resolve.mockResolvedValue({ record, quote });
  let calls = 0;
  f.authorize.mockImplementation(async () => {
    if (++calls === 3) {
      record.quoteReference = id(100);
      (quote as { cartVersion: number }).cartVersion = 99;
    }
    return f.guest;
  });
  expect(await f.service.reconcile(f.input)).toMatchObject({
    status: "Expired",
    record: { quoteReference: f.quote.quoteReference, cartVersion: 4 },
  });
});
it("rejects incomplete complete-Quote evidence without writing expiry", async () => {
  const f = fixture();
  f.resolve.mockResolvedValue({ record: f.record, quote: { ...f.quote, lines: [] } });
  await expect(f.service.reconcile(f.input)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.expire).not.toHaveBeenCalled();
});
