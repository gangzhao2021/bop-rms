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
      await expect(page.getByRole("heading", { name: "Check your payment" })).toBeVisible();
      const message = {
        Failed: "Payment failed",
        Succeeded: "Payment confirmed",
        Pending: "Payment confirmation is pending. Do not submit another payment.",
        Unknown: "Neither success nor failure is confirmed.",
        Unprepared: "Payment has not been prepared for this checkout.",
      }[status];
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Confirm simulated payment" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Review payment total" })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /start secure payment|pay again|retry payment/i }),
      ).toHaveCount(0);
      const tone =
        status === "Unknown"
          ? "warning"
          : status === "Failed"
            ? "danger"
            : status === "Succeeded"
              ? "success"
              : "pending";
      await expect(page.locator(".payment-result-page__badge")).toHaveAttribute("data-tone", tone);
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
    if (status === "Unknown") {
      await expect(page.getByText("Check the same payment; do not submit another.")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Check payment status", exact: true }),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText("0190fa21-0000-7000-8000-000000000002");
      await expect(page.locator("body")).not.toContainText("0190fa21-0000-7000-8000-000000000003");
      await expect(page.locator("body")).not.toContainText("CAD 11.30");
    }
    await expect(page.locator("body")).not.toContainText("0190fa21-0000-7000-8000-000000000002");
    await expect(page.locator("body")).not.toContainText("0190fa21-0000-7000-8000-000000000003");
    if (status === "Succeeded") {
      await expect(page.getByText("Paid:", { exact: false })).toContainText("CAD 11.30");
      await expect(
        page.getByRole("link", { name: "View order status", exact: true }),
      ).toHaveAttribute("href", "/orders/0190fa21-0000-7000-8000-000000000003");
    } else {
      await expect(page.locator("body")).not.toContainText("CAD 11.30");
      await expect(page.getByRole("link", { name: "View order status", exact: true })).toHaveCount(
        0,
      );
    }
    if (status === "Pending") {
      await expect(
        page.getByRole("button", { name: "Check payment status", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Do not submit another payment.", { exact: false }),
      ).toBeVisible();
    } else if (status === "Failed" || status === "Succeeded") {
      await expect(
        page.getByRole("button", { name: "Check payment status", exact: true }),
      ).toHaveCount(0);
    }
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
      const geometry = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".payment-result-page__header");
        const nav = document.querySelector<HTMLElement>(".payment-result-page__journey");
        const title = document.querySelector<HTMLElement>(".payment-result-page > h1");
        const intro = document.querySelector<HTMLElement>(".payment-result-page__intro");
        const card = document.querySelector<HTMLElement>(".payment-result-page__card");
        const items = [...(nav?.querySelectorAll<HTMLElement>("a, span") ?? [])].map((item) =>
          item.getBoundingClientRect(),
        );
        const labels = [...(nav?.querySelectorAll<HTMLElement>("a, span") ?? [])].map((item) => {
          const text = document.createRange();
          text.selectNodeContents(item);
          const textBox = text.getBoundingClientRect();
          const box = item.getBoundingClientRect();
          return {
            text: item.textContent,
            clipped: textBox.left < box.left || textBox.right > box.right,
          };
        });
        return {
          headerWidth: header ? Math.round(header.getBoundingClientRect().width) : 0,
          headerLeft: header ? Math.round(header.getBoundingClientRect().left) : -1,
          headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
          navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
          headerToNavGap:
            header && nav
              ? Math.round(nav.getBoundingClientRect().top - header.getBoundingClientRect().bottom)
              : Infinity,
          navToTitleGap:
            nav && title
              ? Math.round(title.getBoundingClientRect().top - nav.getBoundingClientRect().bottom)
              : Infinity,
          titleIntroGap:
            title && intro
              ? Math.round(intro.getBoundingClientRect().top - title.getBoundingClientRect().bottom)
              : Infinity,
          introCardGap:
            intro && card
              ? Math.round(card.getBoundingClientRect().top - intro.getBoundingClientRect().bottom)
              : Infinity,
          navRowSpread:
            items.length > 0
              ? Math.max(...items.map((item) => item.y)) - Math.min(...items.map((item) => item.y))
              : Infinity,
          largestNavigationControl: Math.max(...items.map((item) => item.height)),
          clippedLabels: labels.filter((label) => label.clipped).map((label) => label.text),
        };
      });
      expect(geometry).toMatchObject({ headerWidth: width, headerLeft: 0, navRowSpread: 0 });
      expect(geometry.headerHeight).toBeLessThanOrEqual(width === 1440 ? 128 : 134);
      expect(geometry.navHeight).toBeLessThanOrEqual(width === 320 ? 56 : 60);
      expect(geometry.headerToNavGap, JSON.stringify(geometry)).toBe(0);
      expect(geometry.navToTitleGap, JSON.stringify(geometry)).toBe(width === 1440 ? 28 : 36);
      expect(geometry.titleIntroGap, JSON.stringify(geometry)).toBe(16);
      expect(geometry.introCardGap, JSON.stringify(geometry)).toBe(width === 1440 ? 36 : 24);
      expect(geometry.clippedLabels).toEqual([]);
      expect(geometry.largestNavigationControl).toBeLessThanOrEqual(48);
      const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      expect(
        overflow.document,
        `no horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`,
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `test-results/customer-payment-result-${status.toLowerCase()}-${width}.png`,
        fullPage: true,
      });
    }
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
