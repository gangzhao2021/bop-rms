import type { Page } from "@playwright/test";
import { syntheticStoreProfile } from "./storefront-reads";

// Batch 63: the synthetic TM2 table guest and pickup entry of batch 49's spec, shared with the
// batch 63 page specs (shapes as v15 answered them).
export interface TableGuestOptions {
  /** The dine-in session read (defaults to one served round on an open pay-later table). */
  readonly session?: (base: Record<string, unknown>) => Record<string, unknown>;
  /** The table cart's items (defaults to none). */
  readonly cartItems?: readonly unknown[];
}

export const id = (n: number) => "018f8a49-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
export const dish = "Beef noodles (TEST)";
export const tableLabel = "G48 C (TEST)";
export const json = (status: number, body: unknown) => ({
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
  body: JSON.stringify(body),
});
export const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

function menu(locale: string) {
  const at = new Date().toISOString();
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: id(40),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: publicStore,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: id(41),
      menuVersionReference: id(42),
      releaseReference: id(43),
      locale,
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(44),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(3),
              productVersionReference: id(45),
              name: dish,
              description: null,
              photo: null,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(46),
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: { status: "Available", amount: "12.50", currency: "CAD", reason: null },
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

/** A seated TM2 guest at an open pay-later table with one served round and an empty cart. */
export async function stubTableGuest(page: Page, options: TableGuestOptions = {}) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "d".repeat(43),
        menuContext: {
          publicStoreReference: publicStore,
          channel: "DineIn",
          locale: "en-CA",
          ...tm2,
        },
        visit: { publicTableReference: id(5), joined: true },
      }),
    ),
  );
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
  await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
    route.fulfill(
      json(200, menu(new URL(route.request().url()).searchParams.get("locale") ?? "en-CA")),
    ),
  );
  // Batch 63: a + on the menu puts one line in the table's cart (read back as such).
  let items: readonly unknown[] = options.cartItems ?? [];
  let writes = 0;
  const cartView = () => ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: 2 + writes,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: tm2.brandDisplayName, storeName: tm2.storeDisplayName },
      lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
      items,
      quote: null,
      warnings: [],
    },
  });
  await page.route(/\/api\/v1\/carts\/[^/]+\/items(?:\/[^/?]+)?(?:\?.*)?$/u, (route) => {
    const method = route.request().method();
    if (method === "POST") items = [...items, cartLine(id(20 + items.length))];
    else if (method === "PATCH") {
      const quantity = Number((route.request().postDataJSON() as { quantity?: unknown }).quantity);
      items = items.map((line, index) =>
        index === 0 ? { ...(line as Record<string, unknown>), quantity } : line,
      );
    } else return route.fulfill(json(503, {}));
    writes += 1;
    return route.fulfill(json(200, cartView()));
  });
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill(json(200, cartView())),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        session: (options.session ?? ((base) => base))({
          tableLabel,
          orderNumber: "31",
          checkedAt: new Date().toISOString(),
          paymentTiming: "PayLater",
          rounds: [
            {
              roundNumber: 1,
              orderedBy: "You",
              submittedAt: new Date(Date.now() - 1_800_000).toISOString(),
              status: "Served",
              payment: "OnTableBill",
              cancelsAt: null,
              storeCancellationReason: null,
              items: [
                {
                  displayName: dish,
                  quantity: 2,
                  servedQuantity: 2,
                  cancelled: false,
                  lineTotal: money("2500"),
                },
              ],
              itemsTotal: money("2500"),
            },
          ],
          summary: {
            paid: money("0"),
            refunded: money("0"),
            refundPending: money("0"),
            due: money("2825"),
          },
        }),
      }),
    ),
  );
}

/** One line of the synthetic dish in the table's cart. */
export const cartLine = (reference: string) => ({
  cartItemReference: reference,
  sellableReference: id(3),
  displayName: dish,
  quantity: 1,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
  warnings: [],
});

/** A pickup guest arriving by the Store's QR code, as at Lane Dessert and Half Sugar Tea. */
export async function enterPickup(page: Page, storeDisplayName: string) {
  await page.route("**/api/v1/customer/store", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "private, max-age=30" },
      json: {
        ...syntheticStoreProfile,
        store: { ...syntheticStoreProfile.store, storeDisplayName },
      },
    }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName,
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
}
