import { expect, test } from "@playwright/test";
// Synthetic HTTP responses exercise the production App; no live issuance evidence.
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function payload() {
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    orderReference: id(1),
    freshnessStatus: "Stale",
    deliveryStatus: "Unavailable",
    supportEligible: false,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-08-12T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Synthetic Store",
          orderNumber: "1001",
          issuedAt: "2026-08-12T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: amount("1000"),
            },
          ],
          subtotal: amount("1000"),
          tax: amount("130"),
          tip: amount("0"),
          total: amount("1130"),
          paymentStatus: "Paid",
          refundedTotal: amount("0"),
        },
      },
    ],
  };
}

test("@production receipt navigation removes inaccessible history", async ({ page }) => {
  const csrf = "c".repeat(43);
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Status Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: csrf,
      },
    }),
  );

  await page.route("**/api/v1/orders/*/receipt", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
    expect(route.request().method()).toBe("GET");
    if (route.request().url().includes(id(1))) {
      await route.fulfill({ json: { schemaVersion: 1, receipt: payload() } });
    } else await route.fulfill({ status: 404, json: { schemaVersion: 1 } });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
  ).toBeVisible();
  const navigate = async (reference: string) =>
    page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference + "/receipt");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, reference);
  await navigate(id(1));
  await expect(page.getByText("Synthetic Operating Entity", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Live receipt status is unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("CAD 11.30", { exact: true })).toBeVisible();
  await navigate(id(99));
  await expect(page.getByRole("heading", { name: "Receipt not found", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Operating Entity", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
