import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 47 (v15 batch 46 live check, Lane Dessert and Test Merchant 2 at 5:05 a.m. Sun Nov 22,
 * browser locale en-CA), with the reads v15 sent:
 * (1) the editor's zh sentences read "时间使用 北美东部时间（…）" and "日期使用 北美东部时间（…）";
 * (2) the withdrawal line was glued in English order, "它已被撤回 由你 11月16日 5:17", and in
 *     English "It was withdrawn by you Nov 16, 5:17 AM" while the page says "4:00 a.m.";
 * (3) the editor's time fields read "12:00:00 PM" (seconds, browser AM/PM), even in Chinese;
 * (4) "no orders after 11:34" broke from its "p.m." at 1024 and 1440;
 * (7) a special date next year read "Fri, Jan 1" with no year.
 * Layout checks keep about 40 px spare so Linux CI fonts (DejaVu) still fit.
 */
const store = "018f8100-0000-7000-8000-000000000047";
const scope = {
  brandLabel: "Lane Dessert",
  storeLabel: "Main",
  storeReference: store,
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const id = (n: number) => `018f9f47-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const viewer = id(10);
const dessert = {
  startLocalTime: "12:00:00",
  endLocalTime: "01:00:00",
  endsNextDay: true,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: 1800,
  leadTimeSeconds: 0,
};
const wholeDay = {
  startLocalTime: "00:00:00",
  endLocalTime: "23:59:59",
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
};
const week = (interval: typeof dessert, sunday = interval) =>
  Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [index === 6 ? sunday : interval],
  }));
const newYear = { localDate: "2027-01-01", kind: "Holiday", intervals: [] };
const at = "2026-10-01T04:00:00.000Z";
const configuration = (version: number, lifecycle: string) => ({
  configurationReference: id(version),
  brandReference: id(20),
  storeReference: store,
  configurationVersion: version,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(21),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(22),
  contactReference: id(23),
  receiptReference: id(24),
  taxConfigurationReference: id(25),
  paymentConfigurationReference: id(26),
  capacityConfigurationReference: null,
  enabledServiceModes: ["DineIn", "Pickup"],
  weeklySchedule: week(dessert),
  exceptions: [newYear],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: version === 1 ? null : id(1),
  reasonCode: version === 1 ? "PILOT_CONFIGURATION" : "STORE_HOURS_UPDATE",
  authoredByReference: viewer,
  approvedByReference: lifecycle === "Published" ? id(27) : null,
  approvalEvidenceReference: lifecycle === "Published" ? id(28) : null,
  publicationReference: lifecycle === "Published" ? id(29) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(30) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

async function open(
  page: Page,
  language: "en" | "zh-Hans",
  {
    weeklySchedule = week(dessert),
    withdrawal = true,
  }: { weeklySchedule?: ReturnType<typeof week>; withdrawal?: boolean } = {},
) {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    });
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
          businessDate: "2026-11-22",
          storeStatus: "Closed",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [],
        },
      },
    }),
  );
  await page.route("**/merchant/store-configuration", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        current: { ...configuration(1, "Published"), weeklySchedule },
        latest: withdrawal
          ? { ...configuration(2, "PendingApproval"), weeklySchedule }
          : { ...configuration(1, "Published"), weeklySchedule },
        expectedVersion: withdrawal ? 2 : 1,
        observedAt: "2026-11-22T10:09:00.000Z",
        viewerActorReference: viewer,
        // Withdrawn by the viewer at 5:17 a.m. Toronto on Mon Nov 16, as live.
        latestWithdrawal: withdrawal
          ? {
              kind: "Withdrawn",
              withdrawnAt: "2026-11-16T10:17:00.000Z",
              byYou: true,
              reason: null,
            }
          : null,
        latestAuthorName: null,
        soleOperator: null,
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({
      headers,
      json: {
        hours: {
          configurationSource: "StoreOverride",
          effectiveFrom: at,
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule,
          exceptions: [newYear],
        },
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        configurationReference: id(1),
        timeZone: "America/Toronto",
        enabledServiceModes: ["DineIn", "Pickup"],
        observedAt: "2026-11-22T10:09:00.000Z",
        expectedVersion: 3,
        activePauses: [],
      },
    }),
  );
  await page.goto("/app/organization/stores/" + store + "/service");
  await expect(page.locator("#published-hours-title")).toBeVisible();
}

const editor = (page: Page) =>
  page.locator("section[aria-labelledby='configuration-editor-title']");

async function openEditor(page: Page, zh: boolean) {
  await editor(page)
    .getByRole("button", { name: zh ? "编辑营业时间" : "Edit operating hours" })
    .click();
  await expect(editor(page).getByRole("group", { name: zh ? "星期一" : "Monday" })).toBeVisible();
}

for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  test.describe(`@production batch 47 hours editor and time style (${language})`, () => {
    test.use({ locale: "en-CA" });

    test("the editor's sentences, withdrawal line and time fields read like the rest of the page", async ({
      page,
    }) => {
      await open(page, language);
      await openEditor(page, zh);
      const text = await editor(page).innerText();
      if (zh) {
        expect(text).toContain(
          "时间使用北美东部时间（多伦多、渥太华和蒙特利尔）。营业日从 4:00 开始。",
        );
        expect(text).toContain("日期使用北美东部时间（多伦多、渥太华和蒙特利尔）。");
        expect(text).toContain("你已于 11月16日 5:17 撤回。下一项更改将基于已发布的营业时间。");
        expect(text).not.toContain("它已被");
      } else {
        expect(text).toContain(
          "Times are in Eastern Time (Toronto, Ottawa and Montréal). The business day starts at 4:00\u00a0a.m.",
        );
        expect(text).toContain(
          "You withdrew it on Nov 16, 5:17\u00a0a.m. The next change starts from the published hours.",
        );
        expect(text).not.toContain("AM");
      }
      // No browser time field: it shows seconds and the browser's own AM/PM in any language.
      await expect(editor(page).locator("input[type='time']")).toHaveCount(0);
      const monday = editor(page).getByRole("group", { name: zh ? "星期一" : "Monday" });
      const start = monday.getByRole("group", { name: zh ? "开始 1" : "Start 1", exact: true });
      const end = monday.getByRole("group", { name: zh ? "结束 1" : "End 1", exact: true });
      const shown = (group: typeof start) =>
        group
          .locator("select")
          .evaluateAll((selects) =>
            selects
              .map((select) => (select as HTMLSelectElement).selectedOptions[0]?.text)
              .join(" "),
          );
      expect(await shown(start)).toBe(zh ? "12 00" : "12 00 p.m.");
      expect(await shown(end)).toBe(zh ? "1 00" : "1 00 a.m.");
      expect(await start.innerText()).not.toMatch(/:\d\d:\d\d|PM|AM/u);
      // Keyboard: the hour is picked by typing it.
      const hour = start.getByRole("combobox", { name: zh ? "小时" : "Hour" });
      await hour.focus();
      // Typing picks an hour the same way on every platform (arrow keys open the list on macOS).
      await page.keyboard.type(zh ? "13" : "1");
      expect(await shown(start)).toBe(zh ? "13 00" : "1 00 p.m.");
      await expectNoInternalText(page);
    });

    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      test(`the open editor fits at ${width}, and a time never breaks from its a.m./p.m.`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        // Test Merchant 2: open 24 hours, Sunday orders stop at 11:34 p.m. (cut-off 1,500 s).
        await open(page, language, {
          weeklySchedule: week(wholeDay, { ...wholeDay, orderCutoffSeconds: 1500 }),
        });
        const sunday = page
          .locator("section[aria-labelledby='published-hours-title'] section")
          .filter({ has: page.getByRole("heading", { name: zh ? "星期日" : "Sunday" }) })
          .locator("li");
        await expect(sunday).toHaveText(
          zh
            ? "24 小时营业 · 堂食、自取 · 23:34 后停止点单"
            : "Open 24 hours · Dine-in, Pickup · no orders after 11:34\u00a0p.m.",
        );
        if (!zh) {
          // One line box holds "11:34 p.m." whatever the width.
          const lines = await sunday.evaluate((element) => {
            const node = [...element.childNodes].find((child) =>
              (child.textContent ?? "").includes("11:34"),
            );
            if (node === undefined) return -1;
            const text = node.textContent ?? "";
            const from = text.indexOf("11:34");
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, from + "11:34\u00a0p.m.".length);
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
          });
          expect(lines).toBe(1);
        }
        // The exception next year says its year.
        await expect(
          page.locator(
            "section[aria-labelledby='published-hours-title'] time[datetime='2027-01-01']",
          ),
        ).toHaveText(zh ? "2027年1月1日周五" : "Fri, Jan 1, 2027");
        await openEditor(page, zh);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // Each time control leaves room for wider Linux fonts inside its row.
        const spare = await editor(page)
          .getByRole("group", { name: zh ? "开始 1" : "Start 1", exact: true })
          .first()
          .evaluate((group) => {
            const row = group.getBoundingClientRect();
            const last = group.querySelector("select:last-of-type")?.getBoundingClientRect();
            const box = (group.closest("fieldset") ?? group).getBoundingClientRect();
            return last === undefined
              ? -1
              : Math.min(box.right, window.innerWidth) - Math.max(row.left, last.right);
          });
        expect(spare).toBeGreaterThanOrEqual(40);
        // Batch 47 review: the whole day ends at the end of the day, not at 11:59 p.m., and that
        // choice fits its row too.
        const end = editor(page)
          .getByRole("group", { name: zh ? "结束 1" : "End 1", exact: true })
          .first();
        await expect(end.locator("select")).toHaveCount(1);
        expect(
          await end
            .locator("select")
            .evaluate((select) => (select as HTMLSelectElement).selectedOptions[0]?.text),
        ).toBe(zh ? "24:00（当天结束）" : "Midnight (end of day)");
        const endSpare = await end.evaluate((group) => {
          const last = group.querySelector("select")?.getBoundingClientRect();
          const box = (group.closest("fieldset") ?? group).getBoundingClientRect();
          return last === undefined ? -1 : Math.min(box.right, window.innerWidth) - last.right;
        });
        expect(endSpare).toBeGreaterThanOrEqual(40);
        await page.screenshot({
          path: `test-results/b47-hours-editor-${language}-${width}.png`,
          fullPage: true,
        });
        if (width === 1440) {
          const axe = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          expect(
            axe.violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map((v) => v.id),
          ).toEqual([]);
        }
      });
    }
  });
}
