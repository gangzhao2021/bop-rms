import { expect, test, type Page } from "@playwright/test";
import { settlementViewFixture } from "../src/settlement.fixtures.js";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { drawnRingOverhang, ringCut } from "./focus-ring-clip";
import {
  headers,
  id,
  inLanguage,
  quietFrame,
  scope,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 64 (v15 live checks of batches 62 and 63): what was left on Reports, Settlement, Hours &
 * ordering, Orders and Exceptions. Synthetic HTTP interception, TEST-only data, measured at 390,
 * 1024 and 1440 in English and Chinese; each size keeps room for Linux fonts (DejaVu Sans).
 */

/** The box a tap can hit, in CSS pixels. */
const target = (page: Page, selector: string, name: string) =>
  page.locator(selector).filter({ hasText: name }).first().boundingBox();

async function reportsToday(page: Page, language: Language) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.clock.setFixedTime(new Date("2026-10-28T01:42:00.000Z"));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ headers, json: session("2026-10-27") }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: "2026-10-28T01:42:00.000Z",
      },
    }),
  );
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
  await page.goto("/app/reports/operations");
  await expect(page.locator(".tonight__links").last()).toBeVisible();
}

async function settlement(page: Page, language: Language) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/settlement*", (route) =>
    route.fulfill({ headers, json: settlementViewFixture() }),
  );
  await page.goto("/app/operations/payment-reconciliation");
  await expect(page.locator(".settlement__other-day button[type=submit]")).toBeVisible();
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production b64 Reports Print, the foot Settlement link and Refresh are 44 x 44 targets, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await reportsToday(page, language);
      const zh = language === "zh-Hans";
      const links = ".tonight__links:last-of-type :is(a, button)";
      for (const [selector, name] of [
        [links, zh ? "打印" : "Print"],
        [links, zh ? "结算" : "Settlement"],
        [".workspace-page__actions button", zh ? "刷新" : "Refresh"],
      ] as const) {
        const box = await target(page, selector, name);
        expect(box, name).not.toBeNull();
        expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44);
        expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });

    test(`@production b64 Settlement Show and Refresh are 44 x 44 targets, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await settlement(page, language);
      const zh = language === "zh-Hans";
      for (const [selector, name] of [
        [".settlement__other-day button[type=submit]", zh ? "显示" : "Show"],
        [".workspace-page__actions button", zh ? "刷新" : "Refresh"],
      ] as const) {
        const box = await target(page, selector, name);
        expect(box, name).not.toBeNull();
        expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44);
        expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44);
      }
      // F58: Settlement's online totals in the words Reports uses.
      const labels = page.locator(".settlement__totals .overview-count__label");
      await expect(labels.nth(0)).toHaveText(zh ? "线上（客人手机）" : "Online (guest's phone)");
      await expect(labels.nth(1)).toHaveText(zh ? "退款" : "Refunds");
      // Batch 67: the online-only net is "Online net"; "Net taken" is the all-methods figure.
      await expect(labels.nth(2)).toHaveText(zh ? "线上净实收" : "Online net");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });
  }

/* ---------- Orders and Exceptions: the row ring at the window's edges ---------- */

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const order = (n: number) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: minutesAgo(30 + n),
  observedAt: minutesAgo(1),
  initialBatchReference: id(200 + n),
  batches: [
    {
      orderBatchReference: id(200 + n),
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
  paidOnline: money("1413"),
  summary: {
    items: [
      { name: "Beef noodles (TEST)", option: null, quantity: 2 },
      { name: "Soy milk (TEST)", option: "Hot", quantity: 1 },
    ],
    lineCount: 3,
    pickupName: "TEST Guest",
    tableLabel: null,
  },
});
const exceptions = () => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: scope.storeLabel,
  businessDate: "2026-11-24",
  projectedAt: new Date().toISOString(),
  freshnessStatus: "Fresh",
  items: Array.from({ length: 24 }, (_, index) => {
    const n = index + 3;
    return {
      exceptionReference: id(900 + n),
      orderReference: id(800 + n),
      orderNumber: String(n),
      kind: "PaidWithoutFulfillableOrder",
      severity: "Critical",
      status: "Open",
      providerState: "Confirmed",
      compensationStatus: "Pending",
      sourceOwner: "Payment",
      createdAt: "2026-11-05T04:43:00.000Z",
      dueAt: "2026-11-05T09:00:00.000Z",
      ownerStatus: "Unassigned",
      sourceFinal: false,
      cause: { kind: "NotAcceptedInTime" },
    };
  }),
});

/**
 * Tab from the page's top to its end and Shift+Tab back, measuring the ring the staff member sees
 * on each order row: drawn by the row (via :has), not by the row's button.
 */
async function rowRingSweep(page: Page) {
  await page.keyboard.press("Shift");
  await page.evaluate(() => document.querySelector<HTMLElement>("a[href], button")?.focus());
  const cut: { name: string; bottom: number; top: number; by: string | null }[] = [];
  let rows = 0;
  let scrolled = 0;
  for (const key of ["Tab", "Shift+Tab"] as const)
    for (let step = 0; step < 160; step += 1) {
      await page.keyboard.press(key);
      const onRow = await page.evaluate(
        () => document.activeElement?.classList.contains("order-row__open") === true,
      );
      if (!onRow) {
        if (key === "Shift+Tab" && rows > 0 && (await page.evaluate(() => window.scrollY)) === 0)
          break;
        continue;
      }
      rows += 1;
      scrolled = Math.max(scrolled, await page.evaluate(() => window.scrollY));
      const ring = await drawnRingOverhang(page);
      expect(ring.ring, `${ring.name} draws a ring`).toBe(true);
      if (ringCut(ring))
        cut.push({ name: ring.name, bottom: ring.bottom, top: ring.top, by: ring.clippedBy });
      if (key === "Tab" && step > 120) break;
    }
  return { cut, rows, scrolled };
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production b64 Orders: each row's ring is whole at the window's edges, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/orders/changes", (route) =>
        route.fulfill({ headers, json: { schemaVersion: 1, mark: "1".padStart(32, "0") } }),
      );
      const items = Array.from({ length: 24 }, (_, index) => order(60 - index));
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) =>
          route.fulfill({ headers, json: { items, nextAfterOrderReference: null } }),
        );
      await page.goto("/operations/orders");
      await expect(page.locator("li.order-row")).toHaveCount(24);
      const sweep = await rowRingSweep(page);
      expect(sweep.rows).toBeGreaterThanOrEqual(24);
      // The list is longer than the window, so rows came in at its bottom edge.
      expect(sweep.scrolled).toBeGreaterThan(0);
      expect(sweep.cut).toEqual([]);
    });

    test(`@production b64 Exceptions: each row's ring is whole at the window's edges, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/order-exceptions*", (route) =>
        route.fulfill({ headers, json: exceptions() }),
      );
      await page.goto("/operations/order-exceptions");
      await expect(page.locator("li.order-row")).toHaveCount(24);
      const sweep = await rowRingSweep(page);
      expect(sweep.rows).toBeGreaterThanOrEqual(24);
      expect(sweep.scrolled).toBeGreaterThan(0);
      expect(sweep.cut).toEqual([]);
    });
  }

/* ---------- Hours & ordering: the hours editor closes, and a refused read says so ---------- */

const store = scope.storeReference;
const at = "2026-11-20T14:00:00.000Z";
const interval = {
  startLocalTime: "00:00:00",
  endLocalTime: "23:59:59",
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
};
const published = {
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: store,
  configurationVersion: 1,
  lifecycle: "Published",
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["DineIn", "Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [interval],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: id(11),
  approvalEvidenceReference: id(12),
  publicationReference: id(13),
  liveGateEvidenceReference: id(14),
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
};
const configurationView = () => ({
  screenId: "STORE-HOURS-SERVICE",
  storeReference: store,
  current: published,
  latest: published,
  expectedVersion: 1,
  observedAt: new Date().toISOString(),
});
const serviceControl = () => ({
  hours: {
    configurationSource: "StoreOverride",
    effectiveFrom: at,
    effectiveUntil: null,
    businessDayStartLocalTime: "04:00:00",
    weeklySchedule: published.weeklySchedule,
    exceptions: [],
  },
  screenId: "STORE-HOURS-SERVICE",
  storeReference: store,
  configurationReference: store,
  timeZone: "America/Toronto",
  enabledServiceModes: ["DineIn", "Pickup"],
  observedAt: new Date().toISOString(),
  expectedVersion: 1,
  activePauses: [],
});

/** Hours & ordering; `editorRead` answers each read of the saved hours after the page's own. */
async function hoursPage(
  page: Page,
  language: Language,
  editorRead: (attempt: number) => { status: number; json: unknown },
) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: serviceControl() }),
  );
  let reads = 0;
  await page.route("**/merchant/store-configuration", (route) => {
    reads += 1;
    // The page's first read says whether the hours can be edited; the editor's reads follow.
    if (reads === 1) return route.fulfill({ headers, json: configurationView() });
    const answer = editorRead(reads - 1);
    return route.fulfill({ status: answer.status, headers, json: answer.json });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const zh = language === "zh-Hans";
  const edit = page.getByRole("button", { name: zh ? "修改营业时间" : "Edit hours", exact: true });
  await expect(edit).toBeVisible();
  return { edit, reads: () => reads };
}

for (const language of ["en", "zh-Hans"] as const) {
  const zh = language === "zh-Hans";
  for (const [width, height] of sizes)
    test(`@production b64 the hours editor closes with Close, a 44 x 44 target, and focus goes back to Edit hours, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const { edit } = await hoursPage(page, language, () => ({
        status: 200,
        json: configurationView(),
      }));
      await edit.click();
      const editor = page.getByRole("region", {
        name: zh ? "修改营业时间" : "Change opening hours",
      });
      await expect(editor.locator("form")).toBeVisible();
      const close = editor.getByRole("button", { name: zh ? "关闭" : "Close", exact: true });
      const box = await close.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      // On the title row, at its end, inside the window.
      const title = await editor.locator("#configuration-editor-title").boundingBox();
      expect(
        Math.abs(
          (box?.y ?? 0) + (box?.height ?? 0) / 2 - ((title?.y ?? 0) + (title?.height ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(2);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      // Nothing changed: it closes at once.
      await close.click();
      await expect(editor).toHaveCount(0);
      await expect(edit).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });

  test(`@production b64 closing over an unsaved change asks first, and Keep editing keeps it, ${language}`, async ({
    page,
  }) => {
    const { edit } = await hoursPage(page, language, () => ({
      status: 200,
      json: configurationView(),
    }));
    await edit.click();
    const editor = page.getByRole("region", { name: zh ? "修改营业时间" : "Change opening hours" });
    await editor
      .getByRole("button", { name: zh ? "添加特定日期例外" : "Add dated exception" })
      .click();
    await editor.getByRole("button", { name: zh ? "关闭" : "Close", exact: true }).click();
    const ask = editor.getByRole("group", {
      name: zh ? "不保存就关闭？" : "Close without saving?",
    });
    await expect(ask).toContainText(
      zh
        ? "不保存就关闭？你在这里做的修改还没有保存。"
        : "Close without saving? The changes you made here are not saved.",
    );
    await ask.getByRole("button", { name: zh ? "继续修改" : "Keep editing" }).click();
    await expect(ask).toHaveCount(0);
    await expect(editor.getByRole("group", { name: zh ? "例外 1" : "Exception 1" })).toHaveCount(1);
    await editor.getByRole("button", { name: zh ? "关闭" : "Close", exact: true }).click();
    await editor
      .getByRole("button", { name: zh ? "不保存，关闭" : "Close without saving", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(edit).toBeFocused();
  });

  test(`@production b64 a first read refused because the sign-in ended says so, never "Configuration unavailable", ${language}`, async ({
    page,
  }) => {
    let ended = false;
    const { edit } = await hoursPage(page, language, () => {
      // v15 b63: another screen signed in with the shared identity and pushed this one out.
      ended = true;
      return { status: 403, json: { error: "request_denied" } };
    });
    await page.route("**/merchant/session/expiry", (route) =>
      ended
        ? route.fulfill({
            status: 401,
            json: { error: "session_ended", reason: "too_many_screens" },
          })
        : route.fulfill({ status: 503, json: { error: "unavailable" } }),
    );
    await edit.click();
    const editor = page.getByRole("region", { name: zh ? "修改营业时间" : "Change opening hours" });
    await expect(editor).toContainText(
      zh
        ? "这台设备上的登录已结束，所以没有打开已保存的营业时间。请重新登录，再到这里打开。没有任何改动。"
        : "Your sign-in on this screen has ended, so the saved hours weren't opened. Sign in again, then open them here. Nothing was changed.",
    );
    await expect(page.locator("main")).not.toContainText(
      zh ? "配置暂不可用" : "Configuration unavailable",
    );
  });

  test(`@production b64 a first read with no usable answer is read again before anything is said, ${language}`, async ({
    page,
  }) => {
    const { edit, reads } = await hoursPage(page, language, (attempt) =>
      attempt === 1
        ? { status: 503, json: { error: "retry_later" } }
        : { status: 200, json: configurationView() },
    );
    await edit.click();
    const editor = page.getByRole("region", { name: zh ? "修改营业时间" : "Change opening hours" });
    await expect(editor.getByRole("group", { name: zh ? "星期一" : "Monday" })).toBeVisible();
    expect(reads()).toBe(3);
    await expect(editor).not.toContainText(zh ? "配置暂不可用" : "Configuration unavailable");
    await expect(editor).not.toContainText(zh ? "暂时读不到" : "couldn't be read");
  });

  test(`@production b64 a read that keeps failing says it plainly with Try again, ${language}`, async ({
    page,
  }) => {
    const { edit } = await hoursPage(page, language, () => ({
      status: 503,
      json: { error: "retry_later" },
    }));
    await edit.click();
    const editor = page.getByRole("region", { name: zh ? "修改营业时间" : "Change opening hours" });
    await expect(editor).toContainText(
      zh
        ? "暂时读不到已保存的营业时间。没有任何改动。请重试。"
        : "The saved hours couldn't be read just now. Nothing was changed. Try again.",
    );
    await expect(editor.getByRole("button", { name: zh ? "重试" : "Try again" })).toBeVisible();
    await expect(editor).not.toContainText(zh ? "检查你的权限" : "Check your access");
  });
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production b64 Exceptions: what is wrong sits over its time, and the ring takes in the row's step, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/order-exceptions*", (route) =>
        route.fulfill({ headers, json: exceptions() }),
      );
      await page.goto("/operations/order-exceptions");
      const row = page.locator("li.order-row").first();
      await expect(row).toBeVisible();
      const type = await row.locator(".order-workbench-type").boundingBox();
      const when = await row.locator(".order-row__when").boundingBox();
      // v15 b63 at 1024 (Linux fonts): both lines were laid in one place, over each other.
      expect((when?.y ?? 0) + 1).toBeGreaterThanOrEqual((type?.y ?? 0) + (type?.height ?? 0));
      await page.keyboard.press("Shift");
      await row.locator(".order-row__open").focus();
      const ring = await row.evaluate((node) => {
        for (let element: HTMLElement | null = node.querySelector(".order-row__open"); element;) {
          const style = getComputedStyle(element);
          if (style.display !== "contents" && style.outlineStyle !== "none") {
            const box = element.getBoundingClientRect();
            const reach =
              (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0);
            return {
              left: box.left - reach,
              right: box.right + reach,
              top: box.top - reach,
              bottom: box.bottom + reach,
            };
          }
          element = element === node ? null : element.parentElement;
        }
        return null;
      });
      const step = await row.locator(".order-exception__next").boundingBox();
      expect(ring).not.toBeNull();
      // The ring goes round the whole case, "Check the refund" included.
      expect(ring?.left ?? 0).toBeLessThanOrEqual(step?.x ?? 0);
      expect(ring?.right ?? 0).toBeGreaterThanOrEqual((step?.x ?? 0) + (step?.width ?? 0));
      expect(ring?.top ?? 0).toBeLessThanOrEqual(step?.y ?? 0);
      expect(ring?.bottom ?? 0).toBeGreaterThanOrEqual((step?.y ?? 0) + (step?.height ?? 0));
    });
