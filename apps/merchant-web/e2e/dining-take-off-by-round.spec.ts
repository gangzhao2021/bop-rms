import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * v15 b21 live check: on the Tables page every round of a pay-at-end table that still had dishes
 * to take off showed a "Take dishes off the bill" button, all stacked under the totals with the
 * same name, so staff could tell which round each opened only by its place in the list. Each
 * round's action sits with that round, under its dishes, and names it.
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const shots23 = process.env.B23_SHOTS ?? "test-results-b23/shots";

/**
 * b23 (live22): the take-off confirm is one shared component; on Orders it drew as the filled
 * primary, on Tables as accent words beside Cancel. Brief §2 (v3): one filled primary (accent
 * background, white words) for the step being taken; Cancel is accent words.
 */
async function confirmLooks(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
}
const filledPrimary = { background: "rgb(31, 99, 224)", color: "rgb(255, 255, 255)" };

for (const zh of [false, true]) {
  test(`@production each round's take-off action is with that round and names it (${zh ? "zh-Hans" : "en"})`, async ({
    page,
  }) => {
    if (zh)
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          // The page still renders in English.
        }
      });
    const scope = {
      brandLabel: "Synthetic Brand",
      storeLabel: "Synthetic Store",
      storeReference: id(99),
    };
    await page.route("**/merchant/session", (route) =>
      route.fulfill({
        headers,
        json: {
          authenticated: true,
          csrf,
          workspace: {
            screenId: "HOME-OVERVIEW",
            selectedScope: scope,
            authorizedStores: [scope],
            businessDate: "2026-10-27",
            storeStatus: "Open",
            freshness: "Current",
            dashboardAvailability: "UnavailableUntilWP1905",
            navigation: [
              {
                screenId: "DIN-FLOOR-BOARD",
                label: "Tables",
                href: "/operations/dining",
                permission: "dining.operate",
              },
            ],
          },
        },
      }),
    );
    await page.route("**/merchant/dining/tables", (route) =>
      route.fulfill({
        headers,
        json: {
          canOperateTables: false,
          canCloseSessions: true,
          canTransferHost: false,
          canCancelUnpaidRounds: true,
          canWriteOff: true,
          items: [
            {
              tableReference: id(31),
              stableLabel: "T3",
              areaCode: "MAIN",
              capacity: 4,
              lifecycle: "Published",
              operationalState: "Available",
              blockReasonCode: null,
              aggregateVersion: 2,
              currentDiningSessionReference: id(71),
              elapsedMinutes: 48,
              qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
              paymentTiming: "PayLater",
              session: { phase: "Active", version: 3, orderReference: id(1) },
              staffRoundsAwaitingPayment: [],
              guestRoundsAwaitingPayment: [],
              roundsAwaitingAcceptance: [],
              staffCall: null,
            },
          ],
          nextAfterTableReference: null,
        },
      }),
    );
    const line = (n: number, round: number, name: string) => ({
      orderItemReference: id(200 + n),
      orderBatchReference: id(50 + round),
      name,
      options: [],
      quantity: 1,
      customerNote: null,
      unitPrice: money("1000"),
      subtotal: money("1000"),
      discount: money("0"),
      tax: money("130"),
      fee: money("0"),
      total: money("1130"),
      canCancel: false,
      cancellation: null,
    });
    const batch = (round: number, removable: string[]) => ({
      orderBatchReference: id(50 + round),
      sequence: round,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
      unpaidRemovableItems: removable,
      unpaidRemovedItems: [],
      compableItems: [],
      compedItems: [],
    });
    // Three rounds: the first was served (nothing to take off), the other two not started yet.
    const order = {
      orderReference: id(1),
      orderNumber: "T-1",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-10-27T23:00:00.000Z",
      observedAt: "2026-10-27T23:40:00.000Z",
      initialBatchReference: id(51),
      batches: [batch(1, []), batch(2, [id(202)]), batch(3, [id(203)])],
      canRequestAcceptance: false,
      tableBill: { totalMinor: "3390", paid: null },
      currentPhase: "InProgress",
      currentVersion: 3,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: false,
    };
    await page.route("**/merchant/orders*", (route) =>
      route.fulfill({ headers, json: { items: [order], nextAfterOrderReference: null } }),
    );
    await page.route("**/merchant/orders/detail*", (route) =>
      route.fulfill({
        headers,
        json: {
          screenId: "OPS-ORDER-DETAIL",
          pickupContact: null,
          order,
          lines: {
            items: [
              line(1, 1, "Synthetic rice bowl"),
              line(2, 2, "Synthetic soup"),
              line(3, 3, "Synthetic tea"),
            ],
            totals: {
              subtotal: money("3000"),
              discount: money("0"),
              tax: money("390"),
              fee: money("0"),
              taxRounding: money("0"),
              total: money("3390"),
            },
          },
        },
      }),
    );
    const previewed: { orderBatchReference: string }[] = [];
    await page.route("**/merchant/orders/remove-unpaid-items/preview", (route) => {
      previewed.push(route.request().postDataJSON() as { orderBatchReference: string });
      return route.fulfill({ headers, json: { status: "Preview", totalMinor: "1130" } });
    });

    await page.goto("/operations/dining");
    await page.getByRole("button", { name: zh ? "选择 T3" : "Select T3", exact: true }).click();
    const details = page.getByRole("complementary", {
      name: zh ? "所选桌台详情" : "Selected table details",
    });
    const tableOrder = details.getByRole("region", {
      name: zh ? "这桌的订单" : "This table's order",
    });
    const round = (n: number) =>
      tableOrder.getByRole("region", { name: zh ? `第 ${n} 轮` : `Round ${n}`, exact: true });
    const takeOff = (n: number) => (zh ? `从第 ${n} 轮删菜` : `Take dishes off round ${n}`);
    // Each round still open has its own action, inside the round, named by it; the served round
    // has none, and no action is left nameless under the totals.
    await expect(round(2).getByRole("button", { name: takeOff(2) })).toBeVisible();
    await expect(round(3).getByRole("button", { name: takeOff(3) })).toBeVisible();
    await expect(round(1).getByRole("button", { name: /删菜|Take dishes off/u })).toHaveCount(0);
    await expect(details.getByRole("button", { name: /从账单删菜|off the bill/u })).toHaveCount(0);
    const totals = tableOrder.locator(".order-lines-totals").first();
    const top = async (locator: ReturnType<typeof page.locator>) => {
      const box = await locator.boundingBox();
      if (box === null) throw new Error("not laid out");
      return box.y;
    };
    for (const n of [2, 3]) {
      const button = await top(round(n).getByRole("button", { name: takeOff(n) }));
      expect(button).toBeGreaterThan(await top(round(n).getByRole("listitem").first()));
      expect(button).toBeLessThan(await top(totals));
    }
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/dining-take-off-by-round-${zh ? "zh-Hans" : "en"}-${width}.png`,
        fullPage: true,
      });
    }
    // Opening round 3's action opens round 3's dishes only, in round 3.
    await page.setViewportSize({ width: 1440, height: 900 });
    await round(3)
      .getByRole("button", { name: takeOff(3) })
      .click();
    const group = round(3).getByRole("group", { name: takeOff(3) });
    // b23: the opener is replaced by the panel, so the panel takes the focus.
    await expect(group).toBeFocused();
    await expect(group.locator(".pay-later-remove__lines label")).toHaveText([
      zh
        ? "1 × Synthetic tea · 账单减 $11.30（含税）"
        : "1 × Synthetic tea · bill goes down $11.30 with tax",
    ]);
    await group.getByRole("checkbox").check();
    await expect.poll(() => previewed.at(-1)?.orderBatchReference).toBe(id(53));
    await expect(round(2).getByRole("button", { name: takeOff(2) })).toBeVisible();
    // b23: with a reason, the confirm is the filled primary, as on Orders.
    await group.getByRole("combobox").selectOption({ index: 1 });
    const confirm = group.getByRole("button", {
      name: zh ? "删掉整轮 · $11.30" : "Take the whole round off · $11.30",
    });
    await expect(confirm).toBeEnabled();
    expect(await confirmLooks(confirm)).toEqual(filledPrimary);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({
        path: `${shots23}/tables-take-off-confirm-${zh ? "zh-Hans" : "en"}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({
        path: `test-results/dining-take-off-by-round-open-${zh ? "zh-Hans" : "en"}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id),
    ).toEqual([]);
    // b23: Cancel gives the focus back to the round's opener.
    await group.getByRole("button", { name: zh ? "取消" : "Cancel" }).click();
    await expect(round(3).getByRole("button", { name: takeOff(3) })).toBeFocused();
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });
}
