import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 60 (v15 b59 live, TM2 L59S B, staff-refund-lines leftOpen): a comp covered only a whole
 * line ("2 × Beef noodles" together), so to comp the one bowl that was wrong staff used "Amount off
 * (one dish)", which hid that it was a comp. A manager now comps 1 of the 2 from the same panel,
 * with the same reason and confirm, and later the other one; the line keeps its price and each
 * comp stays listed with its count. Synthetic Store; the server is mocked in the shape v15 reads
 * (Beef noodles (TEST) $12.50 a bowl, 13 % TEST tax).
 */
const id = (n: number) => "01909972-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const noodles = id(201);
const tea = id(202);
const shots = process.env.B60_SHOTS ?? "test-results-b60/shots";
const widths = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

interface Comp {
  readonly quantity: number;
  readonly amountMinor: string;
  readonly reasonCode: string;
  readonly decidedAt: string;
}

async function signedIn(page: Page, zh: boolean, screen: "Tables" | "Orders") {
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
          businessDate: "2026-11-24",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            screen === "Tables"
              ? {
                  screenId: "DIN-FLOOR-BOARD",
                  label: "Tables",
                  href: "/operations/dining",
                  permission: "dining.operate",
                }
              : {
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
}

/** The table's order: 2 × Beef noodles (TEST) and a tea, with the comps recorded so far. */
async function tableOrder(page: Page, comps: Comp[], phase: "Active" | "Closing" = "Active") {
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
            tableReference: id(70),
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
            session: { phase, version: 3, orderReference: id(1) },
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
  const compedSoFar = () => comps.reduce((sum, comp) => sum + comp.quantity, 0);
  const takenOff = () => comps.reduce((sum, comp) => sum + Number(comp.amountMinor), 0);
  const order = () => ({
    orderReference: id(1),
    orderNumber: "33",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-24T13:00:00.000Z",
    observedAt: "2026-11-24T13:40:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        unpaidRemovableItems: [],
        unpaidRemovedItems: [],
        compableItems: compedSoFar() < 2 ? [noodles, tea] : [tea],
        compedItems: comps.map((comp) => ({
          orderItemReference: noodles,
          kind: "Comp",
          percent: null,
          amountMinor: comp.amountMinor,
          reasonCode: comp.reasonCode,
          decidedAt: comp.decidedAt,
          byLabel: "You",
          compedQuantity: comp.quantity,
          lineQuantity: 2,
        })),
      },
    ],
    canRequestAcceptance: false,
    tableBill: { totalMinor: String(3254 - takenOff()), paid: null },
    currentPhase: "InProgress",
    currentVersion: 3 + comps.length,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  const line = (
    reference: string,
    name: string,
    quantity: number,
    subtotal: string,
    tax: string,
    total: string,
  ) => ({
    orderItemReference: reference,
    orderBatchReference: id(51),
    name,
    options: [],
    quantity,
    customerNote: null,
    unitPrice: money(String(Number(subtotal) / quantity)),
    subtotal: money(subtotal),
    discount: money("0"),
    tax: money(tax),
    fee: money("0"),
    total: money(total),
    canCancel: false,
    cancellation: null,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(),
        lines: {
          items: [
            line(noodles, "Beef noodles (TEST)", 2, "2500", "325", "2825"),
            line(tea, "Jasmine tea (TEST)", 1, "380", "49", "429"),
          ],
          totals: {
            subtotal: money("2880"),
            discount: money("0"),
            tax: money("374"),
            fee: money("0"),
            taxRounding: money("0"),
            total: money("3254"),
          },
        },
      },
    }),
  );
  return { compedSoFar };
}

/** Each signed amount on one line with ~40 px to spare on its row (Linux fonts are wider). */
async function signedAmountsHold(list: Locator, page: Page) {
  const found = await list.locator("li > span.bop-amount").evaluateAll((elements) =>
    elements.map((element) => {
      const row = element.closest("li");
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        text: element.textContent ?? "",
        lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        spare: (row?.getBoundingClientRect().width ?? 0) - element.getBoundingClientRect().width,
      };
    }),
  );
  expect(found.length).toBeGreaterThan(0);
  for (const amount of found) {
    expect(amount.lines, amount.text).toBe(1);
    expect(amount.spare, amount.text).toBeGreaterThanOrEqual(40);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  test(`@production batch 60: a manager comps 1 of 2 Beef noodles, then the other, from Tables (${language})`, async ({
    page,
  }) => {
    await signedIn(page, zh, "Tables");
    const comps: Comp[] = [];
    const { compedSoFar } = await tableOrder(page, comps);
    const previews: Record<string, unknown>[] = [];
    const sent: Record<string, unknown>[] = [];
    /** What the server takes off: one bowl $14.13, the line $28.25, the last bowl $14.12. */
    const amountOf = (body: {
      orderItemReferences: string[];
      compQuantities?: { orderItemReference: string; quantity: number }[];
    }) =>
      body.orderItemReferences.map((item) => {
        if (item === tea) return { item, quantity: null, amountMinor: "429" };
        const left = 2 - compedSoFar();
        const quantity =
          body.compQuantities?.find((entry) => entry.orderItemReference === item)?.quantity ?? left;
        return {
          item,
          quantity,
          amountMinor: compedSoFar() === 1 ? "1412" : quantity === 1 ? "1413" : "2825",
        };
      });
    await page.route("**/merchant/orders/comp-items/preview", (route) => {
      const body = route.request().postDataJSON() as Parameters<typeof amountOf>[0];
      previews.push(body as never);
      const lines = amountOf(body);
      return route.fulfill({
        headers,
        json: {
          status: "Preview",
          totalMinor: String(lines.reduce((sum, entry) => sum + Number(entry.amountMinor), 0)),
          lines: lines.map((entry) => ({
            orderItemReference: entry.item,
            amountMinor: entry.amountMinor,
          })),
        },
      });
    });
    await page.route("**/merchant/orders/comp-items", (route) => {
      const body = route.request().postDataJSON() as Parameters<typeof amountOf>[0] & {
        reasonCode: string;
      };
      sent.push(body as never);
      const [entry] = amountOf(body);
      comps.push({
        quantity: entry?.quantity ?? 1,
        amountMinor: entry?.amountMinor ?? "0",
        reasonCode: body.reasonCode,
        decidedAt: comps.length === 0 ? "2026-11-24T13:13:00.000Z" : "2026-11-24T13:21:00.000Z",
      });
      return route.fulfill({ headers, json: { status: "Recorded", reductions: [] } });
    });

    await page.goto("/operations/dining");
    await page.getByRole("button", { name: zh ? "选择 T3" : "Select T3", exact: true }).click();
    const details = page.getByRole("complementary", {
      name: zh ? "所选桌台详情" : "Selected table details",
    });
    const title = zh ? "免单或折让" : "Comp or discount";
    const down = (amount: string) =>
      zh ? `账单减 ${amount}（含税）` : `bill goes down ${amount} with tax`;
    await details.getByRole("button", { name: title }).click();
    const group = details.getByRole("group", { name: title });
    const dishes = group.locator(".pay-later-remove__lines li > label");
    await expect(dishes).toHaveText([
      `2 × Beef noodles (TEST) · ${down("$28.25")}`,
      `1 × Jasmine tea (TEST) · ${down("$4.29")}`,
    ]);
    await dishes.nth(0).getByRole("checkbox").check();
    const count = group.getByRole("combobox", { name: zh ? "免单份数" : "Dishes to comp" });
    // The whole line by default, as before; one bowl is a choice.
    await expect(count).toHaveValue("2");
    await expect(count.locator("option")).toHaveText(
      zh ? ["2 份中的 2 份", "2 份中的 1 份"] : ["2 of 2", "1 of 2"],
    );
    await expect(
      group.getByRole("button", { name: zh ? "免单 $28.25" : "Comp $28.25" }),
    ).toBeVisible();
    await count.selectOption("1");
    const confirm = group.getByRole("button", { name: zh ? "免单 $14.13" : "Comp $14.13" });
    await expect(confirm).toBeVisible();
    // Batch 61 (v15 b60 live): the dish follows the count chosen, with what that count takes off
    // (the amount the button names and the comp records).
    await expect(dishes.nth(0)).toHaveText(
      zh
        ? `Beef noodles (TEST) · 2 份中的 1 份 · ${down("$14.13")}`
        : `1 of 2 × Beef noodles (TEST) · ${down("$14.13")}`,
    );
    await group.getByRole("radio", { name: zh ? "上错菜" : "Wrong dish served" }).check();
    // The panel with the count holds at every width (no sideways scroll; the count's row keeps
    // room to spare for wider fonts).
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const room = await group.locator(".item-comp__quantity").evaluate((label) => {
        const row = label.closest("li")?.getBoundingClientRect();
        const select = label.querySelector("select")?.getBoundingClientRect();
        return (row?.right ?? 0) - (select?.right ?? 0);
      });
      expect(room).toBeGreaterThanOrEqual(40);
      await page.screenshot({
        path: `${shots}/tables-comp-count-${language}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await confirm.click();
    // b63 (F36): recorded on Confirm, as the cash payment.
    await group.getByRole("button", { name: zh ? "确认" : "Confirm", exact: true }).click();
    // Only the choice goes: the dish, how many of it, why, and what the button showed.
    expect(sent.at(-1)).toEqual({
      orderReference: id(1),
      orderItemReferences: [noodles],
      kind: "Comp",
      percent: null,
      amountOffMinor: null,
      compQuantities: [{ orderItemReference: noodles, quantity: 1 }],
      reasonCode: "WRONG_DISH",
      expectedTotalMinor: "1413",
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    const list = details.getByRole("list", { name: zh ? "免单/折让" : "Comps and discounts" });
    const first = zh
      ? "Beef noodles (TEST) · 免单 2 份中的 1 份 · 上错菜 · 由你经办，8:13−$14.13"
      : "1 of 2 × Beef noodles (TEST) comped · Wrong dish served · by You, 8:13 a.m.−$14.13";
    await expect(list.getByRole("listitem").first()).toHaveText(first);

    // The other bowl, later: the panel offers the one left, with nothing to count.
    await details.getByRole("button", { name: title }).click();
    await expect(dishes).toHaveText([
      zh
        ? `1 × Beef noodles (TEST)（已免单 1 份） · ${down("$14.12")}`
        : `1 × Beef noodles (TEST) (1 comped already) · ${down("$14.12")}`,
      `1 × Jasmine tea (TEST) · ${down("$4.29")}`,
    ]);
    await dishes.nth(0).getByRole("checkbox").check();
    await expect(group.locator(".item-comp__quantity")).toHaveCount(0);
    await group.getByRole("radio", { name: zh ? "等待太久" : "Waited too long" }).check();
    await group.getByRole("button", { name: zh ? "免单 $14.12" : "Comp $14.12" }).click();
    await group.getByRole("button", { name: zh ? "确认" : "Confirm", exact: true }).click();
    await expect.poll(() => sent.at(-1)?.reasonCode).toBe("LONG_WAIT");
    expect(sent.at(-1)).toMatchObject({ orderItemReferences: [noodles], reasonCode: "LONG_WAIT" });
    expect(sent.at(-1)).not.toHaveProperty("compQuantities");
    // Both comps stay listed, each with its count; the line is never hidden.
    await expect(list.getByRole("listitem")).toHaveText([
      first,
      zh
        ? "Beef noodles (TEST) · 免单 2 份中的 1 份 · 等待太久 · 由你经办，8:21−$14.12"
        : "1 of 2 × Beef noodles (TEST) comped · Waited too long · by You, 8:21 a.m.−$14.12",
      `${zh ? "整桌账单减免后应付" : "Whole bill to pay after comps"}$4.29`,
    ]);
    // Every bowl comped: the panel offers only the tea now.
    await details.getByRole("button", { name: title }).click();
    await expect(dishes).toHaveText([`1 × Jasmine tea (TEST) · ${down("$4.29")}`]);
    await group.getByRole("button", { name: zh ? "取消" : "Cancel" }).click();
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await expect(list).toBeVisible();
      await signedAmountsHold(list, page);
      await page.screenshot({
        path: `${shots}/tables-comps-listed-${language}-${width}.png`,
        fullPage: true,
      });
    }
    expect(previews.length).toBeGreaterThan(0);
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });

  for (const [width, height] of widths)
    test(`@production batch 60: Orders lists each comp of part of a line with its count (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await signedIn(page, zh, "Orders");
      await tableOrder(page, [
        {
          quantity: 1,
          amountMinor: "1413",
          reasonCode: "WRONG_DISH",
          decidedAt: "2026-11-24T13:13:00.000Z",
        },
      ]);
      await page.goto("/operations/orders/" + id(1));
      const records = page.locator(".order-comp-records").first();
      await expect(records.locator("li").first()).toHaveText(
        zh
          ? "Beef noodles (TEST) · 免单 2 份中的 1 份 · 上错菜 · 由你经办，08:13 −$14.13 （含税）"
          : "1 of 2 × Beef noodles (TEST) comped · Wrong dish served · by You, 08:13 −$14.13 incl. tax",
      );
      // The line itself stays on the order at its price: 2 × Beef noodles, $28.25.
      await expect(page.getByText("Beef noodles (TEST)", { exact: false }).first()).toBeVisible();
      await signedAmountsHold(records, page);
      await page.screenshot({
        path: `${shots}/orders-comp-part-${language}-${width}.png`,
        fullPage: true,
      });
    });

  test(`@production batch 60: checkout and the printed bill say 1 of 2 comped (${language})`, async ({
    page,
  }) => {
    await signedIn(page, zh, "Tables");
    await tableOrder(
      page,
      [
        {
          quantity: 1,
          amountMinor: "1413",
          reasonCode: "WRONG_DISH",
          decidedAt: "2026-11-24T13:13:00.000Z",
        },
      ],
      "Closing",
    );
    await page.route("**/merchant/dining/table-close-plan", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          diningSessionReference: id(71),
          orderVersion: 4,
          observedAt: "2026-11-24T13:40:00.000Z",
          rounds: [],
          closeBlockers: [],
          totals: { onlineMinor: "0", cardMachineMinor: "0" },
        },
      }),
    );
    // After 1 of 2 bowls comped: $25.00 − $12.50 + $3.80 = $16.30, tax $2.12, $18.42; paid.
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({
        headers,
        json: {
          diningSessionReference: id(71),
          sessionPhase: "Closing",
          sessionVersion: 3,
          paymentTiming: "PayLater",
          tableLabel: "T3",
          orderReference: id(1),
          rounds: [
            {
              roundNumber: 1,
              orderBatchReference: id(51),
              submissionReference: id(52),
              items: [
                {
                  orderItemReference: noodles,
                  quantity: 2,
                  displayName: "Beef noodles (TEST)",
                  subtotalMinor: "2500",
                  totalMinor: "1412",
                  reduction: {
                    kind: "Comp",
                    percent: null,
                    amountMinor: "1413",
                    netMinor: "1250",
                    compedQuantity: 1,
                  },
                },
                {
                  orderItemReference: tea,
                  quantity: 1,
                  displayName: "Jasmine tea (TEST)",
                  subtotalMinor: "380",
                  totalMinor: "429",
                  reduction: null,
                },
              ],
              subtotalMinor: "1630",
              taxMinor: "212",
              totalMinor: "1842",
              taxRoundingMinor: "0",
              paid: true,
            },
          ],
          taxRoundingMinor: "0",
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          consistent: true,
          tips: { enabled: false, tierPercents: [12, 18, 20] },
          settlement: {
            method: "CardMachine",
            roundsMinor: "1842",
            tipMinor: "0",
            roundingMinor: "0",
            totalMinor: "1842",
            tenderedMinor: null,
            changeMinor: null,
            recordedAt: "2026-11-24T13:45:00.000Z",
            recordedAfterOutage: false,
          },
        },
      }),
    );
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: zh ? "选择 T3" : "Select T3", exact: true }).click();
    const checkout = page.getByRole("region", { name: zh ? "结账" : "Checkout" });
    // b63 (F36): one amount per dish in the checkout list — what it is charged after its comp —
    // and its comp in words beside the dish (the paid bill on paper still lists the comp).
    const comp = checkout.locator(".table-checkout__comp").first();
    await expect(comp).toHaveText(zh ? " · 免单 2 份中的 1 份" : " · 1 of 2 comped");
    const line = checkout.locator(".table-checkout__rounds ul > li").first();
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expect(line.locator(":scope > span")).toHaveText([
        zh
          ? "2 × Beef noodles (TEST) · 免单 2 份中的 1 份"
          : "2 × Beef noodles (TEST) · 1 of 2 comped",
        "$12.50",
      ]);
      await page.screenshot({
        path: `${shots}/checkout-comp-part-${language}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // On paper: the line at its price, and the bowl comped before tax under it.
    await page.emulateMedia({ media: "print" });
    const paper = await page.evaluate(() =>
      [...document.querySelectorAll(".table-receipt__dishes > li")].map((li) =>
        [...li.children]
          .map((part) => (part as HTMLElement).innerText.replace(/\s+/gu, " ").trim())
          .join(" | "),
      ),
    );
    expect(paper[0]).toBe(
      zh
        ? "2 × Beef noodles (TEST) | $25.00 | 免单 2 份中的 1 份 −$12.50"
        : "2 × Beef noodles (TEST) | $25.00 | 1 of 2 comped −$12.50",
    );
    await page.emulateMedia({ media: "screen" });
    await expectNoInternalText(page, ["Temporarily unavailable"]);
  });
}
