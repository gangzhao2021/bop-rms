import { expect, test } from "@playwright/test";

// WP-2423 (M171, Owner decision 17): a guest's allergy question comes first and in red, and
// front of house ticks the allergens the table must avoid (no free text). Synthetic fixtures only.
test("@production staff see an allergy question first and mark a table's allergies", async ({
  page,
}, testInfo) => {
  const id = (n: number) => "0190996d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-10",
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
  const now = Date.now();
  let marked: string[] = [];
  const table = (n: number, label: string, staffCall: unknown) => ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(10 + n),
    elapsedMinutes: 20,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall,
    ...(n === 1 && marked.length > 0 ? { tableAllergies: marked } : {}),
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        allergenChoices: [
          { code: "PEANUT", name: "Peanuts", nameZh: "" },
          { code: "SESAME", name: "Sesame", nameZh: "" },
          { code: "MILK", name: "Milk", nameZh: "" },
        ],
        canCloseSessions: false,
        canTransferHost: false,
        canCancelUnpaidRounds: false,
        items: [
          table(1, "T1", {
            callReference: id(31),
            reason: "AllergyQuestion",
            calledAt: new Date(now - 60_000).toISOString(),
          }),
          table(2, "T2", {
            callReference: id(32),
            reason: "Question",
            calledAt: new Date(now - 9 * 60_000).toISOString(),
          }),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/staff-calls/count", (route) =>
    route.fulfill({ headers, json: { open: 2 } }),
  );
  const saved: {
    allergenCodes: string[];
    basedOnAllergenCodes: string[];
    diningSessionReference: string;
  }[] = [];
  // Another server's save lands on the table before this screen's next save.
  let elsewhere: string[] | null = null;
  await page.route("**/merchant/dining/table-allergies", (route) => {
    const body = route.request().postDataJSON() as {
      allergenCodes: string[];
      basedOnAllergenCodes: string[];
      diningSessionReference: string;
    };
    saved.push(body);
    if (elsewhere !== null) {
      marked = elsewhere;
      elsewhere = null;
    }
    if (JSON.stringify([...body.basedOnAllergenCodes].sort()) !== JSON.stringify(marked))
      return route.fulfill({ headers, json: { status: "Changed", allergenCodes: marked } });
    marked = [...body.allergenCodes].sort();
    return route.fulfill({
      headers,
      json: { status: "Applied", allergenCodes: marked },
    });
  });

  await page.goto("/operations/dining");
  const rows = page.locator(".table-row");
  // Asked a minute ago, it still comes before a question asked nine minutes ago, and in red.
  await expect(rows.nth(0)).toContainText("Table T1");
  await expect(rows.nth(0)).toContainText("1 min ago · Allergy question");
  await expect(rows.nth(0)).toHaveAttribute("data-urgent", "true");
  await rows.nth(0).locator(".table-row__open").click();
  const allergies = page.getByRole("region", { name: "Allergies at this table" });
  await expect(allergies).toContainText("No allergies marked for this table.");
  await allergies.getByLabel("Peanuts").check();
  await allergies.getByLabel("Sesame").check();
  await allergies.getByRole("button", { name: "Save allergies" }).click();
  await expect(
    page.getByText("Table T1: kitchen tickets will show Peanuts, Sesame."),
  ).toBeVisible();
  expect(saved).toEqual([
    { ...saved[0], allergenCodes: ["PEANUT", "SESAME"], basedOnAllergenCodes: [] },
  ]);
  expect(saved[0]?.diningSessionReference).toBe(id(11));
  await expect(allergies).toContainText(
    "Kitchen tickets for this table will show: Peanuts, Sesame.",
  );
  // A colleague adds Milk; this screen, still showing Peanuts and Sesame, unticks Sesame. The
  // save is refused, Milk is not lost, and both servers' ticks stay for the next save.
  elsewhere = ["MILK", "PEANUT", "SESAME"];
  await allergies.getByLabel("Sesame").uncheck();
  await allergies.getByRole("button", { name: "Save allergies" }).click();
  await expect(allergies.getByRole("alert")).toContainText(
    "Someone else changed this table's allergies",
  );
  await expect(allergies).toContainText(
    "Kitchen tickets for this table will show: Milk, Peanuts, Sesame.",
  );
  await expect(allergies.getByLabel("Milk")).toBeChecked();
  await expect(allergies.getByLabel("Sesame")).toBeChecked();
  await allergies.getByLabel("Sesame").uncheck();
  await allergies.getByRole("button", { name: "Save allergies" }).click();
  await expect(page.getByText("Table T1: kitchen tickets will show Milk, Peanuts.")).toBeVisible();
  expect(saved.at(-1)).toMatchObject({
    allergenCodes: ["PEANUT", "MILK"],
    basedOnAllergenCodes: ["MILK", "PEANUT", "SESAME"],
  });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await allergies.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: process.env.SHOTS_DIR
        ? `${process.env.SHOTS_DIR}/table-allergies-${width}.png`
        : testInfo.outputPath(`table-allergies-${width}.png`),
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});
