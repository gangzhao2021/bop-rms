import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { serveStoreSetupPanels } from "./store-setup-panels";

/**
 * DEC-STORE-PHONE-BEFORE-PICKUP (M109): pickup guests are not in front of staff, so pickup is
 * offered only with the Store's phone. Store features says why it can't turn pickup on; Home asks
 * the owner of a Store already taking pickup orders without a phone, as a setup step. Synthetic,
 * TEST-only data.
 */
const id = (n: number) => "0190a7f3-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};
const widths = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function session(page: Page) {
  await serveStoreSetupPanels(page);
  await page.route("**/merchant/store/kitchen-statement", (route) =>
    route.fulfill({ headers, json: { status: "Current", statement: null, allergenChoices: [] } }),
  );
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
          businessDate: "2026-11-11",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: "/app/organization/stores/" + store + "/setup",
              permission: "organization.manage",
            },
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
}

const features = (pickup: boolean) => ({
  version: 3,
  templateCode: "Custom",
  modules: { counterOrder: true, pickup, inventory: true, loyalty: false, alcohol: false },
  changedAt: "2026-11-10T15:00:00.000Z",
  services: {
    version: 0,
    staffCall: false,
    chaseDish: false,
    askPartySize: false,
    changedAt: null,
  },
  teaCharge: { version: 0, teaSellableReference: null, changedAt: null, kitchenPrepares: false },
  teaChoices: [],
  tips: {
    version: 0,
    enabled: true,
    tierPercents: [10, 15, 18],
    changedAt: null,
    offInStoreSetup: false,
  },
  canChange: true,
});

const profile = (businessPhone: string | null) => ({
  observedAt: "2026-11-11T15:00:00.000Z",
  canChange: true,
  locales: ["en-CA"],
  current: {
    version: 1,
    publishedAt: "2026-11-01T15:00:00.000Z",
    defaultLocale: "en-CA",
    names: [{ locale: "en-CA", storeDisplayName: "Synthetic Store" }],
    address: {
      addressLines: ["1 Synthetic Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5H 1A1",
      countryCode: "CA",
    },
    businessPhone,
  },
  regionCodes: ["ON"],
});

async function fits(page: Page, width: number, region: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `no horizontal overflow at ${width}`,
  ).toBe(true);
  const axe = await new AxeBuilder({ page }).include(region).analyze();
  expect(
    axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious"),
    `axe at ${width}`,
  ).toEqual([]);
  await expectNoInternalText(page);
}

test("@production turning pickup on without the store's phone is refused and says where to add it, at 1440, 1024 and 390", async ({
  page,
}) => {
  await session(page);
  const changes: unknown[] = [];
  await page.route("**/merchant/store/features", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "Read") return route.fulfill({ headers, json: features(false) });
    changes.push(body);
    return route.fulfill({
      headers,
      status: 409,
      json: { error: "store_features_phone_required" },
    });
  });
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) =>
    route.fulfill({ headers, json: { version: 0, sections: [], products: [] } }),
  );
  await page.goto("/app/organization/stores/" + store + "/capabilities");
  const pickup = page.getByRole("checkbox", { name: /Pickup orders from guests/u });
  await expect(pickup).not.toBeChecked();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await pickup.check();
    const save = page.getByRole("button", { name: "Save", exact: true });
    // v15 2026-11-11 b10: Save at the very bottom of the screen, as the owner found it live.
    await save.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await save.click();
    const refusal = page.getByRole("alert");
    await expect(refusal).toContainText(
      "Pickup guests need a phone number to reach the store. Add it under Name and contact shown to customers in Store setup, then turn pickup on.",
    );
    // v15 batch 8: the refusal is right under the Save that was tapped, in view without
    // scrolling, and the box shows pickup still off (nothing was saved), with the way to the phone.
    // Every line of it, the way to add the phone included, not only its first line.
    await expect(refusal).toBeInViewport({ ratio: 1 });
    const saveBox = await save.boundingBox();
    const refusalBox = await refusal.boundingBox();
    expect(
      (refusalBox?.y ?? Infinity) - ((saveBox?.y ?? 0) + (saveBox?.height ?? 0)),
      `refusal under Save at ${width}`,
    ).toBeLessThan(120);
    await expect(pickup).not.toBeChecked();
    await expect(refusal.getByRole("link", { name: "Add phone number" })).toHaveAttribute(
      "href",
      "/app/organization/stores/" + store + "/setup#store-public-profile",
    );
    // Nothing was turned on behind the refusal: the page still shows pickup off once read again.
    await page.reload();
    await expect(pickup).not.toBeChecked();
    await pickup.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Pickup guests need a phone number");
    await fits(page, width, ".store-features");
  }
  expect(changes.length).toBe(6);
});

test("@production Home asks the owner for the phone of a store taking pickup orders without one, as a setup step, at 1440, 1024 and 390", async ({
  page,
}) => {
  await session(page);
  let phone: string | null = null;
  let modes = ["DineIn", "Pickup"];
  await page.route("**/merchant/store/features", (route) =>
    route.fulfill({ headers, json: features(true) }),
  );
  // The configuration in force (Hours and service): whether the Store takes pickup orders.
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({
      headers,
      json: {
        hours: {
          configurationSource: "StoreOverride",
          effectiveFrom: "2026-11-01T04:00:00.000Z",
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
            isoWeekday: index + 1,
            intervals: [],
          })),
          exceptions: [],
        },
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        configurationReference: id(98),
        timeZone: "America/Toronto",
        enabledServiceModes: modes,
        observedAt: new Date().toISOString(),
        expectedVersion: 0,
        activePauses: [],
      },
    }),
  );
  await page.route("**/merchant/store/public-profile", (route) =>
    route.fulfill({ headers, json: profile(phone) }),
  );
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto("/app");
    const row = page.getByRole("listitem").filter({ hasText: "Add the store's phone number" });
    await expect(row).toBeVisible();
    await expect(row).toContainText(
      "So pickup guests can reach you about allergies or their order.",
    );
    await expect(row).toContainText("Setup step");
    await expect(row.getByRole("link", { name: "Add phone number" })).toHaveAttribute(
      "href",
      "/app/organization/stores/" + store + "/setup#store-public-profile",
    );
    await fits(page, width, "main");
  }
  // A dine-in-only Store is not asked, although Store features has pickup on by default.
  modes = ["DineIn"];
  await Promise.all([
    page.waitForResponse("**/merchant/store/features"),
    page.waitForResponse("**/merchant/store/public-profile"),
    page.waitForResponse("**/merchant/service-control"),
    page.reload(),
  ]);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Add the store's phone number")).toHaveCount(0);
  // Once the phone is published the step is gone.
  modes = ["DineIn", "Pickup"];
  phone = "+14165550142";
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Add the store's phone number")).toHaveCount(0);
});
