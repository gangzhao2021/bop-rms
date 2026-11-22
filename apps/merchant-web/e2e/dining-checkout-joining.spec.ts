import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { tableClosePlanResponse } from "../../../apps/api/src/merchant-dining-table-close-plan-response.js";

/**
 * WP-2423 batch 49 (v15 batch 48 live check, table-panel-outcome-and-join-code). While a table was
 * checking out (session Closing), Manage this table said "This table is paying the bill, so no one
 * new can join and no new join code can be made." and, a few lines above it, its phones block
 * still read "Guests join by scanning the table's QR code." with an active "Pause joining by scan".
 * Joining is refused while a table checks out (the QR issue answers CheckingOut before it looks at
 * the pause), so the pause changes nothing then. After a stale New join code was refused on a
 * second device, the same sentence was said twice in the panel, with "Merging isn't available:
 * this table is checking out." as a third. The panel says what is true once: checking out, or
 * settled once the bill is paid, and offers only steps that work. Synthetic TEST data, shaped as
 * the live reads (TM2, ZV48 C (TEST): one phone joined by scan, one round of Beef noodles).
 */

const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const label = "ZV49 C (TEST)";
const widths = [
  [390, 844],
  [1440, 900],
] as const;

type Floor = "Paying" | "Paid" | "Active" | "StaleThenPaying";

const paying = (zh: boolean) =>
  zh
    ? "这桌正在结账，不能再有人加入，也不能换新的入桌码。"
    : "This table is paying the bill, so no one new can join and no new join code can be made.";
const settled = (zh: boolean) =>
  zh
    ? "这桌已结清，不能再有人加入，也不能换新的入桌码。"
    : "This table's bill is settled, so no one new can join and no new join code can be made.";

async function checkoutFloor(page: Page, floor: Floor, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "TM2",
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
  // Another device started checkout: from the refused join code on, every read shows Closing.
  const state = { refused: false };
  const phaseNow = () =>
    floor === "Active" || (floor === "StaleThenPaying" && !state.refused) ? "Active" : "Closing";
  const paid = floor === "Paid";
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
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
            operationalState: "Available",
            aggregateVersion: 2,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            paymentTiming: "PayLater",
            currentDiningSessionReference: id(2),
            elapsedMinutes: 6,
            session: {
              phase: phaseNow(),
              version: phaseNow() === "Closing" ? 20 : 19,
              orderReference: id(3),
              paymentStarted: paid,
              mergedTables: [],
            },
          },
          // Another seated table that pays at the end, as live, so merging has somewhere to go.
          {
            tableReference: id(11),
            stableLabel: "ZV49 D (TEST)",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            paymentTiming: "PayLater",
            currentDiningSessionReference: id(12),
            elapsedMinutes: 20,
            session: {
              phase: "Active",
              version: 4,
              orderReference: id(13),
              paymentStarted: false,
              mergedTables: [],
            },
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  // The live phones read: one phone joined by scan a minute ago and sent round 1; not paused.
  const phones: string[] = [];
  await page.route("**/merchant/dining/sessions/qr-join", (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      diningSessionReference: string;
    };
    phones.push(body.action);
    return route.fulfill({
      headers,
      json: {
        diningSessionReference: body.diningSessionReference,
        paused: false,
        phones: [
          {
            participantReference: id(41),
            phoneNumber: 1,
            joinedAt: new Date(Date.now() - 60_000).toISOString(),
            left: false,
            removed: false,
          },
        ],
        rounds: [{ orderBatchReference: id(21), phoneNumber: 1 }],
      },
    });
  });
  await page.route("**/merchant/dining/sessions/join-state", (route) => {
    state.refused = true;
    return route.fulfill({
      status: 409,
      headers,
      json: { error: "dining_join_table_checking_out" },
    });
  });
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/dining/party-size", (route) =>
    route.fulfill({ headers, json: { askPartySize: false, partySizes: [] } }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        tableLabel: label,
        diningSessionReference: id(2),
        sessionPhase: phaseNow(),
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 11,
        sessionVersion: phaseNow() === "Closing" ? 20 : 19,
        tableAssignmentVersion: 1,
        orderVersion: 11,
        phase: "Fulfilled",
        observedAt: "2026-11-22T19:00:00.000Z",
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
        observedAt: "2026-11-22T19:00:00.000Z",
        rounds: [],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
        closeBlockers: [],
      }),
    }),
  );
  // One round of Beef noodles (TEST), $14.13 as live; paid by simulated payment on the Paid floor.
  const round = {
    roundNumber: 1,
    orderBatchReference: id(21),
    submissionReference: id(31),
    items: [
      {
        orderItemReference: id(101),
        quantity: 1,
        displayName: "Beef noodles (TEST)",
        subtotalMinor: "1250",
        totalMinor: "1413",
      },
    ],
    subtotalMinor: "1250",
    taxMinor: "163",
    totalMinor: "1413",
    paid,
  };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        sessionPhase: phaseNow(),
        sessionVersion: phaseNow() === "Closing" ? 20 : 19,
        paymentTiming: "PayLater",
        tableLabel: label,
        orderReference: id(3),
        rounds: [round],
        owed: paid
          ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
          : { subtotalMinor: "1250", taxMinor: "163", totalMinor: "1413" },
        consistent: true,
        settlement: paid
          ? {
              method: "Cash",
              roundsMinor: "1413",
              tipMinor: "0",
              roundingMinor: "0",
              totalMinor: "1413",
              tenderedMinor: "1413",
              changeMinor: "0",
              recordedAt: "2026-11-22T19:02:00.000Z",
              recordedAfterOutage: false,
            }
          : null,
      },
    }),
  );
  return { phones };
}

async function openManage(page: Page, zh: boolean) {
  await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
  const panel = page.getByRole("complementary", {
    name: zh ? "所选桌台详情" : "Selected table details",
  });
  await panel.getByText(zh ? "管理这张桌" : "Manage this table").click();
  const phonesBlock = panel.getByRole("region", {
    name: zh ? "这桌的手机" : "Phones at this table",
  });
  await expect(phonesBlock).toBeVisible();
  return { panel, phonesBlock };
}

/** No step or line that says guests can still join, or that pausing it would do anything. */
async function expectNoJoiningSteps(page: Page, zh: boolean) {
  await expect(
    page.getByText(
      zh ? "客人扫这桌的二维码就能加入。" : "Guests join by scanning the table's QR code.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: zh ? "暂停扫码加入" : "Pause joining by scan" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: zh ? /扫码加入/u : /joining by scan/u }),
  ).toHaveCount(0);
  await expect(page.getByText(zh ? /暂停扫码加入/u : /pause joining by scan/iu)).toHaveCount(0);
  await expect(page.getByRole("button", { name: zh ? "换入桌码" : "New join code" })).toHaveCount(
    0,
  );
  // The checkout fact is not said again as a reason not to merge.
  await expect(page.getByText(zh ? /现在不能并桌/u : /Merging isn't available/u)).toHaveCount(0);
}

/** In view, inside the panel's column with room for wider Linux fonts, and no sideways scroll. */
async function expectFits(page: Page, text: string, width: number) {
  const line = page.getByText(text);
  await line.scrollIntoViewIfNeeded();
  await expect(line).toBeInViewport();
  const box = await line.evaluate((node) => node.getBoundingClientRect().toJSON() as DOMRect);
  expect(box.left).toBeGreaterThanOrEqual(16);
  expect(box.right).toBeLessThanOrEqual(width - 16);
  const fit = await line.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const words = range.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    return { overflow: node.scrollWidth - node.clientWidth, room: own.right - words.right };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.room).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of widths) {
    test(`@production WP-2423 batch 49: a table checking out says once that no one new can join, with no pause step (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { phones } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel, phonesBlock } = await openManage(page, zh);
      // Said once, in the phones block, where joining is.
      await expect(phonesBlock.getByText(paying(zh))).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expectNoJoiningSteps(page, zh);
      // The phone that just joined is still pointed out, and can still be taken off the table.
      await expect(phonesBlock).toContainText(zh ? "手机 1 刚加入。" : "Phone 1 just joined.");
      await expect(
        phonesBlock.getByRole("button", {
          name: zh ? "把手机 1 移出这桌" : "Remove phone 1 from this table",
        }),
      ).toBeVisible();
      await expect(panel).not.toContainText(settled(zh));
      expect(phones.filter((action) => action !== "State")).toEqual([]);
      await expectFits(page, paying(zh), width);
      await page.screenshot({ path: `test-results/b49-checkout-joining-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 49: a table that has paid says its bill is settled, once (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await checkoutFloor(page, "Paid", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { phonesBlock } = await openManage(page, zh);
      await expect(phonesBlock.getByText(settled(zh))).toBeVisible();
      await expect(page.getByText(settled(zh))).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await expectNoJoiningSteps(page, zh);
      await expectFits(page, settled(zh), width);
      await page.screenshot({ path: `test-results/b49-paid-joining-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 49: a stale New join code refused during checkout says the checkout fact once (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await checkoutFloor(page, "StaleThenPaying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel, phonesBlock } = await openManage(page, zh);
      // Loaded while the table was still ordering: joining by scan and its pause are offered.
      await expect(
        phonesBlock.getByRole("button", { name: zh ? "暂停扫码加入" : "Pause joining by scan" }),
      ).toBeVisible();
      await panel.getByRole("button", { name: zh ? "换入桌码" : "New join code" }).click();
      // The refusal and the re-read (now Closing) together say it once, in the panel, in view.
      await expect(panel.getByText(paying(zh)).first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: zh ? "换入桌码" : "New join code" }),
      ).toHaveCount(0);
      await expect(
        phonesBlock.getByRole("button", { name: zh ? "暂停扫码加入" : "Pause joining by scan" }),
      ).toHaveCount(0);
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toBeInViewport();
      await expectNoJoiningSteps(page, zh);
      await expect(
        page.getByText(
          zh ? "这张桌子有变动，已重新读取。" : "This table changed. It has been read again.",
        ),
      ).toHaveCount(0);
      await expectFits(page, paying(zh), width);
      await page.screenshot({ path: `test-results/b49-stale-code-once-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 49: a table still ordering keeps joining by scan and its pause (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await checkoutFloor(page, "Active", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel, phonesBlock } = await openManage(page, zh);
      await expect(
        phonesBlock.getByText(
          zh ? "客人扫这桌的二维码就能加入。" : "Guests join by scanning the table's QR code.",
        ),
      ).toBeVisible();
      await expect(
        phonesBlock.getByRole("button", { name: zh ? "暂停扫码加入" : "Pause joining by scan" }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: zh ? "换入桌码" : "New join code" }),
      ).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await expect(page.getByText(settled(zh))).toHaveCount(0);
      await expectNoInternalText(page, ["Mark unavailable"]);
    });
  }
