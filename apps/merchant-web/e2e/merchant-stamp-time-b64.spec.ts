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
 * Batch 64 (v15 batch 63 live check, merchant-shell-orders), measured at 390, 1024 and 1440 in
 * English and Chinese. Synthetic HTTP interception, TEST-only data; every measurement keeps room
 * for Linux fonts (DejaVu Sans runs about 10% wider than the macOS system font).
 *
 * (1) Every staff page that reads data shows the one "Updated 14:02" / "已更新 14:02" stamp where
 *     the shell puts it: in the 1024 top bar, else in the page header. v15 had none on Orders at
 *     390, on Tables and Reports at any width, and on Menus, Shared tablets & PINs and Points.
 * (2) Staff screens write the Store's 24-hour clock: Hours & ordering said "Updated 12:32 p.m.".
 * (3) Tables at 1024: the status line wrapped under "Refresh tables", its second line began with a
 *     leftover "·" and Refresh dropped to a row of its own.
 */
const store = scope.storeReference;
const at = () => new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
const stampWords = (language: Language) =>
  language === "en" ? /^Updated \d\d:\d\d$/u : /^已更新 \d\d:\d\d$/u;

const more = [
  [
    "IAM-SESSION-LIST",
    "Shared tablets & PINs",
    "/app/organization/sessions",
    "identity.store_device.manage",
  ],
].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

async function frame(page: Page, language: Language) {
  await inLanguage(page, language);
  await quietFrame(page);
  const base = session();
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: { ...base, workspace: { ...base.workspace, navigation: [...navigation, ...more] } },
    }),
  );
}

// --- Orders (OPS-ORDER-QUEUE) ------------------------------------------------------------------
async function orders(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/orders/changes", (route) =>
    route.fulfill({ headers, json: { schemaVersion: 1, mark: "1".padStart(32, "0") } }),
  );
  const item = {
    orderReference: id(80),
    orderNumber: "80",
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: at(),
    observedAt: at(),
    initialBatchReference: id(280),
    batches: [
      {
        orderBatchReference: id(280),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Accepted",
    currentVersion: 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    paidOnline: { amountMinor: "1413", currencyCode: "CAD" },
    summary: {
      items: [{ name: "Beef noodles (TEST)", option: null, quantity: 1 }],
      lineCount: 1,
      pickupName: "TEST Guest",
      tableLabel: null,
    },
  };
  for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
    await page.route(pattern, (route) =>
      route.fulfill({ headers, json: { items: [item], nextAfterOrderReference: null } }),
    );
  await page.goto("/operations/orders");
  await expect(page.locator("li.order-row").first()).toBeVisible();
}

// --- Tables (DIN-FLOOR-BOARD): seated tables, warnings and the guest-start pause -------------
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
async function tables(page: Page, language: Language) {
  await frame(page, language);
  const soon = new Date(Date.now() + 7 * 60_000).toISOString();
  const seated = (n: number, minutes: number, closes?: string) =>
    table(n, {
      currentDiningSessionReference: id(600 + n),
      elapsedMinutes: minutes,
      session: { phase: "Active", version: 2, orderReference: null },
      ...(closes ? { guestStart: { closesByItselfAt: closes } } : {}),
    });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        guestTableStart: { version: 4, canTurnOff: true, startsBusy: true },
        items: [seated(1, 3, soon), seated(2, 15, soon), seated(3, 60 * 30), table(4)],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  await expect(page.locator(".dining-floor-summary")).toBeVisible();
}

// --- Reports (RPT-OPS-DASHBOARD): the page opens on today's summary ----------------------------
async function reports(page: Page, language: Language) {
  await frame(page, language);
  const summary = tonightSummaryFixture() as { report: { generatedAt: string } };
  await page.clock.setFixedTime(new Date(Date.parse(summary.report.generatedAt) + 60_000));
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: summary }),
  );
  await page.goto("/app/reports/operations");
  await expect(page.locator(".tonight")).toBeVisible();
}

// --- Menus (CAT-MENU-LIST, one Store's one menu) ------------------------------------------------
const menuPermissions = {
  mayRead: true,
  mayEdit: true,
  maySubmit: true,
  mayApprove: true,
  mayPublish: true,
};
const builder = () => ({
  screenId: "CAT-MENU-BUILDER",
  sourceAsOf: at(),
  viewer: id(50),
  permissions: menuPermissions,
  menus: [],
  menu: {
    menuReference: id(1),
    internalCode: "MAIN",
    aggregateVersion: 3,
    versionReference: id(2),
    name: "TEST menu",
    storeReferences: [store],
    channelCodes: ["CUSTOMER_PWA"],
    orderTypeCodes: ["DINE_IN"],
    sections: [
      {
        sectionReference: id(10),
        code: "NOODLE",
        name: "Noodles (TEST)",
        nameZh: "面",
        items: [{ placementReference: id(230), skuReference: id(30), featured: false }],
      },
    ],
  },
  publication: null,
  latestRelease: null,
  listingStep: "Listed",
  submittedBy: null,
  soleOperator: null,
  sellables: [
    {
      skuReference: id(30),
      skuCode: "SKU_30",
      productName: "Beef noodles (TEST)",
      productNameZh: "牛肉面",
      sizeName: "Beef noodles (TEST)",
      active: true,
      priceMinor: "1250",
      offeredHere: true,
    },
  ],
  mayOfferHere: true,
  allergenRegistry: false,
  customerView: null,
});
async function menus(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/commerce/one-store-combos/query", (route) =>
    route.fulfill({ headers, json: { combos: [] } }),
  );
  await page.route("**/merchant/commerce/menus/query", (route) => {
    const body = route.request().postDataJSON() as { menuReference: string | null };
    if (body.menuReference !== null) return route.fulfill({ headers, json: builder() });
    return route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-LIST",
        sourceAsOf: at(),
        viewer: id(50),
        permissions: menuPermissions,
        menus: [
          {
            menuReference: id(1),
            internalCode: "MAIN",
            aggregateVersion: 3,
            currentVersionReference: id(2),
            localizedNames: { "en-CA": "TEST menu" },
            placements: 1,
            publication: null,
            latestRelease: null,
          },
        ],
      },
    });
  });
  await page.route("**/merchant/commerce/availability/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-AVAILABILITY",
        sourceAsOf: at(),
        viewer: id(50),
        timeZone: scope.timeZone,
        permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
        items: [
          {
            skuReference: id(30),
            skuCode: "SKU_30",
            productName: "x",
            sizeName: "x",
            status: "Available",
            soldOutUntil: null,
          },
        ],
      },
    }),
  );
  await page.goto("/app/commerce/menus");
  await expect(page.locator("main.one-menu")).toBeVisible();
}

// --- Shared tablets & PINs (IAM-SESSION-LIST) ---------------------------------------------------
async function sharedTablets(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/staff-pin", (route) =>
    route.fulfill({
      headers,
      json: {
        pin: { state: "Set", changedAt: "2026-10-01T15:00:00.000Z", lockedUntil: null },
        signIn: "Account",
        verifiedUntil: null,
      },
    }),
  );
  await page.route("**/merchant/store-devices", (route) =>
    route.fulfill({
      headers,
      json: {
        thisDevice: null,
        devices: [
          {
            device: "dev-front",
            label: "Front counter (TEST)",
            registeredAt: "2026-11-02T14:00:00.000Z",
            registeredBy: "You",
            lastUsedAt: "2026-11-24T21:10:00.000Z",
          },
        ],
        staffPins: [],
      },
    }),
  );
  await page.goto("/app/organization/sessions");
  await expect(page.getByText("Front counter (TEST)")).toBeVisible();
}

// --- Points (LOY-PROGRAM-LIST) ------------------------------------------------------------------
async function points(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/member-points", (route) =>
    route.fulfill({
      headers,
      json: {
        canManage: true,
        dishChoices: [],
        offeredHere: true,
        rule: {
          version: 0,
          earnPointsPerDollar: 3,
          redeemPointsPerDollar: 100,
          minimumRedemptionPoints: 300,
          redemptionIncrementPoints: 100,
          inactivityExpiryDays: 548,
          expiryNoticeDays: 30,
          rewards: [],
        },
        members: [],
        report: {
          members: 0,
          issuedPoints: 0,
          usedPoints: 0,
          returnedPoints: 0,
          reversedPoints: 0,
          expiredPoints: 0,
          forfeitedPoints: 0,
          outstandingPoints: 0,
          owedPoints: 0,
          usedValueMinor: "0",
        },
      },
    }),
  );
  await page.goto("/app/customers/loyalty-programs");
  await expect(page.locator(".member-points")).toBeVisible();
}

// --- Hours & ordering (STORE-HOURS-SERVICE): read at 05:09 Toronto ------------------------------
const lunch = {
  startLocalTime: "11:00:00",
  endLocalTime: "21:30:00",
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
};
const week = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({ isoWeekday, intervals: [lunch] }));
async function hours(page: Page, language: Language) {
  await frame(page, language);
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({
      headers,
      json: {
        hours: {
          configurationSource: "StoreOverride",
          effectiveFrom: "2026-11-01T09:00:00.000Z",
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: week,
          exceptions: [],
        },
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        configurationReference: id(1),
        timeZone: scope.timeZone,
        enabledServiceModes: ["DineIn", "Pickup"],
        observedAt: "2026-11-22T10:09:00.000Z",
        expectedVersion: 3,
        activePauses: [],
      },
    }),
  );
  await page.goto(`/app/organization/stores/${store}/service`);
  await expect(page.locator("#published-hours-title")).toBeVisible();
}

const pages = [
  { name: "Orders", open: orders },
  { name: "Tables", open: tables },
  { name: "Reports", open: reports },
  { name: "Menus", open: menus },
  { name: "Shared tablets & PINs", open: sharedTablets },
  { name: "Points", open: points },
  { name: "Hours & ordering", open: hours },
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
        // The innermost element saying it.
        return ![...node.children].some((child) => pattern.test(child.textContent?.trim() ?? ""));
      })
      .map((node) => ({
        text: node.textContent?.trim() ?? "",
        inBar: node.closest(".workspace-sidebar__status") !== null,
        inHeader: node.closest("main .workspace-page__header") !== null,
      }));
  }, words.source);

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    for (const screen of pages)
      test(`@production B64 (1) ${screen.name} shows one "Updated hh:mm" where the shell puts it, ${language} at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.open(page, language);
        const words = stampWords(language);
        await expect
          .poll(async () => (await stampsOn(page, words)).length, { timeout: 8_000 })
          .toBe(1);
        const [stamp] = await stampsOn(page, words);
        // 1024: in the top bar beside the language switch (Figma 58:65); else in the page header.
        expect(stamp).toMatchObject(width === 1024 ? { inBar: true } : { inHeader: true });
        // (2) The staff clock: "Updated 05:09", never "5:09 a.m." or "AM".
        expect(
          await page.evaluate(() => document.querySelector("main")?.textContent ?? ""),
        ).not.toMatch(/\d\s?(?:[ap]\.m\.|[AP]M)\b/u);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production B64 (2) Hours & ordering says its stamp and hours on the 24-hour clock, ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await hours(page, language);
    const header = page.locator("main .workspace-page__header");
    await expect(header).toContainText(language === "en" ? "Updated 05:09" : "已更新 05:09");
    await expect(page.locator(".hours-page__period").first()).toContainText("11:00–21:30");
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production B64 (1) Reports says when today's figures were read in the stamp only, ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await reports(page, language);
    const head = page.locator(".tonight__head");
    await expect(head).toContainText(language === "en" ? "Open now" : "营业中");
    await expect(head).not.toContainText(language === "en" ? "as of" : "截至");
  });

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production B64 (3) Tables keeps Refresh beside its title and never starts a line with "·", ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await tables(page, language);
      const title = await page.locator("main .workspace-page__title h1").boundingBox();
      const refresh = await page
        .getByRole("button", { name: language === "en" ? "Refresh tables" : "刷新桌台" })
        .boundingBox();
      if (title === null || refresh === null) throw new Error("not on screen");
      // Refresh sits on the title's row, never on a row of its own under the status line.
      expect(refresh.y).toBeLessThan(title.y + title.height);
      expect(refresh.y + refresh.height).toBeGreaterThan(title.y);
      // The status line is under the title row, across the page.
      const line = page.locator("main .workspace-page__header .workspace-page__status--line");
      await expect(line).toBeVisible();
      const parts = await line.evaluate((node) => {
        const edge = node.getBoundingClientRect().left;
        const style = getComputedStyle(node);
        const summary = node.querySelector(".dining-floor-summary");
        return {
          edge,
          clip: style.overflowX,
          clipMargin: parseFloat(style.getPropertyValue("overflow-clip-margin") || "0"),
          parts: [...(summary?.children ?? [])].map((child) => {
            const rect = child.getBoundingClientRect();
            const dot = getComputedStyle(child, "::before");
            return {
              left: rect.left,
              top: rect.top,
              bottom: rect.bottom,
              dot: dot.content,
              dotWidth: parseFloat(dot.width),
            };
          }),
        };
      });
      expect(parts.clip).toBe("clip");
      expect(parts.clipMargin).toBeLessThanOrEqual(6);
      expect(parts.parts.length).toBeGreaterThanOrEqual(4);
      // Two parts share a line when their boxes overlap vertically (a part with a 44px button
      // is taller than a line of words).
      const sameLine = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
      const starts = parts.parts.filter(
        (part) => !parts.parts.some((other) => sameLine(other, part) && other.left < part.left - 1),
      );
      // The fixture's line wraps in English at every width here, and in Chinese on a phone.
      if (language === "en" || width === 390) expect(starts.length).toBeGreaterThanOrEqual(2);
      for (const part of parts.parts) {
        // Each part brings its "·" in a gutter before its words. One that starts a line has the
        // whole gutter outside the line's edge (clipped), so a line never begins with "·", and its
        // words start at the edge, never under the clip.
        expect(part.dot).toBe('"·"');
        if (starts.includes(part)) {
          expect(part.left + part.dotWidth).toBeLessThanOrEqual(parts.edge + 0.5);
          expect(part.left + part.dotWidth).toBeGreaterThanOrEqual(parts.edge - 0.5);
        } else expect(part.left).toBeGreaterThan(parts.edge);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });
