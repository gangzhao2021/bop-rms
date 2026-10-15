import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 DEC-STORE-CUSTOMER-NAME: in Store setup the Owner publishes the Store name customers
 * see, the street address and the phone; staff who cannot change them see them read-only; a Store
 * that never published is told customers cannot open its menu yet. Synthetic TEST-ONLY values;
 * the server answers are routed in the browser.
 */
const id = (n: number) => "018f7716-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: store,
};
const headers = { "cache-control": "no-store" };
const regionCodes = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const published = (version: number, name: string, phone: string | null) => ({
  version,
  publishedAt: "2026-10-15T15:00:00.000Z",
  defaultLocale: "en-CA",
  names: [{ locale: "en-CA", storeDisplayName: name }],
  address: {
    addressLines: ["100 Example Street"],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA",
  },
  businessPhone: phone,
});

async function session(page: Page) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: "/app/organization/stores/" + store + "/setup",
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
  // The setup wizard and the receipt section have their own specs.
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "forbidden" } }),
  );
}
const heading = "Name and contact shown to customers";

test("@production the Owner publishes the store name, address and phone customers see", async ({
  page,
}) => {
  await session(page);
  let current = published(1, "DEMO Store - Simulated payments only", "+14165550100");
  const saves: Record<string, unknown>[] = [];
  await page.route("**/merchant/store/public-profile", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(request.headers()["x-bop-csrf"]).toBe("a".repeat(43));
      const body = request.postDataJSON() as {
        expectedVersion: number;
        details: { storeDisplayNames: Record<string, string>; businessPhone: string | null };
      };
      saves.push(body);
      if (body.expectedVersion !== current.version)
        return route.fulfill({ status: 409, headers, json: { error: "profile_changed" } });
      current = published(
        current.version + 1,
        body.details.storeDisplayNames["en-CA"] ?? "",
        "+14165550199",
      );
      return route.fulfill({ headers, json: { status: "Published", current } });
    }
    return route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-15T16:00:00.000Z",
        canChange: true,
        locales: ["en-CA"],
        current,
        regionCodes,
      },
    });
  });
  await page.goto("/app/organization/stores/" + store + "/setup");
  const panel = page.getByRole("region", { name: heading });
  await expect(panel.getByLabel("Store name customers see")).toHaveValue(
    "DEMO Store - Simulated payments only",
  );
  await expect(panel.getByLabel("Phone number (optional)")).toHaveValue("(416) 555-0100");
  await expect(panel.getByLabel("Province or territory")).toHaveValue("ON");
  await expect(panel.getByText(/Last published/u)).toBeVisible();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(panel.getByRole("heading", { name: heading })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .include("#store-public-profile")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
  await expectNoInternalText(page);

  // Mistakes are explained next to the field before anything is sent.
  await panel.getByLabel("Store name customers see").fill("Maple #1");
  await panel.getByLabel("Postal code").fill("90210");
  await panel.getByLabel("Phone number (optional)").fill("555-0100");
  await panel.getByRole("button", { name: "Publish name and contact details" }).click();
  await expect(panel.getByText(/no # \* _ < >/u)).toBeVisible();
  await expect(panel.getByText(/Canadian postal code/u)).toBeVisible();
  await expect(panel.getByText(/10-digit phone number/u)).toBeVisible();
  expect(saves).toHaveLength(0);

  await panel.getByLabel("Store name customers see").fill("Maple Noodle House");
  await panel.getByLabel("Postal code").fill("a1a 1a1");
  await panel.getByLabel("Phone number (optional)").fill("416-555-0199");
  await panel.getByRole("button", { name: "Publish name and contact details" }).click();
  await expect(panel.getByText(/Published\. Customers see these details/u)).toBeVisible();
  await expect(panel.getByText(/Receipts already issued keep the name/u).first()).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    expectedVersion: 1,
    details: {
      storeDisplayNames: { "en-CA": "Maple Noodle House" },
      address: {
        addressLines: ["100 Example Street"],
        locality: "Exampleville",
        regionCode: "ON",
        postalCode: "a1a 1a1",
      },
      businessPhone: "416-555-0199",
    },
  });
  // The form shows the published version, as the server stored it.
  await expect(panel.getByLabel("Store name customers see")).toHaveValue("Maple Noodle House");
  await expect(panel.getByLabel("Phone number (optional)")).toHaveValue("(416) 555-0199");
});

test("@production staff who cannot change the store name see it read-only", async ({ page }) => {
  await session(page);
  await page.route("**/merchant/store/public-profile", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-15T16:00:00.000Z",
        canChange: false,
        locales: ["en-CA"],
        current: published(3, "Maple Noodle House", null),
        regionCodes,
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/setup");
  const panel = page.getByRole("region", { name: heading });
  await expect(panel.getByText("Only the Owner can change these details.")).toBeVisible();
  await expect(panel.getByLabel("Store name customers see")).toHaveValue("Maple Noodle House");
  await expect(panel.getByLabel("Store name customers see")).toHaveAttribute("readonly", "");
  await expect(panel.getByLabel("Province or territory")).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Publish name and contact details" })).toHaveCount(
    0,
  );
});

test("@production a store that never published is told customers cannot open its menu yet", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/store/public-profile", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-15T16:00:00.000Z",
        canChange: true,
        locales: ["en-CA", "fr-CA"],
        current: null,
        regionCodes,
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/setup");
  const panel = page.getByRole("region", { name: heading });
  await expect(panel.getByText(/cannot open this store’s menu/u)).toBeVisible();
  // One name per language the Store offers, labelled in plain words.
  await expect(panel.getByLabel(/Store name customers see \(.*English.*\)/u)).toHaveValue("");
  await expect(panel.getByLabel(/Store name customers see \(.*French.*\)/u)).toHaveValue("");
  await expectNoInternalText(page);
});

// v15 finding: the Store Manager now has "Store setup" in the navigation (they read the Store
// profile, organization.store.read) but only the Owner changes setup. The setup read answers 403
// for them; the page says plainly that only the Owner changes setup and shows no failed sections.
test("@production the Store Manager opens Store setup from the navigation and sees it read-only (v15)", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "request_denied" } }),
  );
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-15T16:00:00.000Z",
        canChange: false,
        version: 1,
        recordedAt: "2026-10-15T15:00:00.000Z",
        details: {
          gstHstNumber: "000000000RT0001",
          qstNumber: null,
          pstNumber: null,
          privacyNoticeUrl: "https://example.com/privacy",
        },
        gaps: { taxRegistrationMissing: false, privacyNoticeMissing: false },
      },
    }),
  );
  await page.route("**/merchant/store/public-profile", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-15T16:00:00.000Z",
        canChange: false,
        locales: ["en-CA"],
        current: published(3, "Maple Noodle House", null),
        regionCodes,
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/setup");
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Store setup" })
      .first(),
  ).toHaveAttribute("href", "/app/organization/stores/" + store + "/setup");
  await expect(page.getByText("Only the Owner can change Store setup.")).toBeVisible();
  await expect(page.getByText("does not allow this action", { exact: false })).toHaveCount(0);
  await expect(page.getByText("could not be loaded", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh saved setup" })).toHaveCount(0);
  const profile = page.getByRole("region", { name: heading });
  await expect(profile.getByLabel("Store name customers see")).toHaveValue("Maple Noodle House");
  await expect(profile.getByText("Only the Owner can change these details.")).toBeVisible();
  const receipts = page.getByRole("region", { name: "Receipts and privacy" });
  await expect(receipts.getByLabel("GST/HST registration number")).toHaveValue("000000000RT0001");
  await expectNoInternalText(page);
});
