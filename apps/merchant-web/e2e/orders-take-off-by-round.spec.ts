import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * v15 live21 (TM2 Order 9, a pay-at-end table: Beef noodles / Soy milk + Smashed cucumber / Beef
 * noodles), on Orders:
 * - the Order page and the workbench put "Take dishes off round N" between the round's heading and
 *   its dishes, where Tables puts it under them;
 * - on the workbench it was a link to the order's page, which opened with no panel, so staff
 *   pressed a second button of the same name;
 * - the panel listed "Smashed cucumber · price $7.07" beside "Take off $7.06";
 * - with nothing ticked the round's panel button read "Take dishes off the bill".
 * b22: the action sits under the round's dishes on both; the workbench opens the panel in place,
 * and the order's page opens it on arrival; each dish says what the bill goes down by.
 */
const id = (n: number) => "01909970-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const shots = process.env.B22_SHOTS ?? "test-results-b22/shots";
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

interface MockState {
  detailFails: boolean;
  /** The order's dishes answer only once this settles (the workbench is still reading them). */
  hold?: Promise<void> | undefined;
  /** false: round 3 can no longer come off (taken off or started elsewhere meanwhile). */
  round3Removable?: boolean;
}

async function mock(page: Page, zh: boolean, state: MockState) {
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
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-11-16",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
  const line = (n: number, round: number, name: string, sub: string, tax: string, tot: string) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(50 + round),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money(sub),
    subtotal: money(sub),
    discount: money("0"),
    tax: money(tax),
    fee: money("0"),
    total: money(tot),
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
  const billRound = (round: number, subtotal: string, tax: string, total: string) => ({
    orderBatchReference: id(50 + round),
    subtotalMinor: subtotal,
    taxMinor: tax,
    totalMinor: total,
  });
  // The live bill: $38.99 (tax worked out once), round 2 carries the bill's −1¢.
  const orderNow = () => ({
    orderReference: id(1),
    orderNumber: "9",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-16T05:32:48.000Z",
    observedAt: "2026-11-16T05:39:00.000Z",
    initialBatchReference: id(51),
    batches: [
      batch(1, []),
      batch(2, [id(202), id(203)]),
      batch(3, state.round3Removable === false ? [] : [id(204)]),
    ],
    canRequestAcceptance: false,
    tableBill: {
      totalMinor: "3899",
      paid: null,
      rounds: [
        billRound(1, "1250", "163", "1413"),
        billRound(2, "950", "123", "1073"),
        billRound(3, "1250", "163", "1413"),
      ],
    },
    currentPhase: "InProgress",
    currentVersion: 7,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [orderNow()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", async (route) => {
    await state.hold;
    return state.detailFails
      ? route.fulfill({ status: 503, headers, json: { error: "unavailable" } })
      : route.fulfill({
          headers,
          json: {
            screenId: "OPS-ORDER-DETAIL",
            pickupContact: null,
            order: orderNow(),
            lines: {
              items: [
                line(1, 1, "Beef noodles (TEST)", "1250", "163", "1413"),
                line(2, 2, "Soy milk", "325", "42", "367"),
                line(3, 2, "Smashed cucumber", "625", "82", "707"),
                line(4, 3, "Beef noodles (TEST)", "1250", "163", "1413"),
              ],
              totals: {
                subtotal: money("3450"),
                discount: money("0"),
                tax: money("450"),
                fee: money("0"),
                taxRounding: money("0"),
                total: money("3900"),
              },
            },
          },
        });
  });
  // What the bill goes down by (the server's preview on the live bill).
  await page.route("**/merchant/orders/remove-unpaid-items/preview", (route) => {
    const items = (route.request().postDataJSON() as { orderItemReferences: string[] })
      .orderItemReferences;
    const total =
      items.length === 2
        ? "1074"
        : items[0] === id(202)
          ? "367"
          : items[0] === id(203)
            ? "706"
            : "1412";
    return route.fulfill({ headers, json: { status: "Preview", totalMinor: total } });
  });
}

const top = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not laid out");
  return box.y;
};

async function shoot(page: Page, name: string, widths = [1440, 1024, 390]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const zh of [false, true]) {
  const lang = zh ? "zh-Hans" : "en";
  const takeOff = (n: number) => (zh ? `从第 ${n} 轮删菜` : `Take dishes off round ${n}`);
  const roundName = (n: number) => (zh ? `第 ${n} 轮` : `Round ${n}`);

  test(`@production b22: an order's page puts each round's take-off under its dishes, and the dish and the button agree (${lang})`, async ({
    page,
  }) => {
    await mock(page, zh, { detailFails: false });
    await page.goto("/operations/orders/" + id(1));
    const round = (n: number) => page.getByRole("region", { name: roundName(n), exact: true });
    await expect(round(2).getByRole("button", { name: takeOff(2) })).toBeVisible();
    await expect(round(3).getByRole("button", { name: takeOff(3) })).toBeVisible();
    await expect(round(1).getByRole("button", { name: /删菜|Take dishes off/u })).toHaveCount(0);
    const totals = page.locator(".order-lines-totals").first();
    for (const n of [2, 3]) {
      const button = await top(round(n).getByRole("button", { name: takeOff(n) }));
      // Under the round's last dish, above the next round and the totals.
      expect(button).toBeGreaterThan(await top(round(n).getByRole("listitem").last()));
      expect(button).toBeLessThan(await top(totals));
    }
    expect(await top(round(2).getByRole("button", { name: takeOff(2) }))).toBeLessThan(
      await top(round(3)),
    );
    await shoot(page, `orders-page-by-round-${lang}`);

    await round(2)
      .getByRole("button", { name: takeOff(2) })
      .click();
    const group = round(2).getByRole("group", { name: takeOff(2) });
    // b23: the opener is replaced by the panel, so the panel takes the focus.
    await expect(group).toBeFocused();
    const choices = group.locator(".pay-later-remove__lines label");
    const down = (amount: string) =>
      zh ? `账单减 ${amount}（含税）` : `bill goes down ${amount} with tax`;
    await expect(choices).toHaveText([
      `1 × Soy milk · ${down("$3.67")}`,
      `1 × Smashed cucumber · ${down("$7.06")}`,
    ]);
    // Nothing ticked: a prompt for this round's dishes, which can't be pressed.
    const empty = group.getByRole("button", {
      name: zh ? "请选要从第 2 轮删的菜" : "Choose dishes to take off round 2",
    });
    await expect(empty).toBeDisabled();
    await expect(page.getByRole("button", { name: /从账单删菜|off the bill/u })).toHaveCount(0);
    await choices.nth(1).getByRole("checkbox").check();
    await expect(
      group.getByRole("button", { name: zh ? "删掉 $7.06" : "Take off $7.06" }),
    ).toBeVisible();
    // The panel opens under the round's dishes, so they stay where they were.
    expect(await top(group)).toBeGreaterThan(await top(round(2).getByRole("listitem").nth(1)));
    await shoot(page, `orders-page-round2-panel-${lang}`);
    // Both: a cent more than the dishes' figures and the round's $10.73, said why.
    await choices.nth(0).getByRole("checkbox").check();
    await expect(
      group.getByRole("button", {
        name: zh ? "删掉整轮 · $10.74" : "Take the whole round off · $10.74",
      }),
    ).toBeVisible();
    await expect(group.locator(".pay-later-remove__note")).toHaveText(
      zh
        ? "第 2 轮在账单上是 $10.73；整轮删掉，账单减 $10.74，因为税按整张账单算一次。"
        : "Round 2 reads $10.73 on the bill; taking it all off takes $10.74 off, because tax is worked out once on the whole bill.",
    );
    await shoot(page, `orders-page-round2-whole-${lang}`);
    // b23: with a reason, the confirm is the filled primary (as on Tables), with room above the
    // order's Subtotal.
    await group.getByRole("combobox").selectOption({ index: 1 });
    const confirm = group.getByRole("button", {
      name: zh ? "删掉整轮 · $10.74" : "Take the whole round off · $10.74",
    });
    await expect(confirm).toBeEnabled();
    expect(await confirmLooks(confirm)).toEqual(filledPrimary);
    // Room under the panel: before the next round's line, and (last round) before Subtotal.
    const roomUnder = async (panel: Locator, next: Locator) => {
      const box = await panel.boundingBox();
      if (box === null) throw new Error("not laid out");
      return (await top(next)) - (box.y + box.height);
    };
    expect(await roomUnder(group, round(3))).toBeGreaterThanOrEqual(16);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({
        path: `${shots23}/orders-page-take-off-confirm-${lang}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // Cancel gives the focus back to the round's opener.
    await group.getByRole("button", { name: zh ? "取消" : "Cancel" }).click();
    await expect(round(2).getByRole("button", { name: takeOff(2) })).toBeFocused();
    await round(3)
      .getByRole("button", { name: takeOff(3) })
      .click();
    const last = round(3).getByRole("group", { name: takeOff(3) });
    await expect(last).toBeFocused();
    expect(await roomUnder(last, totals)).toBeGreaterThanOrEqual(16);
    await shoot(page, `orders-page-round3-panel-${lang}`);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id),
    ).toEqual([]);
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });

  test(`@production b22: on the Orders workbench a round's take-off opens in place, and its page opens it on arrival (${lang})`, async ({
    page,
  }) => {
    const state = { detailFails: false };
    await mock(page, zh, state);
    const openRow = async () => {
      const opener = page.locator("li.order-row").first().locator(".order-row__open");
      await expect(opener).toBeVisible();
      // The one order listed opens by itself.
      if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
    };
    await page.goto("/operations/orders");
    await openRow();
    const panel = page.locator("aside.order-panel");
    const round = (n: number) => panel.getByRole("region", { name: roundName(n), exact: true });
    // A button under the round's dishes, never a link to press the same name again.
    const action = round(2).getByRole("button", { name: takeOff(2) });
    await expect(action).toBeVisible();
    await expect(round(2).getByRole("link", { name: takeOff(2) })).toHaveCount(0);
    expect(await top(action)).toBeGreaterThan(await top(round(2).getByRole("listitem").last()));
    await shoot(page, `orders-workbench-by-round-${lang}`);
    await action.click();
    await expect(page).toHaveURL(/\/operations\/orders(\?.*)?$/u);
    await expect(round(2).getByRole("group", { name: takeOff(2) })).toBeVisible();
    // b23: in place, the panel takes the focus from the opener it replaced.
    await expect(round(2).getByRole("group", { name: takeOff(2) })).toBeFocused();
    {
      const group = round(2).getByRole("group", { name: takeOff(2) });
      await group.locator(".pay-later-remove__lines label").nth(1).getByRole("checkbox").check();
      await group.getByRole("combobox").selectOption({ index: 1 });
      const confirm = group.getByRole("button", { name: zh ? "删掉 $7.06" : "Take off $7.06" });
      await expect(confirm).toBeEnabled();
      expect(await confirmLooks(confirm)).toEqual(filledPrimary);
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.screenshot({
          path: `${shots23}/orders-workbench-take-off-confirm-${lang}-${width}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await shoot(page, `orders-workbench-round2-panel-${lang}`);

    // The order's dishes could not be read on the workbench: the round's link opens its page
    // with that round's panel open and the focus on it (the URL names no round).
    state.detailFails = true;
    await page.goto("/operations/orders");
    await openRow();
    const link = round(3).getByRole("link", { name: takeOff(3) });
    await expect(link).toBeVisible();
    state.detailFails = false;
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/operations/orders/${id(1)}$`, "u"));
    const page3 = page.getByRole("region", { name: roundName(3), exact: true });
    const group = page3.getByRole("group", { name: takeOff(3) });
    await expect(group).toBeVisible();
    await expect(group).toBeFocused();
    await expect(page3.getByRole("button", { name: takeOff(3) })).toHaveCount(0);
    await expect(group.locator(".pay-later-remove__lines label")).toHaveText([
      zh
        ? "1 × Beef noodles (TEST) · 账单减 $14.12（含税）"
        : "1 × Beef noodles (TEST) · bill goes down $14.12 with tax",
    ]);
    // Round 3 reads $14.13 on the bill; taking it all off takes $14.12 off, said why.
    await group.getByRole("checkbox").check();
    await expect(group.locator(".pay-later-remove__note")).toHaveText(
      zh
        ? "第 3 轮在账单上是 $14.13；整轮删掉，账单减 $14.12，因为税按整张账单算一次。"
        : "Round 3 reads $14.13 on the bill; taking it all off takes $14.12 off, because tax is worked out once on the whole bill.",
    );
    await shoot(page, `orders-arrival-round3-${lang}`);
    // Reloading does not open it again.
    await page.reload();
    await expect(page3.getByRole("button", { name: takeOff(3) })).toBeVisible();
    await expect(page3.getByRole("group", { name: takeOff(3) })).toHaveCount(0);
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });

  test(`@production b22 review: the workbench waits in place for a round's dishes, and an arrival for a round that can no longer come off is spent (${lang})`, async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const state: MockState = {
      detailFails: false,
      hold: new Promise<void>((done) => {
        release = done;
      }),
    };
    await mock(page, zh, state);
    await page.goto("/operations/orders");
    const opener = page.locator("li.order-row").first().locator(".order-row__open");
    await expect(opener).toBeVisible();
    if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
    const panel = page.locator("aside.order-panel");
    const round = (n: number) => panel.getByRole("region", { name: roundName(n), exact: true });
    // While the dishes are read: the same button in the same place, not pressable yet, and never
    // a link to the order's page.
    const waiting = round(2).getByRole("button", { name: takeOff(2) });
    await expect(waiting).toBeDisabled();
    await expect(round(2).getByRole("link", { name: takeOff(2) })).toHaveCount(0);
    release();
    await expect(waiting).toBeEnabled();
    await expect(page).toHaveURL(/\/operations\/orders(\?.*)?$/u);

    // The dishes can't be read on the workbench: staff follow round 3's link, but meanwhile its
    // dish came off elsewhere. Its panel can't open, and the arrival is spent: once the round
    // could come off again, a reload doesn't open its panel by surprise.
    state.hold = undefined;
    state.detailFails = true;
    await page.goto("/operations/orders");
    if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
    const link = round(3).getByRole("link", { name: takeOff(3) });
    await expect(link).toBeVisible();
    state.detailFails = false;
    state.round3Removable = false;
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/operations/orders/${id(1)}$`, "u"));
    const page2 = page.getByRole("region", { name: roundName(2), exact: true });
    const page3 = page.getByRole("region", { name: roundName(3), exact: true });
    await expect(page2.getByRole("button", { name: takeOff(2) })).toBeVisible();
    await expect(page3.getByRole("button", { name: takeOff(3) })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.history.state as { usr?: { takeOffRound?: unknown } } | null)?.usr
              ?.takeOffRound,
        ),
      )
      .toBeUndefined();
    state.round3Removable = true;
    await page.reload();
    await expect(page3.getByRole("button", { name: takeOff(3) })).toBeVisible();
    await expect(page3.getByRole("group", { name: takeOff(3) })).toHaveCount(0);
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });
}
