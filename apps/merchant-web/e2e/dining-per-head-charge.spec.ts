import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: the per-head charge is money, and it was lost silently: a failed
 * request kept the old status, so the screen said nothing and a short table paid and left. Whatever
 * was known before, a failure now stays on the screen with the way to match it, in the words of the
 * item the Store really charges, and a mismatch shows directly above the payment. Synthetic TEST data.
 */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const sauce = "Sauce (TEST)";
const charge = (fields: Record<string, unknown>) => ({
  status: "Charged",
  charged: 4,
  expected: 4,
  guests: 4,
  override: null,
  overrideVersion: 0,
  problem: null,
  itemName: sauce,
  ...fields,
});
const busy = (route: Route) =>
  route.fulfill({ headers, status: 503, json: { error: "dining_tea_charge_unavailable" } });

async function stubTable(
  page: Page,
  {
    ordered,
    tea,
    select = "Select T6",
  }: {
    ordered: boolean;
    tea: (route: Route, action: string) => Promise<void>;
    select?: string;
  },
) {
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
          businessDate: "2026-11-05",
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
        canOperateTables: true,
        canCloseSessions: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T6",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 40,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: {
              phase: "Active",
              version: 3,
              orderReference: ordered ? id(3) : null,
              paymentStarted: false,
              mergedTables: [],
            },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/qr-join", (route) =>
    route.fulfill({
      headers,
      json: { diningSessionReference: id(2), paused: false, phones: [], rounds: [] },
    }),
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        sessionPhase: "Active",
        sessionVersion: 3,
        paymentTiming: "PayLater",
        tableLabel: "T6",
        orderReference: id(3),
        rounds: [
          {
            roundNumber: 1,
            orderBatchReference: id(21),
            submissionReference: id(31),
            items: [
              {
                orderItemReference: id(903),
                quantity: 2,
                displayName: sauce,
                subtotalMinor: "400",
                totalMinor: "452",
              },
            ],
            subtotalMinor: "400",
            taxMinor: "52",
            totalMinor: "452",
            paid: false,
          },
        ],
        owed: { subtotalMinor: "400", taxMinor: "52", totalMinor: "452" },
        consistent: true,
        settlement: null,
      },
    }),
  );
  const party = { partySize: ordered ? 4 : (null as number | null), version: ordered ? 1 : 0 };
  await page.route("**/merchant/dining/party-size", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "Read")
      return route.fulfill({
        headers,
        json: {
          askPartySize: true,
          partySizes:
            party.partySize === null
              ? []
              : [
                  {
                    diningSessionReference: id(2),
                    partySize: party.partySize,
                    version: party.version,
                  },
                ],
        },
      });
    party.partySize = body.partySize as number;
    party.version += 1;
    return route.fulfill({
      headers,
      json: { diningSessionReference: id(2), partySize: party.partySize, version: party.version },
    });
  });
  const commands: string[] = [];
  await page.route("**/merchant/dining/tea-charge", (route) => {
    const action = String((route.request().postDataJSON() as { action: string }).action);
    commands.push(action);
    return tea(route, action);
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: select, exact: true }).click();
  return commands;
}

test("@production a table just opened says so when the charge couldn't be added", async ({
  page,
}) => {
  let answered = 0;
  const commands = await stubTable(page, {
    ordered: false,
    tea: (route, action) => {
      if (action === "Read")
        return route.fulfill({
          headers,
          json: charge({ status: "NoPartySize", charged: 0, expected: null, guests: null }),
        });
      answered += 1;
      return answered === 1 ? busy(route) : route.fulfill({ headers, json: charge({}) });
    },
  });
  const guests = page.getByRole("region", { name: "Guests at this table" });
  await guests.getByRole("textbox", { name: /How many guests/u }).fill("4");
  await guests.getByRole("button", { name: "Save", exact: true }).click();
  await expect(guests).toContainText("4 guests");
  // The whole request failed while the table still read "no party size": it was silent before.
  const alert = guests.getByRole("alert");
  await expect(alert).toContainText(
    "Sauce (TEST) on the bill isn't confirmed: the system is busy. Try again in a moment.",
  );
  const axe = await new AxeBuilder({ page }).include(".table-panel__party").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page, ["Mark unavailable"]);
  await alert.getByRole("button", { name: "Match Sauce (TEST) to the guests" }).click();
  await expect(guests).toContainText("Sauce (TEST) on the bill: 4");
  await expect(guests.getByRole("alert")).toHaveCount(0);
  expect(commands.filter((action) => action === "Sync")).toHaveLength(2);
});

test("@production a busy read is read once more, and only then said", async ({ page }) => {
  let reads = 0;
  await stubTable(page, {
    ordered: false,
    tea: (route, action) => {
      expect(action).toBe("Read");
      reads += 1;
      return reads === 1 ? busy(route) : route.fulfill({ headers, json: charge({}) });
    },
  });
  await expect(page.getByRole("region", { name: "Guests at this table" })).toContainText(
    "Sauce (TEST) on the bill: 4",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(2);
});

test("@production a busy read says nothing about a charge it doesn't know, and keeps trying", async ({
  page,
}) => {
  // A Store that never charged per head, at a busy moment, is not warned about a charge it doesn't
  // have; the read keeps trying quietly, and what it finds is shown once it answers.
  let reads = 0;
  let answering = false;
  await stubTable(page, {
    ordered: true,
    tea: (route) => {
      reads += 1;
      return answering
        ? route.fulfill({ headers, json: charge({ status: "Mismatch", charged: 2 }) })
        : busy(route);
    },
  });
  // Each panel reads, and reads once more at once: all busy, and nothing is said.
  await expect.poll(() => reads).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".table-panel__tea-check")).toHaveCount(0);
  await expect(page.getByText("isn't confirmed")).toHaveCount(0);
  answering = true;
  await expect(page.locator(".table-panel__tea-check")).toContainText(
    "Sauce (TEST) on the bill: 2 · guests: 4",
    { timeout: 15_000 },
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("@production a Store without a per-head charge is never told one isn't confirmed", async ({
  page,
}) => {
  let reads = 0;
  await stubTable(page, {
    ordered: true,
    tea: (route) => {
      reads += 1;
      return reads <= 4
        ? busy(route)
        : route.fulfill({
            headers,
            json: charge({ status: "NoTeaCharge", charged: 0, expected: null, itemName: null }),
          });
    },
  });
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(6);
  await expect(page.locator(".table-panel__tea-check")).toHaveCount(0);
  await expect(page.getByText("Per-head charge")).toHaveCount(0);
});

test("@production offline is told apart from a busy system", async ({ page }) => {
  await stubTable(page, {
    ordered: true,
    tea: (route, action) =>
      action === "Sync"
        ? route.abort("internetdisconnected")
        : route.fulfill({ headers, json: charge({ status: "Mismatch", charged: 2 }) }),
  });
  const check = page.locator(".table-panel__tea-check");
  await check.getByRole("button", { name: "Match Sauce (TEST) to the guests" }).click();
  await expect(check.getByRole("alert")).toContainText(
    "Sauce (TEST) on the bill isn't confirmed: this device is offline.",
  );
});

test("@production a count someone else changed first says so and is read again", async ({
  page,
}) => {
  // Two staff at one table: the second count carries the version the first one replaced.
  let saved = false;
  const versions: unknown[] = [];
  const commands = await stubTable(page, {
    ordered: false,
    tea: (route, action) => {
      if (action === "SetTeaCount") {
        versions.push(
          (route.request().postDataJSON() as { expectedVersion: unknown }).expectedVersion,
        );
        if (!saved) {
          saved = true;
          return route.fulfill({
            headers,
            status: 409,
            json: { error: "dining_tea_charge_changed" },
          });
        }
      }
      return route.fulfill({
        headers,
        json: saved
          ? charge({
              charged: 3,
              expected: 3,
              override: { teaQuantity: 3, reason: "ChildNotCharged" },
              overrideVersion: 1,
            })
          : charge({}),
      });
    },
  });
  const guests = page.getByRole("region", { name: "Guests at this table" });
  await guests.getByRole("textbox", { name: /How many guests/u }).fill("4");
  await guests.getByRole("button", { name: "Save", exact: true }).click();
  await guests.getByRole("button", { name: "Change Sauce (TEST) count" }).click();
  await guests.getByRole("textbox", { name: "Sauce (TEST) to charge" }).fill("2");
  await guests.getByRole("button", { name: "Save Sauce (TEST) count" }).click();
  await expect(guests.getByRole("alert")).toContainText(
    "Someone else changed the per-head count on this table. It has been read again: check it.",
  );
  await expect(guests).toContainText("Sauce (TEST) for 3 instead of 4 guests: child not charged");
  await expect(guests.getByRole("textbox", { name: "Sauce (TEST) to charge" })).toHaveCount(0);
  await expect(page.getByText("the system is busy")).toHaveCount(0);
  // The next count carries what is there now.
  await guests.getByRole("button", { name: "Change Sauce (TEST) count" }).click();
  await guests.getByRole("textbox", { name: "Sauce (TEST) to charge" }).fill("2");
  await guests.getByRole("button", { name: "Save Sauce (TEST) count" }).click();
  await expect(guests.getByRole("textbox", { name: "Sauce (TEST) to charge" })).toHaveCount(0);
  expect(versions).toEqual([0, 1]);
  expect(commands.filter((action) => action === "Read").length).toBeGreaterThanOrEqual(2);
});

test("@production a session that ended says so when Match is pressed", async ({ page }) => {
  await stubTable(page, {
    ordered: true,
    tea: (route, action) =>
      action === "Sync"
        ? route.fulfill({ headers, status: 401, json: { error: "denied" } })
        : route.fulfill({ headers, json: charge({ status: "Mismatch", charged: 2 }) }),
  });
  const check = page.locator(".table-panel__tea-check");
  await check.getByRole("button", { name: "Match Sauce (TEST) to the guests" }).click();
  await expect(check.getByRole("alert")).toContainText(
    "This wasn't saved: your access doesn't allow it, or you have been signed out.",
  );
});

test("@production a short charge shows directly above the payment and is never added by itself", async ({
  page,
}) => {
  let matched = false;
  const commands = await stubTable(page, {
    ordered: true,
    tea: (route, action) => {
      if (action === "Sync") matched = true;
      return route.fulfill({
        headers,
        json: matched ? charge({}) : charge({ status: "Mismatch", charged: 2 }),
      });
    },
  });
  // The guests panel is folded away once a table has an order; this line is not.
  await expect(page.locator("details.table-panel__manage")).not.toHaveAttribute("open", "");
  const check = page.locator(".table-panel__tea-check");
  await expect(check).toContainText("Sauce (TEST) on the bill: 2 · guests: 4");
  const above = await check.evaluate((node) => {
    const payment = document.querySelector(".table-checkout");
    return (
      payment !== null &&
      (node.compareDocumentPosition(payment) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  });
  expect(above, "the line sits above the payment").toBe(true);
  // Reading never adds: staff may have taken it off on purpose.
  expect(commands).not.toContain("Sync");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await check.getByRole("button", { name: "Match Sauce (TEST) to the guests" }).click();
  await expect(check).toHaveCount(0);
});

test("@production the charge's own name reads in the staff member's language", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
  await stubTable(page, {
    ordered: true,
    select: "选择 T6",
    tea: (route) =>
      route.fulfill({
        headers,
        json: charge({ status: "Mismatch", charged: 2, itemName: "调料位（测试）" }),
      }),
  });
  const check = page.locator(".table-panel__tea-check");
  await expect(check).toContainText("账单上的调料位（测试）：2 · 人数：4");
  await expect(check.getByRole("button", { name: "按人数调整调料位（测试）" })).toBeVisible();
});
