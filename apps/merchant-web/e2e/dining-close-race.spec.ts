import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { tableClosePlanResponse } from "../../../apps/api/src/merchant-dining-table-close-plan-response.js";

/**
 * WP-2423 batch 46 (v15 batch 45 live check, closing-refusal-codes): two staff devices press Close
 * on one table at the same moment. The losing device is refused (409 order_already_closed on a
 * paid table, 409 dining_session_changed at the table's own step on an empty one) and re-read the
 * tables at once. That read landed 7-66 ms before the winner's Finalize committed (5 races out of
 * 5), so the losing page kept the table open (Paid · close when the guests leave / Checking the
 * bill, an active Close) for as long as staff looked, and said a payment or refund had come in.
 *
 * Here the other device's close commits 250 ms after this device's refusal: the first re-read is
 * still stale, as live. The page must read again until the table has settled, then say plainly
 * that another device closed it; if it never closes, the reads stop and the page says it changed.
 */

const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const label = "TL45 C (TEST)";
const widths = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

type Race = "PaidTable" | "EmptyTable";

async function racedFloor(
  page: Page,
  race: Race,
  language: "en" | "zh-Hans",
  {
    closes,
    fillers = 0,
    wins = false,
  }: {
    readonly closes: boolean;
    /** Batch 47: other tables waiting to be cleaned, as on the live floor (a long list). */
    readonly fillers?: number;
    /** Batch 47: this device's close goes through (the winner of the race). */
    readonly wins?: boolean;
  },
) {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  const scope = { brandLabel: "Synthetic Brand", storeLabel: "TM2", storeReference: id(99) };
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
          businessDate: "2026-11-22",
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
  // When the other device's close commits (null: not yet refused here).
  const other = { closedAt: null as number | null, readsAfterRefusal: 0 };
  // The paid table: checkout done (session Closing v20), the order paid and fulfilled, not closed.
  // The empty table: the other device's Begin already committed (Closing v20) when this one's
  // Begin, sent at v19, was refused.
  const open = {
    phase: race === "PaidTable" ? "Closing" : "Active",
    version: 19 + (race === "PaidTable" ? 1 : 0),
    orderReference: race === "PaidTable" ? id(3) : null,
  };
  await page.route("**/merchant/dining/tables", (route) => {
    const refused = other.closedAt !== null;
    if (refused) other.readsAfterRefusal += 1;
    const closed = refused && closes && Date.now() >= (other.closedAt as number);
    return route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        canCancelUnpaidRounds: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: label,
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            aggregateVersion: closed ? 3 : 2,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            ...(race === "PaidTable" ? { paymentTiming: "PayLater" } : {}),
            ...(closed
              ? {
                  operationalState: "TemporarilyBlocked",
                  blockReasonCode: "CLEANING",
                  currentDiningSessionReference: null,
                  elapsedMinutes: null,
                }
              : {
                  operationalState: "Available",
                  currentDiningSessionReference: id(2),
                  elapsedMinutes: 38,
                  session: refused
                    ? { phase: "Closing", version: 20, orderReference: open.orderReference }
                    : {
                        phase: open.phase,
                        version: open.version,
                        orderReference: open.orderReference,
                      },
                }),
          },
          ...Array.from({ length: fillers }, (_, n) => ({
            tableReference: id(200 + n),
            stableLabel: `BR ${String.fromCharCode(65 + n)} (TEST)`,
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            aggregateVersion: 4,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            operationalState: "TemporarilyBlocked",
            blockReasonCode: "CLEANING",
            currentDiningSessionReference: null,
            elapsedMinutes: null,
          })),
        ],
        nextAfterTableReference: null,
      },
    });
  });
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        tableLabel: label,
        diningSessionReference: id(2),
        sessionPhase: "Closing",
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 11,
        sessionVersion: 20,
        tableAssignmentVersion: 1,
        orderVersion: 11,
        phase: "Fulfilled",
        observedAt: "2026-11-22T04:56:00.000Z",
        items: [
          {
            orderItemReference: id(101),
            orderBatchReference: id(21),
            displayName: "Beef noodles (TEST)",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "Fulfilled",
            orderedQuantity: 1,
            deliveredQuantity: 1,
            remainingQuantity: 0,
            itemServiceVersion: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: tableClosePlanResponse({
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 11,
        observedAt: "2026-11-22T04:56:00.000Z",
        rounds: [],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
        closeBlockers: [],
      }),
    }),
  );
  // The paid table, as live: one round of Beef noodles, paid in cash ($14.15).
  const round = {
    roundNumber: 1,
    orderBatchReference: id(21),
    submissionReference: id(31),
    items: [
      {
        orderItemReference: id(101),
        quantity: 1,
        displayName: "Beef noodles (TEST)",
        subtotalMinor: "1252",
        totalMinor: "1415",
      },
    ],
    subtotalMinor: "1252",
    taxMinor: "163",
    totalMinor: "1415",
    paid: true,
  };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        sessionPhase: "Closing",
        sessionVersion: 20,
        paymentTiming: "PayLater",
        tableLabel: label,
        orderReference: id(3),
        rounds: [round],
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        consistent: true,
        settlement: {
          method: "Cash",
          roundsMinor: "1415",
          tipMinor: "0",
          roundingMinor: "0",
          totalMinor: "1415",
          tenderedMinor: "1415",
          changeMinor: "0",
          recordedAt: "2026-11-22T04:50:00.000Z",
          recordedAfterOutage: false,
        },
      },
    }),
  );
  await page.route("**/merchant/dining/party-size", (route) =>
    route.fulfill({ headers, json: { askPartySize: false, partySizes: [] } }),
  );
  const refuse = () => {
    other.closedAt = Date.now() + 250;
  };
  const sent: string[] = [];
  await page.route("**/merchant/orders/close", (route) => {
    sent.push("order close");
    if (wins)
      return route.fulfill({
        headers,
        json: { status: "Committed", closureVersion: 1, closedOrderVersion: 11 },
      });
    refuse();
    return route.fulfill({ status: 409, headers, json: { error: "order_already_closed" } });
  });
  await page.route("**/merchant/dining/closing", (route) => {
    const body = route.request().postDataJSON() as { action: string };
    sent.push(body.action);
    if (wins) {
      // Closed here: every read from now on shows the table waiting to be cleaned.
      other.closedAt = Date.now();
      return route.fulfill({
        headers,
        json: { status: "Applied", phase: "Closed", sessionVersion: 21 },
      });
    }
    refuse();
    return route.fulfill({ status: 409, headers, json: { error: "dining_session_changed" } });
  });
  return { other, sent };
}

/** The table's row on the list (the only table on this floor). */
const row = (page: Page) => page.locator(".table-row").first();

for (const race of ["PaidTable", "EmptyTable"] as const)
  for (const language of ["en", "zh-Hans"] as const)
    for (const [width, height] of widths)
      test(`@production WP-2423 batch 46: the device that loses a Close race on a ${race === "PaidTable" ? "paid" : "empty"} table shows it closed elsewhere (${language}, ${width})`, async ({
        page,
      }) => {
        const zh = language === "zh-Hans";
        const { other, sent } = await racedFloor(page, race, language, { closes: true });
        await page.setViewportSize({ width, height });
        await page.goto("/operations/dining");
        await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
        const close = page.getByRole("button", {
          name: zh ? /^关闭 TL45/u : /^Close TL45/u,
        });
        if (race === "PaidTable" && !zh)
          await expect(row(page)).toContainText("Paid · close when the guests leave");
        await close.click();
        // Once the other device's close has committed, this page shows the table closed and says
        // who closed it, without guessing a payment or refund.
        await expect(
          page.getByText(
            zh
              ? `${label} 已在另一台设备上关台。清洁后点“已清洁”。`
              : `${label} was closed on another device. Clean it, then mark it cleaned.`,
          ),
        ).toBeVisible({ timeout: 5_000 });
        await expect(row(page)).toContainText(zh ? "待清洁" : "Needs cleaning");
        await expect(close).toHaveCount(0);
        await expect(page.getByText(zh ? /付款或退款/u : /payment or refund/u)).toHaveCount(0);
        expect(sent).toEqual(race === "PaidTable" ? ["order close"] : ["Begin"]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/b46-close-race-${race}-${language}-${width}.png`,
          fullPage: true,
        });
        // Bounded: it stopped reading once the table settled.
        const reads = other.readsAfterRefusal;
        await page.waitForTimeout(1_500);
        expect(other.readsAfterRefusal).toBe(reads);
        await expectNoInternalText(page);
      });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 46: a table changed on another device but not closed is read a few times, then says what happened (${language})`, async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const zh = language === "zh-Hans";
    const { other } = await racedFloor(page, "EmptyTable", language, { closes: false });
    // On a phone in Chinese, on a wide screen in English.
    const width = zh ? 390 : 1440;
    await page.setViewportSize({ width, height: zh ? 844 : 900 });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
    await page
      .getByRole("button", {
        name: zh ? /^关闭 TL45/u : /^Close TL45/u,
      })
      .click();
    const alert = page
      .getByRole("region", { name: zh ? "关闭这张桌台" : "Close this table" })
      .getByRole("alert");
    await expect(alert).toHaveText(
      zh
        ? "这桌刚在另一台设备上关台或有改动，这里没有关台。已重新读取，请核对后再试。"
        : "This table was just closed or changed on another device, so it wasn't closed here. It has been read again: check it before trying again.",
    );
    // About 6 s of reads, further apart, then no more: never a read loop.
    await page.waitForTimeout(8_000);
    const reads = other.readsAfterRefusal;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThanOrEqual(6);
    await page.waitForTimeout(1_500);
    expect(other.readsAfterRefusal).toBe(reads);
    await expect(page.getByText(zh ? /付款或退款/u : /payment or refund/u)).toHaveCount(0);
    // The table is still open, so Close can be pressed again once staff have looked.
    await expect(
      page.getByRole("button", { name: zh ? /^关闭 TL45/u : /^Close TL45/u }),
    ).toBeEnabled();
    const box = await alert.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
    expect(box.left).toBeGreaterThanOrEqual(16);
    expect(box.right).toBeLessThanOrEqual(width - 16);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/b46-close-race-changed-${language}-${width}.png` });
    await expectNoInternalText(page);
  });

/**
 * WP-2423 batch 47 (v15 batch 46 live check, close-race-and-kitchen-search): on a phone the selected
 * table's panel sits under the whole table list. Live (TM2, 78 tables) the line that says why the
 * table changed ("…was closed on another device…", and the winner's "…is closed…") was shown above
 * the list, so staff looking at the panel saw the table turn to Needs cleaning with no reason. The
 * outcome is shown where they are looking, at the panel, and on a wide screen stays above the list.
 */
for (const outcome of ["lost", "won"] as const)
  for (const language of ["en", "zh-Hans"] as const)
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ] as const)
      test(`@production WP-2423 batch 47: the ${outcome} Close outcome on a long floor shows where staff are looking (${language}, ${width})`, async ({
        page,
      }) => {
        const zh = language === "zh-Hans";
        const { sent } = await racedFloor(page, "PaidTable", language, {
          closes: true,
          fillers: 14,
          wins: outcome === "won",
        });
        await page.setViewportSize({ width, height });
        await page.goto("/operations/dining");
        await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
        const close = page.getByRole("button", { name: zh ? /^关闭 TL45/u : /^Close TL45/u });
        // Staff are at the table's panel, with its Close step in view.
        await close.scrollIntoViewIfNeeded();
        await expect(close).toBeInViewport();
        await close.click();
        const text =
          outcome === "won"
            ? zh
              ? `${label} 已关台。清洁后点“已清洁”。`
              : `${label} is closed. Clean it, then mark it cleaned.`
            : zh
              ? `${label} 已在另一台设备上关台。清洁后点“已清洁”。`
              : `${label} was closed on another device. Clean it, then mark it cleaned.`;
        const line = page.getByText(text);
        await expect(line).toBeVisible({ timeout: 5_000 });
        expect(sent[0]).toBe("order close");
        const panel = page.getByRole("complementary", {
          name: zh ? "所选桌台详情" : "Selected table details",
        });
        const list = page.getByRole("region", {
          name: zh ? "按需要处理排列的桌台" : "Tables by what they need",
        });
        if (width === 390) {
          // In view, at the table's panel, not at the top of the 15-table list.
          await expect(line).toBeInViewport();
          await expect(panel.getByText(text)).toBeVisible();
          await expect(panel).toContainText(zh ? "待清洁" : "Needs cleaning");
        } else {
          // The wide layout is unchanged: the line above the list, the panel beside it.
          await expect(panel.getByText(text)).toHaveCount(0);
          const lineBox = await line.boundingBox();
          const listBox = await list.boundingBox();
          expect(lineBox !== null && listBox !== null).toBe(true);
          expect((lineBox?.y ?? 0) + (lineBox?.height ?? 0)).toBeLessThanOrEqual(
            (listBox?.y ?? 0) + 1,
          );
        }
        const box = await line.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
        expect(box.left).toBeGreaterThanOrEqual(16);
        expect(box.right).toBeLessThanOrEqual(width - 16);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/b47-close-outcome-${outcome}-${language}-${width}.png`,
        });
        await expectNoInternalText(page);
      });
