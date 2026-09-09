import { describe, expect, it, vi } from "vitest";
import type { GetPublicStoreResult } from "@rms/store";
import { createCustomerCartViewQuery } from "../application/customer-cart-view-query.js";
import { CartError, parseCartAggregate, parseOrderingInstant } from "../domain/cart.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import type { PickupCartReadResult } from "../application/pickup-cart-read-service.js";
import type { CatalogSelectionDisplayResult } from "@rms/catalog";
const id = (n: number) => `018f5900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-08T12:01:00.000Z";
function cart() {
  return parseCartAggregate({
    cartReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    orderType: "Pickup",
    sourceChannel: "Web",
    diningSessionReference: null,
    createdByActorReference: id(5),
    aggregateVersion: 1,
    createdAt: "2026-09-08T11:59:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(15),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-09-08T13:00:00.000Z",
      absoluteExpiresAt: "2026-09-09T11:59:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: id(8),
        cartReference: id(4),
        sellableReference: id(9),
        quantity: 1,
        optionSelections: [{ optionReference: id(12), quantity: 1 }],
        customerNote: "Synthetic note",
        catalogSelectionEvidence: {
          menuVersionReference: id(11),
          productVersionReference: id(10),
          catalogChannelCode: "WEB",
          catalogOrderTypeCode: "PICKUP",
          ruleEvidence: [{ bindingReference: id(13), optionSetVersionReference: id(14) }],
          validatedAt: "2026-09-08T12:00:00.000Z",
        },
        addedByActorReference: id(5),
        addedByParticipantReference: null,
        addedAt: "2026-09-08T12:00:00.000Z",
      },
    ],
  });
}
function snapshot(): PickupCartReadResult {
  return {
    cart: cart(),
    context: { publicStoreReference: id(16), locale: "en-CA" },
    effectiveStatus: "Active",
    observedAt: parseOrderingInstant(at),
  };
}
function quote(): CartQuoteAttachment {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return parseCartQuoteAttachment({
    operationReference: id(1),
    operationIntentHash: `sha256:${"a".repeat(64)}`,
    guestSessionReference: id(5),
    cartReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    cartVersion: 1,
    quoteReference: id(6),
    quoteVersion: 1,
    quoteInputDigest: `sha256:${"b".repeat(64)}`,
    currencyCode: "CAD",
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: id(7),
    subtotal: money(9007199254740993n),
    discount: money(0n),
    tax: money(0n),
    fee: money(0n),
    total: money(9007199254740993n),
    lines: [
      {
        lineReference: id(8),
        sellableReference: id(9),
        productVersionReference: id(10),
        menuVersionReference: id(11),
        quantity: 1,
      },
    ],
    warnings: [],
    quoteCreatedAt: "2026-09-08T12:00:00.000Z",
    quoteExpiresAt: "2026-09-08T12:05:00.000Z",
    attachedAt: "2026-09-08T12:00:00.000Z",
    idempotencyExpiresAt: "2026-09-09T12:00:00.000Z",
  });
}
function profile(): GetPublicStoreResult {
  return {
    status: "Available",
    profile: {
      profileReference: id(20),
      profileVersion: 1,
      releaseReference: id(21),
      contentDigest: `sha256:${"c".repeat(64)}`,
      defaultLocale: "en-CA",
      selectedLocale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      brandDisplayName: "Synthetic Brand",
      storeDisplayName: "Synthetic Store",
      address: {
        countryCode: "CA",
        regionCode: "ON",
        locality: "Exampleville",
        postalCode: "A1A 1A1",
        addressLines: ["100 Example Avenue"],
      },
      businessPhone: null,
      website: null,
      logoAssetVersionReference: null,
    },
  } as unknown as GetPublicStoreResult;
}
function description(): CatalogSelectionDisplayResult {
  return {
    status: "Found",
    menuVersionReference: id(11),
    productVersionReference: id(10),
    sellableReference: id(9),
    displayName: "Synthetic latte",
    options: [{ optionReference: id(12), displayName: "Synthetic option" }],
  } as unknown as CatalogSelectionDisplayResult;
}
function fixture() {
  const read = vi.fn(async (): Promise<PickupCartReadResult | null> => snapshot());
  const getPublicStore = vi.fn(async () => profile());
  const describeMany = vi.fn(async (): Promise<readonly CatalogSelectionDisplayResult[]> => [
    description(),
  ]);
  const loadLatest = vi.fn(async (): Promise<CartQuoteAttachment | null> => quote());
  const query = createCustomerCartViewQuery({
    reads: { read },
    stores: { getPublicStore },
    catalog: { describeMany },
    quotes: { loadLatest },
  });
  return { read, getPublicStore, describeMany, loadLatest, query };
}
const request = { sessionCredential: "x".repeat(43) };
describe("safe Customer Cart display", () => {
  it("composes only approved fields and exact monetary strings after reauthorization", async () => {
    const f = fixture();
    const result = await f.query.read(request);
    expect(result?.cart.quote?.total).toEqual({ amountMinor: "9007199254740993", currency: "CAD" });
    expect(result?.cart.context).toEqual({
      brandName: "Synthetic Brand",
      storeName: "Synthetic Store",
    });
    expect(result?.cart.items[0]).toEqual({
      cartItemReference: id(8),
      sellableReference: id(9),
      displayName: "Synthetic latte",
      quantity: 1,
      configuration: [{ optionReference: id(12), displayName: "Synthetic option", quantity: 1 }],
      customerNote: "Synthetic note",
      lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
      warnings: [],
    });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.getPublicStore).toHaveBeenCalledWith({
      publicStoreReference: id(16),
      requestedLocale: "en-CA",
      evaluatedAt: at,
      purpose: "CustomerCart",
    });
    expect(f.loadLatest).toHaveBeenCalledWith({
      cartReference: id(4),
      cartVersion: 1,
      observedAt: at,
    });
    const dependencyInputs = JSON.stringify([
      f.describeMany.mock.calls,
      f.getPublicStore.mock.calls,
      f.loadLatest.mock.calls,
    ]);
    expect(dependencyInputs).not.toContain("Synthetic note");
    expect(dependencyInputs).not.toContain(request.sessionCredential);
    expect(dependencyInputs).not.toContain(id(5));
    const json = JSON.stringify(result);
    for (const value of [
      id(1),
      id(2),
      id(3),
      id(5),
      id(7),
      id(10),
      id(11),
      id(13),
      id(14),
      id(16),
      request.sessionCredential,
      "sha256:",
    ])
      expect(json).not.toContain(value);
    expect(Object.isFrozen(result?.cart.items[0]?.configuration)).toBe(true);
  });
  it("returns uniform absence without querying dependent owners", async () => {
    const f = fixture();
    f.read.mockResolvedValue(null);
    expect(await f.query.read(request)).toBeNull();
    expect(f.getPublicStore).not.toHaveBeenCalled();
    expect(f.describeMany).not.toHaveBeenCalled();
    expect(f.loadLatest).not.toHaveBeenCalled();
  });
  it("returns a real empty Cart without inventing a quote", async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...snapshot(), cart: parseCartAggregate({ ...cart(), items: [] }) });
    f.describeMany.mockResolvedValue([]);
    f.loadLatest.mockResolvedValue(null);
    const result = await f.query.read(request);
    expect(result?.cart.items).toEqual([]);
    expect(result?.cart.quote).toBeNull();
  });
  it("preserves credential denial before reads and after dependency resolution", async () => {
    for (const after of [false, true]) {
      const f = fixture();
      if (after) f.read.mockResolvedValueOnce(snapshot());
      f.read.mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
      await expect(f.query.read(request)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
      if (!after) expect(f.loadLatest).not.toHaveBeenCalled();
    }
  });
  it.each(["version", "context", "missing", "clock"])("denies changed final %s", async (mode) => {
    const f = fixture();
    f.read.mockResolvedValueOnce(snapshot());
    if (mode === "missing") f.read.mockResolvedValueOnce(null);
    else
      f.read.mockResolvedValueOnce({
        ...snapshot(),
        ...(mode === "version"
          ? { cart: parseCartAggregate({ ...cart(), aggregateVersion: 2 }) }
          : {}),
        ...(mode === "context"
          ? { context: { publicStoreReference: id(99), locale: "en-CA" } }
          : {}),
        ...(mode === "clock"
          ? { observedAt: parseOrderingInstant("2026-09-08T12:00:30.000Z") }
          : {}),
      });
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each(["scope", "version", "actor", "line", "future"])(
    "denies substituted Quote %s",
    async (mode) => {
      const f = fixture();
      const value = quote();
      f.loadLatest.mockResolvedValue({
        ...value,
        ...(mode === "scope" ? { storeReference: id(99) } : {}),
        ...(mode === "version" ? { cartVersion: 2 } : {}),
        ...(mode === "actor" ? { guestSessionReference: id(99) } : {}),
        ...(mode === "line"
          ? { lines: value.lines.map((line) => ({ ...line, quantity: 2 })) }
          : {}),
        ...(mode === "future" ? { attachedAt: "2026-09-08T12:02:00.000Z" } : {}),
      } as CartQuoteAttachment);
      await expect(f.query.read(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("reflects exact lifecycle and Quote expiry at final observation without changing stored facts", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({
      ...snapshot(),
      observedAt: parseOrderingInstant("2026-09-08T13:00:00.000Z"),
      effectiveStatus: "Expired",
    });
    const result = await f.query.read(request);
    expect(result?.cart.lifecycle.status).toBe("Expired");
    expect(result?.cart.quote?.blockingReasons).toEqual(["QUOTE_EXPIRED"]);
    expect(cart().lifecycle?.status).toBe("Active");
  });
  it("denies missing or mismatched display evidence", async () => {
    const f = fixture();
    for (const result of [
      [],
      [{ status: "NotFound" }],
      [{ ...description(), sellableReference: id(99) }],
    ]) {
      f.describeMany.mockResolvedValue(result as CatalogSelectionDisplayResult[]);
      await expect(f.query.read(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    }
  });
  it("bounds profile and malformed snapshot failures without copying private error details", async () => {
    const f = fixture();
    f.getPublicStore.mockResolvedValue({ status: "StoreUnavailable" });
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    f.read.mockResolvedValue({ ...snapshot(), cart: {} } as PickupCartReadResult);
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
  });
});
