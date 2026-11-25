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
    declined = false,
    openChange,
    service = "Published",
    draftTimeZone,
  }: {
    weeklySchedule?: ReturnType<typeof week>;
    withdrawal?: boolean;
    /** Batch 48: the latest change was declined by someone else, not withdrawn by you. */
    declined?: boolean;
    /** Batch 48: an open change (no withdrawal), yours or someone else's. */
    openChange?: { lifecycle: "PendingApproval" | "Approved"; yours: boolean };
    /** Batch 51: how the service-status read ends (Published hours is drawn only from it). */
    service?: ServiceState;
    /** Batch 51: the open change moves the Store to another time zone. */
    draftTimeZone?: string;
  } = {},
) {
  // Batch 64: a date of this year is written without its year; the page reads as at the read.
  await page.clock.setFixedTime(new Date("2026-11-22T10:11:00.000Z"));
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
        // Batch 51: nothing published yet, as v15 reads a Store whose first hours are a draft.
        current:
          service === "NotPublished" ? null : { ...configuration(1, "Published"), weeklySchedule },
        latest: openChange
          ? {
              ...configuration(2, openChange.lifecycle),
              weeklySchedule,
              authoredByReference: openChange.yours ? viewer : id(31),
              ...(draftTimeZone ? { timeZone: draftTimeZone } : {}),
            }
          : withdrawal
            ? { ...configuration(2, "PendingApproval"), weeklySchedule }
            : { ...configuration(1, "Published"), weeklySchedule },
        expectedVersion: withdrawal || openChange ? 2 : 1,
        observedAt: "2026-11-22T10:09:00.000Z",
        viewerActorReference: viewer,
        // Withdrawn by the viewer at 5:17 a.m. Toronto on Mon Nov 16, as live.
        latestWithdrawal:
          withdrawal && !openChange
            ? {
                kind: declined ? "Declined" : "Withdrawn",
                withdrawnAt: "2026-11-16T10:17:00.000Z",
                byYou: !declined,
                reason: null,
              }
            : null,
        viewerMayApprove: true,
        viewerMayDecline: true,
        latestAuthorName: null,
        soleOperator: null,
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) => {
    // Batch 51 (v15 b50 live): the read is cut off (outage), never answers while the page is
    // looked at (still loading), or is refused because nothing is published yet.
    if (service === "Outage") return route.abort();
    // Left unanswered: the read is still loading.
    if (service === "Loading") return;
    if (service === "NotPublished")
      return route.fulfill({
        status: 503,
        headers,
        json: { error: "Service request unavailable." },
      });
    return route.fulfill({
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
    });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  if (service === "Published") await expect(page.locator("#published-hours-title")).toBeVisible();
  else
    await expect(
      page.locator("section[aria-labelledby='service-controls-title'] [role='status']"),
    ).toHaveText(
      service === "Loading"
        ? language === "zh-Hans"
          ? "正在加载服务状态…"
          : "Loading service status…"
        : language === "zh-Hans"
          ? "无法加载当前服务状态。请检查网络后刷新。"
          : "Unable to load current service status. Check your connection and refresh.",
    );
}
type ServiceState = "Published" | "Outage" | "Loading" | "NotPublished";

const editor = (page: Page) =>
  page.locator("section[aria-labelledby='configuration-editor-title']");

async function openEditor(page: Page, zh: boolean) {
  // Batch 63 F54: "Edit hours" sits on Opening hours (or in the editor while hours can't be read).
  await page
    .getByRole("button", { name: zh ? "修改营业时间" : "Edit hours" })
    .first()
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
        // Batch 49: the time zone and day start are said under Published hours, not again here.
        expect(text).not.toContain("时间使用");
        // Batch 50: nor again in the special dates part.
        expect(text).not.toContain("日期使用");
        expect(text).toContain("没有时段的例外表示当天停业。");
        expect(text).toContain(
          "你已于 11月16日周一 05:17 撤回你的更改。下一项更改将基于已发布的营业时间。",
        );
        expect(text).not.toContain("它已被");
      } else {
        // Batch 49: the time zone and day start are said under Published hours, not again here.
        expect(text).not.toContain("Times are in");
        expect(text).toContain(
          "You withdrew your change on Mon, Nov 16 05:17. The next change starts from the published hours.",
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
      // Batch 64: the staff clock, 00–23, in English as in Chinese.
      expect(await shown(start)).toBe("12 00");
      expect(await shown(end)).toBe("01 00");
      expect(await start.innerText()).not.toMatch(/:\d\d:\d\d|PM|AM/u);
      // Keyboard: the hour is picked by typing it.
      const hour = start.getByRole("combobox", { name: zh ? "小时" : "Hour" });
      await hour.focus();
      // Typing picks an hour the same way on every platform (arrow keys open the list on macOS).
      await page.keyboard.type("13");
      expect(await shown(start)).toBe("13 00");
      await expectNoInternalText(page);
    });

    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      test(`the open editor fits at ${width}, and a time stays whole on its line`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        // Test Merchant 2: open 24 hours, Sunday orders stop at 23:34 (cut-off 1,500 s).
        await open(page, language, {
          weeklySchedule: week(wholeDay, { ...wholeDay, orderCutoffSeconds: 1500 }),
        });
        // Batch 63 F54: a row a day (was a block per day with its periods in a list).
        const sunday = page
          .locator("section[aria-labelledby='published-hours-title'] .hours-page__row")
          .filter({ has: page.locator("dt", { hasText: zh ? "星期日" : "Sunday" }) })
          .locator(".hours-page__period");
        await expect(sunday).toHaveText(
          zh
            ? "24 小时营业 · 堂食、自取 · 23:34 后停止点单"
            : "Open 24 hours · Dine-in, Pickup · no orders after 23:34",
        );
        {
          // One line box holds "23:34" whatever the width.
          const lines = await sunday.evaluate((element) => {
            const node = [...element.childNodes].find((child) =>
              (child.textContent ?? "").includes("23:34"),
            );
            if (node === undefined) return -1;
            const text = node.textContent ?? "";
            const from = text.indexOf("23:34");
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, from + "23:34".length);
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

    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      test(`batch 48: start and end times are the same width, and the withdrawal is said once, at ${width}`, async ({
        page,
      }) => {
        // v15 b47 live (Lane Dessert, 12:00 p.m.–1:00 a.m., withdrawn by the viewer Nov 16): the
        // end Hour select was sized to its "Midnight (end of day)" choice (168 px en, 151 px zh,
        // against 36–39 px), and "Latest change: Withdrawn by the person who made it" stood above
        // "You withdrew it on Nov 16, 5:17 a.m.".
        await page.setViewportSize({ width, height });
        await open(page, language);
        await openEditor(page, zh);
        const monday = editor(page).getByRole("group", { name: zh ? "星期一" : "Monday" });
        const field = (name: string) =>
          monday.getByRole("group", { name, exact: true }).getByRole("combobox", {
            name: zh ? "小时" : "Hour",
          });
        const startHour = await field(zh ? "开始 1" : "Start 1").boundingBox();
        const endHour = await field(zh ? "结束 1" : "End 1").boundingBox();
        expect(startHour).not.toBeNull();
        expect(endHour).not.toBeNull();
        expect(Math.abs((endHour?.width ?? 0) - (startHour?.width ?? 0))).toBeLessThanOrEqual(1);
        expect(endHour?.width ?? 999).toBeLessThanOrEqual(72);
        // The end of the day is still offered, by its whole name.
        await expect(
          field(zh ? "结束 1" : "End 1").locator("option", {
            hasText: zh ? "24:00（当天结束）" : "Midnight (end of day)",
          }),
        ).toHaveCount(1);
        // Said once, as one whole sentence naming who and when.
        const text = await editor(page).innerText();
        const sentence = zh
          ? "你已于 11月16日周一 05:17 撤回你的更改。下一项更改将基于已发布的营业时间。"
          : "You withdrew your change on Mon, Nov 16 05:17. The next change starts from the published hours.";
        expect(text).toContain(sentence);
        expect(text).not.toContain(zh ? "最近更改：" : "Latest change:");
        expect(text.split(zh ? "撤回" : "withdr").length - 1).toBe(1);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await monday.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/b48-hours-editor-${language}-${width}.png` });
      });
    }

    test("batch 48: the end of the day shows its whole name, and other latest changes are said once", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, language, {
        weeklySchedule: week(wholeDay),
        openChange: { lifecycle: "PendingApproval", yours: true },
      });
      await openEditor(page, zh);
      const end = editor(page)
        .getByRole("group", { name: zh ? "结束 1" : "End 1", exact: true })
        .first()
        .getByRole("combobox", { name: zh ? "小时" : "Hour" });
      const fits = await end.evaluate((select) => {
        const element = select as HTMLSelectElement;
        const style = getComputedStyle(element);
        const context = document.createElement("canvas").getContext("2d");
        if (context === null) return -1;
        context.font = `${style.fontSize} ${style.fontFamily}`;
        const label = element.selectedOptions[0]?.text ?? "";
        return element.getBoundingClientRect().width - context.measureText(label).width;
      });
      // Room for the label and the arrow.
      expect(fits).toBeGreaterThanOrEqual(16);
      // Your change waiting for approval: its state is said once, in your words.
      const text = await editor(page).innerText();
      expect(text).toContain(
        zh
          ? "你正在编辑你自己的更改（版本 2，等待批准）"
          : "You are editing your own change (version 2, waiting for approval)",
      );
      expect(text).not.toContain(zh ? "最近更改：" : "Latest change:");
    });
  });
}

/**
 * Batch 49 (v15 batch 48 live, Lane Dessert, Edit operating hours): the editor head stacked
 * "Configuration loaded." / "配置已加载。", the "Reload configuration" button and "You withdrew your
 * change …" with no gap between the button and the sentence, at 390 and 1440 in both languages;
 * and "Times are in Eastern Time … The business day starts at 4:00 a.m." repeated the time zone
 * and business-day start that Published hours had just given.
 */
for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  test.describe(`@production batch 49 hours editor head (${language})`, () => {
    test.use({ locale: "en-CA" });
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      test(`the head reads status, latest change, then actions, spaced, and the day start is said once, at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await open(page, language);
        await openEditor(page, zh);
        const head = editor(page);
        const sentence = head.getByText(
          zh ? "你已于 11月16日周一 05:17 撤回你的更改。" : "You withdrew your change on Mon, Nov 16",
        );
        const reload = head.getByRole("button", {
          name: zh ? "重新读取已保存的营业时间" : "Reload saved hours",
        });
        await expect(sentence).toBeVisible();
        await expect(reload).toBeVisible();
        // Once loaded, the form itself says so: no "Configuration loaded." line.
        const text = await head.innerText();
        expect(text).not.toContain(zh ? "配置已加载" : "Configuration loaded");
        // Order: the latest-change sentence, then the actions, with at least an 8 px step between.
        const said = await sentence.boundingBox();
        const button = await reload.boundingBox();
        expect(said).not.toBeNull();
        expect(button).not.toBeNull();
        const gap = (button?.y ?? 0) - ((said?.y ?? 0) + (said?.height ?? 0));
        expect(gap).toBeGreaterThanOrEqual(8);
        // The intro above the sentence keeps its own step too.
        const intro = head.getByText(zh ? "保存后等待审批。" : "Save your change for approval.", {
          exact: false,
        });
        const introBox = await intro.boundingBox();
        expect(
          (said?.y ?? 0) - ((introBox?.y ?? 0) + (introBox?.height ?? 0)),
        ).toBeGreaterThanOrEqual(8);
        // The time zone and the start of the business day are said once on the page, under
        // the page title (batch 63 F54; was under Published hours).
        const page_ = await page.locator("main").innerText();
        const dayStart = zh ? /营业日从 04:00 开始/gu : /business day starts (?:at )?04:00/giu;
        expect(page_.match(dayStart)?.length ?? 0).toBe(1);
        expect(text).not.toContain(zh ? "时间使用" : "Times are in");
        await expect(page.locator(".workspace-page__meta")).toContainText(
          zh ? "北美东部时间（多伦多、渥太华和蒙特利尔）" : "Eastern Time (Toronto",
        );
        // Nothing runs off the screen; the button keeps about 40 px spare for Linux fonts.
        const spare = await reload.evaluate((element) => {
          const box = (element.closest("section") ?? element).getBoundingClientRect();
          return Math.min(box.right, window.innerWidth) - element.getBoundingClientRect().right;
        });
        expect(spare).toBeGreaterThanOrEqual(40);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // A reload still answers in a polite live region.
        await reload.click();
        const status = head.locator("[role='status'][aria-live='polite']");
        await expect(status).toHaveText(
          zh ? "已重新加载最新保存的营业时间。" : "Reloaded the latest saved hours.",
        );
        await sentence.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `test-results/b49-hours-editor-head-${language}-${width}.png`,
        });
        await expectNoInternalText(page);
      });
    }
  });
}

/**
 * Batch 50 (v15 batch 49 live, Test Merchant 2 at 1024 zh-Hans, Edit operating hours): the head
 * no longer repeated the time zone, but the special dates part (特定日期例外) still said
 * "日期使用北美东部时间（多伦多、渥太华和蒙特利尔）。…", so the page named the time zone under Published
 * hours and again at the foot of the editor. Read-only: the editor is opened, nothing is saved.
 */
for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  test.describe(`@production batch 50 hours editor says the time zone once (${language})`, () => {
    test.use({ locale: "en-CA" });
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      test(`the special dates part does not repeat the time zone, at ${width}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await open(page, language);
        // Read-only: any hours or service write is stopped and recorded (added
        // after the page's own reads, so it is asked first).
        const writes: string[] = [];
        for (const path of ["**/merchant/store-configuration**", "**/merchant/service-control**"])
          await page.route(path, (route) => {
            if (route.request().method() === "GET") return route.fallback();
            writes.push(route.request().method() + " " + new URL(route.request().url()).pathname);
            return route.abort();
          });
        await openEditor(page, zh);
        const main = await page.locator("main").innerText();
        const zone = zh ? "北美东部时间（多伦多、渥太华和蒙特利尔）" : "Eastern Time (Toronto";
        expect(main.split(zone).length - 1).toBe(1);
        await expect(page.locator(".workspace-page__meta")).toContainText(zone);
        const exceptions = editor(page).getByRole("group", {
          name: zh ? "特定日期例外" : "Dated exceptions",
          exact: true,
        });
        await expect(exceptions).toBeVisible();
        const said = exceptions.getByText(
          zh
            ? "没有时段的例外表示当天停业。"
            : "An exception with no intervals is closed for that date.",
          { exact: true },
        );
        await expect(said).toBeVisible();
        const text = await exceptions.innerText();
        expect(text).not.toContain(zh ? "日期使用" : "Dates use");
        // The sentence wraps inside its part and nothing runs off the screen.
        const clipped = await said.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const part = (element.closest("fieldset") ?? element).getBoundingClientRect();
          return box.right - Math.min(part.right, window.innerWidth);
        });
        expect(clipped).toBeLessThanOrEqual(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await exceptions.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `test-results/b50-hours-editor-dates-${language}-${width}.png`,
        });
        await page.screenshot({
          path: `test-results/b50-hours-page-${language}-${width}.png`,
          fullPage: true,
        });
        await expectNoInternalText(page);
        expect(writes).toEqual([]);
      });
    }
  });
  test.describe(`@production batch 51 hours editor says the time zone in every state (${language})`, () => {
    test.use({ locale: "en-CA" });
    // v15 b50 live: with the service-status read failing, Published hours was not drawn and the
    // editor hid its "Times are in …" (draft zone = published zone), so the zone was said 0 times.
    // Each state of Hours & ordering, with where the zone is said (once each).
    const toronto = zh ? "北美东部时间（多伦多、渥太华和蒙特利尔）" : "Eastern Time (Toronto";
    const vancouver = zh ? "温哥华，不列颠哥伦比亚省" : "Vancouver, British Columbia";
    const states = [
      { state: "Loading", service: "Loading", said: { [toronto]: "Editor" } },
      { state: "Outage", service: "Outage", said: { [toronto]: "Editor" } },
      { state: "NotPublished", service: "NotPublished", said: { [toronto]: "Editor" } },
      { state: "Published", service: "Published", said: { [toronto]: "Published" } },
      {
        state: "DraftZoneDiffers",
        service: "Published",
        draftTimeZone: "America/Vancouver",
        said: { [toronto]: "Published", [vancouver]: "Editor" },
      },
    ] as const;
    for (const { state, service, said, ...rest } of states)
      for (const [width, height] of [
        [390, 844],
        [1024, 768],
        [1440, 900],
      ] as const)
        test(`${state}: the zone is said once with the editor open, at ${width}`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height });
          const draftTimeZone = "draftTimeZone" in rest ? rest.draftTimeZone : undefined;
          await open(page, language, {
            service,
            ...(draftTimeZone
              ? {
                  draftTimeZone,
                  withdrawal: false,
                  openChange: { lifecycle: "PendingApproval", yours: true },
                }
              : {}),
          });
          // Read-only: any hours or service write is stopped and recorded.
          const writes: string[] = [];
          for (const path of ["**/merchant/store-configuration**", "**/merchant/service-control**"])
            await page.route(path, (route) => {
              if (route.request().method() === "GET") return route.fallback();
              writes.push(route.request().method() + " " + new URL(route.request().url()).pathname);
              return route.abort();
            });
          await openEditor(page, zh);
          const main = await page.locator("main").innerText();
          await expect(
            page.locator("section[aria-labelledby='published-hours-title']"),
          ).toHaveCount(service === "Published" ? 1 : 0);
          // Batch 63 F54: with the hours read, the zone is said under the page title.
          const published = page.locator(".workspace-page__meta");
          const sentence = editor(page).locator("p", {
            hasText: zh ? /^时间使用/u : /^Times are in /u,
          });
          for (const [zone, where] of Object.entries(said)) {
            expect(main.split(zone).length - 1, zone).toBe(1);
            await expect(where === "Published" ? published : sentence).toContainText(zone);
          }
          await expect(sentence).toHaveCount(
            "draftTimeZone" in rest || service !== "Published" ? 1 : 0,
          );
          if (service !== "Published") {
            await expect(sentence).toContainText(
              zh ? "营业日从 04:00 开始" : "business day starts at 04:00",
            );
            // The sentence wraps inside the editor, about 40 px clear of the screen edge.
            const room = await sentence.evaluate((element) => ({
              right: window.innerWidth - element.getBoundingClientRect().right,
              spill: element.scrollWidth - element.clientWidth,
            }));
            expect(room.spill).toBeLessThanOrEqual(0);
            expect(room.right).toBeGreaterThanOrEqual(16);
          }
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          // Where the zone is said in the editor (or under Published hours), for review by eye.
          await (
            Object.values(said).includes("Editor") ? sentence : published
          ).scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `test-results/b51-hours-zone-${state}-${language}-${width}.png`,
          });
          await expectNoInternalText(page);
          expect(writes).toEqual([]);
        });
  });
}

/**
 * Batch 63 F54 (v15 design review RA-05, Figma 57:121 against 57:69): Hours & ordering read as a
 * settings dump. The h1 was 26/650 under 28/650 section heads, every action a white outlined
 * button, the service select touched "Pause service", Save looked like plain grey text, and the
 * copy said "Store configuration", "Operating hours draft" and "publish a new configuration".
 * Now the Orders header, three 20/600 sections, one row a day at 16/400 with row hairlines,
 * accent text actions, one accent primary 24 px from its fields. Read-only: nothing is saved.
 */
for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  test.describe(`@production batch 63 Hours & ordering in the v3 rules (${language})`, () => {
    test.use({ locale: "en-CA" });
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const)
      test(`the page reads as three plain sections, at ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.route("**/merchant/dining/payment-timing", (route) =>
          route.fulfill({
            headers,
            json: { paymentTiming: "PayLater", version: 1, changedAt: null },
          }),
        );
        await open(page, language, { withdrawal: false });
        await expect(
          page.getByRole("button", { name: zh ? "修改营业时间" : "Edit hours" }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: zh ? "保存" : "Save" })).toBeDisabled();
        const main = page.locator("main");
        const text = await main.innerText();
        for (const word of zh
          ? ["门店配置", "草稿", "已发布的营业时间", "服务控制", "发布新配置"]
          : [
              "Store configuration",
              "draft",
              "Published hours",
              "Service controls",
              "configuration",
            ])
          expect(text, word).not.toContain(word);
        await expect(main).toContainText(zh ? "客人现在看到的时间" : "Hours guests see now");
        await expect(main).toContainText(
          zh ? "等待审批的修改：没有。" : "Changes waiting for approval: none.",
        );
        await expect(page.locator(".workspace-page__meta")).toHaveText(
          zh
            ? "Main · 北美东部时间（多伦多、渥太华和蒙特利尔）· 营业日从 04:00 开始"
            : "Main · Eastern Time (Toronto, Ottawa and Montréal) · business day starts 04:00",
        );
        const look = await page.evaluate(() => {
          const style = (element: Element | null) =>
            element === null ? null : getComputedStyle(element);
          const probe = document.createElement("span");
          probe.style.color = "var(--bop-color-accent)";
          document.body.append(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          const h1 = style(document.querySelector("main h1"));
          const sections = [...document.querySelectorAll("main h2")].map((h2) => ({
            text: h2.textContent,
            size: getComputedStyle(h2).fontSize,
            weight: getComputedStyle(h2).fontWeight,
          }));
          const rows = [...document.querySelectorAll(".hours-page__rows")][0];
          const row = [...(rows?.children ?? [])].map((child) => ({
            size: getComputedStyle(child.querySelector("dt") as Element).fontSize,
            weight: getComputedStyle(child.querySelector("dd") as Element).fontWeight,
            line: getComputedStyle(child).borderTopWidth,
          }));
          // Every button but the language switch: no outline box; text actions in the accent.
          const buttons = [...document.querySelectorAll("main button")]
            .filter((button) => !button.closest(".language-switch, .workspace-page__language"))
            .filter((button) => (button as HTMLElement).offsetParent !== null)
            .map((button) => {
              const css = getComputedStyle(button);
              return {
                text: button.textContent,
                border: css.borderTopWidth,
                color: css.color,
                background: css.backgroundColor,
                opacity: css.opacity,
                height: button.getBoundingClientRect().height,
              };
            });
          const select = document.querySelector("#pause-mode") as HTMLElement;
          const primary = document.querySelector(".hours-page__primary") as HTMLElement;
          const s = select.getBoundingClientRect();
          const p = primary.getBoundingClientRect();
          const sameLine = Math.abs(s.bottom - p.bottom) < 2;
          const title = (document.querySelector("main h1") as HTMLElement).getBoundingClientRect();
          // Batch 63 (F38): at 1024 the stamp sits in the approved top bar (Figma 58:65), so
          // what stays beside the title there is Refresh; on wider screens it is the stamp.
          const inBar = document.querySelector(
            ".workspace-sidebar__status .workspace-page__status",
          );
          const stamp = (
            document.querySelector(
              inBar === null
                ? ".workspace-page__header .workspace-page__status"
                : ".workspace-page__header .workspace-page__actions",
            ) as HTMLElement
          ).getBoundingClientRect();
          return {
            accent,
            h1: { size: h1?.fontSize, weight: h1?.fontWeight },
            sections,
            row,
            buttons,
            gap: sameLine ? p.left - s.right : p.top - s.bottom,
            sameLine,
            primaryRight: window.innerWidth - p.right,
            stampRight: stamp.left > title.right,
            stampInBar: inBar !== null,
          };
        });
        expect(look.h1).toEqual({ size: "28px", weight: "600" });
        expect(look.sections.map((section) => [section.size, section.weight])).toEqual([
          ["20px", "600"],
          ["20px", "600"],
          ["20px", "600"],
        ]);
        expect(look.row).toHaveLength(7);
        for (const [index, row] of look.row.entries()) {
          expect(row.size).toBe("16px");
          expect(row.weight).toBe("400");
          expect(row.line).toBe(index === 0 ? "0px" : "1px");
        }
        for (const button of look.buttons) {
          expect(button.border, JSON.stringify(button)).toBe("0px");
          expect(button.height, JSON.stringify(button)).toBeGreaterThanOrEqual(44);
          const filled = button.background !== "rgba(0, 0, 0, 0)";
          // Text actions are the accent; the filled ones are the accent behind white.
          expect(filled ? button.background : button.color, JSON.stringify(button)).toBe(
            look.accent,
          );
        }
        // Save is the accent at reduced strength until something changes.
        const save = look.buttons.find((button) => button.text === (zh ? "保存" : "Save"));
        expect(Number(save?.opacity)).toBeLessThan(1);
        // One accent primary, 24 px from its fields on one line (below them on a phone), with
        // about 40 px to spare for Linux fonts.
        if (look.sameLine) expect(look.gap).toBeGreaterThanOrEqual(24);
        else expect(look.gap).toBeGreaterThanOrEqual(16);
        if (width >= 1024) expect(look.sameLine).toBe(true);
        expect(look.primaryRight).toBeGreaterThanOrEqual(width >= 1024 ? 40 : 16);
        if (width >= 1024) expect(look.stampRight).toBe(true);
        expect(look.stampInBar).toBe(width === 1024);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: `test-results/b63-hours-page-${language}-${width}.png`,
          fullPage: true,
        });
        await expectNoInternalText(page);
      });
  });
}
