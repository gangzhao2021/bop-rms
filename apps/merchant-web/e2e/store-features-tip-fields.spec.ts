import { expect, test, type Page } from "@playwright/test";

// Batch 63 RA-12 (v15 design review, Store features): each tip percentage was a 22 × 44 field in
// a 22 px label, so its "%" wrapped under the number and a finger could barely edit it on a
// tablet. Each field is at least 56 px wide and 44 px tall, with "%" on the same line.
// Synthetic, TEST-only data.
const id = (n: number) => "0190a7f2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};
const features = {
  version: 0,
  templateCode: null,
  modules: { counterOrder: true, pickup: true, inventory: true, loyalty: false, alcohol: false },
  changedAt: null,
  services: {
    version: 0,
    staffCall: false,
    chaseDish: false,
    askPartySize: false,
    changedAt: null,
  },
  teaCharge: { version: 0, teaSellableReference: null, changedAt: null },
  teaChoices: [],
  tips: {
    version: 0,
    enabled: true,
    tierPercents: [10, 15, 18],
    changedAt: null,
    offInStoreSetup: false,
  },
  autoAccept: { version: 0, pickup: false, dineIn: false, changedAt: null },
  canChange: true,
};

async function open(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-25",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-CAPABILITY",
              label: "Store features",
              href: "/app/organization/stores/" + store + "/capabilities",
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/store/features", (route) =>
    route.fulfill({ headers, json: features }),
  );
  await page.route("**/merchant/store/kitchen-statement", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Current",
        statement: null,
        allergenChoices: [{ code: "PEANUT", name: "Peanuts", nameZh: "花生" }],
      },
    }),
  );
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) =>
    route.fulfill({ headers, json: { version: 0, sections: [] } }),
  );
  await page.goto("/app/organization/stores/" + store + "/capabilities");
}

for (const language of ["en", "zh-Hans"] as const) {
  test(`@production each tip percentage is a tappable field with its % beside it (${language})`, async ({
    page,
  }) => {
    await open(page, language);
    const fields = page.locator(".store-features__tiers input");
    await expect(fields).toHaveCount(3);
    await expect(fields.first()).toHaveValue("10");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const boxes = await fields.evaluateAll((inputs) =>
        inputs.map((input) => {
          const field = input.getBoundingClientRect();
          const label = (input.closest("label") as HTMLElement).getBoundingClientRect();
          return { width: field.width, height: field.height, labelHeight: label.height };
        }),
      );
      for (const box of boxes) {
        expect(box.width, JSON.stringify(box)).toBeGreaterThanOrEqual(56);
        expect(box.height, JSON.stringify(box)).toBeGreaterThanOrEqual(44);
        // "%" on the field's line: the label is one line, the field's height.
        expect(box.labelHeight, JSON.stringify(box)).toBeLessThanOrEqual(box.height + 1);
      }
      await page.locator(".store-features__tiers").screenshot({
        path: `test-results/store-tip-fields-${language}-${width}.png`,
      });
    }
  });
}
