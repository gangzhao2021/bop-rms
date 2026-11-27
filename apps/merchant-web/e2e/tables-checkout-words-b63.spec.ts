import { expect, test, type Page } from "@playwright/test";
import { atWidth, box, floor, headers, splitBill, widths, zh } from "./tables-b63-fixture";

/**
 * b63 design review of v15 (bundle E): F40 (a part's cash), T15 (words) and T16 (the payment's
 * confirm without divider lines), at 390, 1024 and 1440 in English and Chinese.
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

  test(`@production b63: a part in cash says the cash to ask for; its confirm has no divider lines (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(
      page,
      { phase: "Closing", version: 7 },
      { closeBlockers: ["ORDER_BALANCE_UNPAID"] },
    );
    const bill = await splitBill();
    // T15: two of a dish, as the round lines say it.
    const [first] =
      (bill.rounds as { items: { quantity: number; options?: unknown }[] }[])[0]?.items ?? [];
    if (first !== undefined) {
      first.quantity = 2;
      // b63 review (T15): the dish's options, on a grey line under it.
      first.options = [{ name: "Hot (TEST)", quantity: 1 }];
    }
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({ headers, json: bill }),
    );
    await page.route("**/merchant/dining/table-settle", (route) => {
      const paid = structuredClone(bill) as typeof bill & {
        split: { parts: Record<string, unknown>[]; paidParts: number; remainingMinor: string };
      };
      paid.split.parts[0] = {
        ...paid.split.parts[0],
        payment: {
          method: "Cash",
          tipMinor: "0",
          roundingMinor: "1",
          totalMinor: "3165",
          tenderedMinor: "4000",
          changeMinor: "835",
          recordedAt: "2026-11-25T19:10:00.000Z",
          recordedAfterOutage: false,
        },
      };
      paid.split.paidParts = 1;
      paid.split.remainingMinor = "3164";
      return route.fulfill({ headers, json: { status: "Recorded", bill: paid } });
    });
    const panel = await openT2(page, chinese);
    const checkout = panel.getByRole("region", { name: chinese ? "结账" : "Checkout" });
    await expect(checkout.locator(".table-checkout__rounds")).toContainText("2 × Mapo tofu (TEST)");
    const options = checkout.locator(".table-checkout__options");
    await expect(options).toHaveText("Hot (TEST)");
    for (const width of widths) {
      await atWidth(page, width);
      const [look, dish] = await Promise.all([
        options.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.fontWeight];
        }),
        box(checkout.locator(".table-checkout__rounds li li").first()),
      ]);
      expect(look, `${width}`).toEqual(["14px", "400"]);
      // On a line of its own under the dish's name.
      expect((await box(options)).y, `${width}`).toBeGreaterThan(dish.y + 8);
    }
    await checkout
      .getByRole("button", { name: chinese ? "收这一份" : "Collect this part" })
      .first()
      .click();
    // T15: collecting one part, the payment block is about that part.
    await expect(
      checkout.getByRole("group", { name: chinese ? "这份怎么付" : "How this part is paid" }),
    ).toBeVisible();
    await checkout.getByRole("radio", { name: chinese ? "不加小费" : "No tip" }).check();
    await checkout.getByRole("radio", { name: chinese ? "现金" : "Cash", exact: true }).check();
    // F40: the part line names the cash to ask for and how it is made up.
    const parts = checkout.locator(".table-split__parts");
    await expect(parts).toContainText(
      chinese
        ? "第 1 份 · 现金 $31.65（$31.64，取整 +1¢）"
        : "Part 1 · $31.65 cash ($31.64 + 1¢ rounding)",
    );
    await checkout
      .getByRole("textbox", { name: chinese ? "实收现金" : "Cash received" })
      .fill("40");
    await checkout
      .getByRole("button", { name: chinese ? "已收现金 · $31.65" : "Cash received · $31.65" })
      .click();
    const confirm = checkout.getByRole("alertdialog", {
      name: chinese ? "确认收款" : "Confirm the payment",
    });
    for (const width of widths) {
      await atWidth(page, width);
      // T16: no top or bottom line around it (hairlines are for list rows); 24 px of space instead.
      const look = await confirm.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopWidth, style.borderBottomWidth, style.marginTop, style.marginBottom];
      });
      expect(look, `${width}`).toEqual(["0px", "0px", "24px", "24px"]);
      await confirm.screenshot({ path: `${shots}/part-confirm-${language}-${width}.png` });
    }
    await confirm.getByRole("button", { name: /\$31\.65/u }).click();
    await expect(checkout.locator(".table-split__parts")).toContainText(
      chinese ? "已付 $31.65 · 现金" : "Paid $31.65 · cash",
    );
    // T15: once every part is paid, the paid record says the change was given (handed over).
    const allPaid = structuredClone(bill) as typeof bill & {
      split: {
        parts: Record<string, unknown>[];
        paidParts: number;
        remainingMinor: string;
        paidInFull?: boolean;
      };
      owed: Record<string, string>;
    };
    for (const part of allPaid.split.parts)
      part.payment = {
        method: "Cash",
        tipMinor: "0",
        roundingMinor: "1",
        totalMinor: "3165",
        tenderedMinor: "4000",
        changeMinor: "835",
        recordedAt: "2026-11-25T19:10:00.000Z",
        recordedAfterOutage: false,
      };
    allPaid.split.paidParts = 2;
    allPaid.split.remainingMinor = "0";
    allPaid.owed = { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" };
    await page.unroute("**/merchant/dining/table-bill");
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({ headers, json: allPaid }),
    );
    await page.reload();
    await page
      .getByRole("button", { name: chinese ? "选择 T2" : "Select T2", exact: true })
      .click();
    await expect(checkout).toContainText(chinese ? "已找零$8.35" : "Change given$8.35");
    if (!chinese) await expect(checkout).not.toContainText("Change to give");
  });

  // T15: a free table read "空闲" in its panel but "空桌" on its tab and list.
  test(`@production b63: a free table's panel says Free, as its tab does (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(page, { phase: "Active", version: 6 });
    await page.goto("/operations/dining");
    await page
      .getByRole("button", { name: chinese ? "选择 F1" : "Select F1", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: chinese ? "所选桌台详情" : "Selected table details",
    });
    await expect(panel.locator(".table-panel__meta").first()).toHaveText(
      chinese ? "2 座 · 空桌" : "Seats 2 · Free",
    );
  });
}
