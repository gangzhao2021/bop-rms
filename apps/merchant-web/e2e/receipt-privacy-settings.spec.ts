import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): the Owner enters the Store's receipt registration
 * numbers and privacy notice link in Store setup; staff are warned on Store setup and Tax review
 * while receipts lack a registration number or checkout lacks a privacy link. Synthetic TEST-ONLY
 * values; the server answers are routed in the browser.
 */
const id = (n: number) => "018f7715-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: store,
};
const headers = { "cache-control": "no-store" };

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
          businessDate: "2026-10-14",
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
            {
              screenId: "TAX-STORE-REVIEW",
              label: "Tax review",
              href: "/app/commerce/tax-review",
              permission: "pricing.tax_config.read",
            },
          ],
        },
      },
    }),
  );
  // The setup wizard's own sources are not under test here.
  await page.route("**/merchant/store-setup**", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
}
async function noOverflowOrBlockingAxe(page: Page) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Receipts and privacy", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .include(".receipt-privacy")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
}

test("@production the Owner enters receipt registrations and the privacy link; staff are warned until then", async ({
  page,
}) => {
  await session(page);
  let version = 0;
  let details = {
    gstHstNumber: null,
    qstNumber: null,
    pstNumber: null,
    privacyNoticeUrl: null,
  } as Record<string, string | null>;
  const saves: Record<string, unknown>[] = [];
  const gaps = () => ({
    taxRegistrationMissing:
      details.gstHstNumber === null && details.qstNumber === null && details.pstNumber === null,
    privacyNoticeMissing: details.privacyNoticeUrl === null,
  });
  await page.route("**/merchant/store/receipt-profile", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(request.headers()["x-bop-csrf"]).toBe("a".repeat(43));
      const body = request.postDataJSON() as Record<string, unknown>;
      saves.push(body);
      if (body.expectedVersion !== version)
        return route.fulfill({ status: 409, headers, json: { error: "profile_changed" } });
      details = body.details as typeof details;
      version += 1;
      return route.fulfill({
        headers,
        json: { status: "Recorded", version, recordedAt: "2026-10-14T16:00:00.000Z", gaps: gaps() },
      });
    }
    return route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-14T16:00:00.000Z",
        canChange: true,
        version,
        recordedAt: version === 0 ? null : "2026-10-14T16:00:00.000Z",
        details,
        gaps: gaps(),
      },
    });
  });
  await page.route("**/merchant/commerce/tax-review/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "TAX-STORE-REVIEW",
        sourceAsOf: "2026-10-14T16:00:00.000Z",
        receiptSetup: gaps(),
        configuration: null,
        classes: [],
        products: [],
      },
    }),
  );

  // Tax review tells staff what receipts and checkout lack, and where the Owner enters it.
  await page.goto("/app/commerce/tax-review");
  await expect(
    page.getByText("Customer receipts show no GST/HST registration number"),
  ).toBeVisible();
  await expect(page.getByText("Add your privacy notice link before going live")).toBeVisible();
  await page
    .getByRole("link", { name: "Enter them in Store setup → Receipts and privacy" })
    .click();
  await expect(page).toHaveURL(new RegExp("/app/organization/stores/" + store + "/setup"));

  const panel = page.getByRole("region", { name: "Receipts and privacy" });
  await expect(panel.getByText("Add your privacy notice link before going live")).toBeVisible();
  await noOverflowOrBlockingAxe(page);

  // Mistakes are explained next to the field before anything is sent.
  await panel.getByLabel("GST/HST registration number").fill("12345");
  await panel.getByLabel("Privacy notice link").fill("http://example.test/privacy");
  await panel.getByRole("button", { name: "Save receipt and privacy details" }).click();
  await expect(panel.getByText(/9 digits, RT, 4 digits/u)).toBeVisible();
  await expect(panel.getByText(/starting with https:\/\//u)).toBeVisible();
  expect(saves).toHaveLength(0);

  // TEST-ONLY number and link (shaped like real ones, not a real registration).
  await panel.getByLabel("GST/HST registration number").fill("000000000 RT 0001");
  await panel.getByLabel("Privacy notice link").fill("https://example.test/privacy");
  await panel.getByRole("button", { name: "Save receipt and privacy details" }).click();
  await expect(
    panel.getByText(/Saved\. Receipts issued from now on show these details/u),
  ).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    expectedVersion: 0,
    details: {
      gstHstNumber: "000000000 RT 0001",
      qstNumber: null,
      pstNumber: null,
      privacyNoticeUrl: "https://example.test/privacy",
    },
  });
  await expect(panel.getByText("Add your privacy notice link before going live")).toHaveCount(0);
  await expect(panel.getByText("Last saved", { exact: false })).toBeVisible();

  // Tax review no longer warns.
  await page.goto("/app/commerce/tax-review");
  await expect(page.getByRole("heading", { name: "Tax review", level: 2 })).toBeVisible();
  await expect(page.getByText("Customer receipts show no GST/HST registration number")).toHaveCount(
    0,
  );
});

test("@production staff who cannot change the details see them read-only", async ({ page }) => {
  await session(page);
  await page.route("**/merchant/store/receipt-profile", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: "2026-10-14T16:00:00.000Z",
        canChange: false,
        version: 1,
        recordedAt: "2026-10-14T15:00:00.000Z",
        details: {
          gstHstNumber: "000000000RT0001",
          qstNumber: null,
          pstNumber: null,
          privacyNoticeUrl: null,
        },
        gaps: { taxRegistrationMissing: false, privacyNoticeMissing: true },
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/setup");
  const panel = page.getByRole("region", { name: "Receipts and privacy" });
  await expect(panel.getByText("Only the Owner can change these details.")).toBeVisible();
  await expect(panel.getByLabel("GST/HST registration number")).toHaveValue("000000000RT0001");
  await expect(panel.getByLabel("GST/HST registration number")).toHaveAttribute("readonly", "");
  await expect(panel.getByRole("button", { name: "Save receipt and privacy details" })).toHaveCount(
    0,
  );
  await expect(panel.getByText("Add your privacy notice link before going live")).toBeVisible();
});
