import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP interception on the production PWA, not live Store evidence.
// WP-2423 (rush-logging-and-entry, v15 2026-11-13): a new phone opening the store's pickup link in
// a rush was told "Scan the location QR code to begin" for about 8 s while the store answered busy
// and the scan was asked again. Now the page says the store is busy, that nothing was ordered,
// with Try again (asks at once), and never asks to scan; the entry then works.
const id = (n: number) => "018f8905-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const busy = {
  schemaVersion: 1,
  code: "entry_service_unavailable",
  messageKey: "customer.entry.service_unavailable",
  recovery: { action: "RetryOrAskStaff", storeSelection: "Hidden" },
};

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production A busy entry " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    for (const language of ["en", "zh-Hans"] as const)
      test(
        "says the store is busy with Try again, never to scan, then enters " + language,
        async ({ page }) => {
          const zh = language === "zh-Hans";
          if (zh)
            await page.addInitScript(() =>
              localStorage.setItem("bop.customer.language", "zh-Hans"),
            );
          let calls = 0;
          let open = false;
          await page.route("**/bff/customer/entry", async (route) => {
            calls += 1;
            if (!open)
              return route.fulfill({
                status: 503,
                headers: { "cache-control": "no-store", "retry-after": "5" },
                json: busy,
              });
            return route.fulfill({
              status: 201,
              headers: { "cache-control": "no-store" },
              json: {
                schemaVersion: 2,
                status: "Established",
                brandDisplayName: "Synthetic Brand",
                storeDisplayName: "Synthetic Rush Store",
                publicStoreReference: id(4),
                publicTableReference: null,
                channel: "Pickup",
                operatingState: "Open",
                availableServiceModes: ["Pickup"],
                locale: "en-CA",
                contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
                csrfToken: "e".repeat(43),
              },
            });
          });
          await page.goto("/#qr=aaa.bbb.ccc");
          const heading = page.getByRole("heading", {
            name: zh ? "店里的系统有点忙" : "The store’s system is busy",
          });
          await expect(heading).toBeVisible();
          await expect(
            page.getByText(
              zh
                ? "还没有下单。几秒后本页会自动再试。"
                : "Nothing has been ordered. This page asks again by itself in a few seconds.",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            page.getByText(zh ? "扫描门店二维码" : "Scan the location QR code"),
          ).toHaveCount(0);
          await expectNoInternalText(page);
          await page.screenshot({
            path: test.info().outputPath(`entry-busy-${screen.width}-${language}.png`),
            fullPage: true,
          });
          // The store answers again: Try again asks at once (no wait for the next automatic ask).
          open = true;
          const before = calls;
          await page.getByRole("button", { name: zh ? "重试" : "Try again", exact: true }).click();
          await expect(
            page.getByRole("button", { name: zh ? "查看菜单" : "Continue to menu" }),
          ).toBeVisible({ timeout: 2_000 });
          expect(calls).toBe(before + 1);
          await expect(
            page.getByText(zh ? "扫描门店二维码" : "Scan the location QR code"),
          ).toHaveCount(0);
          // Nothing overflows the narrowest screen.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
        },
      );
  });
}
