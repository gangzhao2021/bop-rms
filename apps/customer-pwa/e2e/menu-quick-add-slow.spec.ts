import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

/**
 * Live v15 2026-11-10 (merchant-outage-recovery M68): a plain dish added with the menu's one-tap +
 * that is still waiting after 3 s tells the guest the restaurant's system is busy, as the dish page
 * does, so nobody taps again. Synthetic HTTP results only.
 */
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => `018f8800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
for (const width of [390, 1024, 1440])
  test(`@production a slow one-tap add says the system is busy at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
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
            locale: "en-CA",
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
    await page.route("**/bff/customer/cart", (route) =>
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
    let adds = 0;
    let release: () => void = () => undefined;
    await page.route("**/api/v1/carts/*/items", async (route) => {
      adds += 1;
      // The restaurant's system answers after 5 s.
      await new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, 5_000);
      });
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
    const plus = page.getByRole("button", { name: "Add Synthetic tea to your cart", exact: true });
    await plus.click();
    await expect(plus).toBeDisabled();
    const busy = page.getByRole("status").filter({
      hasText: "Still adding; the restaurant's system is busy. No need to tap again.",
    });
    await expect(busy).toHaveCount(0);
    await expect(busy).toBeVisible({ timeout: 4_000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/quick-add-slow-${width}.png` });
    release();
    await expect(page.getByText("Added to your cart.", { exact: true })).toBeVisible();
    await expect(busy).toHaveCount(0);
    expect(adds).toBe(1);
    void created;
    void activationAttempts;
    void fault;
  });
