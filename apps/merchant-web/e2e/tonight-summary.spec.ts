import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ② (Figma 47-2): at closing the Owner or Store Manager sees today's figures —
 * sales, what each payment method took (card-machine batch check, the table cash this system recorded), the
 * tables still open and today's cancellations — and a reminder on Home around closing. If the
 * store system can't be reached, the last figures stay with what to do. Synthetic figures.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const evening = "2026-10-28T01:42:00.000Z"; // 21:42 in Toronto, business day 2026-10-27

test.use({ timezoneId: "America/Toronto" });

async function workspace(page: Page) {
  await page.clock.setFixedTime(new Date(evening));
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
          businessDate: "2026-10-27",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "RPT-OPS-DASHBOARD",
              label: "Reports",
              href: "/app/reports/operations",
              permission: "reporting.sales.read",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: evening,
      },
    }),
  );
}

test("@production tonight's summary adds up, checks the card machine and drawer, lists open tables, and keeps its figures offline", async ({
  page,
}) => {
  await workspace(page);
  let reachable = true;
  let reads = 0;
  await page.route("**/merchant/reports/tonight", (route) => {
    reads += 1;
    if (!reachable) return route.abort("internetdisconnected");
    return route.fulfill({ headers, json: tonightSummaryFixture() });
  });
  await page.goto("/app/reports/operations");
  await expect(page.getByRole("button", { name: "Today's summary", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Today's summary · Tue, Oct 27" })).toBeVisible();
  const sales = page.getByRole("region", { name: /^Sales/u });
  await expect(sales).toContainText("Gross sales$412.50");
  await expect(sales).toContainText("Comps and discounts by a manager3 dishes−$18.25");
  await expect(sales).toContainText("Net sales$394.25");
  const takings = page.getByRole("region", { name: /^Taken, by payment method/u });
  await expect(takings.getByRole("table")).toContainText("Card machine8$27.40$219.50");
  await expect(takings).toContainText(
    "Cash this system recorded (not the whole cash drawer)$86.95",
  );
  await expect(takings).toContainText("Total taken$503.05");
  await expect(takings).toContainText("Net taken$491.05");
  await expect(takings).toContainText("this system recorded $219.50 on the card machine today");
  await expect(takings).not.toContainText("should be");
  await expect(takings).toContainText(
    "The cash drawer also holds cash taken on your own register.",
  );
  const open = page.getByRole("region", { name: /^Tables not paid yet/u });
  await expect(open).toContainText("2 tables · $86.40 to take before closing");
  await expect(open.getByRole("link", { name: "Go to Tables" })).toHaveAttribute(
    "href",
    /\/operations\/dining$/u,
  );
  await expect(page.getByRole("region", { name: /^Refunds and cancellations/u })).toContainText(
    "Dishes taken off a bill before payment2 dishes$18.80",
  );
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/tonight-summary-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);

  // The store system can't be reached: the last figures stay, with their time and what to do.
  reachable = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const offline = page.getByRole("status", { name: "Can't reach the store system" });
  await expect(offline).toContainText("showing the figures from 21:42");
  await expect(offline).toContainText(
    "check the card machine's batch and the cash this system recorded",
  );
  await expect(sales).toContainText("Net sales$394.25");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/tonight-summary-offline-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  reachable = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(offline).toHaveCount(0);
  expect(reads).toBe(3);
});

test("@production in the evening Home reminds the manager what is still open and links to tonight", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
  await page.goto("/app");
  const reminder = page.getByRole("region", { name: "Before closing" });
  await expect(reminder).toContainText("Before closing: 2 tables not paid yet · $86.40");
  await expect(reminder).toContainText("Today's net taken $491.05");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await reminder.screenshot({ path: `test-results/closing-reminder-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await reminder.getByRole("link", { name: "See today's summary" }).click();
  await expect(page.getByRole("heading", { name: "Today's summary · Tue, Oct 27" })).toBeVisible();
});

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b39-2: the closing reminder names a table left open from an earlier day apart, in ${language}`, async ({
    page,
  }) => {
    // Review of b39: tonight's owed amount leaves out a table opened two weeks ago, but the
    // manager closing the day must still be told it is open and what to do.
    await workspace(page);
    if (language === "zh-Hans")
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          /* the page falls back to English */
        }
      });
    const fixture = tonightSummaryFixture();
    const forgotten = {
      tableLabel: "5",
      phase: "Closing",
      paymentTiming: "PayLater",
      owedMinor: "9596",
      openedMinutes: 21_563,
      standing: "Owes",
    };
    await page.route("**/merchant/reports/tonight", (route) =>
      route.fulfill({
        headers,
        json: {
          ...fixture,
          openTables: [...(fixture.openTables as unknown[]), forgotten],
          // The server's total of every open table, the earlier day's one included.
          openTablesOwedMinor: String(Number(fixture.openTablesOwedMinor) + 9596),
        },
      }),
    );
    await page.goto("/app");
    const reminder = page.getByRole("region", {
      name: language === "en" ? "Before closing" : "打烊前",
    });
    if (language === "en") {
      await expect(reminder).toContainText("Before closing: 2 tables not paid yet · $86.40");
      await expect(reminder).toContainText(
        "Also open from earlier days: 1 table · $95.96, not in today's figures. On Tables, take the payment or record that the guests left without paying, then close each one.",
      );
    } else {
      await expect(reminder).toContainText("$86.40");
      await expect(reminder).toContainText("较早营业日开的，还没关 · $95.96，不计入今天的数字");
      await expect(reminder).toContainText("请在“桌台”里收款或登记客人未付离开，然后逐桌关台。");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await reminder.screenshot({ path: `test-results/b39-2-closing-reminder-${language}-390.png` });
  });

test("@production a lunch-only Store: an unpaid table still surfaces after closing, and nothing else does", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: evening,
        lastOrdersAt: null,
        closesAt: "2026-10-27T18:30:00.000Z", // 14:30 in Toronto, seven hours ago.
        closedToday: false,
      },
    }),
  );
  let paid = false;
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({
      headers,
      json: paid
        ? { ...tonightSummaryFixture(), openTables: [], openTablesOwedMinor: "0" }
        : tonightSummaryFixture(),
    }),
  );
  await page.goto("/app");
  const reminder = page.getByRole("region", { name: "After closing" });
  await expect(reminder).toContainText("After closing: 2 tables not paid yet · $86.40");
  paid = true;
  await page.reload();
  // Read on this page's answer: once every table is paid the reminder has nothing to say.
  await expect.poll(async () => page.getByRole("region", { name: /closing/u }).count()).toBe(0);
});

// Batch 61 (v15 b60 live, TM2 at 390): "Paid, guests still seated · 4 tables" listed the table
// names on one unbreakable line beside the label, so the label was squeezed one letter wide
// (about 1,000 px tall) and the page scrolled sideways (scrollWidth 483 en / 502 zh-Hans).
for (const language of ["en", "zh-Hans"] as const) {
  test(`@production a row listing six tables wraps their names under its label (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          // The page still renders in English.
        }
      });
    await workspace(page);
    const fixture = tonightSummaryFixture();
    const names = [
      "L60P A (TEST)",
      "L60P B (TEST)",
      "Patio by the window (TEST)",
      "Booth by the door (TEST)",
      "Long banquet table (TEST)",
      "Private room east (TEST)",
    ];
    (fixture.openTables as Record<string, unknown>[]).push(
      ...names.map((tableLabel) => ({
        tableLabel,
        phase: "Active",
        paymentTiming: "PayLater",
        owedMinor: "0",
        openedMinutes: 40,
        standing: "Paid",
      })),
    );
    await page.route("**/merchant/reports/tonight", (route) =>
      route.fulfill({ headers, json: fixture }),
    );
    await page.goto("/app/reports/operations");
    const label = zh ? "已付清，客人还在座" : "Paid, guests still seated";
    const row = page.locator(".tonight__row", { hasText: label });
    await expect(row).toContainText(names[5] as string);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const shape = await row.evaluate((element) => {
        const dt = (element.querySelector("dt") as HTMLElement).getBoundingClientRect();
        const dd = (element.querySelector("dd") as HTMLElement).getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return {
          labelWidth: dt.width,
          labelHeight: dt.height,
          namesInside: dd.right <= box.right + 0.5 && dd.left >= box.left - 0.5,
          namesBelow: dd.top >= dt.bottom - 0.5,
          height: box.height,
        };
      });
      // The label keeps its words on one or two lines (it was one letter wide), and every name
      // stays inside the row; at a phone width they go under the label.
      expect(shape.labelWidth, JSON.stringify(shape)).toBeGreaterThan(140);
      expect(shape.labelHeight, JSON.stringify(shape)).toBeLessThan(60);
      expect(shape.namesInside, JSON.stringify(shape)).toBe(true);
      expect(shape.height, JSON.stringify(shape)).toBeLessThan(200);
      if (width === 390) expect(shape.namesBelow, JSON.stringify(shape)).toBe(true);
      await page.screenshot({
        path: `test-results/tonight-seated-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });
}

// Batch 62 (v15 b61 live, TM2 at 390): the six tables "Paid, guests still seated" wrapped as
// "…, C61 C" / "(TEST), C61 D (TEST), …": one table's name split across two lines, in English and
// in Chinese. Each name is measured where it is drawn: all of it on one line.
for (const language of ["en", "zh-Hans"] as const) {
  test(`@production a row listing tables never splits a table's name across lines (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          // The page still renders in English.
        }
      });
    await workspace(page);
    const fixture = tonightSummaryFixture();
    const names = [
      "S61 A (TEST)",
      "S61 B (TEST)",
      "C61 B (TEST)",
      "C61 C (TEST)",
      "C61 D (TEST)",
      "C61 E (TEST)",
    ];
    (fixture.openTables as Record<string, unknown>[]).push(
      ...names.map((tableLabel) => ({
        tableLabel,
        phase: "Active",
        paymentTiming: "PayLater",
        owedMinor: "0",
        openedMinutes: 40,
        standing: "Paid",
      })),
    );
    await page.route("**/merchant/reports/tonight", (route) =>
      route.fulfill({ headers, json: fixture }),
    );
    await page.goto("/app/reports/operations");
    const row = page.locator(".tonight__row", {
      hasText: zh ? "已付清，客人还在座" : "Paid, guests still seated",
    });
    await expect(row).toContainText(names[5] as string);
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const drawn = await row.locator("dd").evaluate((dd, listed) => {
        // Every text node of the names, and where each name starts and ends in them.
        const nodes: Text[] = [];
        const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
          nodes.push(node as Text);
        const text = nodes.map((node) => node.data).join("");
        const at = (offset: number): [Text, number] => {
          let left = offset;
          for (const node of nodes) {
            if (left <= node.data.length) return [node, left];
            left -= node.data.length;
          }
          throw new Error("offset");
        };
        const lineHeight = Number.parseFloat(getComputedStyle(dd).lineHeight) || 20;
        const tops = new Set<number>();
        const names = listed.map((name) => {
          const start = text.indexOf(name);
          if (start < 0) return { name, lines: 0 };
          const range = document.createRange();
          range.setStart(...at(start));
          range.setEnd(...at(start + name.length));
          const lines = new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.width > 0.5)
              .map((rect) => Math.round(rect.top / (lineHeight / 2))),
          );
          for (const line of lines) tops.add(line);
          return { name, lines: lines.size };
        });
        return { names, rows: tops.size };
      }, names);
      // Every name on one line; at a phone width they take more than one line between them.
      for (const name of drawn.names) expect(name.lines, `${name.name} at ${width}`).toBe(1);
      if (width === 390) expect(drawn.rows, JSON.stringify(drawn)).toBeGreaterThan(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/tonight-names-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });
}
