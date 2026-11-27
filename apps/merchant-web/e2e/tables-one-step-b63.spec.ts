import { expect, test, type Page } from "@playwright/test";
import { accent, filledPrimaries } from "./tables-v3-look";
import { atWidth, floor, headers, splitBill, widths, zh } from "./tables-b63-fixture";

/**
 * b63 design review of v15 (bundle E, F34): one filled primary, for the step that is due now.
 */
const shots = process.env.B63_SHOTS ?? "test-results/b63-shots";

async function openT2(page: Page, chinese: boolean) {
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: chinese ? "选择 T2" : "Select T2", exact: true }).click();
  return page.getByRole("complementary", {
    name: chinese ? "所选桌台详情" : "Selected table details",
  });
}

for (const language of ["en", "zh-Hans"] as const) {
  const chinese = language === "zh-Hans";

  // T4 (v15 D62DV A): a just-seated table showed two filled buttons, Start checkout and Close,
  // while Take order (the step due) was a text link; Close ran on one tap.
  test(`@production b63: a table seated with nothing ordered has Take order as its one primary (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(page, { phase: "Active", version: 3, ordered: false }, { canTakeOrders: true });
    const panel = await openT2(page, chinese);
    const take = chinese ? "为桌台 T2 点单" : "Take order for table T2";
    await expect(panel.getByRole("link", { name: take })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: chinese ? "开始结账" : "Start checkout" }),
    ).toHaveCount(0);
    const close = panel.getByRole("button", {
      name: chinese ? "客人走了，关台" : "Guests left — close table",
    });
    await expect(close).toBeVisible();
    for (const width of widths) {
      await atWidth(page, width);
      expect(await filledPrimaries(panel)).toEqual([take]);
      expect(await close.evaluate((element) => getComputedStyle(element).color)).toBe(accent);
      await panel.screenshot({ path: `${shots}/seated-empty-${language}-${width}.png` });
    }
  });

  // T13: while a by-dish split was set up, the whole table's tip, payment method and payment
  // button stayed under a text-link "Split this way"; the full payment could be taken by mistake.
  test(`@production b63: setting up a split by dish holds back the whole table's payment (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(
      page,
      { phase: "Closing", version: 7 },
      { closeBlockers: ["ORDER_BALANCE_UNPAID"] },
    );
    const bill = await splitBill();
    bill.split = null;
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({ headers, json: bill }),
    );
    const panel = await openT2(page, chinese);
    const checkout = panel.getByRole("region", { name: chinese ? "结账" : "Checkout" });
    await expect(checkout.getByRole("group", { name: chinese ? "小费" : "Tip" })).toBeVisible();
    await checkout.getByRole("button", { name: chinese ? "按菜分" : "By dish" }).click();
    const split = chinese ? "按这样分" : "Split this way";
    await expect(checkout.getByRole("button", { name: split })).toBeVisible();
    await expect(checkout.getByRole("group", { name: chinese ? "小费" : "Tip" })).toHaveCount(0);
    await expect(
      checkout.getByRole("group", { name: chinese ? "付款方式" : "How the table pays" }),
    ).toHaveCount(0);
    for (const width of widths) {
      await atWidth(page, width);
      expect(await filledPrimaries(panel)).toEqual([split]);
      await checkout.screenshot({ path: `${shots}/by-dish-setup-${language}-${width}.png` });
    }
    // All together again: the whole table's payment is back.
    await checkout.getByRole("button", { name: chinese ? "整桌一起" : "All together" }).click();
    await expect(checkout.getByRole("group", { name: chinese ? "小费" : "Tip" })).toBeVisible();
  });
}
