import { describe, expect, it, vi } from "vitest";
import {
  createCustomerMenuQueryService,
  parsePublishedMenuProjection,
  type CustomerMenuFound,
  type PublishedMenuProjection,
} from "@rms/catalog";
import { parseCartAggregate } from "../domain/cart.js";
import { parseCustomerCartDisplay } from "../application/customer-cart-view.js";
import {
  createCustomerCartPresentationService,
  type CustomerCartQuoteStateRequest,
} from "../application/customer-cart-presentation-service.js";
const id = (n: number) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:01:00.000Z";
function aggregate(empty = false) {
  return parseCartAggregate({
    cartReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: id(4),
    aggregateVersion: empty ? 3 : 2,
    createdAt: "2026-08-02T13:59:00.000Z",
    updatedAt: "2026-08-02T14:00:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(40),
      policyDigest: `sha256:${"a".repeat(64)}`,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T15:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T13:59:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: empty
      ? []
      : [
          {
            cartItemReference: id(9),
            cartReference: id(1),
            sellableReference: id(7),
            quantity: 2,
            optionSelections: [{ optionReference: id(8), quantity: 1 }],
            customerNote: "Synthetic napkins",
            addedByActorReference: id(4),
            addedByParticipantReference: null,
            addedAt: "2026-08-02T14:00:00.000Z",
            catalogSelectionEvidence: {
              menuVersionReference: id(19),
              productVersionReference: id(20),
              catalogChannelCode: "SYNTHETIC_QR",
              catalogOrderTypeCode: "SYNTHETIC_PICKUP",
              ruleEvidence: [{ bindingReference: id(21), optionSetVersionReference: id(22) }],
              validatedAt: "2026-08-02T14:00:00.000Z",
            },
          },
        ],
  });
}
function projection(): PublishedMenuProjection {
  return parsePublishedMenuProjection({
    projectionName: "catalog_published_menu_v1",
    projectionVersion: 1,
    generationReference: id(30),
    sourceEventReference: id(31),
    sourceAggregateVersion: 1,
    sourceCheckpoint: id(31),
    lastRebuiltAt: at,
    freshnessStatus: "Fresh",
    snapshot: {
      brandReference: id(2),
      menuReference: id(18),
      menuVersionReference: id(19),
      releaseReference: id(32),
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic menu" },
      storeReferences: [id(3)],
      channelCodes: ["SYNTHETIC_QR"],
      orderTypeCodes: ["SYNTHETIC_PICKUP"],
      timeZone: "America/Toronto",
      effectiveFrom: "2026-08-02T13:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(33),
          internalCode: "SYNTHETIC",
          localizedNames: { "en-CA": "Synthetic section" },
          sortOrder: 1,
          sellables: [
            {
              placementReference: id(34),
              sellableReference: id(7),
              productVersionReference: id(20),
              localizedNames: { "en-CA": "Synthetic drink" },
              presentationRole: "Standard",
              sortOrder: 1,
              pinned: false,
              configuredAvailability: "Available",
              allergenDisclosure: {
                registryVersionReference: id(35),
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              optionRules: [
                {
                  bindingReference: id(21),
                  optionSetVersionReference: id(22),
                  minimumSelections: 0,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(8)],
                  defaultOptionReferences: [],
                  options: [
                    {
                      optionReference: id(8),
                      localizedNames: { "en-CA": "Synthetic option" },
                      maximumQuantity: 2,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as PublishedMenuProjection);
}
function fixture() {
  const published = projection();
  const menu = createCustomerMenuQueryService({
    stores: {
      async resolvePublic() {
        return { brandReference: id(2), storeReference: id(3), status: "Active" } as never;
      },
    },
    projections: {
      async loadCandidates() {
        return [published];
      },
    },
  });
  const catalog = { getPublishedMenu: vi.fn(menu.getPublishedMenu) };
  const quotes = {
    resolve: vi.fn(async (request: CustomerCartQuoteStateRequest): Promise<unknown> => ({
      ...request,
      quoteStatus: "None",
    })),
  };
  const request = {
    purpose: "CustomerCart",
    brandReference: id(2),
    storeReference: id(3),
    publicStoreReference: id(5),
    locale: "en-CA",
    orderType: "Pickup",
    evaluatedAt: at,
  } as const;
  const display = parseCustomerCartDisplay(
    {
      ...request,
      brandName: "Synthetic Brand",
      storeName: "Synthetic Store",
      serviceMode: "Pickup",
    },
    request,
  );
  return {
    published,
    catalog,
    quotes,
    display,
    service: createCustomerCartPresentationService({ catalog, quotes }),
  };
}
type Mutable<T> = T extends string | number | boolean | null
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("missing synthetic source");
  return value;
}
async function changedSource(
  f: ReturnType<typeof fixture>,
  change: (source: Mutable<CustomerMenuFound>) => void,
) {
  const result = structuredClone(
    await f.catalog.getPublishedMenu({
      publicStoreReference: id(5),
      channelCode: "SYNTHETIC_QR",
      orderTypeCode: "SYNTHETIC_PICKUP",
      locale: "en-CA",
      requestedAt: at,
      searchTerm: null,
      sectionReference: null,
    } as never),
  );
  if (result.status !== "Found") throw new Error("synthetic Catalog fixture unavailable");
  change(result as unknown as Mutable<CustomerMenuFound>);
  f.catalog.getPublishedMenu.mockResolvedValue(result);
}
describe("unquoted persisted Cart presentation", () => {
  it("uses real public Catalog query names and preserves configuration without inventing price", async () => {
    const f = fixture();
    const view = await f.service.getView(aggregate(), f.display);
    expect(view.cart.items[0]).toMatchObject({
      displayName: "Synthetic drink",
      quantity: 2,
      customerNote: "Synthetic napkins",
      configuration: [{ displayName: "Synthetic option", quantity: 1 }],
      lineEstimate: { status: "Unavailable", reasonCode: "PRICE_UNAVAILABLE" },
    });
    expect(view.cart.quote).toBeNull();
    expect(view.cart.version).toBe(2);
    expect(Object.isFrozen(view.cart.items[0]?.configuration)).toBe(true);
    const request = f.catalog.getPublishedMenu.mock.calls[0]?.[0];
    expect(Object.keys(request as object).sort()).toEqual(
      [
        "publicStoreReference",
        "channelCode",
        "orderTypeCode",
        "locale",
        "requestedAt",
        "searchTerm",
        "sectionReference",
      ].sort(),
    );
    expect(JSON.stringify(request)).not.toContain("Synthetic napkins");
    for (const key of [
      "brandReference",
      "storeReference",
      "policyDigest",
      "addedByActorReference",
      "catalogSelectionEvidence",
      "allergenDisclosure",
      "PRICING_NOT_INTEGRATED",
    ])
      expect(JSON.stringify(view)).not.toContain(key);
  });
  it("reads changed-empty Carts only after absence proof and without a Catalog call", async () => {
    const f = fixture();
    const view = await f.service.getView(aggregate(true), f.display);
    expect(view.cart).toMatchObject({ version: 3, items: [], quote: null });
    expect(f.quotes.resolve).toHaveBeenCalledOnce();
    expect(f.catalog.getPublishedMenu).not.toHaveBeenCalled();
  });
  it.each(["Present", "Unknown", "Missing", "WrongVersion", "WrongStore"])(
    "rejects %s quote state",
    async (mode) => {
      const f = fixture();
      f.quotes.resolve.mockImplementation(async (request) =>
        mode === "Missing"
          ? null
          : {
              ...request,
              quoteStatus: mode === "WrongVersion" || mode === "WrongStore" ? "None" : mode,
              ...(mode === "WrongVersion" ? { cartVersion: 9 } : {}),
              ...(mode === "WrongStore" ? { storeReference: id(99) } : {}),
            },
      );
      await expect(f.service.getView(aggregate(), f.display)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.catalog.getPublishedMenu).not.toHaveBeenCalled();
    },
  );
  it.each([
    "stale",
    "future",
    "scope",
    "menu",
    "product",
    "optionSet",
    "option",
    "duplicate",
    "price",
    "locale",
  ])("rejects %s public source", async (mode) => {
    const f = fixture();
    await changedSource(f, (source) => {
      const item = first(first(source.menu.sections).sellables);
      if (mode === "stale") source.projection.asOfUtc = "2026-08-02T14:00:54.000Z" as never;
      if (mode === "future") source.projection.asOfUtc = "2026-08-02T14:01:01.000Z" as never;
      if (mode === "scope") source.scope.publicStoreReference = id(99) as never;
      if (mode === "menu") source.menu.menuVersionReference = id(99) as never;
      if (mode === "product") item.productVersionReference = id(99) as never;
      if (mode === "optionSet") first(item.optionRules).optionSetVersionReference = id(99) as never;
      if (mode === "option") first(item.optionRules).enabledOptionReferences = [];
      if (mode === "duplicate")
        first(source.menu.sections).sellables.push({
          ...item,
          name: "Conflicting synthetic label",
        });
      if (mode === "price")
        item.displayPrice = {
          status: "Available",
          amount: 100,
          currency: "CAD",
          reason: "SYNTHETIC",
        } as never;
      if (mode === "locale") source.menu.locale = "fr-CA";
    });
    await expect(f.service.getView(aggregate(), f.display)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("accepts repeated menu placements only when their displayed facts agree", async () => {
    const f = fixture();
    await changedSource(f, (source) => {
      const section = first(source.menu.sections);
      section.sellables.push(first(section.sellables));
    });
    expect((await f.service.getView(aggregate(), f.display)).cart.items).toHaveLength(1);
  });
  it("requires explicit shared-Cart visibility authority before exposing DineIn contents", async () => {
    const f = fixture();
    const cart = aggregate();
    const dining = parseCartAggregate({
      ...cart,
      orderType: "DineIn",
      diningSessionReference: id(60),
      items: cart.items.map((item) => ({ ...item, addedByParticipantReference: id(61) })),
    });
    await expect(
      f.service.getView(dining, { ...f.display, orderType: "DineIn", serviceMode: "DineIn" }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    expect(f.quotes.resolve).not.toHaveBeenCalled();
    expect(f.catalog.getPublishedMenu).not.toHaveBeenCalled();
  });
  it("never invokes source getters or leaks their errors", async () => {
    const f = fixture();
    const getter = vi.fn(() => {
      throw new Error("private source");
    });
    await changedSource(f, (source) =>
      Object.defineProperty(first(first(source.menu.sections).sellables), "name", {
        enumerable: true,
        get: getter,
      }),
    );
    await expect(f.service.getView(aggregate(), f.display)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects expired lifecycle, mismatched display and missing Item evidence", async () => {
    const f = fixture();
    await expect(
      f.service.getView(aggregate(), { ...f.display, evaluatedAt: "2026-08-02T16:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    await expect(
      f.service.getView(aggregate(), { ...f.display, storeReference: id(99) }),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
    const cart = aggregate();
    await expect(
      f.service.getView(
        { ...cart, items: cart.items.map((item) => ({ ...item, catalogSelectionEvidence: null })) },
        f.display,
      ),
    ).rejects.toMatchObject({ code: "CART_DEPENDENCY_UNAVAILABLE" });
  });
});
