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
 * with nothing moving for 8 s — within the time one answer to each distinct read takes.
 * Synthetic HTTP interception on the production build, TEST-only data.
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

async function home(page: Page) {
  const sent: { path: string; at: number }[] = [];
  let server: Promise<unknown> = Promise.resolve();
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
    // One request at a time, in the order they arrive, each for what it cost v15.
    const turn = server.then(() => later(costOf(path)));
    server = turn;
    await turn;
    const { status, json } = answer(path);
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
  return sent;
}

for (const [width, height] of [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const)
  test(`@production Home asks each read once, the day first, and shows whole within one answer to each, nothing moving for 8 s (${width})`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width, height });
    const sent = await home(page);
    await page.goto("/app");
    const needs = page.getByRole("region", { name: "Needs attention" });
    await expect(needs.getByText("Orders waiting to be accepted")).toBeVisible();
    await page.waitForTimeout(8_000);
    const seen = await page.evaluate(
      () =>
        (window as unknown as { homeSamples: { top: number; rows: number; at: number }[] })
          .homeSamples,
    );
    // Each read asked once while Home opened (its first 2.5 s; refreshes come later).
    const opening = sent.filter((entry) => entry.at - (sent[0]?.at ?? 0) < 2_500);
    for (const path of sharedPaths)
      expect(opening.filter((entry) => entry.path === path).length, path).toBeLessThanOrEqual(1);
    // The day's hours, which Home waits for, are asked first.
    expect(sent[0]?.path).toBe("/merchant/business-day");
    // Shown within the time one answer to each distinct read takes (and before the 3 s cap).
    const budget = [...new Set(opening.map((entry) => entry.path))].reduce(
      (sum, path) => sum + costOf(path),
      0,
    );
    const firstShown = seen[0]?.at ?? Infinity;
    expect(firstShown).toBeLessThan(budget + 400);
    expect(firstShown).toBeLessThan(3_000);
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
