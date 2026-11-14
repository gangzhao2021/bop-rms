import type { Page } from "@playwright/test";

/** Orders v2: one row per order on the list (a heading with the button that opens it). */
export const orderRows = (page: Page) => page.locator("li.order-row");
/** Orders v2: the opened order (a side panel, or the whole page on a phone). */
export const orderPanel = (page: Page) => page.locator("aside.order-panel");

/** Orders v2: opens an order from its row. */
export async function openOrder(page: Page, orderNumber: string) {
  await page.getByRole("button", { name: orderNumber, exact: true }).click();
}

/** Orders v2: chooses one option behind "Filter" (date, type, channel, other statuses). */
export async function chooseOrderFilter(page: Page, group: string, option: string) {
  await page.getByRole("button", { name: /^Filter/u }).click();
  await page
    .getByRole("group", { name: group, exact: true })
    .getByRole("button", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
}
