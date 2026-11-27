import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { notPausedServiceControl } from "./service-control-state";

/**
 * Batch 36 (v15 b35 live minor): since batch 35 Home showed only its header and "Reading…" for
 * 1.8–2.3 s on every visit at Test Merchant 2, with every read answering normally. Measured on v15:
 * the merchant server answers its reads one at a time (one process, ~30–250 ms of its time each),
 * Home opened 29 of them where 21 say everything (the frame's refund warning and Home each read
 * the Orders list; the Approvals badge and Home each read the refunds and staff roles waiting;
 * Home's setup step and its panels each read the Store's setup and service), and the Store's
 * business day, which Home waits for, was sent last and answered after all the others.
 *
 * Here a synthetic server answers one request at a time, each costing what it cost v15 (rounded),
 * in the order they arrive. Home must ask each read once, ask for the day first, and show — whole,
 * with nothing moving for 8 s — as soon as the last read it needs has answered (it adds no wait of
 * its own). With a server that answers every read at once, Home shows in well under a second.
 * Batch 36 review: the store system's read failing twice and then answering on the background
 * retry takes the "could not be checked" row's place without moving anything.
 * Each run writes its timeline to test-results/b36/*.json (what was asked when, what answered when,
 * when Home showed). Synthetic HTTP interception on the production build, TEST-only data.
 */
const id = (n: number) => "019a3601-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const day = "2026-10-27";
const observedAt = "2026-10-27T18:01:00.000Z";
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What each read cost v15's merchant server at Test Merchant 2 (ms, rounded; 40 otherwise). */
const cost: readonly (readonly [RegExp, number])[] = [
  [/\/merchant\/orders$/u, 250],
  [/\/merchant\/order-exceptions$/u, 240],
  [/\/merchant\/business-day$/u, 180],
  [/\/merchant\/organization\/staff\/role-requests$/u, 130],
  [/\/merchant\/payments\/refunds\/approvals$/u, 100],
  [/\/merchant\/service-control$/u, 100],
  [/\/merchant\/dining\/tables$/u, 100],
  [/\/merchant\/store\/features$/u, 95],
  [/\/merchant\/pickup\/query$/u, 90],
  [/\/merchant\/store\/public-profile$/u, 90],
  [/\/merchant\/organization\/roles\/waiting$/u, 80],
  [/\/merchant\/store\/kitchen-setup$/u, 70],
  [/\/merchant\/operations-alerts$/u, 60],
];
const costOf = (path: string) => cost.find(([pattern]) => pattern.test(path))?.[1] ?? 40;
/** The reads Home holds its first view for (each adds a row or decides one). */
const held = [
  /\/merchant\/business-day$/u,
  /\/merchant\/orders$/u,
  /\/merchant\/order-exceptions$/u,
  /\/merchant\/pickup\/query$/u,
  /\/merchant\/dining\/tables$/u,
  /\/merchant\/operations-alerts$/u,
  /\/merchant\/payments\/refunds\/approvals$/u,
  /\/merchant\/organization\/staff\/role-requests$/u,
  /\/merchant\/organization\/roles\/waiting$/u,
  /\/merchant\/store\/kitchen-setup$/u,
  /\/merchant\/store\/features$/u,
  /\/merchant\/store\/public-profile$/u,
  /\/merchant\/service-control$/u,
];
/** Reads more than one part of the screen asks for. */
const sharedPaths = [
  "/merchant/orders",
  "/merchant/payments/refunds/approvals",
  "/merchant/organization/staff/role-requests",
  "/merchant/organization/roles/waiting",
  "/merchant/store/kitchen-setup",
  "/merchant/store/public-profile",
  "/merchant/service-control",
  "/merchant/organization/staff/me",
];

function answer(path: string): { status: number; json: unknown } {
  switch (path) {
    case "/merchant/business-day":
      return {
        status: 200,
        json: {
          businessDate: day,
          startsAt: "2026-10-27T08:00:00.000Z",
          endsAt: "2026-10-28T08:00:00.000Z",
          timeZone: "America/Toronto",
          observedAt,
        },
      };
    case "/merchant/orders":
      return {
        status: 200,
        json: {
          items: [
            {
              orderReference: id(1),
              orderNumber: "ORD-1",
              orderType: "Pickup",
              sourceChannel: "Web",
              submittedAt: "2026-10-27T17:00:00.000Z",
              observedAt,
              initialBatchReference: id(51),
              batches: [
                {
                  orderBatchReference: id(51),
                  sequence: 1,
                  acceptanceStatus: "NotAccepted",
                  canRequestAcceptance: true,
                  canCancel: false,
                  staffCancellation: null,
                  canCancelItems: false,
                },
              ],
              canRequestAcceptance: true,
              currentPhase: "Submitted",
              currentVersion: 1,
              unfulfillable: null,
              pickupNotCollected: false,
              acceptBy: null,
              awaitingPayment: false,
            },
          ],
          nextAfterOrderReference: null,
        },
      };
    case "/merchant/pickup/query":
      return {
        status: 200,
        json: {
          source: "CurrentFulfillment",
          workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
          storeReference: scope.storeReference,
          observedAt,
          nextAfterFulfillmentReference: null,
          items: [],
        },
      };
    case "/merchant/dining/tables":
      return {
        status: 200,
        json: {
          canOperateTables: true,
          canCloseSessions: true,
          canTransferHost: true,
          canCancelUnpaidRounds: true,
          nextAfterTableReference: null,
          items: [],
        },
      };
    case "/merchant/order-exceptions":
      return {
        status: 200,
        json: {
          screenId: "OPS-ORDER-EXCEPTION",
          projectionName: "merchant_order_exception_v1",
          storeLabel: scope.storeLabel,
          businessDate: day,
          projectedAt: observedAt,
          freshnessStatus: "Fresh",
          items: [],
        },
      };
    case "/merchant/operations-alerts":
      return {
        status: 200,
        json: {
          monitor: "Reporting",
          observedAt,
          active: [],
          recentlyCleared: [],
          outbound: { email: false, webhooks: 0, heartbeat: false },
          lastSuccessfulBackupAt: "2026-10-27T08:30:00.000Z",
        },
      };
    case "/merchant/service-control":
      return { status: 200, json: notPausedServiceControl(scope.storeReference) };
    case "/merchant/payments/refunds/approvals":
      return {
        status: 200,
        json: { observedAt, canApprove: true, canSend: true, soleOperator: null, entries: [] },
      };
    case "/merchant/organization/staff/role-requests":
      return {
        status: 200,
        json: { screenId: "APPROVAL-INBOX", sourceAsOf: observedAt, requests: [] },
      };
    case "/merchant/organization/roles/waiting":
      return {
        status: 200,
        json: { screenId: "APPROVAL-INBOX", sourceAsOf: observedAt, changes: [] },
      };
    default:
      // Everything else this staff member is not shown (their parts stay hidden).
      return { status: 403, json: { error: "permission_denied" } };
  }
}

interface Server {
  /** "serial": one request at a time, as v15's merchant server; "parallel": all at once. */
  readonly answers: "serial" | "parallel";
  /** How many store system reads fail (503) before they answer. */
  readonly alertsFail?: number;
}
interface Timeline {
  readonly sent: { path: string; at: number }[];
  readonly answered: { path: string; at: number; status: number }[];
}
async function home(page: Page, mode: Server = { answers: "serial" }): Promise<Timeline> {
  const sent: { path: string; at: number }[] = [];
  const answered: { path: string; at: number; status: number }[] = [];
  let server: Promise<unknown> = Promise.resolve();
  let alertsFailed = 0;
  await page.route("**/merchant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/merchant/session")
      return route.fulfill({
        headers,
        json: {
          authenticated: true,
          csrf: "a".repeat(43),
          workspace: {
            screenId: "HOME-OVERVIEW",
            selectedScope: { ...scope, timeZone: "America/Toronto" },
            authorizedStores: [scope],
            businessDate: day,
            storeStatus: "Open",
            freshness: "Current",
            dashboardAvailability: "UnavailableUntilWP1905",
            pauseOrderingShown: true,
            navigation: [
              ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
              ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"],
              [
                "OPS-ORDER-EXCEPTION",
                "Exceptions",
                "/operations/order-exceptions",
                "operations.order-exception.manage",
              ],
              ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
              ["APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"],
              [
                "STORE-SETUP",
                "Store setup",
                "/app/organization/stores/" + scope.storeReference + "/setup",
                "organization.manage",
              ],
            ].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission })),
          },
        },
      });
    sent.push({ path, at: Date.now() });
    if (mode.answers === "serial") {
      // One request at a time, in the order they arrive, each for what it cost v15.
      const turn = server.then(() => later(costOf(path)));
      server = turn;
      await turn;
    } else await later(costOf(path));
    const failing = path === "/merchant/operations-alerts" && alertsFailed < (mode.alertsFail ?? 0);
    if (failing) alertsFailed += 1;
    const { status, json } = failing
      ? { status: 503, json: { error: "operations_alerts_unavailable" } }
      : answer(path);
    answered.push({ path, at: Date.now(), status });
    return route.fulfill({ status, headers, json }).catch(() => undefined);
  });
  await page.addInitScript(() => {
    const samples: { top: number; rows: number; at: number }[] = [];
    (window as unknown as { homeSamples: typeof samples }).homeSamples = samples;
    const sample = () => {
      const now = document.querySelector("main .overview-now");
      if (now !== null && now.getClientRects().length > 0)
        samples.push({
          top: Math.round(now.getBoundingClientRect().top + window.scrollY),
          rows: document.querySelectorAll("main .overview-attention > li").length,
          at: performance.now(),
        });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return { sent, answered };
}

interface Sample {
  top: number;
  rows: number;
  at: number;
}
/** When Home first showed, on this process's clock, and every frame's sample since. */
async function shown(page: Page): Promise<{ at: number; fromStart: number; seen: Sample[] }> {
  const { seen, origin } = await page.evaluate(() => ({
    seen: (window as unknown as { homeSamples: Sample[] }).homeSamples,
    origin: performance.timeOrigin,
  }));
  const fromStart = seen[0]?.at ?? Infinity;
  return { at: origin + fromStart, fromStart, seen };
}
function keep(name: string, start: number, timeline: Timeline, firstShown: number) {
  // The timeline this run measured, kept with the screenshots (reproducible evidence).
  mkdirSync("test-results/b36", { recursive: true });
  writeFileSync(
    `test-results/b36/${name}.json`,
    JSON.stringify(
      {
        firstShownMs: Math.round(firstShown - start),
        sent: timeline.sent.map((entry) => ({ path: entry.path, atMs: entry.at - start })),
        answered: timeline.answered.map((entry) => ({
          path: entry.path,
          status: entry.status,
          atMs: entry.at - start,
        })),
      },
      null,
      2,
    ),
  );
}
/** When the last read Home holds for answered (its first answer each). */
function lastHeldAnswer(timeline: Timeline): number {
  return Math.max(
    ...held.map(
      (pattern) => timeline.answered.find((entry) => pattern.test(entry.path))?.at ?? Infinity,
    ),
  );
}

for (const [width, height] of [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const)
  test(`@production Home asks each read once, the day first, and shows whole once the last read it needs answers, nothing moving for 8 s (${width})`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width, height });
    const timeline = await home(page);
    const sent = timeline.sent;
    const start = Date.now();
    await page.goto("/app");
    const needs = page.getByRole("region", { name: "Needs attention" });
    await expect(needs.getByText("Orders waiting to be accepted")).toBeVisible();
    await page.waitForTimeout(8_000);
    const { at: firstShown, seen } = await shown(page);
    keep(`home-first-show-${width}`, start, timeline, firstShown);
    // Each read asked once while Home opened (its first 2.5 s; refreshes come later).
    const opening = sent.filter((entry) => entry.at - (sent[0]?.at ?? 0) < 2_500);
    for (const path of sharedPaths)
      expect(opening.filter((entry) => entry.path === path).length, path).toBeLessThanOrEqual(1);
    // The day's hours, which Home waits for, are asked first.
    expect(sent[0]?.path).toBe("/merchant/business-day");
    // Shown as soon as the last read it holds for has answered: Home adds no wait of its own (a
    // timer, a read sent only after another answered, or a read it does not need).
    expect(firstShown - lastHeldAnswer(timeline)).toBeLessThan(250);
    expect(firstShown - start).toBeLessThan(3_000);
    // Whole from its first frame: one place for "Right now", every row already there.
    expect(seen.length).toBeGreaterThan(100);
    expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
    expect(new Set(seen.map((entry) => entry.rows)).size).toBe(1);
    await expect(needs.getByText("Still checking")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/b36/home-first-show-${width}-en.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "切换到中文" }).first().click();
    await expect(page.getByRole("region", { name: "需要处理" })).toBeVisible();
    await expect(page.getByRole("region", { name: "需要处理" }).getByText("仍在查看")).toHaveCount(
      0,
    );
    await page.waitForTimeout(3_500);
    await page.screenshot({
      path: `test-results/b36/home-first-show-${width}-zh-Hans.png`,
      fullPage: true,
    });
    await expectNoInternalText(page);
  });

test("@production with a server that answers every read at once, Home shows whole in well under a second (1440)", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const timeline = await home(page, { answers: "parallel" });
  const start = Date.now();
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(needs.getByText("Orders waiting to be accepted")).toBeVisible();
  await page.waitForTimeout(3_000);
  const { at: firstShown, fromStart, seen } = await shown(page);
  keep("home-first-show-parallel-1440", start, timeline, firstShown);
  // The slowest read Home holds for costs 250 ms; the page itself takes the rest. Measured from the
  // page's first read, so a shared CI runner's slower start of the browser and bundle (818 ms whole
  // on 2026-11-21, against 360 ms here) is not counted as Home's own wait; the whole time keeps a
  // looser bound of its own.
  const firstAsked = Math.min(...timeline.sent.map((entry) => entry.at));
  expect(firstShown - firstAsked).toBeLessThan(600);
  expect(fromStart).toBeLessThan(1_500);
  expect(firstShown - lastHeldAnswer(timeline)).toBeLessThan(250);
  expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
  expect(new Set(seen.map((entry) => entry.rows)).size).toBe(1);
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const)
  test(`@production the store system read failing twice, then answering on the background retry, takes its row's place without moving anything (${width})`, async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width, height });
    const timeline = await home(page, { answers: "parallel", alertsFail: 2 });
    const start = Date.now();
    await page.goto("/app");
    const needs = page.getByRole("region", { name: "Needs attention" });
    await expect(needs.getByText("The store system could not be checked")).toBeVisible();
    // The background retry (4 s after the second failure) answers.
    await expect
      .poll(
        () =>
          timeline.answered.filter((entry) => entry.path === "/merchant/operations-alerts").length,
        { timeout: 8_000 },
      )
      .toBe(3);
    await page.waitForTimeout(1_500);
    const { at: firstShown, seen } = await shown(page);
    keep(`home-alerts-retry-${width}`, start, timeline, firstShown);
    expect(
      timeline.answered.filter((entry) => entry.path === "/merchant/operations-alerts"),
    ).toEqual([
      expect.objectContaining({ status: 503 }),
      expect.objectContaining({ status: 503 }),
      expect.objectContaining({ status: 200 }),
    ]);
    // Every frame from the first: "Right now" in one place and the same number of rows.
    expect(seen.length).toBeGreaterThan(100);
    expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
    expect(new Set(seen.map((entry) => entry.rows)).size).toBe(1);
    // The same row says so, in its place.
    await expect(needs.getByText("The store system was checked again")).toBeVisible();
    await expect(needs.getByText("The store system could not be checked")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/b36/home-alerts-retry-${width}-en.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "切换到中文" }).first().click();
    await expect(page.getByRole("region", { name: "需要处理" })).toBeVisible();
    await page.screenshot({
      path: `test-results/b36/home-alerts-retry-${width}-zh-Hans.png`,
      fullPage: true,
    });
    await expectNoInternalText(page);
  });
