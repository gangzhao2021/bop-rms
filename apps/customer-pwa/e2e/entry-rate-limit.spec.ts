import { expect, test } from "@playwright/test";
test.use({ trace: "off", screenshot: "off", video: "off" });
test("@production Entry waits for cooldown without automatic replay", async ({ page }) => {
  let calls = 0;
  await page.route("**/bff/customer/entry", async (route) => {
    calls++;
    await route.fulfill({
      status: calls === 1 ? 429 : 422,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "2",
      },
      body: JSON.stringify(
        calls === 1
          ? {
              schemaVersion: 1,
              code: "entry_rate_limited",
              messageKey: "customer.entry.rate_limited",
              recovery: { action: "RetryOrAskStaff", storeSelection: "Hidden" },
            }
          : {
              schemaVersion: 1,
              code: "entry_unavailable",
              messageKey: "customer.entry.unavailable",
              recovery: { action: "RescanOrAskStaff", storeSelection: "Hidden" },
            },
      ),
    });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Please wait before trying again" }),
  ).toBeFocused();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeDisabled();
  expect(calls).toBe(1);
  await expect(page.getByText("You can try again now.", { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  expect(calls).toBe(1);
  await retry.click();
  await expect(page.getByRole("heading", { name: "This entry link can’t be used" })).toBeVisible();
  expect(calls).toBe(2);
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
