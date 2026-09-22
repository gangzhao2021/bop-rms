import { expect, test } from "@playwright/test";
// Synthetic HTTP fixtures exercise the built UI; they do not prove live Guest authorization.
const checkout = "0190fa21-0000-7000-8000-000000000001";
test.use({ serviceWorkers: "block" });
for (const status of ["Failed", "Succeeded", "Pending", "Unknown", "Unprepared"] as const) {
  test("@production payment reload recovers read-only: " + status, async ({ page }) => {
    const mutations: string[] = [];
    let reads = 0;
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.method() !== "GET") mutations.push(url.pathname);
      if (url.pathname === "/api/v1/customer/session/csrf") {
        await route.fulfill({
          json: { schemaVersion: 1, csrfToken: "B".repeat(43), checkoutSessionReference: checkout },
          headers: { "cache-control": "no-store" },
        });
      } else if (url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-result`) {
        reads++;
        expect(request.headers()["x-csrf-token"]).toBe("B".repeat(43));
        await route.fulfill({
          json: {
            schemaVersion: 1,
            payment: {
              checkoutSessionReference: checkout,
              paymentIntentReference:
                status === "Unprepared" ? null : "0190fa21-0000-7000-8000-000000000002",
              orderReference:
                status === "Unprepared" ? null : "0190fa21-0000-7000-8000-000000000003",
              status: status === "Unprepared" ? "Pending" : status,
              total: status === "Unprepared" ? null : { amountMinor: "1130", currency: "CAD" },
            },
          },
          headers: { "cache-control": "no-store" },
        });
      } else await route.fulfill({ status: 503, json: { unavailable: true } });
    });
    const assertView = async () => {
      await expect(page.getByRole("heading", { name: "Verify your payment" })).toBeVisible();
      const message = {
        Failed: "Payment failed",
        Succeeded: "Payment confirmed",
        Pending: "Payment confirmation is pending.",
        Unknown: "Your payment result is not yet known. Check again before paying again.",
        Unprepared: "Payment has not been prepared for this checkout.",
      }[status];
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Confirm simulated payment" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Review payment total" })).toHaveCount(0);
    };
    await page.goto("/checkout/payment");
    await assertView();
    await page.reload();
    await assertView();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(mutations).toEqual([]);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
  });
}

test("@production explicit recovery never repeats payment creation", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/v1/customer/session/csrf")
      return route.fulfill({
        json: { schemaVersion: 1, csrfToken: "B".repeat(43), checkoutSessionReference: checkout },
        headers: { "cache-control": "no-store" },
      });
    calls.push(request.method() + " " + path.split("/").at(-1));
    const recover = path.endsWith("/payment-reconciliation");
    if (recover) {
      expect(request.method()).toBe("POST");
      expect(request.postData()).toBe("{}");
    }
    await route.fulfill({
      json: {
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: checkout,
          paymentIntentReference: "0190fa21-0000-7000-8000-000000000002",
          orderReference: "0190fa21-0000-7000-8000-000000000003",
          status: recover ? "Succeeded" : "Unknown",
          total: { amountMinor: "1130", currency: "CAD" },
        },
      },
      headers: { "cache-control": "no-store" },
    });
  });
  await page.goto("/checkout/result");
  await expect(
    page.getByRole("button", { name: "Check payment status", exact: true }),
  ).toBeVisible();
  expect(calls.every((value) => value === "GET payment-result")).toBe(true);
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment confirmed", exact: true })).toBeVisible();
  expect(calls.filter((value) => value.startsWith("POST"))).toEqual([
    "POST payment-reconciliation",
  ]);
});
