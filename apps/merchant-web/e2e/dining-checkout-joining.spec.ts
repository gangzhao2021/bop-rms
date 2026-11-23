import { expect, test, type Page, type Route } from "@playwright/test";
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

// Batch 50 (v15 b49 live): the same one statement also says the party can't be moved or merged.
const paying = (zh: boolean) =>
  zh
    ? "这桌正在结账，不能换桌或并桌，不能再有人加入，也不能换新的入桌码。"
    : "This table is paying the bill, so it can't be moved or merged, no one new can join and no new join code can be made.";
const settled = (zh: boolean) =>
  zh
    ? "这桌已结清，不能换桌或并桌，不能再有人加入，也不能换新的入桌码。"
    : "This table's bill is settled, so it can't be moved or merged, no one new can join and no new join code can be made.";

async function checkoutFloor(
  page: Page,
  floor: Floor,
  language: "en" | "zh-Hans",
  /** A role that can't operate tables (no phones block), at a table with no QR code. */
  {
    viewOnlyNoCode = false,
    mergeRefuses = "Self",
  }: {
    readonly viewOnlyNoCode?: boolean;
    /**
     * Batch 51 (v15 b50 live): which table had begun checkout on another device when this screen's
     * stale Merge was pressed: this one, or the table it was merged into.
     */
    readonly mergeRefuses?: "Self" | "Other";
  } = {},
) {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "TM2",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  // Batch 51: the Store a sign-in made on another screen chose (v15 b50 live: TM2, or another).
  const otherScope = { ...scope, storeLabel: "TM3", storeReference: id(98) };
  const scopeNow = () => (state.signedInAgain === "OtherStore" ? otherScope : scope);
  await page.route("**/merchant/session", (route) => {
    state.sessionReads += 1;
    return route.fulfill({
      headers,
      json: {
        authenticated: true,
        // A sign-in made again on another screen of this browser has its own value.
        csrf: state.signedInAgain === null ? csrf : "b".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scopeNow(),
          authorizedStores: [scopeNow()],
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
    });
  });
  // Another device started checkout: from the refused join code on, every read shows Closing.
  // The guest pays later on the StaleThenPaying floor (state.paid, set by the test).
  // Batch 50: `cancelled` is Cancel checkout pressed on another device (reads show Active again);
  // `ended` is this screen's sign-in ended elsewhere (v15 b49 live: pushed out on another screen).
  // Batch 51: `otherPaying` is checkout begun on ZV49 D (TEST) on another device; `signedInAgain`
  // is a sign-in made again on another screen of this browser, as the same staff at this Store,
  // at another Store, or one that no longer sees this table.
  const state = {
    refused: false,
    paid: false,
    cancelled: false,
    ended: false,
    moves: 0,
    merges: 0,
    otherPaying: false,
    tableReads: 0,
    billReads: 0,
    sessionReads: 0,
    signedInAgain: null as null | "Same" | "OtherStore" | "TableGone",
  };
  const phaseNow = () =>
    floor === "Active" || state.cancelled || (floor === "StaleThenPaying" && !state.refused)
      ? "Active"
      : "Closing";
  // v15 b49 live, once the sign-in ended: every signed-in read answered 403 request_denied and
  // the deadline check 401 session_ended (too many screens).
  const ended = () => state.ended && state.signedInAgain === null;
  const deniedRead = { status: 403, headers, json: { error: "request_denied" } };
  // Batch 51 (v15 b50 live): once signed in again on another tab, this screen still sent the
  // ended sign-in's value, and the browser's new sign-in refused it (403).
  const endedValue = (route: Route) =>
    state.signedInAgain !== null && route.request().headers()["x-bop-csrf"] === csrf;
  await page.route(/\/merchant\/session\/(?:expiry|activity)$/u, (route) =>
    endedValue(route)
      ? route.fulfill(deniedRead)
      : ended()
        ? route.fulfill({
            status: 401,
            headers,
            json: { error: "session_ended", reason: "too_many_screens" },
          })
        : route.fulfill({
            headers,
            json: {
              idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              absoluteExpiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
              idleTimeoutMinutes: 30,
              serverTime: new Date().toISOString(),
            },
          }),
  );
  await page.route("**/merchant/sign-in-entry", (route) =>
    route.fulfill({ headers, json: { path: "/internal-test/staff", testOnly: true } }),
  );
  // A stale "Move to…" pressed after checkout began on another device (the server rule).
  await page.route("**/merchant/dining/table-move", (route) => {
    state.moves += 1;
    state.refused = true;
    return route.fulfill({ status: 409, headers, json: { error: "table_move_checking_out" } });
  });
  // A stale "Merge into…" pressed after checkout began on another device (the server rule:
  // either table not Active is refused with one code).
  await page.route("**/merchant/dining/table-merge", (route) => {
    state.merges += 1;
    if (mergeRefuses === "Other") state.otherPaying = true;
    else state.refused = true;
    return route.fulfill({ status: 409, headers, json: { error: "table_merge_checking_out" } });
  });
  const paidNow = () => floor === "Paid" || state.paid;
  await page.route("**/merchant/dining/tables", (route) => {
    if (ended() || endedValue(route)) return route.fulfill(deniedRead);
    state.tableReads += 1;
    const gone = state.signedInAgain === "OtherStore" || state.signedInAgain === "TableGone";
    return route.fulfill({
      headers,
      json: {
        canOperateTables: !viewOnlyNoCode,
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
            ...(viewOnlyNoCode ? { qrCodeValidUntil: null } : {}),
            currentDiningSessionReference: id(2),
            elapsedMinutes: 6,
            session: {
              phase: phaseNow(),
              version: phaseNow() === "Closing" ? 20 : 19,
              orderReference: id(3),
              paymentStarted: paidNow(),
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
              phase: state.otherPaying ? "Closing" : "Active",
              version: state.otherPaying ? 5 : 4,
              orderReference: id(13),
              paymentStarted: false,
              mergedTables: [],
            },
          },
          // Batch 50: a free table with a QR code, so "Move to…" has somewhere to go.
          {
            tableReference: id(51),
            stableLabel: "ZV49 E (TEST)",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 3,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            paymentTiming: "PayLater",
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            session: null,
          },
        ].filter((table) => !gone || table.tableReference !== id(1)),
        nextAfterTableReference: null,
      },
    });
  });
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
  };
  await page.route("**/merchant/dining/table-bill", (route) => {
    if (ended() || endedValue(route)) return route.fulfill(deniedRead);
    state.billReads += 1;
    const paid = paidNow();
    return route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        sessionPhase: phaseNow(),
        sessionVersion: phaseNow() === "Closing" ? 20 : 19,
        paymentTiming: "PayLater",
        tableLabel: label,
        orderReference: id(3),
        rounds: [{ ...round, paid }],
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
    });
  });
  return { phones, state };
}

const moveRegion = (zh: boolean) =>
  zh ? "把这桌客人换到另一张桌" : "Move this party to another table";
const mergeRegion = (zh: boolean) =>
  zh ? "把这桌客人并到另一桌" : "Merge this party into another table";
/** Batch 50: what the checkout says once this screen's sign-in has ended. */
const signedOutBill = (zh: boolean) =>
  zh
    ? "这台设备上的登录已结束，所以账单没有在读取。请重新登录后继续工作。"
    : "Your sign-in on this screen has ended, so the bill isn't being read. Sign in again to keep working.";

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

/**
 * In view, inside the panel's column, and no sideways scroll; and with room for wider Linux fonts:
 * laid out 40 px narrower than it is, the line still wraps inside itself with nothing cut off.
 */
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
    const element = node as HTMLElement;
    const before = element.style.cssText;
    element.style.boxSizing = "border-box";
    element.style.width = `${own.width - 40}px`;
    element.style.maxWidth = `${own.width - 40}px`;
    const narrower = element.scrollWidth - element.clientWidth;
    element.style.cssText = before;
    return {
      overflow: node.scrollWidth - node.clientWidth,
      room: own.right - words.right,
      narrower,
    };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.room).toBeGreaterThanOrEqual(0);
  expect(fit.narrower).toBeLessThanOrEqual(0);
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

    test(`@production WP-2423 batch 49: a stale New join code refused during checkout gives way to settled once the bill is paid (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "StaleThenPaying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel, phonesBlock } = await openManage(page, zh);
      await panel.getByRole("button", { name: zh ? "换入桌码" : "New join code" }).click();
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toBeInViewport();
      // The guest pays; the tables are read again (as when this tab comes back into view).
      state.paid = true;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      // Nothing still says the table is paying; that the bill is settled is said once.
      await expect(page.getByText(settled(zh))).toHaveCount(1);
      await expect(phonesBlock.getByText(settled(zh))).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await expectNoJoiningSteps(page, zh);
      await expectFits(page, settled(zh), width);
      await page.screenshot({
        path: `test-results/b49-stale-code-then-paid-${language}-${width}.png`,
      });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 49: a role that can't operate tables still reads the checkout fact at a table with no QR code (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await checkoutFloor(page, "Paying", language, { viewOnlyNoCode: true });
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
      const panel = page.getByRole("complementary", {
        name: zh ? "所选桌台详情" : "Selected table details",
      });
      await panel.getByText(zh ? "管理这张桌" : "Manage this table").click();
      await expect(panel.getByText(paying(zh))).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expect(
        page.getByRole("region", { name: zh ? "这桌的手机" : "Phones at this table" }),
      ).toHaveCount(0);
      await expectNoJoiningSteps(page, zh);
      await expectFits(page, paying(zh), width);
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

    test(`@production WP-2423 batch 50: a table paying the bill offers no Move and says once it can't be moved (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel, phonesBlock } = await openManage(page, zh);
      await expect(phonesBlock.getByText(paying(zh))).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      // No step that the server refuses only on submit.
      await expect(panel.getByRole("region", { name: moveRegion(zh) })).toHaveCount(0);
      await expect(panel.getByRole("combobox", { name: zh ? "换到…" : "Move to…" })).toHaveCount(0);
      await expect(panel.getByRole("region", { name: mergeRegion(zh) })).toHaveCount(0);
      expect(state.moves).toBe(0);
      await expectFits(page, paying(zh), width);
      await page.screenshot({ path: `test-results/b50-no-move-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 50: Cancel checkout on another device brings Move back (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel } = await openManage(page, zh);
      await expect(panel.getByRole("region", { name: moveRegion(zh) })).toHaveCount(0);
      // Checkout is cancelled; the tables are read again (as when this tab comes back into view).
      state.cancelled = true;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(panel.getByRole("combobox", { name: zh ? "换到…" : "Move to…" })).toBeVisible();
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await expect(page.getByText(settled(zh))).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: zh ? "换入桌码" : "New join code" }),
      ).toBeVisible();
    });

    test(`@production WP-2423 batch 50: a stale Move refused during checkout says the fact once, in view (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "StaleThenPaying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel } = await openManage(page, zh);
      // Loaded while the table was still ordering; another device then started checkout.
      const move = panel.getByRole("region", { name: moveRegion(zh) });
      await move
        .getByRole("combobox", { name: zh ? "换到…" : "Move to…" })
        .selectOption({ label: zh ? "ZV49 E (TEST) · 4 座" : "ZV49 E (TEST) · seats 4" });
      await move.getByRole("button", { name: zh ? /^换到 /u : /^Move to /u }).click();
      await expect.poll(() => state.moves).toBe(1);
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toBeInViewport();
      await expect(panel.getByRole("region", { name: moveRegion(zh) })).toHaveCount(0);
      await expect(
        page.getByText(
          zh ? "这桌正在结账，不能换桌。" : "This table is checking out, so it stays where it is.",
        ),
      ).toHaveCount(0);
      await expectFits(page, paying(zh), width);
      await page.screenshot({ path: `test-results/b50-stale-move-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 50: signed out on another screen during checkout says so, never a retrying outage (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
      const panel = page.getByRole("complementary", {
        name: zh ? "所选桌台详情" : "Selected table details",
      });
      await expect(panel.getByText("Beef noodles (TEST)").first()).toBeVisible();
      // Pushed out on another screen (v15 b49 live): reads 403, the sign-in check 401.
      state.ended = true;
      const dialog = page.getByRole("dialog", {
        name: zh ? "你已退出登录" : "You’ve been signed out",
      });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(
        dialog.getByRole("link", { name: zh ? "重新登录" : "Sign in again" }),
      ).toBeVisible();
      // Nothing on the page, under the cover either, says it is retrying an outage.
      await expect(page.getByText(signedOutBill(zh))).toHaveCount(1);
      await expect(page.getByText(zh ? /正在自动重试|自动重试/u : /Trying again/u)).toHaveCount(0);
      await expect(page.getByText(zh ? /无法重新读取/u : /could not be read again/u)).toHaveCount(
        0,
      );
      await page.screenshot({ path: `test-results/b50-signed-out-${language}-${width}.png` });
    });
  }

/**
 * WP-2423 batch 51 (v15 batch 50 live check, table-panel-move-and-signed-out). (1) A second device
 * that loaded before checkout began elsewhere pressed its armed "Merge into TPM50 A (TEST)": the
 * 409 table_merge_checking_out was said inside the merge block, below the fold (top 908 at
 * 1440x900), and nothing was read again, so the select still offered the paying table. (2) After
 * the signed-out cover, staff signed in again on another tab and pressed Check again: the cover
 * lifted but the selected table was dropped ("Choose a table to serve it…"), costing a tap.
 */
const widths51 = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;
const otherLabel = "ZV49 D (TEST)";
/** The table this party was to be merged into began checkout on another device. */
const otherPaying = (zh: boolean) =>
  zh
    ? `${otherLabel} 正在结账，不能把这桌客人并过去。`
    : `${otherLabel} is paying the bill, so this party can't be merged into it.`;
const oldMergeRefusal = (zh: boolean) =>
  zh
    ? "其中一桌正在结账。请在结账前并桌。"
    : "One of the tables is checking out. Merge before checking out.";
const stillSignedOut = (zh: boolean) =>
  zh
    ? "这台设备仍未登录。请重新登录后继续工作。"
    : "Still signed out on this screen. Sign in again to keep working.";
const otherStore = (zh: boolean) =>
  zh
    ? `现在登录的是 TM3，所以这里不显示 TM2 的 ${label}。`
    : `You're signed in at TM3 now, so ${label} at TM2 isn't shown here.`;
const tableGone = (zh: boolean) =>
  zh
    ? `这次登录看不到 ${label}（可能已删除，或这次登录没有权限看）。请从列表里选一桌。`
    : `${label} isn't on the floor for this sign-in (it was removed, or this sign-in can't see it). Choose a table from the list.`;
const noTableChosen = (zh: boolean) =>
  zh ? "选一桌来上菜、收款或关台。" : "Choose a table to serve it, take its payment or close it.";

async function pressStaleMerge(page: Page, zh: boolean) {
  const panel = page.getByRole("complementary", {
    name: zh ? "所选桌台详情" : "Selected table details",
  });
  const merge = panel.getByRole("region", { name: mergeRegion(zh) });
  await merge
    .getByRole("combobox", { name: zh ? "并到…" : "Merge into…" })
    .selectOption({ label: otherLabel });
  await merge
    .getByRole("button", { name: zh ? `并到 ${otherLabel}` : `Merge into ${otherLabel}` })
    .click();
  return { panel, merge };
}

async function signOutWithTableOpen(page: Page, zh: boolean, state: { ended: boolean }) {
  await page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }).click();
  const panel = page.getByRole("complementary", {
    name: zh ? "所选桌台详情" : "Selected table details",
  });
  await expect(panel.getByText("Beef noodles (TEST)").first()).toBeVisible();
  // Signed out on another screen (v15 b50 live: POST /merchant/logout from a second tab).
  state.ended = true;
  const dialog = page.getByRole("dialog", {
    name: zh ? "你已退出登录" : "You’ve been signed out",
  });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(signedOutBill(zh))).toHaveCount(1);
  return { panel, dialog };
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of widths51) {
    test(`@production WP-2423 batch 51: a stale Merge into a table that began checkout says so in view and reads the tables again (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Active", language, { mergeRefuses: "Other" });
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await openManage(page, zh);
      const readsBefore = state.tableReads;
      const { merge } = await pressStaleMerge(page, zh);
      await expect.poll(() => state.merges).toBe(1);
      // The fact is said once, where staff are looking, and the tables are read again at once.
      await expect(page.getByText(otherPaying(zh))).toHaveCount(1);
      await expect(page.getByText(otherPaying(zh))).toBeInViewport();
      await expect.poll(() => state.tableReads, { timeout: 3_000 }).toBeGreaterThan(readsBefore);
      await expect(page.getByText(oldMergeRefusal(zh))).toHaveCount(0);
      // The paying table is no longer offered: it says why, and the button no longer names it.
      const option = merge.locator("option", { hasText: otherLabel });
      await expect(option).toHaveJSProperty("disabled", true);
      await expect(option).toHaveText(
        zh ? `${otherLabel}——正在结账` : `${otherLabel} — checking out`,
      );
      await expect(
        merge.getByRole("button", { name: zh ? `并到 ${otherLabel}` : `Merge into ${otherLabel}` }),
      ).toHaveCount(0);
      await expect(merge.getByRole("button", { name: zh ? "并桌" : "Merge" })).toBeDisabled();
      // This table is still ordering: it says nothing about itself paying.
      await expect(page.getByText(paying(zh))).toHaveCount(0);
      await expectFits(page, otherPaying(zh), width);
      await page.screenshot({
        path: `test-results/b51-stale-merge-other-${language}-${width}.png`,
      });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 51: a stale Merge refused because this table began checkout says the checkout fact once, in view (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "StaleThenPaying", language, {
        mergeRefuses: "Self",
      });
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { panel } = await openManage(page, zh);
      const readsBefore = state.tableReads;
      await pressStaleMerge(page, zh);
      await expect.poll(() => state.merges).toBe(1);
      await expect.poll(() => state.tableReads, { timeout: 3_000 }).toBeGreaterThan(readsBefore);
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await expect(page.getByText(paying(zh))).toBeInViewport();
      await expect(panel.getByRole("region", { name: mergeRegion(zh) })).toHaveCount(0);
      await expect(panel.getByRole("region", { name: moveRegion(zh) })).toHaveCount(0);
      await expect(page.getByText(oldMergeRefusal(zh))).toHaveCount(0);
      await expectFits(page, paying(zh), width);
      await page.screenshot({ path: `test-results/b51-stale-merge-self-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 51: Check again while still signed out says so and keeps the cover (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { dialog } = await signOutWithTableOpen(page, zh, state);
      const sessionReads = state.sessionReads;
      await dialog.getByRole("button", { name: zh ? "再次检查" : "Check again" }).click();
      await expect(dialog.getByText(stillSignedOut(zh))).toBeVisible();
      await expect.poll(() => state.sessionReads).toBeGreaterThan(sessionReads);
      await expect(dialog).toBeVisible();
      await expect(page.getByText("Beef noodles (TEST)")).toHaveCount(0);
      await expect(page.getByText(zh ? /自动重试/u : /Trying again/u)).toHaveCount(0);
      await expectFits(page, stillSignedOut(zh), width);
      await page.screenshot({
        path: `test-results/b51-check-again-still-${language}-${width}.png`,
      });
    });

    test(`@production WP-2423 batch 51: Check again after signing in again as the same staff keeps the table and reads its bill at once (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { dialog } = await signOutWithTableOpen(page, zh, state);
      // Signed in again on another tab of this browser, as the same staff at this Store.
      state.signedInAgain = "Same";
      const bills = state.billReads;
      await dialog.getByRole("button", { name: zh ? "再次检查" : "Check again" }).click();
      await expect(
        page.getByRole("dialog", { name: zh ? "你已退出登录" : "You’ve been signed out" }),
      ).toHaveCount(0, { timeout: 10_000 });
      const panel = page.getByRole("complementary", {
        name: zh ? "所选桌台详情" : "Selected table details",
      });
      await expect(
        page.getByRole("button", { name: zh ? `选择 ${label}` : `Select ${label}` }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(panel.getByText("Beef noodles (TEST)").first()).toBeVisible({ timeout: 3_000 });
      expect(state.billReads).toBeGreaterThan(bills);
      await expect(page.getByText(noTableChosen(zh))).toHaveCount(0);
      await expect(page.getByText(signedOutBill(zh))).toHaveCount(0);
      await expect(page.getByText(paying(zh))).toHaveCount(1);
      await page.screenshot({ path: `test-results/b51-check-again-same-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 51: Check again finding the sign-in live after all keeps the table and reads its bill at once (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { dialog, panel } = await signOutWithTableOpen(page, zh, state);
      state.ended = false;
      const bills = state.billReads;
      await dialog.getByRole("button", { name: zh ? "再次检查" : "Check again" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(panel.getByText("Beef noodles (TEST)").first()).toBeVisible({ timeout: 3_000 });
      expect(state.billReads).toBeGreaterThan(bills);
      await expect(page.getByText(signedOutBill(zh))).toHaveCount(0);
      await expect(page.getByText(noTableChosen(zh))).toHaveCount(0);
    });

    test(`@production WP-2423 batch 51: Check again after signing in at another Store says plainly why the table isn't shown (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { dialog } = await signOutWithTableOpen(page, zh, state);
      state.signedInAgain = "OtherStore";
      await dialog.getByRole("button", { name: zh ? "再次检查" : "Check again" }).click();
      await expect(
        page.getByRole("dialog", { name: zh ? "你已退出登录" : "You’ve been signed out" }),
      ).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText(otherStore(zh))).toHaveCount(1);
      await expect(page.getByText(otherStore(zh))).toBeInViewport();
      await expect(page.getByText("Beef noodles (TEST)")).toHaveCount(0);
      await expectFits(page, otherStore(zh), width);
      await page.screenshot({
        path: `test-results/b51-check-again-store-${language}-${width}.png`,
      });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });

    test(`@production WP-2423 batch 51: Check again when the new sign-in no longer sees the table says so plainly (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      const { state } = await checkoutFloor(page, "Paying", language);
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      const { dialog } = await signOutWithTableOpen(page, zh, state);
      state.signedInAgain = "TableGone";
      await dialog.getByRole("button", { name: zh ? "再次检查" : "Check again" }).click();
      await expect(
        page.getByRole("dialog", { name: zh ? "你已退出登录" : "You’ve been signed out" }),
      ).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText(tableGone(zh))).toHaveCount(1);
      await expect(page.getByText(tableGone(zh))).toBeInViewport();
      await expectFits(page, tableGone(zh), width);
      await page.screenshot({ path: `test-results/b51-check-again-gone-${language}-${width}.png` });
      await expectNoInternalText(page, ["Mark unavailable"]);
    });
  }
