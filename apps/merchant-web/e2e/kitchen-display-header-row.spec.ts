import { expect, test, type Locator, type Page } from "@playwright/test";
import { ringsFrom, whole } from "./focus-ring-clip";
import { expectNoInternalText } from "./internal-text-guard";
import { at, headers, navigation, store } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 54 (v15 batch 53 live check, kitchen-first-tap-earlier-day-slots): Test Merchant
 * 2's kitchen display at 1024 wide in zh-Hans. The browser could not hold the screen on, so the
 * header said so. The top bar did not fit: 厨房 / 标记商品售罄 moved to a second row and the
 * "English" switch sat alone on a third row. Owner rule: the language switch is top-right.
 *
 * At 1024 and 1440 the Store's name, the display's own links, Hand over and the language switch
 * share one row with about 40 px to spare (Linux fonts are wider), the switch rightmost. On a
 * phone and at 768 the bar degrades on purpose: the switch stays top-right beside the Store's
 * name, never alone on a line, and every control stays a 44 px target inside the screen.
 */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

const box = async (locator: Locator, label: string): Promise<Box> => {
  await expect(locator, label).toBeVisible();
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    };
  });
};

/** The rendered text of an element (not its box, which a grid or flex cell may stretch). */
const textBox = (locator: Locator): Promise<Box> =>
  locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    };
  });

const middle = (b: Box) => (b.top + b.bottom) / 2;
const sameRow = (a: Box, b: Box) => middle(a) > b.top && middle(a) < b.bottom;

/** One line of text: shorter than two lines of its own type. */
async function oneLine(locator: Locator, label: string) {
  const lines = await locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight) || 20;
    return range.getBoundingClientRect().height / lineHeight;
  });
  expect(lines, `${label}: one line`).toBeLessThan(1.6);
}

/** The switch reloads once the store system answered: wait for that reload. */
async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  const name = language === "zh-Hans" ? "切换到中文" : "Switch to English";
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name }).click()]);
}

const sizes = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
] as const;

for (const awake of ["Unsupported", "Held"] as const)
  test(`@production WP-2423 batch 54: the kitchen display's top bar keeps the language switch top-right (${awake === "Unsupported" ? "screen cannot be held on" : "screen kept on"})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.clock.setFixedTime(new Date(at));
    // Live, the browser could not hold the screen on (no Screen Wake Lock); a tablet browser can.
    await page.addInitScript((held) => {
      Object.defineProperty(Navigator.prototype, "wakeLock", {
        configurable: true,
        get: () =>
          held
            ? { request: () => Promise.resolve({ release: () => Promise.resolve() }) }
            : undefined,
      });
    }, awake === "Held");
    await store(page, "Named", { reworks: [], commands: [] });
    await page.goto("/operations/kitchen");
    const header = page.locator(".kitchen-shell .bop-shell__header");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      const nav = page.getByRole("navigation", { name: zh ? "主导航" : "Primary" });
      const title = header.getByRole("heading", { level: 1 });
      const links = [
        nav.getByRole("link", { name: zh ? "厨房" : "Kitchen", exact: true }),
        nav.getByRole("link", { name: zh ? "标记商品售罄" : "Mark an item sold out" }),
      ];
      const handover = header.getByRole("button", {
        name: zh ? "交接 / 退出" : "Hand over / sign out",
      });
      const switcher = header.getByRole("button", {
        name: zh ? "Switch to English" : "切换到中文",
      });
      const note = header.locator(".kitchen-screen-awake");
      await expect(note).toHaveAttribute("data-state", awake);
      for (const [width, height] of sizes) {
        const where = `${awake} ${width} ${language}`;
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `test-results/b54-header-${awake}-${width}-${language}.png`,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${where}: no sideways scroll`,
        ).toBe(true);
        const controls = [...links, handover, switcher];
        const boxes = await Promise.all(
          controls.map((control, n) => box(control, `${where} #${n}`)),
        );
        const titleBox = await box(title, `${where} title`);
        const lang = boxes[3] as Box;
        for (const [n, control] of controls.entries()) {
          const b = boxes[n] as Box;
          expect(b.height, `${where} #${n}: 44 px target`).toBeGreaterThanOrEqual(44);
          expect(b.left, `${where} #${n}: inside the screen`).toBeGreaterThanOrEqual(8);
          expect(b.right, `${where} #${n}: inside the screen`).toBeLessThanOrEqual(width - 8);
          await oneLine(control, `${where} #${n}`);
          // The switch is the rightmost control of the bar and in its top row.
          expect(b.right, `${where} #${n}: left of the language switch`).toBeLessThanOrEqual(
            lang.right,
          );
          expect(lang.top, `${where}: switch in the top row`).toBeLessThanOrEqual(b.top + 1);
        }
        // Never alone on a line: the Store's name shares the switch's row.
        expect(sameRow(titleBox, lang), `${where}: title beside the switch`).toBe(true);
        expect(lang.right, `${where}: switch at the right edge`).toBeGreaterThan(width - 48);
        if (width >= 1024) {
          // One row: the name, the links, Hand over and the switch.
          for (const [n] of controls.entries())
            expect(sameRow(boxes[n] as Box, lang), `${where} #${n}: same row`).toBe(true);
          await oneLine(title, `${where} title`);
          // About 40 px to spare between the left group (name, links) and Hand over, so the wider
          // Linux fonts still fit on one row.
          const name = await textBox(title);
          const leftEnd = Math.max(name.right, (boxes[1] as Box).right);
          const free = (boxes[2] as Box).left - leftEnd;
          if (awake === "Held" || width < 1440)
            expect(free, `${where}: room to spare`).toBeGreaterThanOrEqual(40);
          // The browser's own words about the screen: in the row's spare room at 1440 (no more
          // than two lines), under the row at 1024 and 1280 (three lines there on the Linux CI
          // runner); never pushing a control off the row.
          const noteBox = await textBox(note);
          if (width >= 1440) {
            expect(noteBox.height, `${where}: note in two lines`).toBeLessThan(44);
            // Between the links and Hand over, never over either of them.
            expect(noteBox.left, `${where}: note after the links`).toBeGreaterThanOrEqual(
              (boxes[1] as Box).right + 16,
            );
            expect(noteBox.right, `${where}: note before Hand over`).toBeLessThanOrEqual(
              (boxes[2] as Box).left,
            );
          } else
            expect(noteBox.top, `${where}: note under the row`).toBeGreaterThanOrEqual(lang.top);
        } else {
          // Phone and 768: the links and Hand over sit under the name, each on one line.
          for (const n of [0, 1, 2])
            expect((boxes[n] as Box).top, `${where} #${n}: under the name`).toBeGreaterThanOrEqual(
              titleBox.top,
            );
        }
        // The board starts under the bar, not over it.
        const bar = await box(header, `${where} bar`);
        const board = await box(page.locator(".kitchen-board-heading").first(), `${where} board`);
        expect(board.top, `${where}: board under the bar`).toBeGreaterThanOrEqual(bar.bottom - 1);
      }
      await expectNoInternalText(page);
    }
  });

/**
 * Review of batch 54: the bar has no links while the board is loading, when the kitchen cannot be
 * read (the outage screen staff rely on), and the links are hidden when the only one would be the
 * current page (a cook whose sign-in cannot mark items sold out). The display's label
 * ("Kitchen display") then names the screen on the bar at every width, and the switch stays
 * top-right beside the Store's name.
 */
for (const state of ["Loading", "Unavailable", "Kitchen only"] as const)
  test(`@production WP-2423 batch 54: the kitchen display's top bar keeps the switch top-right with no links (${state})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.clock.setFixedTime(new Date(at));
    // "Kitchen only": the same sign-in without "Item availability", so the only link is the board.
    await store(
      page,
      "Named",
      { reworks: [], commands: [] },
      state === "Kitchen only"
        ? { navigation: navigation.filter((item) => item.screenId === "KIT-KITCHEN-QUEUE") }
        : {},
    );
    if (state === "Loading")
      // The board never answers: the bar shows what it has while the first read is under way.
      await page.route("**/merchant/kitchen/query", () => new Promise<void>(() => undefined));
    if (state === "Unavailable")
      await page.route("**/merchant/kitchen/query", (route) =>
        route.fulfill({ status: 503, headers, json: { code: "UNAVAILABLE" } }),
      );
    await page.goto("/operations/kitchen");
    const header = page.locator(".kitchen-shell .bop-shell__header");
    for (const language of ["en", "zh-Hans"] as const) {
      if (language === "zh-Hans") await chooseLanguage(page, language);
      const zh = language === "zh-Hans";
      if (state === "Unavailable")
        await expect(
          page.getByText(zh ? "这个页面暂时用不了" : "This screen isn't working"),
        ).toBeVisible();
      if (state === "Kitchen only")
        await expect(
          header.getByRole("button", { name: zh ? "交接 / 退出" : "Hand over / sign out" }),
        ).toBeVisible();
      const title = header.getByRole("heading", { level: 1 });
      const label = header.locator(":scope > p");
      await expect(label).toHaveText(zh ? "厨房屏" : "Kitchen display");
      const switcher = header.getByRole("button", {
        name: zh ? "Switch to English" : "切换到中文",
      });
      for (const [width, height] of sizes) {
        const where = `${state} ${width} ${language}`;
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `test-results/b54-header-nolinks-${state.replace(" ", "-")}-${width}-${language}.png`,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${where}: no sideways scroll`,
        ).toBe(true);
        const lang = await box(switcher, `${where} switch`);
        const titleBox = await box(title, `${where} title`);
        const labelCell = await box(label, `${where} label`);
        // Its words, not its grid cell (which spans the bar on a phone).
        const labelBox = await textBox(label);
        expect(lang.height, `${where}: 44 px target`).toBeGreaterThanOrEqual(44);
        expect(lang.right, `${where}: switch at the right edge`).toBeGreaterThan(width - 48);
        expect(lang.right, `${where}: switch inside the screen`).toBeLessThanOrEqual(width - 8);
        expect(sameRow(titleBox, lang), `${where}: title beside the switch`).toBe(true);
        expect(lang.top, `${where}: switch in the top row`).toBeLessThanOrEqual(titleBox.top + 1);
        // The label names the screen, in sight and on one line, left of the switch.
        expect(labelCell.right - labelCell.left, `${where}: label in sight`).toBeGreaterThan(24);
        expect(labelBox.right, `${where}: label left of the switch`).toBeLessThanOrEqual(lang.left);
        await oneLine(label, `${where} label`);
        if (width >= 768) await oneLine(title, `${where} title`);
        if (width >= 1024) expect(sameRow(labelBox, lang), `${where}: label in the row`).toBe(true);
        else {
          // Under the name, from the bar's start.
          expect(labelBox.top, `${where}: label under the name`).toBeGreaterThanOrEqual(
            titleBox.bottom - 1,
          );
          expect(
            Math.abs(labelBox.left - titleBox.left),
            `${where}: label at the start`,
          ).toBeLessThan(2);
        }
      }
      await expectNoInternalText(page);
    }
  });

/**
 * Batch 61 (b60 sweep): the bar keeps 4 px above its 44 px controls, so their focus ring (3 px +
 * 3 px offset) lost 2 px at the top of the screen: Kitchen, Mark an item sold out, Hand over and
 * the language switch, at every width. Every ring in the bar is now whole.
 */
test("@production WP-2423 batch 61: every focus ring in the kitchen display's top bar is whole", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(new Date(at));
  await store(page, "Named", { reworks: [], commands: [] });
  await page.goto("/operations/kitchen");
  const header = page.locator(".kitchen-shell .bop-shell__header");
  for (const language of ["en", "zh-Hans"] as const) {
    if (language === "zh-Hans") await chooseLanguage(page, language);
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      const rings = await ringsFrom(page, header, header.getByRole("link").first());
      expect(rings.length, `${language} ${width}`).toBeGreaterThanOrEqual(4);
      for (const ring of rings) {
        expect(ring.ring, ring.name).toBe(true);
        expect(ring, `${language} ${width}: ${ring.name}`).toEqual(whole(ring));
      }
    }
  }
});
