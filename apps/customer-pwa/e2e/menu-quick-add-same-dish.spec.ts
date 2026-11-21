import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

/**
 * b39 (v15 b38 dinner sweep): a guest tapped + twice on the same dish and the cart showed two
 * lines of 1 instead of one line of 2 (the kitchen ticket already read "2×"). The second tap adds
 * to the guest's own line (same dish, same choices, no note). Synthetic HTTP results only (a
 * pickup fixture stands in for the table: the menu's handling is the same).
 */
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => `018f8800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
for (const language of ["en", "zh-Hans"] as const)
  test(`@production b39: two taps on + for the same dish make one cart line of 2 (${language})`, async ({
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
      quantity = 0,
      activationAttempts = 0;
    const bindingCalls: { action: string; key: string | undefined }[] = [];
    const view = () => ({
      schemaVersion: 1,
      cart: {
        cartReference: id(1),
        version: quantity + 1,
        orderType: "Pickup",
        serviceMode: "Pickup",
        context: { brandName: "Synthetic Brand", storeName: "Synthetic Pickup Store" },
        lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
        items:
          quantity > 0
            ? [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: "Synthetic tea",
                  quantity,
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
    const writes: { method: string; path: string; quantity: unknown }[] = [];
    await page.route(/\/api\/v1\/carts\/[^/]+\/items(?:\/[^/?]+)?(?:\?.*)?$/u, async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { quantity?: unknown };
      writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        quantity: body.quantity,
      });
      quantity = request.method() === "PATCH" ? Number(body.quantity) : quantity + 1;
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
    const add = page.getByRole("button", {
      name: zh ? "把Synthetic tea加入购物车" : "Add Synthetic tea to your cart",
      exact: true,
    });
    await add.click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(add).toBeEnabled();
    await add.click();
    await expect.poll(() => writes.length).toBe(2);
    // One new line, then the same line set to 2: never a second line of 1.
    expect(writes[0]).toMatchObject({ method: "POST", path: `/api/v1/carts/${id(1)}/items` });
    expect(writes[1]).toEqual({
      method: "PATCH",
      path: `/api/v1/carts/${id(1)}/items/${id(2)}`,
      quantity: 2,
    });
    expect(new URL(page.url()).pathname).toBe("/menu");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/b39-quick-add-same-dish-${language}.png` });
    void created;
    void activationAttempts;
    void fault;
  });
