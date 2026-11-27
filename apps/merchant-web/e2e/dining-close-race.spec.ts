import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { expectRoomAbove } from "./outcome-line-room";
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
            stableLabel: `BR ${String(n + 1)} (TEST)`,
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
    const body = route.request().postDataJSON() as {
      action: string;
      expectedSessionVersion: number;
    };
    sent.push(body.action);
    if (wins) {
      // Batch 48: an empty table's close begins (Closing), then finishes (Closed).
      if (body.action === "Begin")
        return route.fulfill({
          headers,
          json: {
            status: "Applied",
            phase: "Closing",
            sessionVersion: body.expectedSessionVersion + 1,
          },
        });
      // Closed here: every read from now on shows the table waiting to be cleaned.
      other.closedAt = Date.now();
      return route.fulfill({
        headers,
        json: {
          status: "Applied",
          phase: "Closed",
          sessionVersion: body.expectedSessionVersion + 1,
        },
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
          // b63 (F34): an empty table's close reads "Guests left — close table".
          name: zh ? /^关闭 TL45|^客人走了，关台$/u : /^Close TL45|^Guests left — close table$/u,
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
        // b63 (F34): an empty table's close reads "Guests left — close table".
        name: zh ? /^关闭 TL45|^客人走了，关台$/u : /^Close TL45|^Guests left — close table$/u,
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
      page.getByRole("button", {
        name: zh ? /^关闭 TL45|^客人走了，关台$/u : /^Close TL45|^Guests left — close table$/u,
      }),
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
 * outcome is shown where they are looking, at the panel. Batch 48 (v15 b47 live): the same holds on
 * a wide screen, where the panel stays beside the list (see the long-floor test below).
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
        const close = page.getByRole("button", {
          name: zh ? /^关闭 TL45|^客人走了，关台$/u : /^Close TL45|^Guests left — close table$/u,
        });
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
        // In view, at the table's panel, not at the top of the 15-table list; said once.
        await expect(line).toHaveCount(1);
        await expect(line).toBeInViewport();
        // b52: with room above it, never flush on the top edge of a phone.
        await expectRoomAbove(line);
        await expect(panel.getByText(text)).toBeVisible();
        await expect(panel).toContainText(zh ? "待清洁" : "Needs cleaning");
        if (width !== 390) {
          // The wide layout is kept: the panel beside the list.
          const panelBox = await panel.boundingBox();
          const listBox = await list.boundingBox();
          expect(panelBox !== null && listBox !== null).toBe(true);
          expect(panelBox?.x ?? 0).toBeGreaterThanOrEqual(
            (listBox?.x ?? 0) + (listBox?.width ?? 0) - 1,
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

/**
 * WP-2423 batch 48 (v15 batch 47 live check, guest-and-staff-wording (3b)): at 1440 on TM2 (84
 * tables) the losing page had scrolled down the list (scrollY 599) to select W47 R2, an open table
 * with no order. Its "…was closed on another device…" line was drawn above the list, out of view
 * (top -446), and the panel beside the row said only "4 座 · 待清洁". The outcome of the selected
 * table is said in its panel at every width, once, in view, at least 40 px from each edge of the
 * panel's column (DejaVu fonts on Linux are wider).
 */
for (const outcome of ["lost", "won"] as const)
  for (const language of ["en", "zh-Hans"] as const)
    for (const [width, height] of widths)
      test(`@production WP-2423 batch 48: on a long floor scrolled down to the table, the ${outcome} Close outcome is said in its panel, in view (${language}, ${width})`, async ({
        page,
      }) => {
        const zh = language === "zh-Hans";
        // 83 other tables waiting to be cleaned list first: the open table is far down, as live.
        await racedFloor(page, "EmptyTable", language, {
          closes: true,
          fillers: 83,
          wins: outcome === "won",
        });
        await page.setViewportSize({ width, height });
        await page.goto("/operations/dining");
        // Tables > All, as live.
        await page.getByRole("button", { name: zh ? /^全部/u : /^All /u }).click();
        const select = page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` });
        await select.scrollIntoViewIfNeeded();
        await select.click();
        const close = page.getByRole("button", {
          name: zh ? /^关闭 TL45|^客人走了，关台$/u : /^Close TL45|^Guests left — close table$/u,
        });
        await close.scrollIntoViewIfNeeded();
        await expect(close).toBeInViewport();
        // Staff have scrolled well down the floor: the top of the list is out of view. b63 review
        // (F37): on a phone the panel takes the list's place, so it starts near the top instead.
        if (width >= 768) expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
        else await expect(page.locator(".table-list")).toBeHidden();
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
        await expect(line).toBeVisible({ timeout: 6_000 });
        await expect(line).toHaveCount(1);
        const panel = page.getByRole("complementary", {
          name: zh ? "所选桌台详情" : "Selected table details",
        });
        await expect(panel.getByText(text)).toBeVisible();
        await expect(line).toBeInViewport();
        await expectRoomAbove(line);
        await expect(panel).toContainText(zh ? "待清洁" : "Needs cleaning");
        const box = await line.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(height);
        expect(box.left).toBeGreaterThanOrEqual(16);
        expect(box.right).toBeLessThanOrEqual(width - 16);
        // Room to spare for wider fonts: the text ends well inside the panel's column.
        const room = await line.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          const column = (node.parentElement as HTMLElement).getBoundingClientRect();
          return column.right - text.right;
        });
        expect(room).toBeGreaterThanOrEqual(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/b48-long-floor-${outcome}-${language}-${width}.png`,
        });
        await expectNoInternalText(page);
      });

/**
 * WP-2423 batch 48 (v15 batch 47 live check, guest-503-and-closed-capabilities): while a table was
 * checking out, Manage this table still offered New join code. Pressing it was refused 409
 * changed_while_loading, and staff read "This table changed. It has been read again." though
 * nothing had changed. A table paying its bill takes no one new (dining-qr-join.md), so the panel
 * says that instead of offering the step; a table that started checkout a moment ago, before this
 * page read it again, is refused with that reason too.
 */
const paying = (zh: boolean) =>
  zh
    ? "这桌正在结账，不能换桌或并桌，不能再有人加入，也不能换新的入桌码。"
    : "This table is paying the bill, so it can't be moved or merged, no one new can join and no new join code can be made.";
for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`@production WP-2423 batch 48: a table checking out offers no new join code and says why (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await racedFloor(page, "PaidTable", language, { closes: false });
      const asked: string[] = [];
      await page.route("**/merchant/dining/sessions/join-state", (route) => {
        asked.push("join-state");
        return route.fulfill({
          status: 409,
          headers,
          json: { error: "dining_join_table_checking_out" },
        });
      });
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
      const panel = page.getByRole("complementary", {
        name: zh ? "所选桌台详情" : "Selected table details",
      });
      await panel.getByText(zh ? "管理这张桌" : "Manage this table").click();
      const more = panel.getByRole("region", {
        name: zh ? "这桌的其他操作" : "More for this table",
      });
      await expect(more).toBeVisible();
      await expect(
        more.getByRole("button", { name: zh ? "换一个加入码" : "New join code" }),
      ).toHaveCount(0);
      // Batch 49: this table has paid (cash), so the panel says its bill is settled, once, where
      // its phones are (dining-checkout-joining.spec.ts has the phones and the unpaid case).
      const settled = zh
        ? "这桌已结清，不能换桌或并桌，不能再有人加入，也不能换新的入桌码。"
        : "This table's bill is settled, so it can't be moved or merged, no one new can join and no new join code can be made.";
      const reason = panel.getByText(settled);
      await expect(reason).toBeVisible();
      await expect(page.getByText(settled)).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await reason.scrollIntoViewIfNeeded();
      const box = await reason.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
      expect(box.left).toBeGreaterThanOrEqual(16);
      expect(box.right).toBeLessThanOrEqual(width - 16);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect(
        page.getByText(
          zh ? "这张桌子有变动，已重新读取。" : "This table changed. It has been read again.",
        ),
      ).toHaveCount(0);
      expect(asked).toEqual([]);
      await page.screenshot({ path: `test-results/b48-checkout-no-code-${language}-${width}.png` });
      // The open Manage section's "Mark unavailable" is a staff word, as in dining-table-cart.
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 48: a table that began checkout since it was read is refused a new join code as paying, not as changed (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      // Shown open (Active), but its checkout began on a guest's phone a moment ago.
      const { other } = await racedFloor(page, "EmptyTable", language, { closes: false });
      const regenerate: string[] = [];
      await page.route("**/merchant/dining/sessions/join-state", (route) => {
        // Batch 49 review: from the refusal on, every read shows the table checking out (Closing),
        // as it is; the refusal's line holds only while that stays true.
        other.closedAt = Number.MAX_SAFE_INTEGER;
        return route.fulfill({
          status: 409,
          headers,
          json: { error: "dining_join_table_checking_out" },
        });
      });
      await page.route("**/merchant/dining/sessions/regenerate", (route) => {
        regenerate.push("regenerate");
        return route.abort("failed");
      });
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
      const panel = page.getByRole("complementary", {
        name: zh ? "所选桌台详情" : "Selected table details",
      });
      await panel.getByText(zh ? "管理这张桌" : "Manage this table").click();
      await panel.getByRole("button", { name: zh ? "换一个加入码" : "New join code" }).click();
      const line = page.getByText(paying(zh));
      await expect(line).toBeVisible();
      await expect(line).toHaveCount(1);
      // Said in the table's panel, in view.
      await expect(panel.getByText(paying(zh))).toBeVisible();
      await expect(line).toBeInViewport();
      await expectRoomAbove(line);
      await expect(
        page.getByText(
          zh ? "这张桌子有变动，已重新读取。" : "This table changed. It has been read again.",
        ),
      ).toHaveCount(0);
      expect(regenerate).toEqual([]);
      const box = await line.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
      expect(box.left).toBeGreaterThanOrEqual(16);
      expect(box.right).toBeLessThanOrEqual(width - 16);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/b48-code-refused-paying-${language}-${width}.png`,
      });
      // The open Manage section's "Mark unavailable" is a staff word, as in dining-table-cart.
      await expectNoInternalText(page, ["Mark unavailable"]);
    });
  }
