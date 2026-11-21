import { expect, test, type Page } from "@playwright/test";

/**
 * b40 review (v15 b39 live, L39 M3 merged into L39 M2): Tables numbered the merged bill's rounds
 * 1-4, but Orders still numbered each order's rounds from 1, so the host's order and the merged-in
 * order each offered "Take dishes off round 1". The order read now carries each round's number on
 * the whole bill, and Orders uses it for the round headings and the take-off controls, on the
 * order's page and on the list (also when the dishes can't be read there). Synthetic Store.
 */
const id = (n: number) => "0190a410-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

// Host order 1 (M2): its rounds are 1 and 4 on the bill; merged order 2 (M3): 2 and 3.
const rounds = [
  { order: 1, sequence: 1, batch: 51, item: 201, number: 1 },
  { order: 2, sequence: 1, batch: 52, item: 202, number: 2 },
  { order: 2, sequence: 2, batch: 62, item: 203, number: 3 },
  { order: 1, sequence: 2, batch: 61, item: 204, number: 4 },
] as const;
const billRoundNumbers = rounds.map((round) => ({
  orderBatchReference: id(round.batch),
  roundNumber: round.number,
}));

async function mock(page: Page, zh: boolean, detailFails: boolean) {
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
          businessDate: "2026-11-20",
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
  const order = (n: 1 | 2) => ({
    orderReference: id(n),
    orderNumber: "T-" + n,
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-21T06:20:00.000Z",
    observedAt: "2026-11-21T06:30:00.000Z",
    initialBatchReference: id(50 + n),
    batches: rounds
      .filter((round) => round.order === n)
      .map((round) => ({
        orderBatchReference: id(round.batch),
        sequence: round.sequence,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        unpaidRemovableItems: [id(round.item)],
        unpaidRemovedItems: [],
        compableItems: [],
        compedItems: [],
      })),
    canRequestAcceptance: false,
    tableBill:
      n === 1
        ? { totalMinor: "5652", paid: null, billRoundNumbers }
        : {
            totalMinor: "0",
            paid: null,
            mergedInto: { tableLabel: "L39 M2 (TEST)", paid: false },
            billRoundNumbers,
          },
    currentPhase: "InProgress",
    currentVersion: 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      // Newest Order first, as the API lists them.
      json: { items: [order(2), order(1)], nextAfterOrderReference: null },
    }),
  );
  await page.route("**/merchant/orders/detail*", (route) => {
    if (detailFails) return route.fulfill({ status: 503, headers, json: { error: "unavailable" } });
    const n = new URL(route.request().url()).searchParams.get("order") === id(2) ? 2 : 1;
    return route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(n),
        // b41 (v15 b40 live): the record names each round by the order's own number; staff read
        // it by the bill's (order 2's own rounds 1 and 2 are rounds 2 and 3 on the bill).
        record: {
          accepted: rounds
            .filter((round) => round.order === n)
            .map((round) => ({ round: round.sequence, by: null, at: "2026-11-21T06:21:00.000Z" })),
          handedOver: [],
          payments: [],
          cancellations: [],
          refunds: [],
          writeOff: null,
          paidOnlineByGuest: false,
        },
        lines: {
          items: rounds
            .filter((round) => round.order === n)
            .map((round) => ({
              orderItemReference: id(round.item),
              orderBatchReference: id(round.batch),
              name: "Beef noodles (TEST)",
              options: [],
              quantity: 1,
              customerNote: null,
              unitPrice: money("1250"),
              subtotal: money("1250"),
              discount: money("0"),
              tax: money("163"),
              fee: money("0"),
              total: money("1413"),
              canCancel: false,
              cancellation: null,
            })),
          totals: {
            subtotal: money("2500"),
            discount: money("0"),
            tax: money("326"),
            fee: money("0"),
            taxRounding: money("0"),
            total: money("2826"),
          },
        },
      },
    });
  });
}

for (const zh of [false, true]) {
  const lang = zh ? "zh-Hans" : "en";
  const takeOff = (n: number) => (zh ? `从第 ${n} 轮删菜` : `Take dishes off round ${n}`);
  const roundName = (n: number) => (zh ? `第 ${n} 轮` : `Round ${n}`);

  test(`@production b40 review: a merged-in order's page numbers its rounds as the bill does (${lang})`, async ({
    page,
  }) => {
    await mock(page, zh, false);
    await page.goto("/operations/orders/" + id(2));
    for (const n of [2, 3])
      await expect(
        page
          .getByRole("region", { name: roundName(n), exact: true })
          .getByRole("button", { name: takeOff(n) }),
      ).toBeVisible();
    await expect(page.getByRole("region", { name: roundName(1), exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: takeOff(1) })).toHaveCount(0);
    // b41: the Record section says the same numbers as the headings.
    const recordSection = page.getByRole("region", { name: zh ? "记录" : "Record", exact: true });
    for (const n of [2, 3])
      await expect(recordSection).toContainText(zh ? `第 ${n} 轮接单` : `Round ${n} accepted`);
    await expect(recordSection).not.toContainText(zh ? "第 1 轮接单" : "Round 1 accepted");
  });

  test(`@production b40 review: the Orders list never shows two "round 1" take-offs for one merged bill (${lang})`, async ({
    page,
  }) => {
    // The dishes can't be read here: each round's take-off is a link to its order's page.
    await mock(page, zh, true);
    await page.goto("/operations/orders");
    const panel = page.locator("aside.order-panel");
    const seen: string[] = [];
    for (const [row, expected] of [
      [0, [2, 3]],
      [1, [1, 4]],
    ] as const) {
      const opener = page.locator("li.order-row").nth(row).locator(".order-row__open");
      await expect(opener).toBeVisible();
      if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
      for (const n of expected)
        await expect(
          panel
            .getByRole("region", { name: roundName(n), exact: true })
            .getByRole("link", { name: takeOff(n) }),
        ).toBeVisible();
      seen.push(
        ...(await panel
          .getByRole("link", { name: zh ? /从第 \d+ 轮删菜/u : /^Take dishes off round \d+$/u })
          .allTextContents()),
      );
    }
    // Four rounds on one bill, four different numbers.
    expect(seen.sort()).toEqual([1, 2, 3, 4].map(takeOff).sort());
  });
}
