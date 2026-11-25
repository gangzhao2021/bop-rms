import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";
import { offScaleText, smallTargets } from "./guest-v3-measure";

// Batch 63 (v15 batch 62 page review, F07 and F08): the customer pages still used the old type
// scale (11.25, 12.19, 13.13, 14.06, 15.94, 16.875, 18.75, 22.5 and 26.25 px at 500/650/700) and
// had taps under 44 px (language switch 45×30, dish steppers 40×40, nav "Cart" 32×45, category
// "面食" 28×44). Every page of the local preview is measured at 390, 1024 and 1440, in English and
// Chinese: only 28/20/16/14 at 600/400, and every key tap at least 44 × 44.
test.beforeEach(({ context }) => routeStorefrontReads(context));

const SELLABLE_REFERENCE = "018f9900-0000-7000-8000-000000000003";
const ORDER_REFERENCE = "018f9900-0000-7000-8000-000000000014";
const paths = [
  "/",
  "/menu",
  "/menu/search",
  `/menu/items/${SELLABLE_REFERENCE}`,
  "/cart",
  "/checkout",
  "/checkout/result",
  `/orders/${ORDER_REFERENCE}`,
  `/orders/${ORDER_REFERENCE}/receipt`,
] as const;
const taps =
  ".language-switch, .bop-shell__nav > a, .menu-sections a, .configure-stepper button, .cart-item__actions button, .dining-session__pay-stepper button, .menu-card__quick-add";

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@demo batch 63 customer type and taps (${zh ? "zh-Hans" : "en"} ${String(width)})`, () => {
      test.use({
        viewport: { width, height: 900 },
        hasTouch: width < 1440,
        isMobile: width < 768,
        locale: zh ? "zh-CN" : "en-CA",
      });
      for (const path of paths)
        test(`${path} uses only 28/20/16/14 at 600/400 and 44 px taps`, async ({ page }) => {
          await page.goto(path);
          await expect(page.locator("html")).toHaveAttribute("lang", zh ? /^zh/u : "en");
          await expect(page.getByRole("main")).toBeVisible();
          await page.waitForLoadState("networkidle");
          expect(await offScaleText(page)).toEqual([]);
          expect(await smallTargets(page, taps)).toEqual([]);
        });
    });

// Batch 63 (D62B-11/12, CDI-7, F09): two button kinds. On checkout "Edit cart" was 12 px black
// words and "Reload checkout details" a white box; the step waiting for a tip was grey words with
// no button shape ("Choose a tip to continue"), in a sticky bar that covered the form.
for (const width of [390, 1024, 1440])
  test.describe(`@demo batch 63 checkout actions at ${String(width)}`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 1440, isMobile: width < 768 });
    test("secondary actions are accent words and the waiting step keeps its shape", async ({
      page,
    }) => {
      await page.goto("/checkout");
      const main = page.getByRole("main");
      const next = main.getByRole("button", { name: "Continue to payment" });
      await expect(next).toBeDisabled();
      const css = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              color: style.color,
              border: style.borderTopWidth,
              background: style.backgroundColor,
              size: style.fontSize,
              weight: style.fontWeight,
              opacity: style.opacity,
              position: style.position,
              height: element.getBoundingClientRect().height,
            };
          });
      for (const selector of [".checkout-edit-link", ".checkout-details-form button"]) {
        const look = await css(selector);
        expect(look).toMatchObject({
          color: "rgb(31, 99, 224)",
          border: "0px",
          background: "rgba(0, 0, 0, 0)",
          size: "16px",
          weight: "400",
        });
        expect(look.height).toBeGreaterThanOrEqual(44);
      }
      const waiting = await css(".checkout-continue__button");
      expect(waiting.background).toBe("rgb(31, 99, 224)");
      expect(Number(waiting.opacity)).toBeLessThan(1);
      await expect(main.getByText("Choose a tip first", { exact: true })).toBeVisible();
      // The next step comes after the form, never over it.
      expect((await css(".checkout-continue")).position).toBe("static");
      await page.screenshot({
        path: `test-results/b63-checkout-${String(width)}.png`,
        fullPage: true,
      });
    });
  });
