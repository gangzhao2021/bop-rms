import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN (decisions 2–3): on the table page staff see the phones at
 * the table, numbered in join order. A phone that just joined is pointed out; staff pause joining
 * by scan and take a phone off the table. Synthetic, TEST-only data; no guest details.
 */
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

test("@production staff see the phones at a table, pause joining by scan and remove a phone", async ({
  page,
}) => {
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
          businessDate: "2026-10-28",
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
        canCloseSessions: false,
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
            paymentTiming: "PayFirst",
            session: { phase: "Active", version: 3, orderReference: null },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  const ago = (minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000);
    at.setUTCMilliseconds(0);
    return at.toISOString();
  };
  const state = {
    diningSessionReference: id(2),
    paused: false,
    phones: [
      {
        participantReference: id(11),
        phoneNumber: 1,
        joinedAt: ago(5),
        left: false,
        removed: false,
      },
      {
        participantReference: id(12),
        phoneNumber: 2,
        joinedAt: ago(3),
        left: false,
        removed: false,
      },
    ],
    rounds: [],
  };
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/sessions/qr-join", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (body.action === "Pause") state.paused = true;
    if (body.action === "Resume") state.paused = false;
    if (body.action === "Remove")
      state.phones = state.phones.map((phone) =>
        phone.participantReference === body.participantReference
          ? { ...phone, left: true, removed: true }
          : phone,
      );
    return route.fulfill({ headers, json: state });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  const phones = page.getByRole("region", { name: "Phones at this table" });
  await expect(phones).toContainText("Phone 2 just joined.");
  await expect(phones.getByRole("heading", { name: "2 phones at this table" })).toBeVisible();
  await expect(phones).toContainText("Guests join by scanning the table's QR code.");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await phones.screenshot({ path: `test-results/table-phones-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".table-phones").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page, ["Mark unavailable"]);

  // v15 2026-10-28 b: with two phones just joined, every control is shown once — the notices
  // only point them out; pausing is in the heading, each phone's remove is in its row.
  await expect(phones.getByRole("note")).toHaveCount(2);
  await expect(phones.getByRole("note").getByRole("button")).toHaveCount(0);
  const names = (await phones.getByRole("button").allTextContents()).map((name) => name.trim());
  expect(names.length).toBe(new Set(names).size);
  await expect(phones.getByRole("button", { name: "Pause joining by scan" })).toHaveCount(1);
  // Pause: new guests then need a code.
  await phones.getByRole("button", { name: "Pause joining by scan" }).click();
  await expect(phones).toContainText("Joining by scan is paused. New guests need a table code");
  await expect(phones.getByRole("button", { name: "Resume joining by scan" })).toBeVisible();

  // Remove phone 2 (asked once more first).
  // Each remove button names its phone (a screen reader can tell them apart), once each.
  const removeNames = await phones
    .getByRole("button", { name: /^Remove phone \d+ from this table$/u })
    .allTextContents();
  expect(removeNames.sort()).toEqual([
    "Remove phone 1 from this table",
    "Remove phone 2 from this table",
  ]);
  await expect(phones.getByRole("button", { name: "Remove from this table" })).toHaveCount(0);
  await phones
    .getByRole("listitem")
    .filter({ hasText: "Phone 2" })
    .getByRole("button", { name: "Remove phone 2 from this table" })
    .click();
  await expect(phones).toContainText("Remove phone 2? It can no longer see this table or order.");
  await phones.getByRole("button", { name: "Remove phone 2" }).click();
  await expect(phones.getByRole("heading", { name: "1 phone at this table" })).toBeVisible();
  await expect(phones).toContainText("Phone 2 · removed");
  await expect(phones).not.toContainText("Phone 2 just joined.");
  await phones.screenshot({ path: "test-results/table-phones-removed-1440.png" });

  const changes = sent.filter((body) => body.action !== "State");
  expect(changes.map((body) => body.action)).toEqual(["Pause", "Remove"]);
  expect(changes[1]).toMatchObject({ participantReference: id(12), diningSessionReference: id(2) });
  // Each change carries its own reference; nothing about the guest is sent.
  expect(changes[0]?.operationReference).not.toBe(changes[1]?.operationReference);
});

/**
 * WP-2423 item 8 ⑤ decisions 5–7: a guest's round waits for staff before the kitchen. The Tables
 * list puts the table under "needs action"; on the table page staff send it to the kitchen or
 * cancel it (asked once more). A manager turns on "a new phone's first round waits for staff".
 */
test("@production a round waiting for staff needs action; staff send it or cancel it; the setting", async ({
  page,
}) => {
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
          businessDate: "2026-10-28",
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
  const ago = (minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000);
    at.setUTCMilliseconds(0);
    return at.toISOString();
  };
  const held = [
    {
      orderReference: id(40),
      orderBatchReference: id(41),
      roundNumber: 2,
      reason: "FirstOrder",
      heldAt: ago(2),
    },
    {
      orderReference: id(40),
      orderBatchReference: id(42),
      roundNumber: 3,
      reason: "PhoneRapid",
      heldAt: ago(1),
    },
  ];
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: false,
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
            elapsedMinutes: 20,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: { phase: "Active", version: 3, orderReference: null },
            staffRoundsAwaitingPayment: [],
            heldRounds: held,
            newPhones: [{ phoneNumber: 2, joinedAt: ago(3) }],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  const setting = { version: 0, firstRoundNeedsStaff: false, canChange: true };
  const changes: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/round-hold-setting", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "Change") {
      changes.push(body);
      setting.version += 1;
      setting.firstRoundNeedsStaff = body.firstRoundNeedsStaff === true;
    }
    return route.fulfill({ headers, json: setting });
  });
  const decisions: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/held-round", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    decisions.push(body);
    held.splice(
      held.findIndex((round) => round.orderBatchReference === body.orderBatchReference),
      1,
    );
    return route.fulfill({
      headers,
      json: { status: body.action === "Confirm" ? "Sent" : "Cancelled" },
    });
  });
  await page.goto("/operations/dining");
  // The list: the table needs action for the waiting round (first: it never times out).
  await expect(page.getByText("Round waiting for your OK")).toBeVisible();
  await expect(
    page.getByText("first round from a new phone", { exact: false }).first(),
  ).toBeVisible();
  const settingBox = page.getByRole("checkbox", {
    name: "A new phone's first round waits for staff OK before the kitchen",
  });
  await expect(settingBox).not.toBeChecked();
  await settingBox.click();
  await expect(settingBox).toBeChecked();
  expect(changes).toMatchObject([{ expectedVersion: 0, firstRoundNeedsStaff: true }]);

  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  const waiting = page.getByRole("region", { name: "Rounds waiting for your OK" });
  await expect(waiting).toContainText("Round 2 is waiting for your OK");
  await expect(waiting).toContainText("It has not gone to the kitchen.");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await waiting.screenshot({ path: `test-results/held-rounds-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/held-rounds-page-1440.png" });
  const axe = await new AxeBuilder({ page }).include(".table-held-rounds").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page, ["Mark unavailable"]);

  // Send round 2; cancel round 3 after the second question.
  await waiting.getByRole("button", { name: "Send to kitchen" }).first().click();
  await expect.poll(() => decisions.length).toBe(1);
  const third = waiting.locator(".table-held-rounds__round").filter({ hasText: "Round 3" });
  await third.getByRole("button", { name: "Cancel this round" }).click();
  await expect(third).toContainText("Cancel round 3? Nothing was made or paid");
  await third.getByRole("button", { name: "Cancel this round" }).click();
  await expect.poll(() => decisions.length).toBe(2);
  expect(decisions).toMatchObject([
    { action: "Confirm", orderReference: id(40), orderBatchReference: id(41) },
    { action: "Cancel", orderReference: id(40), orderBatchReference: id(42) },
  ]);
  expect(decisions[0]?.operationReference).not.toBe(decisions[1]?.operationReference);
});
