import { describe, expect, it, vi } from "vitest";
import type { GetPublicStoreResult } from "@rms/store";
import { createCustomerDiningCartViewQuery } from "../application/customer-cart-view-query.js";
import { CartError, parseCartAggregate, parseOrderingInstant } from "../domain/cart.js";
import type { DiningCartReadResult } from "../application/dining-cart-read-service.js";
import type { CatalogSelectionDisplayResult } from "@rms/catalog";
const id = (n: number) => `018f5900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-08T12:01:00.000Z";
function cart() {
  return parseCartAggregate({
    cartReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    orderType: "DineIn",
    sourceChannel: "Web",
    diningSessionReference: id(30),
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
          catalogOrderTypeCode: "DINE_IN",
          ruleEvidence: [{ bindingReference: id(13), optionSetVersionReference: id(14) }],
          validatedAt: "2026-09-08T12:00:00.000Z",
        },
        addedByActorReference: id(5),
        addedByParticipantReference: id(31),
        addedAt: "2026-09-08T12:00:00.000Z",
      },
    ],
  });
}
function snapshot(): DiningCartReadResult {
  return {
    cart: cart(),
    viewer: {
      guestSessionReference: id(5),
      guestSessionVersion: 1,
      participantReference: id(31),
      participantVersion: 1,
      diningSessionVersion: 1,
      tableReference: id(32),
      tableAssignmentVersion: 1,
      publicTableReference: id(33),
      qrReference: id(34),
      qrRevocationVersion: 1,
    },
    context: { publicStoreReference: id(16), locale: "en-CA" },
    effectiveStatus: "Active",
    observedAt: parseOrderingInstant(at),
  };
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
  const read = vi.fn(async (): Promise<DiningCartReadResult | null> => snapshot());
  const getPublicStore = vi.fn(async () => profile());
  const describeMany = vi.fn(async (): Promise<readonly CatalogSelectionDisplayResult[]> => [
    description(),
  ]);
  const query = createCustomerDiningCartViewQuery({
    reads: { read },
    stores: { getPublicStore },
    catalog: { describeMany },
  });
  return { read, getPublicStore, describeMany, query };
}
const request = { sessionCredential: "x".repeat(43) };
function shared() {
  const base = snapshot();
  const first = base.cart.items[0];
  if (first === undefined) throw new Error("synthetic item missing");
  return {
    ...base,
    cart: parseCartAggregate({
      ...base.cart,
      items: [
        first,
        {
          ...first,
          cartItemReference: id(40),
          addedByActorReference: id(41),
          addedByParticipantReference: id(42),
          customerNote: "Other synthetic restricted note",
        },
      ],
    }),
  };
}
function sharedFixture() {
  const f = fixture();
  f.read.mockResolvedValue(shared());
  f.describeMany.mockResolvedValue([description(), description()]);
  return f;
}
describe("safe shared Dining Cart display", () => {
  it("shares products while minimizing notes for each current participant", async () => {
    const f = sharedFixture();
    const first = await f.query.read(request);
    expect(first?.cart).toMatchObject({ orderType: "DineIn", serviceMode: "DineIn", quote: null });
    expect(first?.cart.items.map((x) => [x.quantity, x.customerNote, x.warnings])).toEqual([
      [1, "Synthetic note", []],
      [1, null, ["OTHER_PARTICIPANT_ITEM"]],
    ]);
    f.read.mockResolvedValue({
      ...shared(),
      viewer: { ...shared().viewer, guestSessionReference: id(41), participantReference: id(42) },
    });
    const second = await f.query.read(request);
    expect(second?.cart.items.map((x) => [x.customerNote, x.warnings])).toEqual([
      [null, ["OTHER_PARTICIPANT_ITEM"]],
      ["Other synthetic restricted note", []],
    ]);
    expect(shared().cart.items[1]?.customerNote).toBe("Other synthetic restricted note");
    expect(first?.cart.items[0]?.lineEstimate).toEqual({
      status: "Unavailable",
      reasonCode: "LINE_ESTIMATE_UNAVAILABLE",
    });
    expect(Object.isFrozen(first?.cart.items)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(4);
  });
  it("publishes only the existing customer schema and passes no notes or actors to display dependencies", async () => {
    const f = fixture();
    const result = await f.query.read(request);
    expect(Object.keys(result ?? {})).toEqual(["schemaVersion", "cart"]);
    expect(Object.keys(result?.cart.items[0] ?? {})).toEqual([
      "cartItemReference",
      "sellableReference",
      "displayName",
      "quantity",
      "configuration",
      "customerNote",
      "lineEstimate",
      "warnings",
    ]);
    for (const secret of [
      request.sessionCredential,
      id(2),
      id(3),
      id(5),
      id(30),
      id(31),
      id(32),
      id(33),
      id(34),
      "sha256:",
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    const calls = JSON.stringify([f.describeMany.mock.calls, f.getPublicStore.mock.calls]);
    for (const secret of [request.sessionCredential, "Synthetic note", id(5), id(31), id(32)])
      expect(calls).not.toContain(secret);
    expect(f.getPublicStore).toHaveBeenCalledWith({
      publicStoreReference: id(16),
      requestedLocale: "en-CA",
      evaluatedAt: at,
      purpose: "CustomerCart",
    });
  });
  it.each(Object.keys(snapshot().viewer))(
    "denies %s drift during public display lookup",
    async (key) => {
      const f = fixture();
      const value = snapshot();
      const before = value.viewer[key as keyof typeof value.viewer];
      f.read.mockResolvedValueOnce(value).mockResolvedValue({
        ...snapshot(),
        viewer: {
          ...snapshot().viewer,
          [key]: typeof before === "number" ? before + 1 : id(99),
        },
      });
      await expect(f.query.read(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each([
    null,
    {},
    { ...snapshot().viewer, extra: "rejected" },
    { ...snapshot().viewer, participantReference: "wrong" },
    { ...snapshot().viewer, participantVersion: 0 },
    { ...snapshot().viewer, guestSessionVersion: 1.5 },
  ])("denies malformed viewer before display queries", async (value) => {
    const f = fixture();
    f.read.mockResolvedValue({ ...snapshot(), viewer: value } as unknown as DiningCartReadResult);
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.describeMany).not.toHaveBeenCalled();
  });
  it.each(["CART_PERMISSION_DENIED", "CART_INPUT_INVALID"] as const)(
    "preserves bounded %s from current read",
    async (code) => {
      const f = fixture();
      f.read.mockRejectedValue(new CartError(code));
      await expect(f.query.read(request)).rejects.toMatchObject({ code });
      expect(f.getPublicStore).not.toHaveBeenCalled();
    },
  );
  it("denies revoked authority after dependencies", async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
    await expect(f.query.read(request)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
  });
  it("captures the first viewer before dependency mutation", async () => {
    const f = fixture();
    const original = snapshot();
    f.read.mockResolvedValue(original);
    f.describeMany.mockImplementation(async () => {
      Object.assign(original.viewer, { participantReference: id(99) });
      return [description()];
    });
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each(["cart", "locale", "time", "missing"])(
    "denies changed %s after dependencies",
    async (key) => {
      const f = fixture();
      const next = snapshot();
      f.read.mockResolvedValueOnce(snapshot()).mockResolvedValue(
        key === "missing"
          ? null
          : {
              ...next,
              cart:
                key === "cart"
                  ? parseCartAggregate({ ...next.cart, aggregateVersion: 2 })
                  : next.cart,
              context: key === "locale" ? { ...next.context, locale: "fr-CA" } : next.context,
              observedAt:
                key === "time" ? parseOrderingInstant("2026-09-08T12:00:59.000Z") : next.observedAt,
            },
      );
      await expect(f.query.read(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("reports effective expiry at the final authorized observation", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(snapshot()).mockResolvedValue({
      ...snapshot(),
      observedAt: parseOrderingInstant("2026-09-08T13:00:00.000Z"),
      effectiveStatus: "Expired",
    });
    expect((await f.query.read(request))?.cart.lifecycle.status).toBe("Expired");
  });
  it("returns null without unnecessary display queries for absent Cart", async () => {
    const f = fixture();
    f.read.mockResolvedValue(null);
    expect(await f.query.read(request)).toBeNull();
    expect(f.describeMany).not.toHaveBeenCalled();
  });
  it.each(["catalog", "store", "read"])("bounds %s dependency failures", async (key) => {
    const f = fixture();
    const error = new Error("synthetic internal metadata");
    if (key === "catalog") f.describeMany.mockRejectedValue(error);
    if (key === "store") f.getPublicStore.mockRejectedValue(error);
    if (key === "read") f.read.mockRejectedValue(error);
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    await expect(f.query.read(request)).rejects.not.toThrow("synthetic internal metadata");
  });
  it.each(["Pickup", "Pos", "missingLifecycle", "futureCart"])(
    "rejects unsupported %s snapshot",
    async (kind) => {
      const f = fixture();
      const initial = snapshot();
      const cartValue = {
        ...initial.cart,
        ...(kind === "Pickup"
          ? { orderType: "Pickup", diningSessionReference: null, items: [] }
          : {}),
        ...(kind === "Pos" ? { sourceChannel: "Pos" } : {}),
        ...(kind === "missingLifecycle" ? { lifecycle: null } : {}),
        ...(kind === "futureCart" ? { updatedAt: "2026-09-08T12:02:00.000Z" } : {}),
      };
      f.read.mockResolvedValue({ ...initial, cart: parseCartAggregate(cartValue) });
      await expect(f.query.read(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.getPublicStore).not.toHaveBeenCalled();
    },
  );
  it("shows an empty Dining Cart without estimating or loading a Quote", async () => {
    const f = fixture();
    const initial = snapshot();
    f.read.mockResolvedValue({
      ...initial,
      cart: parseCartAggregate({ ...initial.cart, items: [] }),
    });
    f.describeMany.mockResolvedValue([]);
    expect((await f.query.read(request))?.cart).toMatchObject({
      items: [],
      quote: null,
      orderType: "DineIn",
    });
  });
  it("rejects a viewer accessor without invoking it", async () => {
    const f = fixture();
    const value = { ...snapshot().viewer };
    const getter = vi.fn(() => id(31));
    Object.defineProperty(value, "participantReference", { enumerable: true, get: getter });
    f.read.mockResolvedValue({ ...snapshot(), viewer: value });
    await expect(f.query.read(request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
