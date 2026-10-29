import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2): with "ask how many guests
 * when opening a table" on, a table just opened asks for the number of guests; staff save it and
 * change it later. Another server's change first is said and read again. Synthetic TEST data.
 */
const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

test("@production staff record how many guests sit at a table and change it", async ({ page }) => {
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
  await page.route("**/merchant/dining/sessions/qr-join", (route) =>
    route.fulfill({
      headers,
      json: { diningSessionReference: id(2), paused: false, phones: [], rounds: [] },
    }),
  );
  const party = { partySize: null as number | null, version: 0 };
  const sent: Record<string, unknown>[] = [];
  let conflictOnce = false;
  await page.route("**/merchant/dining/party-size", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
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
    if (conflictOnce) {
      conflictOnce = false;
      // Another server recorded 6 first.
      party.partySize = 6;
      party.version += 1;
      return route.fulfill({ headers, status: 409, json: { error: "party_size_changed" } });
    }
    if (body.expectedVersion !== party.version)
      return route.fulfill({ headers, status: 409, json: { error: "party_size_changed" } });
    party.partySize = body.partySize as number;
    party.version += 1;
    return route.fulfill({
      headers,
      json: { diningSessionReference: id(2), partySize: party.partySize, version: party.version },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  const guests = page.getByRole("region", { name: "Guests at this table" });
  const count = guests.getByRole("textbox", { name: "How many guests at table T6?" });
  await expect(count).toBeVisible();
  const save = guests.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await count.fill("0");
  await expect(save).toBeDisabled();
  await count.fill("4");
  await save.click();
  await expect(guests).toContainText("4 guests");
  expect(sent.at(-1)).toMatchObject({
    action: "Record",
    diningSessionReference: id(2),
    expectedVersion: 0,
    partySize: 4,
  });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".table-panel__party").analyze();
  expect(axe.violations).toEqual([]);
  // A fifth guest arrives, but another server changed it first: said, and read again.
  conflictOnce = true;
  await guests.getByRole("button", { name: "Change", exact: true }).click();
  await guests.getByRole("textbox", { name: "Number of guests" }).fill("5");
  await guests.getByRole("button", { name: "Save", exact: true }).click();
  await expect(guests).toContainText(
    "Someone else changed the number of guests. It has been read again: check it.",
  );
  await expect(guests).toContainText("6 guests");
  await guests.getByRole("button", { name: "Change", exact: true }).click();
  await guests.getByRole("textbox", { name: "Number of guests" }).fill("5");
  await guests.getByRole("button", { name: "Save", exact: true }).click();
  await expect(guests).toContainText("5 guests");
  expect(sent.at(-1)).toMatchObject({ action: "Record", expectedVersion: 2, partySize: 5 });
  await expectNoInternalText(page, ["Mark unavailable"]);
});
