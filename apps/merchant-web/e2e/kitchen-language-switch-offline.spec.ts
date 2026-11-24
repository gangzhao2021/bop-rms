import { expect, test, type Page } from "@playwright/test";
import { at, store } from "./kitchen-tm2-fixture";

/**
 * WP-2423 batch 55 (v15 batch 54 live check, kitchen-display-header-1024): Test Merchant 2's
 * kitchen display, offline ("Read-only until reconnected"). Tapping 中文 / English reloaded the
 * page; the reload failed and the whole screen became the front-of-house offline page: no bar, no
 * switch, floor steps (paper slips for rounds, card machine for payment) and the last-seen tickets
 * gone until the network came back.
 *
 * Changing the language never loses the board: while the store system can't be reached the switch
 * says so in plain words and the board, its bar and its tickets stay as they were; once the
 * connection is back the same tap switches. A kitchen display the browser itself reloads while
 * offline shows kitchen steps, not floor steps. In English the switch ("中文") is a 44 px target
 * like every other control of the bar.
 */

const LANGUAGE = "bop.merchant.language";
const sizes = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;

async function startIn(page: Page, language: "en" | "zh-Hans") {
  // Only the first load: the language a tap chose must survive the reload it causes.
  await page.addInitScript(
    ([key, value]) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    [LANGUAGE, language] as const,
  );
}

async function offlineCopyReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production WP-2423 batch 55: tapping the language switch offline keeps the kitchen board (${language}, ${width})`, async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      const zh = language === "zh-Hans";
      await page.clock.setFixedTime(new Date(at));
      await page.setViewportSize({ width, height });
      await startIn(page, language);
      await store(page, "Named", { reworks: [], commands: [] });
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await page.goto("/operations/kitchen");
      const header = page.locator(".kitchen-shell .bop-shell__header");
      // Today's Order 8 (the earlier days' backlog stays folded).
      const ticket = page
        .getByText(zh ? /担担面/u : /Dan dan noodles \(TEST\)/u)
        .locator("visible=true")
        .first();
      await expect(header).toBeVisible();
      await expect(ticket).toBeVisible();
      await offlineCopyReady(page);
      const switcher = header.getByRole("button", {
        name: zh ? "Switch to English" : "切换到中文",
      });

      await context.setOffline(true);
      await expect(
        page.getByText(zh ? "重新联网前只读" : "Read-only until reconnected").first(),
      ).toBeVisible({ timeout: 30_000 });
      const size = await switcher.boundingBox();
      expect(size?.width, `${language} ${width}: switch 44 px wide`).toBeGreaterThanOrEqual(44);
      expect(size?.height, `${language} ${width}: switch 44 px tall`).toBeGreaterThanOrEqual(44);
      const before = navigations;
      await switcher.click();
      await expect(
        page.getByRole("status").filter({
          hasText: zh ? "现在连不上系统，语言暂时换不了" : "Can't reach the system right now",
        }),
      ).toBeVisible();
      // Batch 56 (v15 batch 55 live, zh-Hans 390): the note sat fixed over the bottom of the first
      // ticket's 做好了 / Finished button for 8 s. It now covers no control of the screen at any
      // width, and stays a status the screen reader announces.
      const covered = await page.evaluate(() => {
        const note = document.querySelector(".language-switch-note");
        if (note === null) return ["no note"];
        const box = note.getBoundingClientRect();
        return [...document.querySelectorAll("button, a[href], input, select, summary")]
          .filter((control) => !note.contains(control))
          .filter((control) => {
            const r = control.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (getComputedStyle(control).visibility === "hidden") return false;
            return (
              r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top
            );
          })
          .map((control) => (control.textContent ?? "").trim().slice(0, 40));
      });
      expect(covered, `${language} ${width}: controls under the note`).toEqual([]);
      await expect(page.locator(".language-switch-note")).toHaveAttribute("role", "status");
      await page.waitForTimeout(2_000);
      expect(navigations, `${language} ${width}: no reload`).toBe(before);
      await expect(header).toBeVisible();
      await expect(switcher).toBeVisible();
      await expect(ticket).toBeVisible();
      await expect(
        page.getByText(zh ? "断网期间怎么做" : "While the connection is down"),
      ).toHaveCount(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), LANGUAGE)).toBe(language);
      await page.screenshot({ path: `test-results/b55-offline-switch-${language}-${width}.png` });

      // Back online, the same tap switches.
      await context.setOffline(false);
      await switcher.click();
      await expect(
        header.getByRole("button", { name: zh ? "切换到中文" : "Switch to English" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .getByText(zh ? /Dan dan noodles \(TEST\)/u : /担担面/u)
          .locator("visible=true")
          .first(),
      ).toBeVisible();
    });

test("@production WP-2423 batch 55: the sold-out page opened from the kitchen keeps its page when the switch is tapped offline", async ({
  page,
  context,
}) => {
  await page.clock.setFixedTime(new Date(at));
  await page.setViewportSize({ width: 1024, height: 768 });
  await startIn(page, "en");
  await store(page, "Named", { reworks: [], commands: [] });
  await page.goto("/app/commerce/availability?from=kitchen");
  const header = page.locator(".kitchen-shell .bop-shell__header");
  await expect(header).toBeVisible();
  await offlineCopyReady(page);
  await context.setOffline(true);
  const switcher = header.getByRole("button", { name: "切换到中文" });
  const size = await switcher.boundingBox();
  expect(size?.width).toBeGreaterThanOrEqual(44);
  await switcher.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Can't reach the system right now" }),
  ).toBeVisible();
  await expect(header).toBeVisible();
  await expect(page.getByText("While the connection is down")).toHaveCount(0);
  await context.setOffline(false);
});

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 55: a kitchen display reloaded offline shows kitchen steps, not floor steps (${language})`, async ({
    page,
    context,
  }) => {
    const zh = language === "zh-Hans";
    await page.clock.setFixedTime(new Date(at));
    await page.setViewportSize({ width: 1024, height: 768 });
    await startIn(page, language);
    await store(page, "Named", { reworks: [], commands: [] });
    await page.goto("/operations/kitchen");
    await expect(page.locator(".kitchen-shell .bop-shell__header")).toBeVisible();
    await offlineCopyReady(page);
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: zh ? "断网期间怎么做" : "While the connection is down" }),
    ).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).toContain(zh ? "照纸单做菜" : "Cook from the paper slips the floor brings");
    // Floor steps and the floor's last bills are not the kitchen's work.
    expect(text).not.toMatch(zh ? /刷卡机|账单/u : /card machine|bills?\b/iu);
    await page.screenshot({ path: `test-results/b55-kitchen-offline-page-${language}.png` });
    await context.setOffline(false);
    await expect(page.locator(".kitchen-shell .bop-shell__header")).toBeVisible({
      timeout: 20_000,
    });
  });

test("@production WP-2423 batch 55: the floor's offline page keeps the floor steps and last bills", async ({
  page,
  context,
}) => {
  await startIn(page, "en");
  await page.goto("/operations/dining");
  await offlineCopyReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "While the connection is down" })).toBeVisible();
  await expect(page.getByText(/card machine/u)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Last bills seen before the connection dropped" }),
  ).toBeVisible();
  await context.setOffline(false);
});
