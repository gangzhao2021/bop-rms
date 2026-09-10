import { expect, test } from "@playwright/test";
// Synthetic HTTP owner results on the production PWA; no live Store/Catalog authority is asserted.
const id = (n: number) => `018f8800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Pickup configuration " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    for (const fault of ["activation", "add", "unavailable"] as const)
      test("explicit recovery after " + fault, async ({ page, context }) => {
        const failures: string[] = [];
        page.on("pageerror", () => failures.push("page error"));
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            !(
              /\/bff\/customer\/cart|\/api\/v1\/carts\//u.test(message.location().url) &&
              /404|503|ERR_FAILED/u.test(message.text())
            )
          )
            failures.push("unexpected console error");
        });
        const at = new Date().toISOString(),
          expiresAt = new Date(Date.now() + 600000).toISOString();
        const csrf = "s".repeat(43),
          candidate = "c".repeat(43),
          proof = "p".repeat(43);
        let created = false,
          added = false,
          activationAttempts = 0,
          addAttempts = 0;
        const bindingCalls: { action: string; key: string | undefined }[] = [];
        const addCalls: { key: string | undefined; body: unknown; version: string | undefined }[] =
          [];
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
                channelCode: "PICKUP",
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
            status: created ? 200 : 404,
            headers: { "cache-control": "no-store" },
            json: created
              ? view()
              : {
                  schemaVersion: 1,
                  error: { code: "cart_not_found", messageKey: "customer.cart.not_found" },
                },
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
        await page.route("**/api/v1/carts", (route) => {
          failures.push("legacy create route");
          return route.abort();
        });
        await page.route("**/api/v1/carts/*/items", async (route) => {
          const request = route.request();
          expect(request.headers()["x-csrf-token"]).toBe(candidate);
          expect(request.method()).toBe("POST");
          addCalls.push({
            key: request.headers()["idempotency-key"],
            body: request.postDataJSON(),
            version: request.headers()["if-match"],
          });
          added = true;
          if (fault === "add" && addAttempts++ === 0) {
            await route.abort("failed");
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: view(),
          });
        });
        await page.goto("/#qr=aaa.bbb.ccc");
        await expect(
          page.getByRole("heading", { name: "Synthetic Pickup Store", exact: true }),
        ).toBeVisible();
        await page.evaluate(() => {
          history.pushState(null, "", "/menu");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Synthetic tea", exact: true }),
        ).toBeVisible();
        expect(bindingCalls).toHaveLength(0);
        expect(addCalls).toHaveLength(0);
        await page.getByRole("button", { name: "Add to cart", exact: true }).click();
        await expect(page.getByRole("spinbutton", { name: "Quantity", exact: true })).toBeVisible();
        const submit = page.getByRole("button", { name: "Add to cart", exact: true });
        if (screen.touch) await submit.tap();
        else {
          await submit.focus();
          await page.keyboard.press("Enter");
        }
        const retry = page.getByRole("button", { name: "Retry the same operation", exact: true });
        await expect(retry).toBeEnabled();
        await expect(page.getByText("Added to the server cart.", { exact: true })).toHaveCount(0);
        const before = { binding: bindingCalls.length, add: addCalls.length };
        await context.setOffline(true);
        await expect(retry).toBeDisabled();
        await expect(submit).toBeDisabled();
        await context.setOffline(false);
        await expect(retry).toBeEnabled();
        expect(bindingCalls).toHaveLength(before.binding);
        expect(addCalls).toHaveLength(before.add);
        if (fault !== "unavailable") {
          if (screen.touch) await retry.tap();
          else {
            await retry.focus();
            await page.keyboard.press("Enter");
          }
          await expect(page.getByText("Added to the server cart.", { exact: true })).toBeVisible();
          expect(bindingCalls.filter((x) => x.action === "prepare")).toHaveLength(1);
          const original = bindingCalls[0]?.key;
          expect(original).toMatch(/^[0-9a-f-]{36}$/u);
          expect(bindingCalls.every((x) => x.key === original)).toBe(true);
          if (fault === "activation")
            expect(bindingCalls.map((x) => x.action)).toEqual(["prepare", "activate", "complete"]);
          if (fault === "add") {
            expect(addCalls).toHaveLength(2);
            expect(addCalls[1]).toEqual(addCalls[0]);
          } else expect(addCalls).toHaveLength(1);
          expect(addCalls[0]?.key).not.toBe(original);
          expect(addCalls[0]?.body).toEqual({
            sellableReference: id(3),
            quantity: 1,
            optionSelections: [],
            customerNote: null,
          });
          await page.getByRole("link", { name: "Review cart", exact: true }).click();
          await expect(page.getByText("Synthetic tea", { exact: true })).toHaveCount(1);
        } else {
          expect(created).toBe(false);
          expect(addCalls).toHaveLength(0);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(failures).toEqual([]);
      });
  });
}
