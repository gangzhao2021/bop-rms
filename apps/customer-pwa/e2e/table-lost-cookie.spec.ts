import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 shared-table-checkout (b), lost cookie. Synthetic HTTP on the production PWA at 390,
// 1024 and 1440: a phone whose cookie is gone but whose page kept its continuity token scans the
// table code; the token goes with the scan (never in the URL), the answer is "You're already at this
// table." with no join offered, and the new token replaces the old one in the page's storage. The
// rotation itself is proven by the restricted-role acceptance guest-session-continuity.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block", trace: "off", video: "off" });

const id = (n: number) => `018f2523-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const json = { "cache-control": "no-store", "content-type": "application/json" };

for (const width of [390, 1024, 1440]) {
  test(`@production a phone that lost its cookie is the same phone at the table again (${width})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("page error"));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded") === null) {
        localStorage.setItem("bop.customer.table-continuity", "T".repeat(43));
        sessionStorage.setItem("seeded", "1");
      }
    });
    const sent: unknown[] = [];
    await page.route("**/bff/customer/entry", (route) => {
      sent.push(JSON.parse(route.request().postData() ?? "{}"));
      return route.fulfill({
        status: 200,
        headers: json,
        body: JSON.stringify({
          schemaVersion: 2,
          status: "AlreadyAtTable",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Dining Store",
          publicStoreReference: id(6),
          publicTableReference: id(7),
          channel: "DineIn",
          locale: "en-CA",
          continuityToken: "U".repeat(43),
        }),
      });
    });
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      route.fulfill({
        headers: json,
        body: JSON.stringify({
          schemaVersion: 1,
          csrfToken: "c".repeat(43),
          menuContext: {
            publicStoreReference: id(6),
            channel: "DineIn",
            locale: "en-CA",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Dining Store",
          },
        }),
      }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "You’re already at this table." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Join this table", exact: true })).toHaveCount(0);
    expect(sent).toEqual([{ qrToken: "aaa.bbb.ccc", continuity: "T".repeat(43) }]);
    expect(page.url()).not.toContain("T".repeat(43));
    expect(await page.evaluate(() => localStorage.getItem("bop.customer.table-continuity"))).toBe(
      "U".repeat(43),
    );
    await expectNoInternalText(page);
    await page.screenshot({ path: `test-results/lost-cookie-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
