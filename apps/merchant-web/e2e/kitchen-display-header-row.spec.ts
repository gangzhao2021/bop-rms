import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { at, store } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 54 (v15 batch 53 live check, kitchen-first-tap-earlier-day-slots): Test Merchant
 * 2's kitchen display at 1024 wide in zh-Hans. The browser could not hold the screen on, so the
 * header said so. The top bar did not fit: 后厨 / 标记商品售罄 moved to a second row and the
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

async function chooseLanguage(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans") await page.getByRole("button", { name: "切换到中文" }).click();
  else await page.getByRole("button", { name: "Switch to English" }).click();
}

const sizes = [
  [390, 844],
  [768, 1024],
  [1024, 768],
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
        nav.getByRole("link", { name: zh ? "后厨" : "Kitchen", exact: true }),
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
          if (awake === "Held" || width < 1280)
            expect(free, `${where}: room to spare`).toBeGreaterThanOrEqual(40);
          // The browser's own words about the screen: in the row's spare room at 1440 (no more
          // than two lines), under the row at 1024; never pushing a control off the row.
          const noteBox = await textBox(note);
          if (width >= 1280) expect(noteBox.height, `${where}: note in two lines`).toBeLessThan(44);
          else expect(noteBox.top, `${where}: note under the row`).toBeGreaterThanOrEqual(lang.top);
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
