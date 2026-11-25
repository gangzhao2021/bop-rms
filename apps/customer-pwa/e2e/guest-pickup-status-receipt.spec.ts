import { expect, test, type Page } from "@playwright/test";
import {
  v15PickupOrderReference,
  v15PickupStatusBody,
  type V15PickupStage,
} from "../src/order-status/v15-pickup-status.fixture";
import { receipt } from "./receipt-fixture";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 63 (v15 batch 62 page review, F15–F17). Synthetic HTTP answers in the shapes v15 sent.
// F15: once a pickup was ready, its code sat at y=692–951 on a 390×844 phone, under the steps and
//      the type / kitchen / payment rows; a guest at the counter had to scroll for it.
// F16: "Accepted by the store · Now" showed before the store accepted, and a collected order still
//      said "Kitchen status Ready" with "Refresh now".
// F17: the receipt read as a system record ("Receipt history / Version 1: Receipt", "Last
//      checked", zero refund lines) set 15 and 30 px in from the page's edge.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const storeDisplayName = "Synthetic Status Store";

async function enter(page: Page) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName,
        publicStoreReference: "01a14783-0000-7000-8000-000000000006",
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.locator(".bop-shell__header h1")).toHaveText(storeDisplayName);
}

async function openOrder(page: Page, stage: V15PickupStage, path = "") {
  await page.route("**/api/v1/orders/*/status", (route) =>
    route.fulfill({ json: v15PickupStatusBody(stage) }),
  );
  await page.route("**/api/v1/orders/*/pickup-code", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        status: "Ready",
        orderReference: v15PickupOrderReference,
        orderNumber: "17",
        storeDisplayName,
        pickupInstruction: "Show this code at the pickup counter.",
        generation: 1,
        proofKind: "Opaque",
        proofValue: "AbCdEfGhIjKlMnOpQrStUQ",
        counterCode: "048213",
        observedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    }),
  );
  await enter(page);
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/orders/${v15PickupOrderReference}${path}`);
}

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom };
    });

for (const width of [390, 1024, 1440])
  test.describe(`@production batch 63 pickup status and receipt at ${String(width)}`, () => {
    const height = width === 390 ? 844 : width === 1024 ? 768 : 900;
    test.use({ viewport: { width, height }, hasTouch: width < 1440, isMobile: width < 768 });

    test("F15: a ready order shows its pickup code first, above the steps, on the first screen", async ({
      page,
    }) => {
      await openOrder(page, "ready");
      const main = page.getByRole("main");
      await expect(main.getByText("048 213", { exact: true })).toBeVisible();
      const code = await box(page, ".pickup-code");
      const steps = await box(page, ".order-status__timeline");
      const rows = await box(page, ".order-status__summary dl");
      expect(code.top).toBeLessThan(steps.top);
      expect(code.top).toBeLessThan(rows.top);
      // The digits a guest shows staff are on the first screen, without scrolling.
      const digits = await box(page, ".pickup-code__visual--short");
      expect(digits.bottom).toBeLessThanOrEqual(height);
      // F16: "Ready for pickup" is done; collecting it is what waits ("Now" read as a time).
      await expect(main.locator(".order-status__step--current")).toHaveText("Picked upWaiting");
      await expect(main.getByText("Now", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `test-results/b63-pickup-ready-${String(width)}.png` });
    });

    test("F16: before the store accepts, its step waits; once collected, nothing is left to check", async ({
      page,
    }) => {
      await openOrder(page, "awaiting-acceptance");
      const main = page.getByRole("main");
      await expect(main.locator(".order-status__step--current")).toHaveText(
        "Accepted by the storeWaiting",
      );
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await routeStorefrontReads(page);
      await openOrder(page, "collected");
      await expect(main.getByText("This order is complete.", { exact: true })).toBeVisible();
      await expect(
        main.locator(".order-status__summary dt", { hasText: "Kitchen status" }),
      ).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Refresh now" })).toHaveCount(0);
      await page.screenshot({ path: `test-results/b63-pickup-collected-${String(width)}.png` });
    });

    test("F09: every other action is accent words on a 44 px tap; removing contact details is red", async ({
      page,
    }) => {
      await openOrder(page, "collected");
      const main = page.getByRole("main");
      await expect(main.getByText("This order is complete.", { exact: true })).toBeVisible();
      const look = (target: import("@playwright/test").Locator) =>
        target.evaluate((element) => {
          const css = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            color: css.color,
            border: css.borderTopWidth,
            background: css.backgroundColor,
            underline: css.textDecorationLine,
            size: css.fontSize,
            weight: css.fontWeight,
            tall: box.height >= 43.5,
          };
        });
      const accentWords = {
        color: "rgb(31, 99, 224)",
        border: "0px",
        background: "rgba(0, 0, 0, 0)",
        underline: "none",
        size: "16px",
        weight: "400",
        tall: true,
      };
      for (const name of [/^Call /u, /View receipt/u, /Back to menu/u])
        expect(await look(main.getByRole("link", { name }).first())).toEqual(accentWords);
      expect(await look(main.getByRole("button", { name: "Remove my contact details" }))).toEqual({
        ...accentWords,
        color: "rgb(191, 85, 82)",
      });
      // It still asks first.
      await main.getByRole("button", { name: "Remove my contact details" }).click();
      await expect(main.getByRole("group")).toBeVisible();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await routeStorefrontReads(page);
      await page.route(/\/api\/v1\/orders\/[^/]+\/receipt(?:\?.*)?$/u, (route) =>
        route.fulfill({
          json: {
            ...receipt(false),
            receipt: { ...receipt(false).receipt, orderReference: v15PickupOrderReference },
          },
        }),
      );
      await openOrder(page, "collected", "/receipt");
      await expect(main.getByText("Synthetic Issuer Ltd. (TEST-ONLY)")).toBeVisible();
      expect(await look(main.getByRole("button", { name: "Print or save receipt" }))).toEqual(
        accentWords,
      );
    });

    for (const zh of [false, true])
      test(`F17: the receipt reads as a receipt on the page's one edge (${zh ? "zh-Hans" : "en"})`, async ({
        page,
      }) => {
        await page.route(/\/api\/v1\/orders\/[^/]+\/receipt(?:\?.*)?$/u, (route) =>
          route.fulfill({
            json: {
              ...receipt(false),
              receipt: { ...receipt(false).receipt, orderReference: v15PickupOrderReference },
            },
          }),
        );
        await openOrder(page, "collected", "/receipt");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        const main = page.getByRole("main");
        await expect(main.getByText("Synthetic Issuer Ltd. (TEST-ONLY)")).toBeVisible();
        const text = (await main.innerText()).replace(/\s+/gu, " ");
        expect(text).not.toMatch(/Receipt history|Version 1|Last checked|收据记录|版本|最后检查/u);
        expect(text).not.toMatch(
          /Refunded \$0\.00|Pending refunds|Confirmed refunds|已退款 \$0\.00/u,
        );
        if (zh) {
          // Every date in Chinese, and no English month beside a Chinese one.
          expect(text).toContain("2026年10月14日");
          expect(text).not.toMatch(/\bOct\b|a\.m\.|p\.m\./u);
        }
        // One left edge: each part of the receipt starts its words where the part starts (no
        // inner indent), and the first column starts where the page title does.
        const edge = (await box(page, "#page-heading")).left;
        const parts = await page
          .locator(".receipt-page__content > :is(section, aside)")
          .evaluateAll((elements) =>
            elements.map((element) => ({
              left: Math.round(element.getBoundingClientRect().left),
              inner: [
                ...element.querySelectorAll(
                  "h2:not(.sr-only), .receipt-page__lines li, .receipt-page__totals div, address, p",
                ),
              ]
                .filter((child) => child.getBoundingClientRect().width > 0)
                .map((child) => Math.round(child.getBoundingClientRect().left)),
            })),
          );
        expect(parts.length).toBeGreaterThan(2);
        expect(Math.min(...parts.map((part) => part.left))).toBeCloseTo(edge, -0.5);
        for (const part of parts)
          for (const left of part.inner) expect(Math.abs(left - part.left)).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: `test-results/b63-receipt-${zh ? "zh" : "en"}-${String(width)}.png`,
          fullPage: true,
        });
      });
  });
