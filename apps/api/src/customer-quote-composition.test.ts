import { createServer } from "node:http";
import * as Pricing from "@rms/pricing";
import * as Ordering from "@rms/ordering";
import { afterEach, describe, expect, it, vi } from "vitest";
import { at, id, quoteInput } from "../test-support/customer-quote-composition-fixture.js";
import { fixture as entryFixture } from "../test-support/customer-entry-composition-fixture.js";
import {
  createCustomerQuoteComposition,
  createCustomerQuotePort,
  type CustomerQuoteCompositionOptions,
} from "./customer-quote-composition.js";
import { CustomerQuoteHandler, type QuoteCartCommand } from "./customer-quote.js";
import { createApp } from "./app.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const quote = Pricing.createPriceQuote(quoteInput());
  const attachment = Ordering.parseCartQuoteAttachment({
    operationReference: id(91),
    operationIntentHash: `sha256:${"a".repeat(64)}`,
    guestSessionReference: id(92),
    cartReference: quote.cartReference,
    brandReference: quote.brandReference,
    storeReference: quote.storeReference,
    cartVersion: quote.cartVersion,
    quoteReference: quote.quoteReference,
    quoteVersion: 1,
    quoteInputDigest: quote.inputDigest,
    currencyCode: quote.currencyMetadata.currencyCode,
    currencyMetadataVersion: quote.currencyMetadata.metadataVersion,
    currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax,
    fee: quote.fee,
    total: quote.total,
    lines: quote.lines.map((line) => ({
      lineReference: line.lineReference,
      sellableReference: line.sellableReference,
      productVersionReference: line.productVersionReference,
      menuVersionReference: line.menuVersionReference,
      quantity: line.quantity,
    })),
    warnings: quote.warnings,
    quoteCreatedAt: quote.createdAt,
    quoteExpiresAt: quote.expiresAt,
    attachedAt: at,
    idempotencyExpiresAt: "2026-08-03T16:00:00.000Z",
  });
  const record = Pricing.parsePriceQuoteRequestRecord({
    operationReference: id(91),
    guestSessionReference: id(92),
    brandReference: quote.brandReference,
    storeReference: quote.storeReference,
    cartReference: quote.cartReference,
    cartVersion: quote.cartVersion,
    recordVersion: 1,
    intentDigest: `sha256:${"a".repeat(64)}`,
    quoteReference: quote.quoteReference,
    quoteOutcome: "Created",
    createdAt: at,
    idempotencyExpiresAt: "2026-08-03T16:00:00.000Z",
  });
  const input: QuoteCartCommand = {
    cartReference: quote.cartReference,
    expectedCartVersion: quote.cartVersion,
    guestCredential: "g".repeat(43),
    csrfCredential: "c".repeat(43),
    idempotencyKey: id(91),
    requestedAt: at,
  };
  const attach = vi.fn(
    async (): Promise<
      Awaited<ReturnType<ReturnType<typeof Ordering.createPickupCartQuoteService>["attach"]>>
    > => ({ status: "Attached", attachment }),
  );
  const resolve = vi.fn<Pricing.PriceQuoteRequestStore["resolve"]>(async () => ({ record, quote }));
  const now = vi.fn(() => at);
  const scope = {
    brandReference: String(quote.brandReference),
    storeReference: String(quote.storeReference),
  };
  return {
    quote,
    attachment,
    record,
    input,
    attach,
    resolve,
    now,
    scope,
    port: createCustomerQuotePort({ scope, attachment: { attach }, requests: { resolve }, now }),
  };
}

describe("authorized Quote HTTP bridge", () => {
  it.each(["Created", "Existing"] as const)(
    "returns original %s outcome after final authorization",
    async (quoteOutcome) => {
      const f = fixture();
      f.resolve.mockResolvedValue({ record: { ...f.record, quoteOutcome }, quote: f.quote });
      f.attach.mockResolvedValue({ status: "AlreadyAttached", attachment: f.attachment });
      const result = await f.port.quoteCart(f.input);
      expect(result).toEqual({
        status: quoteOutcome === "Created" ? "Created" : "Current",
        quote: f.quote,
      });
      expect(f.attach).toHaveBeenCalledTimes(2);
      expect(f.resolve).toHaveBeenCalledWith({
        operationReference: id(91),
        guestSessionReference: id(92),
        cartReference: f.quote.cartReference,
        cartVersion: f.quote.cartVersion,
        observedAt: at,
      });
      if (result.status !== "Created" && result.status !== "Current")
        throw new Error("missing Quote");
      expect(Object.isFrozen(result.quote)).toBe(true);
      expect(result.quote).not.toBe(f.quote);
    },
  );
  it.each([
    ["CART_PERMISSION_DENIED", "NotFound"],
    ["CART_UNAVAILABLE", "NotFound"],
    ["CART_VERSION_CONFLICT", "VersionConflict"],
    ["CART_IDEMPOTENCY_CONFLICT", "IdempotencyConflict"],
    ["CART_QUOTE_INVALID", "InvalidConfiguration"],
    ["CART_DEPENDENCY_UNAVAILABLE", "Unavailable"],
  ] as const)("maps initial %s without reading history", async (code, status) => {
    const f = fixture();
    f.attach.mockRejectedValue(new Ordering.CartError(code));
    expect(await f.port.quoteCart(f.input)).toEqual({ status });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each([null, "corrupt", "failure"])("preserves uncertainty for %s history", async (kind) => {
    const f = fixture();
    if (kind === "failure") f.resolve.mockRejectedValue(new Error("synthetic private cause"));
    else
      f.resolve.mockResolvedValue(kind === null ? null : { record: f.record, quote: {} as never });
    expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
    expect(f.attach).toHaveBeenCalledTimes(1);
  });
  it.each([
    "operationReference",
    "guestSessionReference",
    "brandReference",
    "storeReference",
    "cartReference",
    "quoteReference",
  ] as const)("rejects foreign record %s", async (field) => {
    const f = fixture();
    f.resolve.mockResolvedValue({ quote: f.quote, record: { ...f.record, [field]: id(999) } });
    expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
  });
  it.each(["scope", "total", "line", "status"])(
    "rejects mismatched attachment %s",
    async (kind) => {
      const f = fixture();
      const attachment =
        kind === "scope"
          ? { ...f.attachment, storeReference: id(999) }
          : kind === "total"
            ? {
                ...f.attachment,
                subtotal: {
                  ...f.attachment.subtotal,
                  amountMinor: f.attachment.subtotal.amountMinor + 1n,
                },
                total: { ...f.attachment.total, amountMinor: f.attachment.total.amountMinor + 1n },
              }
            : {
                ...f.attachment,
                lines: f.attachment.lines.map((line) => ({
                  ...line,
                  productVersionReference: id(999),
                })),
              };
      f.attach.mockResolvedValue({
        status: kind === "status" ? "invalid" : "Attached",
        attachment,
      } as never);
      expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
    },
  );
  it("keeps historical expiry and rejects request-expiry boundary", async () => {
    const f = fixture();
    f.now.mockReturnValue("2026-08-02T17:00:00.000Z");
    expect(await f.port.quoteCart(f.input)).toEqual({ status: "Created", quote: f.quote });
    f.now.mockReturnValue(f.record.idempotencyExpiresAt);
    expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
  });
  it.each(["2026-08-02T15:59:59.000Z", "2026-08-03T16:00:00.000Z", "invalid"])(
    "denies a final clock boundary of %s",
    async (finalAt) => {
      const f = fixture();
      f.now.mockReturnValueOnce(at).mockReturnValueOnce(finalAt);
      expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
      expect(f.attach).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["revoked", "changed"])(
    "preserves uncertainty when final authorization is %s",
    async (kind) => {
      const f = fixture();
      f.attach.mockResolvedValueOnce({ status: "Attached", attachment: f.attachment });
      if (kind === "revoked")
        f.attach.mockRejectedValueOnce(new Ordering.CartError("CART_PERMISSION_DENIED"));
      else
        f.attach.mockResolvedValueOnce({
          status: "AlreadyAttached",
          attachment: { ...f.attachment, quoteReference: String(id(999)) as never },
        });
      expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
      expect(f.resolve).toHaveBeenCalledTimes(1);
    },
  );
  it("copies commands before awaits and never sends credentials to Pricing", async () => {
    const f = fixture();
    const raw = { ...f.input };
    f.attach.mockImplementationOnce(async () => {
      raw.idempotencyKey = id(999);
      raw.csrfCredential = "x".repeat(43);
      return { status: "Attached", attachment: f.attachment };
    });
    expect((await f.port.quoteCart(raw)).status).toBe("Created");
    expect(f.attach).toHaveBeenLastCalledWith({
      sessionCredential: f.input.guestCredential,
      csrfCredential: f.input.csrfCredential,
      cartReference: f.input.cartReference,
      expectedCartVersion: f.input.expectedCartVersion,
      operationReference: f.input.idempotencyKey,
    });
    expect(Object.keys(f.resolve.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "cartReference",
      "cartVersion",
      "guestSessionReference",
      "observedAt",
      "operationReference",
    ]);
  });
  it("rejects an accessor before calling the entry", async () => {
    const f = fixture();
    const get = vi.fn(() => id(91));
    const raw = { ...f.input };
    Object.defineProperty(raw, "idempotencyKey", { enumerable: true, get });
    expect(await f.port.quoteCart(raw)).toEqual({ status: "Unavailable" });
    expect(get).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });
  it("serves original exact money through the actual HTTP handler and preserves post-read denial", async () => {
    const f = fixture();
    const origin = "https://customer.example";
    const server = createServer(
      createApp({
        customerQuote: new CustomerQuoteHandler({
          port: f.port,
          allowedOrigin: origin,
          now: () => at,
        }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing address");
      const send = () =>
        fetch(`http://127.0.0.1:${address.port}/api/v1/carts/${f.input.cartReference}/quote`, {
          method: "POST",
          headers: {
            origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: `__Host-bop-guest=${f.input.guestCredential}`,
            "x-csrf-token": f.input.csrfCredential,
            "idempotency-key": f.input.idempotencyKey,
          },
          body: JSON.stringify({ cartVersion: f.input.expectedCartVersion }),
        });
      const first = await send();
      expect(first.status).toBe(201);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json()).toMatchObject({
        quote: {
          total: { amountMinor: f.quote.total.amountMinor.toString(), currency: "CAD" },
          expiresAt: f.quote.expiresAt,
        },
      });
      f.attach
        .mockResolvedValueOnce({ status: "AlreadyAttached", attachment: f.attachment })
        .mockRejectedValueOnce(new Ordering.CartError("CART_PERMISSION_DENIED"));
      const denied = await send();
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({ error: { code: "quote_service_unavailable" } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function compositionOptions(f: ReturnType<typeof fixture>): CustomerQuoteCompositionOptions {
  const run = async (): Promise<never> => {
    throw new Error("synthetic unavailable database");
  };
  return {
    scope: f.scope,
    session: entryFixture().options.session,
    sessionTransactions: { run },
    cartTransactions: { run },
    attachmentTransactions: { run },
    pricingTransactions: { run },
    references: { hashIntent: () => `sha256:${"a".repeat(64)}`, equals: (a, b) => a === b },
    pricingReferences: {
      generateReference: () => id(999),
      hashIntent: () => `sha256:${"a".repeat(64)}`,
      equals: (a, b) => a === b,
    },
    audit: () => ({}) as never,
    expiryAudit: () => ({}) as never,
    candidate: async () => ({ quote: f.quote, audit: {} as never }),
    now: () => at,
  };
}
describe("explicit owner Quote composition", () => {
  it("constructs without database I/O", () => {
    const f = fixture();
    const options = compositionOptions(f);
    const run = vi.fn(async (): Promise<never> => {
      throw new Error("synthetic unavailable database");
    });
    expect(() =>
      createCustomerQuoteComposition({
        ...options,
        sessionTransactions: { run },
        cartTransactions: { run },
        attachmentTransactions: { run },
        pricingTransactions: { run },
      }),
    ).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["existing", "new", "conflict", "mismatch", "mutation", "wrongmode"])(
    "coordinates %s Pricing request",
    async (kind) => {
      const f = fixture();
      const resolve = vi.fn(async (): Promise<Pricing.PriceQuoteRequestResult | null> =>
        kind === "existing" ? { record: f.record, quote: f.quote } : null,
      );
      if (kind === "conflict")
        resolve.mockRejectedValue(new Pricing.PriceQuoteRequestError("QUOTE_REQUEST_CONFLICT"));
      const append = vi.fn(async () => ({ record: f.record, quote: f.quote }));
      vi.spyOn(Pricing, "createPostgresPriceQuoteRequestStore").mockReturnValue({
        resolve,
        append,
      });
      let captured: Ordering.PickupCartQuoteOptions | undefined;
      vi.spyOn(Ordering, "createPickupCartQuoteService").mockImplementation((options) => {
        captured = options;
        return { attach: f.attach };
      });
      const options = compositionOptions(f);
      const candidate = vi.fn(async (input: Ordering.PricingCartInput) => {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.lines[0]?.catalogSelectionEvidence)).toBe(true);
        if (kind === "mutation") Object.defineProperty(input, "cartReference", { value: id(999) });
        if (kind === "wrongmode") {
          const source = quoteInput();
          return {
            quote: Pricing.createPriceQuote({
              ...source,
              priceBook: {
                ...source.priceBook,
                entries: source.priceBook.entries.map((entry) => ({
                  ...entry,
                  orderType: "DineIn",
                })),
              },
              taxConfiguration: {
                ...source.taxConfiguration,
                rules: source.taxConfiguration.rules.map((rule) => ({
                  ...rule,
                  orderType: "DineIn",
                })),
              },
              lines: source.lines.map((line) => ({
                ...line,
                priceContext: { ...line.priceContext, orderType: "DineIn" },
                taxContext: { ...line.taxContext, orderType: "DineIn" },
              })),
            }),
            audit: {} as never,
          };
        }
        return {
          quote:
            kind === "mismatch"
              ? Pricing.createPriceQuote(quoteInput({ cartReference: id(999) }))
              : f.quote,
          audit: {} as never,
        };
      });
      createCustomerQuoteComposition({ ...options, candidate });
      if (captured === undefined) throw new Error("missing owner composition");
      const input = {
        brandReference: f.quote.brandReference,
        storeReference: f.quote.storeReference,
        cartReference: f.quote.cartReference,
        cartVersion: f.quote.cartVersion,
        sourceChannel: "Web",
        orderType: "Pickup",
        requestedAt: at,
        lines: f.quote.lines.map((line) => ({
          lineReference: line.lineReference,
          sellableReference: line.sellableReference,
          quantity: line.quantity,
          optionSelections: [],
          catalogSelectionEvidence: {
            productVersionReference: line.productVersionReference,
            menuVersionReference: line.menuVersionReference,
            catalogChannelCode: "SYNTHETIC",
            catalogOrderTypeCode: "SYNTHETIC",
            ruleEvidence: [],
            validatedAt: at,
          },
        })),
      } as unknown as Ordering.PricingCartInput;
      const attempt = captured.pricing.quoteCart(input, {
        operationReference: String(id(91)) as never,
        guestSessionReference: String(id(92)) as never,
      });
      if (kind === "conflict" || kind === "mismatch" || kind === "mutation" || kind === "wrongmode")
        await expect(attempt).rejects.toMatchObject({
          code:
            kind === "conflict"
              ? "CART_IDEMPOTENCY_CONFLICT"
              : kind === "mutation"
                ? "CART_DEPENDENCY_UNAVAILABLE"
                : "CART_QUOTE_INVALID",
        });
      else expect(await attempt).toEqual(f.quote);
      expect(candidate).toHaveBeenCalledTimes(
        kind === "new" || kind === "mismatch" || kind === "mutation" || kind === "wrongmode"
          ? 1
          : 0,
      );
      expect(append).toHaveBeenCalledTimes(kind === "new" ? 1 : 0);
    },
  );
});

describe("authorized expiry result transport composition", () => {
  function expiryFixture() {
    const f = fixture();
    const expiredAt = new Date(Date.parse(f.quote.expiresAt) + 1000).toISOString();
    const record = Ordering.parseCartQuoteExpiryRecord({
      ...f.scope,
      resolutionVersion: 1,
      operationReference: f.input.idempotencyKey,
      guestSessionReference: f.attachment.guestSessionReference,
      cartReference: f.input.cartReference,
      cartVersion: f.input.expectedCartVersion,
      quoteReference: f.quote.quoteReference,
      quoteInputDigest: f.quote.inputDigest,
      requestIntentDigest: f.record.intentDigest,
      quoteCreatedAt: f.quote.createdAt,
      quoteExpiresAt: f.quote.expiresAt,
      requestCreatedAt: f.record.createdAt,
      requestExpiresAt: f.record.idempotencyExpiresAt,
      expiredAt,
    });
    const reconcile = vi.fn(async (): Promise<Ordering.PickupCartQuoteExpiryResult> => ({
      status: "Expired",
      record,
    }));
    const port = createCustomerQuotePort({
      scope: f.scope,
      attachment: { attach: f.attach },
      requests: { resolve: f.resolve },
      expiry: { reconcile },
      now: () => expiredAt,
    });
    return { ...f, record, reconcile, port };
  }
  it("returns the minimal original-operation receipt without another attach or Pricing query", async () => {
    const f = expiryFixture();
    expect(await f.port.quoteCart(f.input)).toEqual({
      status: "Expired",
      resolution: {
        operationReference: f.input.idempotencyKey,
        cartReference: f.input.cartReference,
        cartVersion: f.input.expectedCartVersion,
      },
    });
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(["operationReference", "cartReference", "storeReference"])(
    "bounds substituted expiry %s",
    async (field) => {
      const f = expiryFixture();
      f.reconcile.mockResolvedValue({
        status: "Expired",
        record: Ordering.parseCartQuoteExpiryRecord({ ...f.record, [field]: id(999) }),
      });
      const result = await f.port.quoteCart(f.input);
      expect(result.status).toBe("Unavailable");
      expect(f.attach).not.toHaveBeenCalled();
    },
  );
  it.each(["CART_PERMISSION_DENIED", "CART_DEPENDENCY_UNAVAILABLE"] as const)(
    "keeps owner denial %s nonterminal",
    async (code) => {
      const f = expiryFixture();
      f.reconcile.mockRejectedValue(new Ordering.CartError(code));
      expect(await f.port.quoteCart(f.input)).toEqual({
        status: code === "CART_PERMISSION_DENIED" ? "NotFound" : "Unavailable",
      });
      expect(f.attach).not.toHaveBeenCalled();
    },
  );
});
