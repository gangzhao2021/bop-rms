import { expect, test, type Page } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import {
  headers,
  id,
  inLanguage,
  navigation,
  quietFrame,
  scope,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 65 (v15 batch 64 live check, merchant-stamp-time-tables-line), measured at 390, 1024 and
 * 1440 in English and Chinese. Synthetic HTTP interception, TEST-only data; every measurement keeps
 * room for Linux fonts (DejaVu Sans runs about 10% wider than the macOS system font).
 *
 * (1) The one "Updated hh:mm" / "已更新 hh:mm" stamp reaches the pages batch 64 missed: Table QR
 *     codes, Item availability and Counter order had none; Products and Prices said "Updated Wed,
 *     Nov 25 20:26" inside their line, Stock counts "Source as of Wed, Nov 25 20:26", and Reports'
 *     Stores tab had none. Each now shows it where the shell puts it: in the 1024 top bar, else in
 *     the page's heading.
 * (2) Tables on a phone: the stamp and Refresh beside the title squeezed the Store's name into a
 *     120 px column, 2 to 3 lines. The name now has the page's width and stays on one line where
 *     it fits with 40 px to spare; Refresh stays beside the title.
 */
// 20:26 in Toronto, as the v15 screenshots read.
const sourceAsOf = "2026-11-26T01:26:00.000Z";
const stampWords = (language: Language) =>
  language === "en" ? /^Updated \d\d:\d\d$/u : /^已更新 \d\d:\d\d$/u;
// For the design review: B65_SHOTS=<folder> keeps a picture of each page measured.
const shots = process.env.B65_SHOTS;
const shoot = async (page: Page, name: string) => {
  if (shots !== undefined)
    await page.screenshot({ path: `${shots}/${name.replace(/[^a-z0-9-]+/giu, "-")}.png` });
};
const stampAt = (language: Language) => (language === "en" ? "Updated 20:26" : "已更新 20:26");

const more = [
  ["DIN-TABLE-LIST", "Table QR codes", "/app/operations/tables", "dining.table.qr.manage"],
  ["CAT-AVAILABILITY", "Item availability", "/app/commerce/availability", "catalog.sku.read"],
  ["PRICE-BOOK-LIST", "Prices", "/app/commerce/pricing", "pricing.price_book.read"],
  ["INV-COUNT-LIST", "Stock counts", "/operations/inventory/counts", "inventory.count.read"],
].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

const second = {
  ...scope,
  storeLabel: "Test Merchant 2 North (TEST)",
  storeReference: id(98),
};

async function frame(
  page: Page,
  language: Language,
  selected: Record<string, unknown> = scope,
  stores: readonly Record<string, unknown>[] = [selected],
) {
  await inLanguage(page, language);
  await quietFrame(page);
  const base = session();
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        ...base,
        workspace: {
          ...base.workspace,
          selectedScope: selected,
          authorizedStores: stores,
          navigation: [...navigation, ...more],
        },
      },
    }),
  );
}

// --- Table QR codes (DIN-TABLE-LIST) ------------------------------------------------------------
async function tableQr(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/dining/table-qr", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            tableReference: id(501),
            stableLabel: "T1",
            areaCode: "MAIN",
            aggregateVersion: 3,
            seated: false,
            codeState: "Active",
            issuedAt: "2026-11-01T15:00:00.000Z",
            validUntil: "2027-04-12T13:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.goto("/app/operations/tables");
  await expect(page.locator("main.table-qr-page")).toBeVisible();
  await expect(page.getByText("T1", { exact: true })).toBeVisible();
}

// --- Item availability (CAT-AVAILABILITY) -------------------------------------------------------
async function availability(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf,
        viewer: id(50),
        timeZone: scope.timeZone,
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [
          {
            skuReference: id(30),
            skuCode: "SKU_30",
            productName: "Beef noodles (TEST)",
            sizeName: "Beef noodles (TEST)",
            status: "Available",
            soldOutUntil: null,
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/availability");
  await expect(page.getByText("Beef noodles (TEST)").first()).toBeVisible();
}

// --- Counter order (OPS-ORDER-ENTRY) ------------------------------------------------------------
const dish = (n: number, name: string, amount: string) => ({
  sellableReference: id(n),
  productVersionReference: id(n + 1),
  name,
  presentationRole: "Standard",
  pinned: false,
  availability: "Available",
  optionRules: [],
  allergenDisclosure: {},
  displayPrice: { status: "Available", amount, currency: "CAD", reason: null },
  taxDisplayContext: {},
});
async function counter(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/counter/menu**", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-ENTRY",
        menu: {
          status: "Found",
          schemaVersion: 1,
          projection: {},
          scope: {},
          menu: {
            menuReference: id(1),
            menuVersionReference: id(2),
            releaseReference: id(3),
            locale: language === "en" ? "en-CA" : "zh-CN",
            name: "Pickup menu",
            effectiveFrom: "2026-10-01T00:00:00.000Z",
            effectiveUntil: null,
            sections: [
              {
                sectionReference: id(10),
                name: "Noodles (TEST)",
                sellables: [dish(20, "Beef noodles (TEST)", "12.50")],
              },
            ],
          },
        },
      },
    }),
  );
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.goto("/operations/order-entry");
  await expect(page.getByText("Beef noodles (TEST)").first()).toBeVisible();
}

// --- Products (CAT-PRODUCT-LIST) ----------------------------------------------------------------
async function products(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/commerce/products/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-PRODUCT-LIST",
        sourceAsOf,
        permissions: { mayCreate: true },
        taxClasses: [],
        productTypes: [],
        products: [],
      },
    }),
  );
  await page.goto("/app/commerce/products");
  await expect(page.locator("main .screen-heading h2")).toBeVisible();
}

// --- Prices (PRICE-BOOK-LIST) -------------------------------------------------------------------
async function prices(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/commerce/pricing/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PRICE-BOOK-LIST",
        sourceAsOf,
        viewer: id(50),
        permissions: { mayRead: true, mayEdit: true, mayApprove: true },
        currencyCode: "CAD",
        storeAssignment: null,
        assignmentHistory: [],
        sellables: [],
        menuSellables: [],
        soleOperator: null,
        books: [],
      },
    }),
  );
  await page.goto("/app/commerce/pricing");
  await expect(page.locator("main .screen-heading h2")).toBeVisible();
}

// --- Stock counts (INV-COUNT-LIST) --------------------------------------------------------------
async function stockCounts(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/supply/counts/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-LIST",
        sourceAsOf,
        viewer: id(50),
        permissions: { mayCreate: true, mayCount: true, mayApprove: true },
        varianceReasons: ["UNRECORDED_WASTE", "COUNTING_ERROR"],
        items: [],
        locations: [{ locationReference: id(31), code: "MAIN", name: "Main storage" }],
        staff: [{ actorReference: id(50), label: "You" }],
        people: [],
        hasMore: false,
        counts: [],
      },
    }),
  );
  await page.goto("/operations/inventory/counts");
  await expect(page.locator("main .screen-heading h2")).toBeVisible();
}

// --- Reports → Stores (RPT-OPS-DASHBOARD, a Brand with two Stores) ------------------------------
async function reportsStores(page: Page, language: Language) {
  await frame(page, language, scope, [scope, second]);
  const summary = tonightSummaryFixture() as { report: { generatedAt: string } };
  // The two Stores were read a minute apart; the stamp says the older read.
  const older = { ...summary, report: { ...summary.report, generatedAt: sourceAsOf } };
  const newer = {
    ...summary,
    report: { ...summary.report, generatedAt: "2026-11-26T01:27:00.000Z" },
  };
  await page.clock.setFixedTime(new Date("2026-11-26T01:28:00.000Z"));
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: newer }),
  );
  await page.route("**/merchant/reports/stores/*/tonight", (route) =>
    route.fulfill({
      headers,
      json: route.request().url().includes(second.storeReference) ? older : newer,
    }),
  );
  await page.goto("/app/reports/operations");
  await page.getByRole("button", { name: language === "en" ? "Stores" : "门店" }).click();
  await expect(page.locator(".brand-stores__table")).toBeVisible();
  await expect(page.locator(".brand-stores__table tbody tr")).toHaveCount(2);
}

const pages = [
  { name: "Table QR codes", open: tableQr, at: false },
  { name: "Item availability", open: availability, at: true },
  { name: "Counter order", open: counter, at: false },
  { name: "Products", open: products, at: true },
  { name: "Prices", open: prices, at: true },
  { name: "Stock counts", open: stockCounts, at: true },
  { name: "Reports' Stores tab", open: reportsStores, at: true },
] as const;

/** Every visible element whose own words are a stamp, and where it sits. */
const stampsOn = (page: Page, words: RegExp) =>
  page.evaluate((source) => {
    const pattern = new RegExp(source, "u");
    return [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        if (!pattern.test(node.textContent?.trim() ?? "")) return false;
        return ![...node.children].some((child) => pattern.test(child.textContent?.trim() ?? ""));
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: node.textContent?.trim() ?? "",
          inBar: node.closest(".workspace-sidebar__status") !== null,
          inHeading: node.closest("main :is(.workspace-page__header, .screen-heading)") !== null,
          height: rect.height,
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5,
        };
      });
  }, words.source);

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    for (const screen of pages)
      test(`@production B65 (1) ${screen.name} shows one "Updated hh:mm" where the shell puts it, ${language} at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.open(page, language);
        const words = stampWords(language);
        await expect
          .poll(async () => (await stampsOn(page, words)).length, { timeout: 8_000 })
          .toBe(1);
        await shoot(page, `${screen.name}-${language}-${String(width)}`);
        const [stamp] = await stampsOn(page, words);
        if (stamp === undefined) throw new Error("no stamp");
        // The time the page's data was read, on the Store's 24-hour clock.
        if (screen.at) expect(stamp.text).toBe(stampAt(language));
        // 1024: in the top bar beside the language switch (Figma 58:65); else in the page heading.
        expect(stamp).toMatchObject(width === 1024 ? { inBar: true } : { inHeading: true });
        // One line, never squeezed into two.
        expect(stamp.height).toBeLessThan(stamp.lineHeight * 1.6);
        // The body no longer says when it was read in its own words.
        const main = await page.evaluate(() => document.querySelector("main")?.textContent ?? "");
        expect(main).not.toMatch(
          /Source as of|数据截至|Checked \d|已检查 \d|Updated [A-Z][a-z]{2},/u,
        );
        // In the heading the stamp never runs into the heading's words: 8px clear, or another line.
        if (width !== 1024) {
          const clear = await page.evaluate((source) => {
            const pattern = new RegExp(source, "u");
            const heading = document.querySelector(
              "main :is(.workspace-page__title h1, .screen-heading h2)",
            );
            const said = [
              ...document.querySelectorAll("main :is(.workspace-page__header, .screen-heading) *"),
            ].find(
              (node) =>
                pattern.test(node.textContent?.trim() ?? "") &&
                ![...node.children].some((child) => pattern.test(child.textContent?.trim() ?? "")),
            );
            if (!heading || !said) return false;
            const range = document.createRange();
            range.selectNodeContents(heading);
            const a = range.getBoundingClientRect();
            const b = said.getBoundingClientRect();
            return b.top >= a.bottom || b.bottom <= a.top || b.left - a.right >= 8;
          }, words.source);
          expect(clear).toBe(true);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });

// --- (2) Tables on a phone ----------------------------------------------------------------------
const longName = { ...scope, storeLabel: "Test Merchant 2 Main - not production" };
async function tables(page: Page, language: Language) {
  await frame(page, language, longName);
  const table = (n: number, extra: Record<string, unknown> = {}) => ({
    tableReference: id(500 + n),
    stableLabel: "T" + String(n),
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: null,
    elapsedMinutes: null,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayFirst",
    ...extra,
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        items: [
          table(1, {
            currentDiningSessionReference: id(601),
            elapsedMinutes: 12,
            session: { phase: "Active", version: 2, orderReference: null },
          }),
          table(2),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  await expect(page.locator(".dining-floor-summary")).toBeVisible();
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production B65 (2) Tables keeps the Store's name on one line and Refresh beside the title, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await tables(page, language);
      const words = stampWords(language);
      await expect
        .poll(async () => (await stampsOn(page, words)).length, { timeout: 8_000 })
        .toBe(1);
      await shoot(page, `tables-${language}-${String(width)}`);
      const measured = await page.evaluate(() => {
        const header = document.querySelector("main .workspace-page__header");
        const meta = document.querySelector("main .workspace-page__meta");
        if (!header || !meta) return null;
        // The name's own width on one line, and the lines it takes on the page.
        const probe = meta.cloneNode(true) as HTMLElement;
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:auto";
        header.appendChild(probe);
        const natural = probe.getBoundingClientRect().width;
        probe.remove();
        const range = document.createRange();
        range.selectNodeContents(meta);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        const style = getComputedStyle(header);
        const room =
          header.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return { natural, room, lines: tops.size };
      });
      if (measured === null) throw new Error("no header");
      // The fixture's name fits the page's width with 40 px to spare (Linux fonts included)...
      expect(measured.room - measured.natural).toBeGreaterThanOrEqual(40);
      // ...so it is on one line, never squeezed into a column beside the stamp and Refresh.
      expect(measured.lines).toBe(1);
      const title = await page.locator("main .workspace-page__title h1").boundingBox();
      const refresh = await page
        .getByRole("button", { name: language === "en" ? "Refresh tables" : "刷新桌台" })
        .boundingBox();
      if (title === null || refresh === null) throw new Error("not on screen");
      // Refresh stays on the title's row.
      expect(refresh.y).toBeLessThan(title.y + title.height);
      expect(refresh.y + refresh.height).toBeGreaterThan(title.y);
      const meta = await page.locator("main .workspace-page__meta").boundingBox();
      if (meta === null) throw new Error("no name");
      // The name sits under the title, never beside it.
      expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });

// Found while stamping the Stores tab: on a phone its eight columns ran 226 px past the window.
for (const language of ["en", "zh-Hans"] as const)
  test(`@production B65 (1b) Reports' Stores tab reads one Store a block on a phone, ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await reportsStores(page, language);
    const layout = await page.evaluate(() => {
      const heading = document.querySelector("#brand-stores")?.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".brand-stores__table tr")]
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.height > 0);
      const name = document.querySelector(".brand-stores__table tbody th");
      const words = document.createRange();
      if (name?.firstChild) words.selectNodeContents(name.firstChild);
      return {
        nameLeft: words.getBoundingClientRect().left,
        left: heading?.left ?? -1,
        right: heading?.right ?? -1,
        rows: rows.map((rect) => ({ left: rect.left, right: rect.right })),
        nameColor: name ? getComputedStyle(name).color : "",
        textColor: getComputedStyle(document.body).color,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.rows.length).toBeGreaterThanOrEqual(3);
    // Each Store's block starts where the page's words do and ends inside the window.
    for (const row of layout.rows) {
      expect(Math.abs(row.left - layout.left)).toBeLessThanOrEqual(1);
      expect(row.right).toBeLessThanOrEqual(390);
    }
    expect(Math.abs(layout.nameLeft - layout.left)).toBeLessThanOrEqual(1);
    // The Store's name is dark words, as the names on Orders are.
    expect(layout.nameColor).toBe(layout.textColor);
  });
