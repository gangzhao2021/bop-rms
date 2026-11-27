import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

/**
 * v15 b17 (live burst 3): a guest taps the menu's one-tap + while another guest at the table is
 * placing a round, and the table's cart answers 409 (its order still being processed, or being
 * paid for). The add is tried once more on the fresh cart; refused again, the guest is told on the
 * menu that the dish wasn't added, never moved silently to the dish page. Synthetic HTTP results
 * only (a pickup fixture stands in for the table: the menu's handling is the same).
 */
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => `018f8800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
for (const [answers, language] of [
  ["retried", "en"],
  ["held", "en"],
  ["held", "zh-Hans"],
] as const)
  test(`@production a one-tap add while another guest's order holds the table's cart (${answers}, ${language})`, async ({
    page,
  }) => {
    if (language === "zh-Hans")
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.customer.language", "zh-Hans");
      });
    await page.setViewportSize({ width: 390, height: 844 });
    const at = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 600000).toISOString();
    const csrf = "s".repeat(43),
      candidate = "c".repeat(43),
      proof = "p".repeat(43);
    const fault = "none" as string;
    let created = false,
      added = false,
      activationAttempts = 0;
    const bindingCalls: { action: string; key: string | undefined }[] = [];
    const view = () => ({
      schemaVersion: 1,
      cart: {
        cartReference: id(1),
        version: added ? 2 : 1,
        orderType: "Pickup",
        serviceMode: "Pickup",
        context: { brandName: "Synthetic Brand", storeName: "Synthetic Pickup Store" },
        lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
        items: added
          ? [
              {
                cartItemReference: id(2),
                sellableReference: id(3),
                displayName: "Synthetic tea",
                quantity: 1,
                configuration: [],
                customerNote: null,
                lineEstimate: {
                  status: "Unavailable",
                  reasonCode: "LINE_ESTIMATE_UNAVAILABLE",
                },
                warnings: [],
              },
            ]
          : [],
        quote: null,
        warnings: [],
      },
    });
    await page.route("**/bff/customer/entry", (route) =>
      route.fulfill({
        status: 201,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 2,
          status: "Established",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Pickup Store",
          publicStoreReference: id(4),
          publicTableReference: null,
          channel: "Pickup",
          operatingState: "Open",
          availableServiceModes: ["Pickup"],
          locale: "en-CA",
          contextExpiresAt: expiresAt,
          csrfToken: csrf,
        },
      }),
    );
    await page.route("**/api/v1/public/stores/*/menu?*", (route) =>
      route.fulfill({
        // The menu in the language asked for (its names stay as the Store wrote them).
        status: 200,
        json: {
          status: "Found",
          schemaVersion: 1,
          projection: {
            name: "catalog_published_menu_v1",
            version: 1,
            asOfUtc: at,
            sourceCheckpoint: id(5),
            sourceAggregateVersion: 1,
            freshnessStatus: "Fresh",
            freshnessTargetMilliseconds: 5000,
            stale: false,
            partial: true,
          },
          scope: {
            publicStoreReference: id(4),
            channelCode: "CUSTOMER_PWA",
            orderTypeCode: "PICKUP",
            effectiveAt: at,
          },
          menu: {
            menuReference: id(6),
            menuVersionReference: id(7),
            releaseReference: id(8),
            locale: new URL(route.request().url()).searchParams.get("locale") ?? "en-CA",
            name: "Synthetic menu",
            effectiveFrom: at,
            effectiveUntil: null,
            sections: [
              {
                sectionReference: id(9),
                name: "Drinks",
                sellables: [
                  {
                    sellableReference: id(3),
                    productVersionReference: id(10),
                    name: "Synthetic tea",
                    description: null,
                    photo: null,
                    presentationRole: "Standard",
                    pinned: false,
                    availability: "Available",
                    optionRules: [],
                    allergenDisclosure: {
                      registryVersionReference: id(11),
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
        },
      }),
    );
    // The cart in the guest's language (Chinese asks with its locale).
    await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: created ? view() : { schemaVersion: 1, cart: null },
      }),
    );
    await page.route("**/bff/customer/cart-binding/*", async (route) => {
      const request = route.request();
      const action = new URL(request.url()).pathname.split("/").at(-1) ?? "";
      const key = request.headers()["idempotency-key"];
      expect(request.method()).toBe("POST");
      bindingCalls.push({ action, key });
      expect(request.headers()["x-csrf-token"]).toBe(action === "complete" ? candidate : csrf);
      if (
        fault === "unavailable" ||
        (action === "activate" && fault === "activation" && activationAttempts++ === 0)
      ) {
        if (fault === "activation") created = true;
        await route.fulfill({
          status: 503,
          headers: { "cache-control": "no-store" },
          json: {
            error: {
              code: "cart_binding_unavailable",
              messageKey: "customer.cart.binding_unavailable",
            },
          },
        });
        return;
      }
      if (action === "prepare")
        await route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            status: "Prepared",
            operationReference: key,
            candidateCsrfToken: candidate,
            recoveryProof: proof,
            expiresAt,
          },
        });
      else {
        created = true;
        await route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: { status: "Activated", operationReference: key, csrfToken: candidate },
        });
      }
    });
    const adds: string[] = [];
    await page.route(/\/api\/v1\/carts\/[^/]+\/items(?:\?.*)?$/u, async (route) => {
      adds.push(route.request().headers()["idempotency-key"] ?? "");
      if (answers === "held" || adds.length === 1) {
        await route.fulfill({
          status: 409,
          headers: { "cache-control": "no-store", "retry-after": "1" },
          json: {
            schemaVersion: 1,
            error: {
              code: adds.length === 1 ? "cart_order_processing" : "cart_checkout_in_progress",
              messageKey: "customer.cart.order_processing",
            },
          },
        });
        return;
      }
      added = true;
      await route.fulfill({ status: 200, headers: { "cache-control": "no-store" }, json: view() });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Pickup Store", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/menu");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const zh = language === "zh-Hans";
    await page
      .getByRole("button", {
        name: zh ? "把 Synthetic tea 加入购物车" : "Add Synthetic tea to your cart",
        exact: true,
      })
      .click();
    if (answers === "retried") {
      // Tried once more after the hold, with a new operation: in the cart, said so, on the menu.
      await expect(page.getByText("Added to your cart.", { exact: true })).toBeVisible();
      expect(adds).toHaveLength(2);
      expect(adds[0]).not.toBe(adds[1]);
    } else {
      // The menu may also show its own last-orders status near the fixture store's closing time,
      // so the check names the add's status instead of expecting it to be the only one.
      await expect(
        page.getByRole("status").filter({
          hasText: zh
            ? "同桌另一位客人正在为这笔订单付款。Synthetic tea 还没加入购物车，请稍后再点 +。"
            : "Another guest at your table is paying for this order. Synthetic tea wasn’t added. Tap + again in a moment.",
        }),
      ).toBeVisible();
      expect(adds).toHaveLength(2);
    }
    expect(new URL(page.url()).pathname).toBe("/menu");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/quick-add-held-${answers}-${language}.png` });
    void created;
    void activationAttempts;
    void fault;
  });
