import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// v15 run (738b4c8b): the stock count list showed "Started" as 2026-10-07T22:59:17.279Z and the
// count said "counted by Staff 0100". Staff read Store-local times and people's names.
test("@production stock counts show Store-local times and people's names, never identifiers", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-07",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-COUNT-LIST",
              label: "Stock counts",
              href: "/operations/inventory/counts",
              permission: "inventory.count.read",
            },
          ],
        },
      },
    }),
  );
  const viewer = id(1),
    owner = id(256),
    milk = id(20),
    fridge = id(30);
  const base = {
    sourceAsOf: "2026-10-07T23:10:00.000Z",
    viewer,
    permissions: { mayCreate: true, mayCount: true, mayApprove: true },
    varianceReasons: ["UNRECORDED_WASTE", "COUNTING_ERROR"],
    items: [
      {
        itemReference: milk,
        internalCode: "MILK-2",
        name: "Whole milk",
        unitCode: "L",
        ledgerPrecision: 3,
      },
    ],
    locations: [{ locationReference: fridge, code: "FRIDGE-1", name: "Walk-in fridge" }],
    staff: [{ actorReference: viewer, label: "You" }],
    // The Brand Owner counted; they are not on this Store's staff list.
    people: [{ actorReference: owner, label: "Mina Chen" }],
  };
  await page.route("**/merchant/supply/counts/query", (route) => {
    const query = route.request().postDataJSON() as { countReference: string | null };
    if (query.countReference === null)
      return route.fulfill({
        headers,
        json: {
          screenId: "INV-COUNT-LIST",
          ...base,
          hasMore: false,
          counts: [
            {
              countReference: id(40),
              locationReference: fridge,
              status: "Submitted",
              countType: "Cycle",
              assigneeReference: owner,
              lineCount: 1,
              countedLines: 1,
              createdAt: "2026-10-07T22:59:17.279Z",
              createdBy: owner,
              updatedAt: "2026-10-07T23:05:00.000Z",
            },
          ],
        },
      });
    return route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-WORKBENCH",
        ...base,
        lots: { [id(50)]: { lotCode: "L-1007", expiryDate: "2026-10-20" } },
        count: {
          countReference: id(40),
          stockScope: { scopeType: "Location", scopeReference: fridge },
          countType: "Cycle",
          status: "Submitted",
          assigneeReference: owner,
          submittedBy: owner,
          approvedBy: null,
          aggregateVersion: 4,
          createdAt: "2026-10-07T22:59:17.279Z",
          updatedAt: "2026-10-07T23:05:00.000Z",
          lines: [
            {
              lineReference: id(60),
              itemReference: milk,
              lotReference: id(50),
              locationReference: fridge,
              unitCode: "L",
              expectedQuantity: "2.5",
              countedQuantity: "2.47",
              variance: "-0.03",
              varianceReasonCode: null,
              recountNumber: 0,
              movementReference: null,
            },
          ],
        },
      },
    });
  });

  await page.goto("/operations/inventory/counts");
  await expect(page.getByRole("heading", { name: "Stock counts", level: 2 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Walk-in fridge" });
  // 22:59 UTC is 6:59 PM in Toronto.
  await expect(row.getByRole("link", { name: "Oct 7, 6:59 PM" })).toBeVisible();
  await expect(row).toContainText("Mina Chen");
  await expect(row).toContainText("Cycle count");
  await expectNoInternalText(page);

  await row.getByRole("link", { name: "Oct 7, 6:59 PM" }).click();
  await expect(
    page.getByRole("heading", { name: "Count · Walk-in fridge", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText("counted by Mina Chen", { exact: false })).toBeVisible();
  await expect(page.getByText("submitted by Mina Chen", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: "L-1007 (exp. Oct 20, 2026)" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reason Whole milk" })).toBeVisible();
  await expectNoInternalText(page);
});

// WP-2423 (2026-10-18 v15) DEC-INV-COUNT-SHORT: a count lower than what open orders held could not
// be posted and the page said "The count changed meanwhile". The count posts; the manager sees the
// orders holding the missing stock and what to do, on the count and on the list.
test("@production a count below what open orders hold posts and lists those orders", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-COUNT-LIST",
              label: "Stock counts",
              href: "/operations/inventory/counts",
              permission: "inventory.count.read",
            },
          ],
        },
      },
    }),
  );
  const viewer = id(1),
    counter = id(2),
    milk = id(20),
    fridge = id(30),
    countReference = id(40);
  const base = {
    sourceAsOf: "2026-10-18T13:30:00.000Z",
    viewer,
    permissions: { mayCreate: true, mayCount: true, mayApprove: true },
    varianceReasons: ["UNRECORDED_WASTE", "THEFT_OR_LOSS"],
    items: [
      {
        itemReference: milk,
        internalCode: "MILK-2",
        name: "Whole milk",
        unitCode: "L",
        ledgerPrecision: 3,
      },
    ],
    locations: [{ locationReference: fridge, code: "FRIDGE-1", name: "Bar fridge" }],
    staff: [
      { actorReference: viewer, label: "You" },
      { actorReference: counter, label: "Sam" },
    ],
  };
  const shortages = [
    {
      itemReference: milk,
      locationReference: fridge,
      lotCode: "TEST-LOT-1017K",
      unitCode: "L",
      onHand: "0.1",
      reserved: "0.26",
      shortQuantity: "0.16",
      usedBeyondCount: "0",
      orders: [
        {
          orderReference: id(70),
          orderNumber: "9",
          orderType: "Pickup",
          businessDate: "2026-10-18",
          quantity: "0.26",
          ended: false,
        },
      ],
    },
  ];
  let posted = false;
  const commands: unknown[] = [];
  await page.route("**/merchant/supply/counts/command", (route) => {
    commands.push(route.request().postDataJSON());
    posted = true;
    return route.fulfill({
      headers,
      json: { status: "Applied", version: 7, movements: 1, shortItems: 1 },
    });
  });
  await page.route("**/merchant/supply/counts/query", (route) => {
    const query = route.request().postDataJSON() as { countReference: string | null };
    if (query.countReference === null)
      return route.fulfill({
        headers,
        json: {
          screenId: "INV-COUNT-LIST",
          ...base,
          shortages,
          hasMore: false,
          counts: [
            {
              countReference,
              locationReference: fridge,
              status: "Posted",
              countType: "Spot",
              assigneeReference: counter,
              lineCount: 1,
              countedLines: 1,
              createdAt: "2026-10-18T13:00:00.000Z",
              createdBy: viewer,
              updatedAt: "2026-10-18T13:30:00.000Z",
            },
          ],
        },
      });
    return route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-WORKBENCH",
        ...base,
        shortages: posted ? shortages : [],
        lots: { [id(50)]: { lotCode: "TEST-LOT-1017K", expiryDate: null } },
        count: {
          countReference,
          stockScope: { scopeType: "Location", scopeReference: fridge },
          countType: "Spot",
          status: posted ? "Posted" : "Submitted",
          assigneeReference: counter,
          submittedBy: counter,
          approvedBy: posted ? viewer : null,
          aggregateVersion: posted ? 7 : 5,
          createdAt: "2026-10-18T13:00:00.000Z",
          updatedAt: "2026-10-18T13:20:00.000Z",
          lines: [
            {
              lineReference: id(60),
              itemReference: milk,
              lotReference: id(50),
              locationReference: fridge,
              unitCode: "L",
              expectedQuantity: "11.23",
              countedQuantity: "0.1",
              variance: "-11.13",
              varianceReasonCode: "THEFT_OR_LOSS",
              recountNumber: 0,
              movementReference: posted ? id(61) : null,
            },
          ],
        },
      },
    });
  });

  await page.goto(`/operations/inventory/counts/${countReference}`);
  await expect(page.getByRole("heading", { name: "Count · Bar fridge", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Approve and post differences" }).click();
  await expect(page.getByText("Posted", { exact: false }).first()).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ action: "ApproveAndPost", expectedVersion: 5 });
  const notice = page.getByRole("region", { name: "Less in stock than open orders need" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "Whole milk (lot TEST-LOT-1017K) at Bar fridge: 0.1 L in stock, 0.26 L held for open orders — short by 0.16 L.",
  );
  await expect(notice.getByRole("link", { name: "Order 9" })).toHaveAttribute(
    "href",
    `/operations/orders/${id(70)}`,
  );
  await expect(notice.getByRole("link", { name: "Receiving" })).toBeVisible();
  await expect(page.getByText("The count changed meanwhile")).toHaveCount(0);
  await expectNoInternalText(page);

  await page.getByRole("link", { name: "All counts" }).click();
  await expect(page.getByRole("heading", { name: "Stock counts", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Less in stock than open orders need" }),
  ).toContainText("short by 0.16 L");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test("@production a count step that fails says nothing changed, not that the count changed", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-COUNT-LIST",
              label: "Stock counts",
              href: "/operations/inventory/counts",
              permission: "inventory.count.read",
            },
          ],
        },
      },
    }),
  );
  let failure: { status: number; error: string } = { status: 503, error: "Unavailable" };
  await page.route("**/merchant/supply/counts/command", (route) =>
    route.fulfill({
      headers,
      status: failure.status,
      json: { error: failure.error, lineReferences: [] },
    }),
  );
  await page.route("**/merchant/supply/counts/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-WORKBENCH",
        sourceAsOf: "2026-10-18T13:30:00.000Z",
        viewer: id(1),
        permissions: { mayCreate: true, mayCount: true, mayApprove: true },
        varianceReasons: ["THEFT_OR_LOSS"],
        items: [
          {
            itemReference: id(20),
            internalCode: "MILK-2",
            name: "Whole milk",
            unitCode: "L",
            ledgerPrecision: 3,
          },
        ],
        locations: [{ locationReference: id(30), code: "FRIDGE-1", name: "Bar fridge" }],
        staff: [
          { actorReference: id(1), label: "You" },
          { actorReference: id(2), label: "Sam" },
        ],
        shortages: [],
        lots: {},
        count: {
          countReference: id(40),
          stockScope: { scopeType: "Location", scopeReference: id(30) },
          countType: "Spot",
          status: "Submitted",
          assigneeReference: id(2),
          submittedBy: id(2),
          approvedBy: null,
          aggregateVersion: 5,
          createdAt: "2026-10-18T13:00:00.000Z",
          updatedAt: "2026-10-18T13:20:00.000Z",
          lines: [
            {
              lineReference: id(60),
              itemReference: id(20),
              lotReference: null,
              locationReference: id(30),
              unitCode: "L",
              expectedQuantity: "1",
              countedQuantity: "0.9",
              variance: "-0.1",
              varianceReasonCode: "THEFT_OR_LOSS",
              recountNumber: 0,
              movementReference: null,
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/operations/inventory/counts/${id(40)}`);
  const post = page.getByRole("button", { name: "Approve and post differences" });
  await post.click();
  await expect(page.getByText("nothing was changed", { exact: false })).toBeVisible();
  await expect(page.getByText("changed this count meanwhile")).toHaveCount(0);
  failure = { status: 409, error: "Conflict" };
  await post.click();
  await expect(
    page.getByText("Someone else changed this count meanwhile", { exact: false }),
  ).toBeVisible();
});

// v15 2026-10-18 D1 (DEC-INV-COUNT-SHORT amendment): milk short against open orders vanished from
// the waste form, so spilled milk could not be recorded. It is listed with what is there and what
// orders hold, a plain note, and can be recorded up to what is there.
test("@production the waste form lists stock held for open orders and records it up to what is there", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-WASTE-RECORD",
              label: "Waste",
              href: "/operations/inventory/waste",
              permission: "inventory.waste.record",
            },
          ],
        },
      },
    }),
  );
  const viewer = id(1),
    milk = id(20),
    beans = id(21),
    fridge = id(30),
    lot = id(50);
  const base = {
    sourceAsOf: "2026-10-18T14:40:00.000Z",
    viewer,
    permissions: { mayRecord: true, mayRead: true, mayReview: false },
    reasons: ["EXPIRED", "SPOILED", "DROPPED", "OTHER"],
    acceptReasons: ["REVIEWED_OK"],
    voidReasons: ["ENTERED_IN_ERROR"],
    reviewThresholdMinor: 2500,
    items: [
      {
        itemReference: milk,
        name: "Whole milk",
        unitCode: "L",
        ledgerPrecision: 3,
        lotTracking: "Lot",
      },
      {
        itemReference: beans,
        name: "Coffee beans",
        unitCode: "KG",
        ledgerPrecision: 3,
        lotTracking: "NoLot",
      },
    ],
    locations: [{ locationReference: fridge, name: "Bar fridge" }],
    stock: [
      {
        itemReference: milk,
        locationReference: fridge,
        lotReference: lot,
        lotCode: "TEST-LOT-1017K",
        expiryDate: null,
        unitCode: "L",
        onHand: "0.05",
        reserved: "0.12",
        available: "-0.07",
      },
      {
        itemReference: beans,
        locationReference: fridge,
        lotReference: null,
        lotCode: null,
        expiryDate: null,
        unitCode: "KG",
        onHand: "4.3",
        reserved: "0",
        available: "4.3",
      },
    ],
    people: { [viewer]: "You" },
    hasMore: false,
  };
  const commands: { lines: { quantity: string; itemReference: string }[] }[] = [];
  await page.route("**/merchant/supply/waste/command", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.route("**/merchant/supply/waste/query", (route) => {
    const query = route.request().postDataJSON() as { wasteReference: string | null };
    return route.fulfill({
      headers,
      json:
        query.wasteReference === null
          ? { screenId: "INV-WASTE-LIST", ...base, records: [] }
          : {
              screenId: "INV-WASTE-DETAIL",
              ...base,
              records: [
                {
                  wasteReference: query.wasteReference,
                  lines: [
                    {
                      lineReference: id(70),
                      itemReference: milk,
                      locationReference: fridge,
                      lotReference: lot,
                      quantity: "0.05",
                      reasonCode: "DROPPED",
                      note: null,
                      unitCode: "L",
                      unitCostMinor: 300,
                      valueMinor: 15,
                    },
                  ],
                  valueMinor: 15,
                  costUnknown: false,
                  needsReview: false,
                  recordedBy: viewer,
                  recordedAt: "2026-10-18T14:41:00.000Z",
                  review: null,
                },
              ],
            },
    });
  });

  await page.goto("/operations/inventory/waste/new");
  await expect(page.getByRole("heading", { name: "Record waste", level: 2 })).toBeVisible();
  const item = page.getByLabel("Item");
  await expect(item.locator("option", { hasText: "Whole milk (L)" })).toHaveCount(1);
  await expect(item).toHaveValue(milk);
  await expect(page.locator("label", { hasText: "Quantity (L)" })).toContainText(
    "— 0.05 in stock, 0.12 held for open orders",
  );
  const note = page.getByRole("note");
  await expect(note).toHaveText(
    "Held for open orders — recording this waste makes the shortage bigger; receive stock or recount.",
  );
  await page.getByLabel(/^Quantity/u).fill("0.06");
  await page.getByLabel("Reason").selectOption("DROPPED");
  await page.getByRole("button", { name: "Record waste" }).click();
  await expect(
    page.getByText("asks for more than is in stock there", { exact: false }),
  ).toBeVisible();
  expect(commands).toHaveLength(0);
  await page.getByLabel(/^Quantity/u).fill("0.05");
  await page.getByRole("button", { name: "Record waste" }).click();
  await expect(page).toHaveURL(/\/operations\/inventory\/waste\/[0-9a-f-]{36}$/u);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.lines.map((line) => [line.itemReference, line.quantity])).toEqual([
    [milk, "0.05"],
  ]);

  // Stock nobody holds carries no note.
  await page.goto("/operations/inventory/waste/new");
  await page.getByLabel("Item").selectOption(beans);
  await expect(page.locator("label", { hasText: "Quantity (KG)" })).toContainText("— 4.3 in stock");
  await expect(page.locator("label", { hasText: "Quantity (KG)" })).not.toContainText("held");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

// v15 2026-10-18 D2: "Refresh lines where stock moved" on a count just started was refused with
// "This step is not possible in the count's current state". It is offered only when stock moved.
test("@production a count offers the refresh only when stock moved on its lines", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-COUNT-LIST",
              label: "Stock counts",
              href: "/operations/inventory/counts",
              permission: "inventory.count.read",
            },
          ],
        },
      },
    }),
  );
  const viewer = id(1),
    line = id(60);
  let moved: string[] = [];
  let version = 3;
  const commands: { action: string; expectedVersion: number }[] = [];
  await page.route("**/merchant/supply/counts/command", (route) => {
    commands.push(route.request().postDataJSON());
    moved = [];
    version += 1;
    return route.fulfill({ headers, json: { status: "Applied", version } });
  });
  await page.route("**/merchant/supply/counts/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-WORKBENCH",
        sourceAsOf: "2026-10-18T14:30:00.000Z",
        viewer,
        permissions: { mayCreate: true, mayCount: true, mayApprove: false },
        varianceReasons: ["THEFT_OR_LOSS"],
        items: [
          {
            itemReference: id(20),
            internalCode: "MILK-2",
            name: "Whole milk",
            unitCode: "L",
            ledgerPrecision: 3,
          },
        ],
        locations: [{ locationReference: id(30), code: "FRIDGE-1", name: "Bar fridge" }],
        staff: [{ actorReference: viewer, label: "You" }],
        shortages: [],
        lots: {},
        movedLineReferences: moved,
        count: {
          countReference: id(40),
          stockScope: { scopeType: "Location", scopeReference: id(30) },
          countType: "Spot",
          status: "InProgress",
          assigneeReference: viewer,
          submittedBy: null,
          approvedBy: null,
          aggregateVersion: version,
          createdAt: "2026-10-18T14:20:00.000Z",
          updatedAt: "2026-10-18T14:21:00.000Z",
          lines: [
            {
              lineReference: line,
              itemReference: id(20),
              lotReference: null,
              locationReference: id(30),
              unitCode: "L",
              expectedQuantity: null,
              countedQuantity: null,
              variance: null,
              varianceReasonCode: null,
              recountNumber: 0,
              movementReference: null,
            },
          ],
        },
      },
    }),
  );
  const refresh = page.getByRole("button", { name: "Refresh lines where stock moved" });
  await page.goto(`/operations/inventory/counts/${id(40)}`);
  await expect(page.getByRole("heading", { name: "Count · Bar fridge", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save counts" })).toBeVisible();
  await expect(refresh).toHaveCount(0);
  await expect(page.getByText("stock moved", { exact: false })).toHaveCount(0);

  // A sale used milk while counting: the line is marked and the refresh is offered.
  moved = [line];
  await page.reload();
  await expect(page.getByRole("note")).toHaveText(
    "Stock moved on 1 line since counting started (sales, deliveries or waste). Refresh them and count them again.",
  );
  await expect(page.getByRole("cell", { name: "Whole milk · stock moved" })).toBeVisible();
  await refresh.click();
  await expect(refresh).toHaveCount(0);
  expect(commands).toEqual([expect.objectContaining({ action: "Refresh", expectedVersion: 3 })]);
  await expect(page.getByText("not possible in the count's current state")).toHaveCount(0);
  await expectNoInternalText(page);
});
