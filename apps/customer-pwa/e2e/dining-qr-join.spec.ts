import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));

const id = (n: number) => `018f2424-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noStore = { "cache-control": "no-store" };
test.use({ serviceWorkers: "block", trace: "off", video: "off" });

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN. Synthetic HTTP (route fixtures standing in for the API):
 * a guest scans an open table and joins with one tap, no code and no account. While staff have
 * paused joining by scan, the guest is told so in plain words and given the code entry. Server
 * rules (open table only, pause, removal, 12 per 10 minutes) are proven by the database
 * acceptance test.
 */
test("@production a guest joins the scanned open table with one tap, or with a code while paused", async ({
  page,
}) => {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const table = { paused: true, qrJoins: 0, codeJoins: 0, bodies: [] as string[] };
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("page error"));
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: noStore,
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Dining Store",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "g".repeat(43),
      },
    }),
  );
  const joined = (route: import("@playwright/test").Route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Joined",
        operationReference: route.request().headers()["idempotency-key"],
        admissionReference: id(30),
      },
    });
  await page.route("**/bff/customer/dining/qr-join", async (route) => {
    table.bodies.push(route.request().postData() ?? "");
    if (table.paused) {
      await route.fulfill({
        status: 409,
        headers: noStore,
        json: {
          error: { code: "dining_join_qr_paused", messageKey: "customer.dining.join_qr_paused" },
        },
      });
      return;
    }
    table.qrJoins++;
    await joined(route);
  });
  await page.route("**/bff/customer/dining/join", async (route) => {
    table.codeJoins++;
    await joined(route);
  });
  await page.route("**/bff/customer/dining-binding/prepare", (route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Prepared",
        operationReference: route.request().headers()["idempotency-key"],
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      },
    }),
  );
  await page.route("**/bff/customer/dining-binding/activate", (route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        status: "Activated",
        operationReference: route.request().headers()["idempotency-key"],
        csrfToken: "n".repeat(43),
      },
    }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.getByText("You don’t need an account.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Join code or invitation", { exact: true })).toHaveCount(0);

  // Staff paused joining by scan: plain words, and the code entry.
  await page.getByRole("button", { name: "Join this table", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Staff have paused joining by scan at this table.",
  );
  const field = page.getByLabel("Join code or invitation", { exact: true });
  await expect(field).toBeVisible();
  await expect(page.getByRole("button", { name: "Join this table", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/qr-join-paused-390.png", fullPage: true });
  // The QR join sent no code and nothing about the guest.
  expect(table.bodies).toEqual(["{}"]);

  // Resumed: a fresh scan joins with one tap.
  table.paused = false;
  await page.goto("about:blank");
  await page.goto("/#qr=aaa.bbb.ccc");
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("button", { name: "Join this table", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/qr-join-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Join this table", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
  expect(table).toMatchObject({ qrJoins: 1, codeJoins: 0 });
  expect(errors).toEqual([]);
});
