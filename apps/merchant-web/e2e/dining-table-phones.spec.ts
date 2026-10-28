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
        joinedAt: ago(40),
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

  // Pause from the new-phone notice: new guests then need a code.
  await phones.getByRole("note").getByRole("button", { name: "Pause joining by scan" }).click();
  await expect(phones).toContainText("Joining by scan is paused. New guests need a table code");
  await expect(phones.getByRole("button", { name: "Resume joining by scan" })).toBeVisible();

  // Remove phone 2 (asked once more first).
  await phones
    .getByRole("listitem")
    .filter({ hasText: "Phone 2" })
    .getByRole("button", { name: "Remove from this table" })
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
