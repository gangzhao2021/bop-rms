import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppendAuditRecordInput } from "../../../packages/bop/audit/src/index.js";
import type {
  GuestRawCredential,
  GuestSession,
  GuestSessionCookieDescriptor,
} from "../../../packages/bop/identity/src/index.js";
import type {
  CustomerMenuQueryInput,
  CustomerMenuQueryResult,
} from "../../../packages/rms/catalog/src/index.js";
import type { PriceQuoteSnapshot } from "../../../packages/rms/pricing/src/index.js";
import { resolveStoreBusinessDate } from "../../../packages/rms/store/src/index.js";

import { createApp } from "../../../apps/api/src/app.js";
import {
  CustomerCartHandler,
  type CustomerCartPort,
  type CustomerCartPortResult,
  type CustomerCartView,
} from "../../../apps/api/src/customer-cart.js";
import {
  CustomerEntryHandler,
  type CustomerEntryPort,
  type CustomerEntryPortInput,
  type CustomerEntryPortResult,
} from "../../../apps/api/src/customer-entry.js";
import { CustomerMenuHandler, type CustomerMenuPort } from "../../../apps/api/src/customer-menu.js";
import {
  CustomerQuoteHandler,
  type CustomerQuotePort,
  type QuoteCartCommand,
  type QuoteCartResult,
} from "../../../apps/api/src/customer-quote.js";
import { createOrderCreationService } from "../../../packages/rms/ordering/src/application/order-creation-service.js";
import type { OrderCreationPorts } from "../../../packages/rms/ordering/src/application/ports/order-creation-ports.js";
import { parseCartAggregate } from "../../../packages/rms/ordering/src/domain/cart.js";
import { parseCheckoutValidationEvidence } from "../../../packages/rms/ordering/src/domain/checkout-validation.js";
import {
  parseOrderCreationRecord,
  type OrderCreationRecord,
} from "../../../packages/rms/ordering/src/domain/order-creation.js";
import { createOrderNumberAllocation } from "../../../packages/rms/ordering/src/domain/order-number.js";

const id = (value: number) => `018f7200-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const now = "2026-08-12T16:00:00.000Z";
const origin = "https://customer.example.test";
const guestCredential = "g".repeat(43) as GuestRawCredential;
const csrfCredential = "c".repeat(43) as GuestRawCredential;
const runReference = randomUUID();
const runSignature = createHash("sha512").update(runReference).digest();
const qrToken = [
  Buffer.from('{"alg":"ES256","kid":"wp-2020"}').toString("base64url"),
  Buffer.from(JSON.stringify({ fixture: "wp-2020", runReference })).toString("base64url"),
  runSignature.toString("base64url"),
].join(".");
const refs = Object.freeze({
  brand: id(1),
  store: id(2),
  publicStore: id(3),
  session: id(4),
  qr: id(5),
  menu: id(6),
  menuVersion: id(7),
  productVersion: id(8),
  sellable: id(9),
  cart: id(10),
  cartItem: id(11),
  quote: id(12),
  submission: id(13),
  validation: id(14),
  fulfillment: id(15),
  order: id(16),
  batch: id(17),
  orderItem: id(18),
  event: id(19),
});

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function cartView(version: number, withItem: boolean): CustomerCartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: refs.cart,
      version,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "WP 2020 Brand", storeName: "WP 2020 Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-12T17:00:00.000Z",
        absoluteExpiresAt: "2026-08-13T16:00:00.000Z",
      },
      items: withItem
        ? [
            {
              cartItemReference: refs.cartItem,
              sellableReference: refs.sellable,
              displayName: "WP 2020 Bowl",
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: {
                status: "Available",
                total: { amountMinor: "1130", currency: "CAD" },
              },
              warnings: [],
            },
          ]
        : [],
      quote: null,
      warnings: [],
    },
  };
}

class EntryPort implements CustomerEntryPort {
  readonly calls: CustomerEntryPortInput[] = [];

  async establish(input: Readonly<CustomerEntryPortInput>): Promise<CustomerEntryPortResult> {
    this.calls.push(input);
    return {
      status: "Established",
      brandDisplayName: "WP 2020 Brand",
      storeDisplayName: "WP 2020 Store",
      publicStoreReference: refs.publicStore,
      publicTableReference: null,
      channel: "Pickup",
      operatingState: "Open",
      availableServiceModes: ["Pickup"],
      locale: "en-CA",
      contextExpiresAt: "2026-08-12T17:00:00.000Z",
      sessionCredential: guestCredential,
      csrfCredential,
      cookie: {
        name: "__Host-bop-guest",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        domain: null,
      } satisfies GuestSessionCookieDescriptor,
    };
  }
}

function menuResult(): CustomerMenuQueryResult {
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: now as never,
      sourceCheckpoint: id(30) as never,
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5_000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: refs.publicStore as never,
      channelCode: "PICKUP" as never,
      orderTypeCode: "PICKUP" as never,
      effectiveAt: now as never,
    },
    menu: {
      menuReference: refs.menu as never,
      menuVersionReference: refs.menuVersion as never,
      releaseReference: id(31) as never,
      locale: "en-CA",
      name: "WP 2020 Menu",
      effectiveFrom: now as never,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(32) as never,
          name: "Bowls",
          sellables: [
            {
              sellableReference: refs.sellable as never,
              productVersionReference: refs.productVersion as never,
              name: "WP 2020 Bowl",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(33) as never,
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: {
                status: "Unavailable",
                amount: null,
                currency: null,
                reason: "PRICING_NOT_INTEGRATED",
              },
              taxDisplayContext: {
                status: "Unavailable",
                taxInclusive: null,
                reason: "FINAL_QUOTE_REQUIRED",
              },
            },
          ],
        },
      ],
    },
  };
}

class MenuPort implements CustomerMenuPort {
  readonly calls: CustomerMenuQueryInput[] = [];

  async getPublishedMenu(input: Readonly<CustomerMenuQueryInput>) {
    this.calls.push(input);
    return menuResult();
  }
}

class CartPort implements CustomerCartPort {
  readonly calls: { readonly name: string; readonly input: unknown }[] = [];
  current = cartView(1, false);

  createCart(input: Parameters<CustomerCartPort["createCart"]>[0]) {
    this.calls.push({ name: "create", input });
    return Promise.resolve({ status: "Applied", view: this.current } as const);
  }

  getCurrentCart(input: Parameters<CustomerCartPort["getCurrentCart"]>[0]) {
    this.calls.push({ name: "current", input });
    return Promise.resolve({ status: "Found", view: this.current } as const);
  }

  getCart(input: Parameters<CustomerCartPort["getCart"]>[0]) {
    this.calls.push({ name: "read", input });
    return Promise.resolve({ status: "Found", view: this.current } as const);
  }

  addItem(input: Parameters<CustomerCartPort["addItem"]>[0]) {
    this.calls.push({ name: "add", input });
    this.current = cartView(2, true);
    return Promise.resolve({ status: "Applied", view: this.current } as const);
  }

  updateItem(
    input: Parameters<CustomerCartPort["updateItem"]>[0],
  ): Promise<CustomerCartPortResult> {
    this.calls.push({ name: "update", input });
    return Promise.resolve({ status: "Unavailable" });
  }

  removeItem(
    input: Parameters<CustomerCartPort["removeItem"]>[0],
  ): Promise<CustomerCartPortResult> {
    this.calls.push({ name: "remove", input });
    return Promise.resolve({ status: "Unavailable" });
  }
}

function priceQuote(): PriceQuoteSnapshot {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    quoteReference: refs.quote as never,
    quoteVersion: 1,
    quoteInputDigest: digest("a") as never,
    brandReference: refs.brand as never,
    storeReference: refs.store as never,
    cartReference: refs.cart as never,
    cartVersion: 2,
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(34) as never,
      metadataDigest: digest("b") as never,
    },
    subtotal: money(1000n),
    discount: money(0n),
    tax: money(130n),
    fee: money(0n),
    total: money(1130n),
    lines: [
      {
        lineReference: refs.cartItem as never,
        sellableReference: refs.sellable as never,
        productVersionReference: refs.productVersion as never,
        menuVersionReference: refs.menuVersion as never,
        quantity: 1,
        unitPrice: money(1000n),
        subtotal: money(1000n),
        discount: money(0n),
        tax: money(130n),
        fee: money(0n),
        total: money(1130n),
        resolvedPrice: {
          priceBookReference: id(35) as never,
          versionReference: id(36) as never,
          snapshotDigest: digest("c") as never,
          entryReference: id(37) as never,
        },
        taxResolution: {
          configurationReference: id(38) as never,
          versionReference: id(39) as never,
          snapshotDigest: digest("d") as never,
        },
        taxLines: [
          {
            ruleReference: id(40) as never,
            taxAmount: money(130n),
            calculationOrder: 1,
            compoundOnPriorTax: false,
          },
        ],
      },
    ],
    appliedPromotionReferences: [],
    warnings: [],
    blockingReasons: [],
    createdAt: now as never,
    expiresAt: "2026-08-12T16:05:00.000Z" as never,
  } as unknown as PriceQuoteSnapshot;
}

class QuotePort implements CustomerQuotePort {
  readonly calls: QuoteCartCommand[] = [];

  async quoteCart(input: Readonly<QuoteCartCommand>): Promise<QuoteCartResult> {
    this.calls.push(input);
    return { status: "Created", quote: priceQuote() };
  }
}

function guestSession(): GuestSession {
  return {
    sessionReference: refs.session,
    status: "Active",
    version: 1,
    brandReference: refs.brand,
    storeReference: refs.store,
    publicStoreReference: refs.publicStore,
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: refs.qr,
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-12T15:00:00.000Z" as never,
    lastSeenAt: now as never,
    idleExpiresAt: "2026-08-12T20:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-13T15:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  } as unknown as GuestSession;
}

function orderCart() {
  return parseCartAggregate({
    cartReference: refs.cart,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: refs.session,
    aggregateVersion: 2,
    createdAt: "2026-08-12T15:30:00.000Z",
    updatedAt: now,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(41),
      policyDigest: digest("e"),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-12T17:00:00.000Z",
      absoluteExpiresAt: "2026-08-13T15:30:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: refs.cartItem,
        cartReference: refs.cart,
        sellableReference: refs.sellable,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        catalogSelectionEvidence: {
          menuVersionReference: refs.menuVersion,
          productVersionReference: refs.productVersion,
          catalogChannelCode: "PICKUP",
          catalogOrderTypeCode: "PICKUP",
          ruleEvidence: [],
          validatedAt: now,
        },
        addedByActorReference: refs.session,
        addedByParticipantReference: null,
        addedAt: now,
      },
    ],
  });
}

function checkoutEvidence() {
  return parseCheckoutValidationEvidence({
    validationReference: refs.validation,
    validationIntentHash: digest("f"),
    guestSessionReference: refs.session,
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: 2,
    quoteReference: refs.quote,
    quoteVersion: 1,
    quoteInputDigest: digest("a"),
    orderType: "Pickup",
    sourceChannel: "Qr",
    catalogLines: [
      {
        cartItemReference: refs.cartItem,
        sellableReference: refs.sellable,
        menuVersionReference: refs.menuVersion,
        productVersionReference: refs.productVersion,
        validatedAt: now,
      },
    ],
    fulfillment: {
      status: "Accepted",
      brandReference: refs.brand,
      storeReference: refs.store,
      cartReference: refs.cart,
      cartVersion: 2,
      quoteReference: refs.quote,
      orderType: "Pickup",
      sourceChannel: "Qr",
      evidenceReference: refs.fulfillment,
      evidenceVersion: 1,
      evidenceDigest: digest("1"),
      checkedAt: now,
      validUntil: "2026-08-12T16:05:00.000Z",
    },
    validatedAt: now,
    validUntil: "2026-08-12T16:05:00.000Z",
  });
}

function orderPorts() {
  let stored: OrderCreationRecord | null = null;
  let commitCount = 0;
  let auditCount = 0;
  const references = {
    CheckoutValidation: [refs.validation],
    Order: [refs.order],
    OrderBatch: [refs.batch],
    OrderItem: [refs.orderItem],
    Event: [refs.event],
  };
  const businessDate = resolveStoreBusinessDate({
    occurredAt: now,
    configuration: {
      configurationReference: id(42),
      configurationVersion: 1,
      brandReference: refs.brand,
      storeReference: refs.store,
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
      businessDayStartSource: "PlatformDefault",
      contentDigest: digest("2"),
      effectiveFrom: "2026-08-12T08:00:00.000Z",
      effectiveUntil: null,
    },
  });
  const ports: OrderCreationPorts = {
    authorization: { authorize: async () => ({ guestSession: guestSession() }) },
    checkout: { validate: async () => checkoutEvidence() },
    source: {
      load: async () => ({
        cart: orderCart(),
        lines: [
          {
            cartItemReference: refs.cartItem,
            catalog: {
              snapshotReference: id(43),
              snapshotDigest: digest("3"),
              brandReference: refs.brand,
              storeReference: refs.store,
              sellableReference: refs.sellable,
              sellableType: "Sku",
              productReference: id(44),
              productVersionReference: refs.productVersion,
              skuReference: id(45),
              menuVersionReference: refs.menuVersion,
              localizedNames: { "en-CA": "WP 2020 Bowl" },
              unitOfSale: "EACH",
              unitQuantity: "1",
              taxClassificationReference: id(46),
              options: [],
              capturedAt: now as never,
            },
            pricing: {
              quoteReference: refs.quote,
              quoteVersion: 1,
              quoteInputDigest: digest("a"),
              lineReference: refs.cartItem,
              sellableReference: refs.sellable,
              quantity: 1,
              currencyMinorUnitExponent: 2,
              currencyMetadataVersion: 1,
              currencyMetadataVersionReference: id(34),
              currencyMetadataDigest: digest("b"),
              unitPrice: { amountMinor: 1000n, currencyCode: "CAD" },
              subtotal: { amountMinor: 1000n, currencyCode: "CAD" },
              discount: { amountMinor: 0n, currencyCode: "CAD" },
              tax: { amountMinor: 130n, currencyCode: "CAD" },
              fee: { amountMinor: 0n, currencyCode: "CAD" },
              total: { amountMinor: 1130n, currencyCode: "CAD" },
              priceResolution: {
                priceBookReference: id(35),
                priceBookVersionReference: id(36),
                priceBookDigest: digest("c"),
                priceEntryReference: id(37),
                unitPrice: { amountMinor: 1000n, currencyCode: "CAD" },
                scopeKind: "Store",
                scopeReference: refs.store,
                channelCode: "PICKUP",
                orderType: "Pickup",
                priority: 0,
                effectiveFrom: "2026-08-12T08:00:00.000Z" as never,
                effectiveUntil: null,
                reasonCode: "BASE_PRICE",
              },
              taxConfigurationReference: id(38),
              taxConfigurationVersionReference: id(39),
              taxConfigurationDigest: digest("d"),
              taxEffectiveFrom: "2026-08-12T08:00:00.000Z" as never,
              taxEffectiveUntil: null,
              taxComponents: [
                {
                  ruleVersionReference: id(40),
                  ruleVersionDigest: digest("4"),
                  jurisdictionCode: "CA_ON",
                  taxComponentCode: "HST",
                  taxClassificationReference: id(46),
                  treatment: "Taxable",
                  rate: "0.13",
                  priceInclusion: "Exclusive",
                  roundingMode: "HalfUp",
                  calculationOrder: 1,
                  compoundOnPriorTax: false,
                  taxAmount: { amountMinor: 130n, currencyCode: "CAD" },
                },
              ],
              quotedAt: now as never,
            },
          },
        ],
      }),
    },
    businessDate: { resolve: async () => businessDate },
    audit: {
      async create(input) {
        auditCount += 1;
        return {
          auditId: id(47),
          brandId: refs.brand,
          storeId: refs.store,
          actor: { type: "System" },
          actionCode: "ORDERING_ORDER_CREATE",
          targetType: "OrderingOrder",
          targetId: input.order.orderReference,
          reasonCode: "AUTHORIZED_ORDER_CREATE",
          correlationId: id(48),
          occurredAt: now,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_STANDARD",
          retentionPolicyVersion: 1,
        } satisfies AppendAuditRecordInput;
      },
    },
    references: {
      generate(purpose) {
        const reference = references[purpose].shift();
        if (reference === undefined) throw new Error("synthetic reference sequence exhausted");
        return reference;
      },
      hashIntent(value) {
        return `sha256:${createHash("sha256").update(value).digest("hex")}`;
      },
      equals: (left, right) => left === right,
    },
    repository: {
      resolveSubmission: async () => stored,
      async commit(input) {
        commitCount += 1;
        stored = parseOrderCreationRecord({
          ...input.record,
          orderNumberAllocation: createOrderNumberAllocation({
            orderReference: input.record.order.orderReference,
            allocatedAt: input.record.createdAt,
            sequence: 20n,
            businessDateResolution: input.businessDateResolution,
          }),
        });
        return stored;
      },
    },
  };
  return { ports, commitCount: () => commitCount, auditCount: () => auditCount };
}

async function listen(input: {
  entry: EntryPort;
  menu: MenuPort;
  cart: CartPort;
  quote: QuotePort;
}): Promise<number> {
  const generated = [id(50), id(51)];
  const server = createServer(
    createApp({
      customerEntry: new CustomerEntryHandler({
        allowedOrigin: origin,
        now: () => now,
        port: input.entry,
        uuidV7Factory: () => generated.shift() ?? id(99),
      }),
      customerMenu: new CustomerMenuHandler({ now: () => now, port: input.menu }),
      customerCart: new CustomerCartHandler({
        allowedOrigin: origin,
        now: () => now,
        port: input.cart,
      }),
      customerQuote: new CustomerQuoteHandler({
        allowedOrigin: origin,
        now: () => now,
        port: input.quote,
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function mutationHeaders(operationReference: string, version?: number) {
  return {
    "content-type": "application/json",
    cookie: `__Host-bop-guest=${guestCredential}`,
    origin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "idempotency-key": operationReference,
    "x-csrf-token": csrfCredential,
    ...(version === undefined ? {} : { "if-match": `"${version}"` }),
  };
}

describe("WP-2020 QR → Menu → Cart → Order E2E", () => {
  it("propagates one synthetic scope and replays the permanent Order submission", async () => {
    const input = {
      entry: new EntryPort(),
      menu: new MenuPort(),
      cart: new CartPort(),
      quote: new QuotePort(),
    };
    const port = await listen(input);
    const root = `http://127.0.0.1:${port}`;

    const entry = await fetch(`${root}/bff/customer/entry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ qrToken }),
    });
    expect(entry.status).toBe(201);
    expect((await entry.json()) as unknown).toMatchObject({
      publicStoreReference: refs.publicStore,
      channel: "Pickup",
      csrfToken: csrfCredential,
    });

    const menu = await fetch(
      `${root}/api/v1/public/stores/${refs.publicStore}/menu?channel=PICKUP&orderType=PICKUP&locale=en-CA`,
    );
    expect(menu.status).toBe(200);
    expect((await menu.json()) as unknown).toMatchObject({
      scope: { publicStoreReference: refs.publicStore },
      menu: { menuVersionReference: refs.menuVersion },
    });

    const createdCart = await fetch(`${root}/api/v1/carts`, {
      method: "POST",
      headers: mutationHeaders(id(52)),
      body: "{}",
    });
    expect(createdCart.status).toBe(201);
    expect((await createdCart.json()) as unknown).toMatchObject({
      cart: { cartReference: refs.cart, version: 1, items: [] },
    });

    const added = await fetch(`${root}/api/v1/carts/${refs.cart}/items`, {
      method: "POST",
      headers: mutationHeaders(id(53), 1),
      body: JSON.stringify({
        sellableReference: refs.sellable,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
      }),
    });
    expect(added.status).toBe(200);
    expect((await added.json()) as unknown).toMatchObject({
      cart: {
        cartReference: refs.cart,
        version: 2,
        items: [{ sellableReference: refs.sellable, quantity: 1 }],
      },
    });

    const quoted = await fetch(`${root}/api/v1/carts/${refs.cart}/quote`, {
      method: "POST",
      headers: mutationHeaders(id(54)),
      body: JSON.stringify({ cartVersion: 2 }),
    });
    expect(quoted.status).toBe(201);
    expect((await quoted.json()) as unknown).toMatchObject({
      quote: {
        quoteReference: refs.quote,
        cartVersion: 2,
        total: { amountMinor: "1130", currency: "CAD" },
      },
    });

    const fixture = orderPorts();
    const service = createOrderCreationService(fixture.ports);
    const command = {
      submissionReference: refs.submission,
      cartReference: refs.cart,
      expectedCartVersion: 2,
      quoteReference: refs.quote,
      requestedAt: now,
    };
    const first = await service.create(command);
    const replay = await service.create({ ...command, requestedAt: "2026-08-12T16:01:00.000Z" });
    await expect(
      service.create({
        ...command,
        expectedCartVersion: 3,
        quoteReference: id(90),
        requestedAt: "2026-08-12T16:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ORDER_CREATE_IDEMPOTENCY_CONFLICT" });

    expect(first.status).toBe("Created");
    expect(replay.status).toBe("AlreadyCreated");
    expect(replay.record.order.orderReference).toBe(first.record.order.orderReference);
    expect(first.record.items[0]).toMatchObject({
      catalog: {
        sellableReference: refs.sellable,
        productVersionReference: refs.productVersion,
        menuVersionReference: refs.menuVersion,
      },
      pricing: { total: { amountMinor: 1130n, currencyCode: "CAD" } },
    });
    expect(first.record.orderNumberAllocation).toMatchObject({
      orderReference: refs.order,
      businessDate: "2026-08-12",
      orderNumber: "20",
    });
    expect(fixture.commitCount()).toBe(1);
    expect(fixture.auditCount()).toBe(1);
    expect(input.entry.calls[0]?.qrToken).toBe(qrToken);
    expect(input.menu.calls[0]).toMatchObject({ publicStoreReference: refs.publicStore });
    expect(input.cart.calls.map((call) => call.name)).toEqual(["create", "add"]);
    expect(input.quote.calls).toEqual([
      expect.objectContaining({ cartReference: refs.cart, expectedCartVersion: 2 }),
    ]);
  });
});
