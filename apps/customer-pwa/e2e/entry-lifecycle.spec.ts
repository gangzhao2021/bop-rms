import { readdir, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
test.use({ trace: "off", screenshot: "off", video: "off" });
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
const publications = (page: Page) => page.getByLabel("Established publications");
const calls = (page: Page) => page.getByLabel("Client calls");
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", (value) => {
    if (value.type() === "error") errors.push("console error");
  });
  await page.goto("/?scenario=entry-lifecycle");
  await expect(calls(page)).toHaveText('{"A":{"start":1,"retry":0},"B":{"start":0,"retry":0}}');
  return async () => {
    await settled(page);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  };
}
async function retrying(page: Page) {
  await click(page, "Fail A start");
  await expect(
    page.getByRole("heading", { name: "Ordering is unavailable", exact: true }),
  ).toBeFocused();
  await click(page, "Try again");
  await expect(calls(page)).toContainText('"A":{"start":1,"retry":1}');
}

test("@demo Entry publishes with the latest callback without restarting and retains menu navigation", async ({
  page,
}) => {
  const check = await open(page);
  await click(page, "Use new callback");
  await settled(page);
  await expect(calls(page)).toContainText('"A":{"start":1,"retry":0}');
  await click(page, "Resolve A start");
  await expect(publications(page)).toHaveText('["Lifecycle training store A:v2"]');
  await click(page, "Continue to menu");
  await expect(page.getByRole("heading", { name: "Lifecycle training menu" })).toBeVisible();
  await check();
});
for (const action of ["start", "retry"] as const) {
  test(`@demo Entry ignores stale ${action} success after client replacement`, async ({ page }) => {
    const check = await open(page);
    if (action === "retry") await retrying(page);
    await click(page, "Replace client");
    await expect(calls(page)).toContainText('"B":{"start":1,"retry":0}');
    await click(page, "Resolve B start");
    await expect(publications(page)).toHaveText('["Lifecycle training store B:v1"]');
    await click(page, `Resolve A ${action}`);
    await settled(page);
    await expect(publications(page)).toHaveText('["Lifecycle training store B:v1"]');
    await expect(
      page.getByRole("heading", { name: "Lifecycle training store B", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Lifecycle training store A", { exact: true })).toHaveCount(0);
    await check();
  });
  test(`@demo Entry ignores ${action} completion after unmount`, async ({ page }) => {
    const check = await open(page);
    if (action === "retry") await retrying(page);
    await click(page, "Unmount entry");
    await click(page, `Resolve A ${action}`);
    await settled(page);
    await expect(publications(page)).toHaveText("[]");
    await expect(page.getByText("Entry unmounted", { exact: true })).toBeVisible();
    await check();
  });
  test(`@demo Entry absorbs stale ${action} rejection after client replacement`, async ({
    page,
  }) => {
    const check = await open(page);
    if (action === "retry") await retrying(page);
    await click(page, "Replace client");
    await click(page, "Resolve B start");
    await expect(publications(page)).toHaveText('["Lifecycle training store B:v1"]');
    await click(page, `Fail A ${action}`);
    await check();
    await expect(publications(page)).toHaveText('["Lifecycle training store B:v1"]');
    await expect(
      page.getByRole("heading", { name: "Ordering is unavailable", exact: true }),
    ).toHaveCount(0);
  });
}
test("@demo Entry failed start and retry remain bounded with explicit recovery", async ({
  page,
}) => {
  const check = await open(page);
  await retrying(page);
  await click(page, "Fail A retry");
  await expect(
    page.getByRole("heading", { name: "Ordering is unavailable", exact: true }),
  ).toBeFocused();
  await expect(page.getByText("synthetic entry failure", { exact: false })).toHaveCount(0);
  await expect(publications(page)).toHaveText("[]");
  await click(page, "Try again");
  await click(page, "Resolve A retry");
  await expect(publications(page)).toHaveText('["Lifecycle training store A:v1"]');
  await expect(calls(page)).toContainText('"A":{"start":1,"retry":2}');
  await check();
});
for (const action of ["start", "retry"] as const) {
  test(`@demo Entry catches synchronous ${action} throws`, async ({ page }) => {
    const check = await open(page);
    await click(page, `Throw on ${action}`);
    if (action === "start") await click(page, "Replace client");
    else {
      await click(page, "Fail A start");
      await click(page, "Try again");
    }
    await expect(
      page.getByRole("heading", { name: "Ordering is unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(publications(page)).toHaveText("[]");
    await check();
  });
}
test("@demo Entry collapses duplicate retries while pending", async ({ page }) => {
  const check = await open(page);
  await click(page, "Fail A start");
  await page.getByRole("button", { name: "Try again", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(calls(page)).toContainText('"A":{"start":1,"retry":1}');
  await click(page, "Use new callback");
  await click(page, "Resolve A retry");
  await expect(publications(page)).toHaveText('["Lifecycle training store A:v2"]');
  await check();
});
test("@production Entry lifecycle controls are excluded", async ({ page }) => {
  const assets = new URL("../dist/assets/", import.meta.url);
  for (const name of (await readdir(assets)).filter((value) => value.endsWith(".js"))) {
    expect(await readFile(new URL(name, assets), "utf8")).not.toContain("Entry lifecycle training");
  }
  await page.goto("/?scenario=entry-lifecycle");
  await expect(page.getByLabel("Entry lifecycle training controls")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Scan the location QR code", exact: true }),
  ).toBeVisible();
});
