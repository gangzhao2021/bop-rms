import type { BrowserContext, Page } from "@playwright/test";

/**
 * WP-2423: the storefront's own reads that every page with a Store context makes — the Store's
 * public identity (`/api/v1/customer/store`) and, for cart lines the Store hasn't priced yet, the
 * published menu. Synthetic owner answers, no live Store authority. Register this before a spec's
 * own routes: Playwright tries the most recently registered route first, so a spec that answers the
 * menu itself still does.
 */
export const syntheticStoreProfile = Object.freeze({
  schemaVersion: 1,
  store: {
    storeDisplayName: "Synthetic Store",
    brandDisplayName: "Synthetic Brand",
    timeZone: "America/Toronto",
    address: {
      addressLines: ["100 Synthetic Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 0A1",
      countryCode: "CA",
    },
    phone: "+15555550100",
    hours: {
      status: "Open",
      todayHours: [{ startLocalTime: "07:00:00", endLocalTime: "22:00:00", endsNextDay: false }],
      closesAt: "22:00:00",
      opensAt: null,
      localDate: "2026-12-22",
      todayKind: null,
      lastOrdersAt: "21:30:00",
      nextOpening: null,
      // WP-2423 item 8 ③ (decision 16): a holiday and special hours in the next 7 days.
      upcoming: [
        {
          localDate: "2026-12-24",
          kind: "Override",
          intervals: [{ startLocalTime: "11:00:00", endLocalTime: "16:00:00", endsNextDay: false }],
        },
        { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
      ],
    },
  },
});

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** A published menu with no sections: lines stay "Priced at checkout" exactly as before. */
function emptyMenu(storeReference: string) {
  const at = new Date().toISOString();
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: id(1),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: storeReference,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "PICKUP",
      effectiveAt: at,
    },
    menu: {
      menuReference: id(2),
      menuVersionReference: id(3),
      releaseReference: id(4),
      locale: "en-CA",
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [],
    },
  };
}

export async function routeStorefrontReads(target: Page | BrowserContext): Promise<void> {
  // WP-2423 item 8 ③ (decision 13): a dine-in menu reads the table to say what it already
  // ordered; a table with no rounds yet unless the spec answers itself.
  await target.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        session: {
          tableLabel: "1",
          orderNumber: null,
          checkedAt: new Date().toISOString(),
          rounds: [],
          summary: null,
        },
      }),
    }),
  );
  await target.route("**/api/v1/customer/store", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "private, max-age=30" },
      contentType: "application/json",
      body: JSON.stringify(syntheticStoreProfile),
    }),
  );
  await target.route("**/api/v1/public/stores/*/menu?*", (route) => {
    const storeReference = new URL(route.request().url()).pathname.split("/")[5] ?? id(9);
    const orderType = new URL(route.request().url()).searchParams.get("orderType") ?? "PICKUP";
    const body = emptyMenu(storeReference);
    body.scope.orderTypeCode = orderType;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}
