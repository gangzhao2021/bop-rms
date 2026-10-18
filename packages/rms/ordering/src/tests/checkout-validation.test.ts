import type { GuestSession } from "@bop/identity";
import type { CatalogSelectionValidationResult } from "@rms/catalog";
import { describe, expect, it } from "vitest";
import { createCheckoutValidationService } from "../application/checkout-validation-service.js";
import type {
  CheckoutStockLine,
  CheckoutValidationPorts,
} from "../application/ports/checkout-validation-ports.js";
import {
  CheckoutValidationError,
  type CheckoutFulfillmentValidationResult,
} from "../contracts/checkout-validation.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import { parseCartAggregate, type CartAggregate } from "../domain/cart.js";

const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const at = "2026-08-02T15:00:00.000Z";
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
  operation: id(14),
  fulfillment: id(15),
  currency: id(16),
};

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

function quote(overrides: Partial<CartQuoteAttachment> = {}): CartQuoteAttachment {
  return parseCartQuoteAttachment({
    operationReference: id(30),
    operationIntentHash: digest("a"),
    guestSessionReference: ids.session,
    cartReference: ids.cart,
    brandReference: ids.brand,
    storeReference: ids.store,
    cartVersion: 4,
    quoteReference: ids.quote,
    quoteVersion: 1,
    quoteInputDigest: digest("b"),
    currencyCode: "CAD",
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: ids.currency,
    subtotal: { amountMinor: 2000n, currencyCode: "CAD" },
    discount: { amountMinor: 0n, currencyCode: "CAD" },
    tax: { amountMinor: 260n, currencyCode: "CAD" },
    fee: { amountMinor: 0n, currencyCode: "CAD" },
    total: { amountMinor: 2260n, currencyCode: "CAD" },
    lines: [
      {
        lineReference: ids.item,
        sellableReference: ids.sellable,
        productVersionReference: ids.productVersion,
        menuVersionReference: ids.menuVersion,
        quantity: 2,
      },
    ],
    warnings: [],
    quoteCreatedAt: "2026-08-02T14:59:00.000Z",
    quoteExpiresAt: "2026-08-02T15:05:00.000Z",
    attachedAt: at,
    idempotencyExpiresAt: "2026-08-03T15:00:00.000Z",
    ...overrides,
  });
}

function acceptedCatalog(
  overrides: Record<string, unknown> = {},
): CatalogSelectionValidationResult {
  return {
    status: "Accepted",
    brandReference: ids.brand,
    storeReference: ids.store,
    sourceChannel: "Qr",
    orderType: "Pickup",
    sellableReference: ids.sellable,
    optionSelections: [],
    menuVersionReference: ids.menuVersion,
    productVersionReference: ids.productVersion,
    catalogChannelCode: "PILOT_CHANNEL",
    catalogOrderTypeCode: "PILOT_ORDER_TYPE",
    ruleEvidence: [
      { bindingReference: ids.binding, optionSetVersionReference: ids.optionSetVersion },
    ],
    validatedAt: at,
    ...overrides,
  } as unknown as CatalogSelectionValidationResult;
}

function acceptedFulfillment(
  overrides: Record<string, unknown> = {},
): CheckoutFulfillmentValidationResult {
  return {
    status: "Accepted",
    brandReference: ids.brand,
    storeReference: ids.store,
    cartReference: ids.cart,
    cartVersion: 4,
    quoteReference: ids.quote,
    orderType: "Pickup",
    sourceChannel: "Qr",
    evidenceReference: ids.fulfillment,
    evidenceVersion: 1,
    evidenceDigest: digest("f"),
    checkedAt: at,
    validUntil: "2026-08-02T15:03:00.000Z",
    ...overrides,
  } as CheckoutFulfillmentValidationResult;
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
    denied?: boolean;
    guest?: GuestSession;
    cart?: CartAggregate | null;
    quote?: CartQuoteAttachment | null;
    catalog?: CatalogSelectionValidationResult;
    fulfillment?: CheckoutFulfillmentValidationResult;
    failDependency?: "authorization" | "cart" | "quote" | "catalog" | "fulfillment";
    badHash?: boolean;
    stock?: (lines: readonly CheckoutStockLine[]) => boolean;
    catalogFor?: (sellableReference: string) => CatalogSelectionValidationResult;
  } = {},
) {
  const calls = {
    cart: 0,
    quote: 0,
    catalog: [] as unknown[],
    fulfillment: [] as unknown[],
    stock: [] as (readonly CheckoutStockLine[])[],
  };
  const currentCart = options.cart === undefined ? cart() : options.cart;
  const currentQuote = options.quote === undefined ? quote() : options.quote;
  const ports: CheckoutValidationPorts = {
    authorization: {
      async authorize() {
        if (options.failDependency === "authorization") throw new Error("synthetic");
        return options.denied ? null : { guestSession: options.guest ?? guest() };
      },
    },
    catalog: {
      async validateSelection(input) {
        calls.catalog.push(input);
        if (options.failDependency === "catalog") throw new Error("synthetic");
        if (options.catalogFor) return options.catalogFor(String(input.sellableReference));
        return options.catalog ?? acceptedCatalog();
      },
    },
    fulfillment: {
      async validate(input) {
        calls.fulfillment.push(input);
        if (options.failDependency === "fulfillment") throw new Error("synthetic");
        return options.fulfillment ?? acceptedFulfillment();
      },
    },
    references: { hashIntent: options.badHash ? () => "invalid" : hash },
    ...(options.stock === undefined
      ? {}
      : {
          stock: {
            async covers(request: { lines: readonly CheckoutStockLine[] }) {
              calls.stock.push(request.lines);
              return (options.stock as NonNullable<typeof options.stock>)(request.lines);
            },
          },
        }),
    repository: {
      async loadCart() {
        calls.cart += 1;
        if (options.failDependency === "cart") throw new Error("synthetic");
        return currentCart;
      },
      async loadQuote() {
        calls.quote += 1;
        if (options.failDependency === "quote") throw new Error("synthetic");
        return currentQuote;
      },
    },
  };
  return { service: createCheckoutValidationService(ports), calls };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    validationReference: ids.operation,
    cartReference: ids.cart,
    expectedCartVersion: 4,
    quoteReference: ids.quote,
    requestedAt: at,
    ...overrides,
  };
}

async function rejects(
  service: ReturnType<typeof createCheckoutValidationService>,
  code: CheckoutValidationError["code"],
  value: unknown = input(),
) {
  await expect(service.validate(value)).rejects.toMatchObject({
    name: "CheckoutValidationError",
    code,
  });
}

describe("WP-1220 Checkout Validation", () => {
  it("returns scope-pinned evidence capped by Quote, Cart and fulfillment validity", async () => {
    const { service, calls } = fixture();
    const result = await service.validate(input());
    expect(result).toMatchObject({
      validationReference: ids.operation,
      guestSessionReference: ids.session,
      brandReference: ids.brand,
      storeReference: ids.store,
      cartReference: ids.cart,
      cartVersion: 4,
      quoteReference: ids.quote,
      quoteVersion: 1,
      quoteInputDigest: digest("b"),
      validUntil: "2026-08-02T15:03:00.000Z",
    });
    expect(result.catalogLines).toEqual([
      {
        cartItemReference: ids.item,
        sellableReference: ids.sellable,
        menuVersionReference: ids.menuVersion,
        productVersionReference: ids.productVersion,
        validatedAt: at,
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls.catalog).toHaveLength(1);
    expect(calls.fulfillment).toHaveLength(1);
  });

  it("fails closed on malformed input and invalid reference hashes", async () => {
    const { service } = fixture();
    await rejects(service, "CHECKOUT_INPUT_INVALID", { ...input(), extra: true });
    await rejects(service, "CHECKOUT_INPUT_INVALID", input({ expectedCartVersion: 0 }));
  });

  it("authorizes before loading Cart or Quote and rejects a mis-scoped Guest Session", async () => {
    const denied = fixture({ denied: true });
    await rejects(denied.service, "CHECKOUT_PERMISSION_DENIED");
    expect(denied.calls.cart).toBe(0);
    expect(denied.calls.quote).toBe(0);
    await rejects(
      fixture({ guest: guest({ storeReference: id(99) as never }) }).service,
      "CHECKOUT_PERMISSION_DENIED",
    );
  });

  it("rejects missing, stale-version, empty and non-active Carts", async () => {
    const activeLifecycle = cart().lifecycle;
    if (activeLifecycle === null) throw new Error("synthetic fixture lifecycle missing");
    await rejects(fixture({ cart: null }).service, "CHECKOUT_CART_UNAVAILABLE");
    await rejects(
      fixture().service,
      "CHECKOUT_CART_VERSION_CONFLICT",
      input({ expectedCartVersion: 3 }),
    );
    await rejects(fixture({ cart: cart({ items: [] }) }).service, "CHECKOUT_CART_EMPTY");
    await rejects(
      fixture({
        cart: cart({
          updatedAt: at as never,
          lifecycle: {
            ...activeLifecycle,
            status: "Abandoned",
            terminalAt: at as never,
            terminalReason: "CUSTOMER_ABANDONED",
          },
        }),
      }).service,
      "CHECKOUT_CART_NOT_ACTIVE",
    );
  });

  it("requires the exact attached Quote and treats the expiry instant as expired", async () => {
    await rejects(fixture({ quote: null }).service, "CHECKOUT_QUOTE_MISSING");
    await rejects(
      fixture({ quote: quote({ quoteReference: id(99) as never }) }).service,
      "CHECKOUT_REQUOTE_REQUIRED",
    );
    await rejects(
      fixture({
        quote: quote({
          quoteExpiresAt: at as never,
          attachedAt: "2026-08-02T14:59:30.000Z" as never,
          idempotencyExpiresAt: "2026-08-03T14:59:30.000Z" as never,
        }),
      }).service,
      "CHECKOUT_QUOTE_EXPIRED",
    );
  });

  it("requires every attached Quote line to match the current Cart selection evidence", async () => {
    const currentItem = cart().items[0];
    if (currentItem === undefined) throw new Error("synthetic fixture item missing");
    const changedCart = cart({
      items: [{ ...currentItem, quantity: 3 }],
    });
    await rejects(fixture({ cart: changedCart }).service, "CHECKOUT_REQUOTE_REQUIRED");
  });

  it("maps current Catalog rejection without accepting stale attachment evidence", async () => {
    await rejects(
      fixture({ catalog: { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" } }).service,
      "CHECKOUT_ITEM_UNAVAILABLE",
    );
    await rejects(
      fixture({ catalog: { status: "Rejected", reason: "OPTION_CONFLICT" } }).service,
      "CHECKOUT_SELECTION_INVALID",
    );
    await rejects(
      fixture({ catalog: acceptedCatalog({ productVersionReference: id(98) }) }).service,
      "CHECKOUT_REQUOTE_REQUIRED",
    );
    await rejects(
      fixture({
        catalog: acceptedCatalog({ optionSelections: [{ optionReference: id(97), quantity: 1 }] }),
      }).service,
      "CHECKOUT_REQUOTE_REQUIRED",
    );
  });

  it.each([
    ["STORE_CLOSED", "CHECKOUT_STORE_CLOSED"],
    ["CAPACITY_UNAVAILABLE", "CHECKOUT_CAPACITY_UNAVAILABLE"],
    ["FULFILLMENT_UNAVAILABLE", "CHECKOUT_FULFILLMENT_UNAVAILABLE"],
  ] as const)("maps fulfillment rejection %s", async (reason, code) => {
    await rejects(fixture({ fulfillment: { status: "Rejected", reason } }).service, code);
  });

  it("rejects malformed fulfillment rejection instead of treating it as policy", async () => {
    await rejects(
      fixture({
        fulfillment: {
          status: "Rejected",
          reason: "CAPACITY_UNAVAILABLE",
          extra: "must-not-cross-boundary",
        } as never,
      }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("rejects malformed or mismatched accepted fulfillment evidence", async () => {
    await rejects(
      fixture({ fulfillment: acceptedFulfillment({ storeReference: id(99) }) }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
    await rejects(
      fixture({ fulfillment: acceptedFulfillment({ validUntil: at }) }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
    await rejects(
      fixture({ fulfillment: acceptedFulfillment({ extra: "must-not-cross-boundary" }) }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("maps malformed dependency records and reference service output", async () => {
    await rejects(
      fixture({ cart: {} as CartAggregate }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
    await rejects(
      fixture({ quote: {} as CartQuoteAttachment }).service,
      "CHECKOUT_DEPENDENCY_UNAVAILABLE",
    );
    await rejects(fixture({ badHash: true }).service, "CHECKOUT_DEPENDENCY_UNAVAILABLE");
  });

  it.each(["authorization", "cart", "quote", "catalog", "fulfillment"] as const)(
    "maps the %s dependency failure without inferring validation success",
    async (failDependency) => {
      await rejects(fixture({ failDependency }).service, "CHECKOUT_DEPENDENCY_UNAVAILABLE");
    },
  );
});

describe("WP-2423 Checkout Validation on a shared transaction (v15 2026-10-14)", () => {
  it("checks a multi-line Cart one line at a time, never two owner calls at once", async () => {
    const base = cart();
    const first = base.items[0];
    if (first === undefined) throw new Error("synthetic line missing");
    const second = { ...first, cartItemReference: id(70) as never, quantity: 1 };
    const twoLines = cart({ items: [first, second] });
    const baseQuote = quote();
    const firstLine = baseQuote.lines[0];
    if (firstLine === undefined) throw new Error("synthetic quote line missing");
    const twoLineQuote = quote({
      lines: [firstLine, { ...firstLine, lineReference: id(70) as never, quantity: 1 }],
    });
    let inFlight = 0;
    let overlapped = false;
    const f = fixture({ cart: twoLines, quote: twoLineQuote });
    const original = f.calls;
    const ports = {
      authorization: { authorize: async () => ({ guestSession: guest() }) },
      catalog: {
        async validateSelection(selection: unknown) {
          original.catalog.push(selection);
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          // A real owner check awaits its transaction; give a concurrent caller the chance.
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          if (overlapped) throw new Error("concurrent use of one transaction");
          return acceptedCatalog();
        },
      },
      fulfillment: { validate: async () => acceptedFulfillment() },
      references: { hashIntent: hash },
      repository: { loadCart: async () => twoLines, loadQuote: async () => twoLineQuote },
    } as unknown as CheckoutValidationPorts;
    const result = await createCheckoutValidationService(ports).validate(input());
    expect(result.catalogLines.map((line) => line.cartItemReference)).toEqual([ids.item, id(70)]);
    expect(original.catalog).toHaveLength(2);
    expect(overlapped).toBe(false);
  });
});

describe("WP-2423 checkout stock shortage", () => {
  const latte = id(80),
    mocha = id(81),
    latteLine = id(82),
    mochaLine = id(83);
  const line = (reference: string, sellable: string, quantity: number) => ({
    cartItemReference: reference,
    cartReference: ids.cart,
    sellableReference: sellable,
    quantity,
    optionSelections: [],
    customerNote: null,
    catalogSelectionEvidence: {
      menuVersionReference: ids.menuVersion,
      productVersionReference: ids.productVersion,
      catalogChannelCode: "PILOT_CHANNEL",
      catalogOrderTypeCode: "PILOT_ORDER_TYPE",
      ruleEvidence: [
        { bindingReference: ids.binding, optionSetVersionReference: ids.optionSetVersion },
      ],
      validatedAt: "2026-08-02T14:30:00.000Z",
    },
    addedByActorReference: ids.session,
    addedByParticipantReference: null,
    addedAt: "2026-08-02T14:30:00.000Z",
  });
  const quoteLine = (reference: string, sellable: string, quantity: number) => ({
    lineReference: reference,
    sellableReference: sellable,
    productVersionReference: ids.productVersion,
    menuVersionReference: ids.menuVersion,
    quantity,
  });
  /** Synthetic stock: each latte and mocha takes one cup of the same milk. */
  const milk = (cups: number) => (lines: readonly CheckoutStockLine[]) =>
    lines.reduce((sum, entry) => sum + entry.quantity, 0) <= cups;
  const shared = (latteCups: number, mochaCups: number) => ({
    cart: cart({
      items: [line(latteLine, latte, latteCups), line(mochaLine, mocha, mochaCups)] as never,
    }),
    quote: quote({
      lines: [
        quoteLine(latteLine, latte, latteCups),
        quoteLine(mochaLine, mocha, mochaCups),
      ] as never,
    }),
    catalogFor: (sellable: string) => acceptedCatalog({ sellableReference: sellable }),
  });

  it("passes a Cart the stock covers, asking Inventory once for the whole Cart", async () => {
    const { service, calls } = fixture({ ...shared(1, 1), stock: milk(2) });
    await expect(service.validate(input())).resolves.toMatchObject({ cartReference: ids.cart });
    expect(calls.stock).toHaveLength(1);
    expect(calls.stock[0]?.map((entry) => entry.cartItemReference)).toEqual([latteLine, mochaLine]);
  });

  it("names two drinks sharing one milk that together exceed it, before fulfillment or payment", async () => {
    const { service, calls } = fixture({ ...shared(2, 2), stock: milk(3) });
    const error = await service.validate(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CheckoutValidationError);
    expect(error).toMatchObject({
      code: "CHECKOUT_STOCK_SHORT",
      // The most recently added item is lowered first; the latte stays as ordered.
      line: { cartItemReference: mochaLine, available: 1, sharedStock: true },
    });
    expect(calls.fulfillment).toHaveLength(0);
  });

  it("says how many are left when one item alone is short (same item on two lines counted together)", async () => {
    const second = id(84);
    const { service } = fixture({
      cart: cart({
        items: [line(latteLine, latte, 1), line(second, latte, 1)] as never,
      }),
      quote: quote({
        lines: [quoteLine(latteLine, latte, 1), quoteLine(second, latte, 1)] as never,
      }),
      catalogFor: (sellable: string) => acceptedCatalog({ sellableReference: sellable }),
      stock: milk(1),
    });
    await expect(service.validate(input())).rejects.toMatchObject({
      code: "CHECKOUT_STOCK_SHORT",
      line: { cartItemReference: latteLine, available: 1, sharedStock: false },
    });
  });

  it("reports a sold-out item the Catalog refuses with nothing left, and an off-menu item as unavailable", async () => {
    const soldOut = fixture({
      catalog: { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" } as never,
      stock: () => false,
    });
    await expect(soldOut.service.validate(input())).rejects.toMatchObject({
      code: "CHECKOUT_STOCK_SHORT",
      line: { cartItemReference: ids.item, available: 0, sharedStock: false },
    });
    const offMenu = fixture({
      catalog: { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" } as never,
      stock: () => true,
    });
    await expect(offMenu.service.validate(input())).rejects.toMatchObject({
      code: "CHECKOUT_ITEM_UNAVAILABLE",
      line: { cartItemReference: ids.item, available: null },
    });
  });

  it("treats an unreadable stock answer as a dependency failure, never as covered", async () => {
    const { service } = fixture({
      stock: () => {
        throw new Error("synthetic");
      },
    });
    await rejects(service, "CHECKOUT_DEPENDENCY_UNAVAILABLE");
  });
});
