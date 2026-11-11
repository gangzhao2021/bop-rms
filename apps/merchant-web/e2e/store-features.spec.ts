import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the owner chooses the modules the Store uses. The
 * full-service setup turns off counter ordering and inventory and recipes; a module can be turned
 * back on; someone else's change in between is shown and asked again. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190a7f2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};

/** WP-2423 (M178): the kitchen's cross-contact statement, answered as the server would. */
const kitchenStatementSaves: unknown[] = [];
async function kitchenStatement(page: Page) {
  let statement: { handledAllergenCodes: string[]; sharedEquipment: string[] } | null = null;
  await page.route("**/merchant/store/kitchen-statement", (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      handledAllergenCodes?: string[];
      sharedEquipment?: string[];
    };
    if (body.action === "Change") {
      kitchenStatementSaves.push(body);
      statement = {
        handledAllergenCodes: body.handledAllergenCodes ?? [],
        sharedEquipment: body.sharedEquipment ?? [],
      };
    }
    return route.fulfill({
      headers,
      json: {
        status: "Current",
        statement,
        allergenChoices: [
          { code: "PEANUT", name: "Peanuts", nameZh: "花生" },
          { code: "SESAME", name: "Sesame", nameZh: "芝麻" },
        ],
      },
    });
  });
}

async function session(page: Page) {
  await kitchenStatement(page);
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
          businessDate: "2026-10-29",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-CAPABILITY",
              label: "Store features",
              href: "/app/organization/stores/" + store + "/capabilities",
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
}

test("@production the owner applies the full-service setup, turns a module back on, and sees a change made meanwhile", async ({
  page,
}) => {
  await session(page);
  let current = {
    version: 0,
    templateCode: null as string | null,
    modules: { counterOrder: true, pickup: true, inventory: true, loyalty: false, alcohol: false },
    changedAt: null as string | null,
    services: {
      version: 0,
      staffCall: false,
      chaseDish: false,
      askPartySize: false,
      changedAt: null as string | null,
    },
    teaCharge: {
      version: 0,
      teaSellableReference: null as string | null,
      changedAt: null as string | null,
      kitchenPrepares: false,
    },
    // v15 2026-10-29: only items on the listed dine-in menu, each by its own name.
    teaChoices: [
      {
        sellableReference: id(505),
        name: "Tea (TEST) 茶位",
        unavailable: null,
        declaredCharge: true,
        priceAmount: "1.50",
        kitchenPrepares: false,
      },
      {
        sellableReference: id(507),
        name: "Kung Pao chicken (TEST) 宫保鸡丁",
        unavailable: null,
        declaredCharge: false,
        priceAmount: "18.00",
        kitchenPrepares: false,
      },
      {
        sellableReference: id(508),
        name: "Plated sauce (TEST)",
        unavailable: null,
        declaredCharge: false,
        priceAmount: "2.00",
        kitchenPrepares: true,
      },
      // Hidden from this store on the menu: a staff round could not sell it.
      {
        sellableReference: id(506),
        name: "Jasmine tea (TEST)",
        unavailable: "NotOffered",
        declaredCharge: true,
        priceAmount: null,
        kitchenPrepares: false,
      },
    ],
    tips: {
      version: 0,
      enabled: true,
      tierPercents: [10, 15, 18],
      changedAt: null as string | null,
      offInStoreSetup: false,
    },
    canChange: true,
  };
  const commands: Record<string, unknown>[] = [];
  let conflictOnce = false;
  await page.route("**/merchant/store/features", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (body.action === "Read") return route.fulfill({ headers, json: current });
    if (body.action === "ChangeTeaCharge") {
      if (body.expectedVersion !== current.teaCharge.version)
        return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
      current = {
        ...current,
        teaCharge: {
          version: current.teaCharge.version + 1,
          teaSellableReference: body.teaSellableReference as string | null,
          changedAt: "2026-10-29T15:30:00.000Z",
          kitchenPrepares: body.teaSellableReference === id(508),
        },
      };
      return route.fulfill({ headers, json: current });
    }
    if (body.action === "ChangeTips") {
      if (body.expectedVersion !== current.tips.version)
        return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
      current = {
        ...current,
        tips: {
          version: current.tips.version + 1,
          enabled: body.enabled === true,
          tierPercents: body.tierPercents as number[],
          changedAt: "2026-10-29T15:20:00.000Z",
          offInStoreSetup: false,
        },
      };
      return route.fulfill({ headers, json: current });
    }
    if (body.action === "ChangeServices") {
      if (body.expectedVersion !== current.services.version)
        return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
      current = {
        ...current,
        services: {
          version: current.services.version + 1,
          staffCall: body.staffCall === true,
          chaseDish: body.chaseDish === true,
          askPartySize: body.askPartySize === true,
          changedAt: "2026-10-29T15:10:00.000Z",
        },
      };
      return route.fulfill({ headers, json: current });
    }
    if (conflictOnce) {
      conflictOnce = false;
      // Another owner session turned counter ordering back on first.
      current = {
        ...current,
        version: current.version + 1,
        templateCode: "Custom",
        modules: { ...current.modules, counterOrder: true },
      };
      return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
    }
    if (body.expectedVersion !== current.version)
      return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
    current =
      body.action === "ApplyTemplate"
        ? {
            ...current,
            version: current.version + 1,
            templateCode: "FullService",
            modules: {
              counterOrder: false,
              pickup: false,
              inventory: false,
              loyalty: false,
              alcohol: false,
            },
            changedAt: "2026-10-29T15:00:00.000Z",
          }
        : {
            ...current,
            version: current.version + 1,
            templateCode: "Custom",
            modules: { ...current.modules, ...(body.modules as object) },
            changedAt: "2026-10-29T15:05:00.000Z",
          };
    return route.fulfill({ headers, json: current });
  });

  // WP-2423 item 8 ⑧: the kitchen sections (none yet).
  let sections = { version: 0, sections: [] as { sectionReference: string; name: string }[] };
  const sectionCommands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sectionCommands.push(body);
    if (body.action === "ChangeSections") {
      if (body.expectedVersion !== sections.version)
        return route.fulfill({ headers, status: 409, json: { error: "kitchen_sections_changed" } });
      sections = {
        version: sections.version + 1,
        sections: body.sections as { sectionReference: string; name: string }[],
      };
    }
    return route.fulfill({ headers, json: { ...sections, products: [] } });
  });
  // Fulfillment's current pickup queue (the Pickup page's read): two orders still waiting.
  let pickupReadable = true;
  const waitingItem = (n: number) => ({
    fulfillmentReference: id(200 + n),
    orderReference: id(300 + n),
    phase: "Ready",
    aggregateVersion: "2",
    readyAt: "2026-10-29T14:50:00.000Z",
    publicOrderReference: String.fromCharCode(65 + n).repeat(22),
    proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-10-29T16:00:00.000Z" },
    items: [
      {
        fulfillmentItemReference: id(400 + n),
        orderedQuantity: 1,
        readyQuantity: 1,
        handedOverQuantity: 0,
      },
    ],
  });
  // The queue's answer can be held back, to see the confirmation while it is still read.
  let release: (() => void) | null = null;
  await page.route("**/merchant/pickup/query", async (route) => {
    if (release === null) await new Promise<void>((resolve) => (release = resolve));
    return pickupReadable
      ? route.fulfill({
          headers,
          json: {
            source: "CurrentFulfillment",
            workstation: null,
            storeReference: store,
            observedAt: "2026-10-29T15:00:00.000Z",
            nextAfterFulfillmentReference: null,
            items: [waitingItem(1), waitingItem(2)],
          },
        })
      : route.fulfill({ headers, status: 403, json: { error: "request_denied" } });
  });
  await page.goto("/app/organization/stores/" + store + "/capabilities");
  await expect(page.getByRole("heading", { name: "Store features", exact: true })).toBeVisible();
  const counter = page.getByRole("checkbox", { name: /Counter ordering/u });
  const inventory = page.getByRole("checkbox", { name: /Inventory and recipes/u });
  const pickup = page.getByRole("checkbox", { name: /Pickup orders from guests/u });
  await expect(counter).toBeChecked();
  await expect(inventory).toBeChecked();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".store-features").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);

  // The full-service setup turns off counter ordering, guests' pickup and inventory; turning
  // pickup off is asked once more, with what to do about pickups still waiting.
  await page.getByRole("button", { name: "Use the full-service setup" }).click();
  // v15 live check: not confirmed while the waiting orders are still being counted.
  await expect(page.getByRole("alert")).toContainText("Checking the pickup orders still waiting…");
  await expect(page.getByRole("button", { name: "Turn off pickup" })).toBeDisabled();
  (release as (() => void) | null)?.();
  release = () => undefined;
  await expect(page.getByRole("alert")).toContainText(
    "2 pickup orders are still waiting to be handed over.",
  );
  // The Pickup page stays while they wait (v15 finding v), so it is not said to be hidden.
  await expect(page.getByRole("alert")).toContainText(
    "The Pickup page stays until the pickup orders still waiting are handed over, then it is hidden.",
  );
  await expect(page.getByRole("button", { name: "Turn off pickup" })).toBeEnabled();
  await page.getByRole("button", { name: "Keep pickup" }).click();
  // The queue can't be read: no number is shown, it says so (still only a warning).
  pickupReadable = false;
  await page.getByRole("button", { name: "Use the full-service setup" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The pickup queue could not be read, so it isn't known whether pickup orders are still waiting.",
  );
  await page.getByRole("button", { name: "Keep pickup" }).click();
  expect(commands.filter((c) => c.action === "ApplyTemplate")).toHaveLength(0);
  await page.getByRole("button", { name: "Use the full-service setup" }).click();
  await page.getByRole("button", { name: "Turn off pickup" }).click();
  await expect(page.getByText("The full-service restaurant setup is in use.")).toBeVisible();
  await expect(page.getByText("This store uses the full-service restaurant setup.")).toBeVisible();
  await expect(counter).not.toBeChecked();
  await expect(inventory).not.toBeChecked();
  await expect(pickup).not.toBeChecked();
  expect(commands.at(-1)).toMatchObject({
    action: "ApplyTemplate",
    template: "FullService",
    expectedVersion: 0,
  });

  // Inventory back on: saved as the next version, pickup is not sent.
  await inventory.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved. Staff see the change the next time a page opens."),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "Change",
    expectedVersion: 1,
    modules: {
      counterOrder: false,
      pickup: false,
      inventory: true,
      loyalty: false,
      alcohol: false,
    },
  });
  await expect(page.getByText(/Last changed/u)).toBeVisible();

  // Someone else changed it meanwhile: the page says so and shows the latest.
  conflictOnce = true;
  await inventory.uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(
      "Someone else changed these settings. The page now shows them; check and save again.",
    ),
  ).toBeVisible();
  await expect(counter).toBeChecked();
  await expect(inventory).toBeChecked();

  // At the table: both off at first; the owner turns them on, saved on their own.
  const call = page.getByRole("checkbox", { name: /Guests can call staff/u });
  const chase = page.getByRole("checkbox", { name: /Servers can chase a dish/u });
  await expect(call).not.toBeChecked();
  await expect(chase).not.toBeChecked();
  await call.check();
  await chase.check();
  await page.getByRole("button", { name: "Save table settings" }).click();
  await expect(
    page.getByText("Saved. Staff see the change the next time a page opens."),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeServices",
    expectedVersion: 0,
    staffCall: true,
    chaseDish: true,
  });
  await expect(page.getByRole("button", { name: "Save table settings" })).toBeDisabled();
  // WP-2423 item 8 ⑦ (decision 2): not asked when opening a table until the owner turns it on.
  const askGuests = page.getByRole("checkbox", {
    name: /Ask how many guests when opening a table/u,
  });
  await expect(askGuests).not.toBeChecked();
  await askGuests.check();
  await page.getByRole("button", { name: "Save table settings" }).click();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeServices",
    expectedVersion: 1,
    staffCall: true,
    chaseDish: true,
    askPartySize: true,
  });
  await expect(askGuests).toBeChecked();

  // WP-2423 item 8 ⑦ 4b-2: no tea charge until the owner chooses its item; only tables that pay
  // at the end are charged it (said on the page).
  await expect(
    page.getByText(
      "Tea is only added at tables that pay at the end. Tables that pay for each round are not charged tea automatically.",
    ),
  ).toBeVisible();
  const teaItem = page.getByRole("combobox", { name: "Tea charge item" });
  await expect(teaItem).toHaveValue("");
  // Only listed items, each named once; one hidden from this store can't be chosen, and says why.
  await expect(teaItem.getByRole("option")).toHaveText([
    "No tea charge",
    "Tea (TEST) 茶位",
    "Kung Pao chicken (TEST) 宫保鸡丁",
    "Plated sauce (TEST)",
    "Jasmine tea (TEST) — hidden from this store on the menu; show it to choose it",
  ]);
  // The option's own `disabled`: Playwright's toBeDisabled reads an <option> as enabled.
  await expect(teaItem.getByRole("option", { name: /^Jasmine tea/u })).toHaveJSProperty(
    "disabled",
    true,
  );
  // WP-2423 item 8a: nothing to remember about the kitchen; a dish chosen by mistake is asked about
  // first, because it is money and it takes the dish from the menu and the kitchen.
  await expect(page.getByText("Not prepared by the kitchen", { exact: false })).toHaveCount(0);
  const teaCommands = () => commands.filter((c) => c.action === "ChangeTeaCharge");
  await teaItem.selectOption({ label: "Kung Pao chicken (TEST) 宫保鸡丁" });
  await page.getByRole("button", { name: "Save tea charge" }).click();
  await expect(
    page.getByText(
      "Kung Pao chicken (TEST) 宫保鸡丁 is a dish. It leaves the guest menu, every guest at a pay-later table is charged $18.00, and it stops going to the kitchen.",
    ),
  ).toBeVisible();
  expect(teaCommands()).toEqual([]);
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByText("is a dish.", { exact: false })).toHaveCount(0);
  await expect(teaItem).toHaveValue(id(507));
  // Marked as made in the kitchen, the question says so; the answer says what was saved.
  await teaItem.selectOption({ label: "Plated sauce (TEST)" });
  await page.getByRole("button", { name: "Save tea charge" }).click();
  await expect(
    page.getByText("The kitchen still makes it, as set on the menu.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, make it the tea" }).click();
  await expect(
    page.getByText("Saved. Tea is added for each guest from the next party size recorded.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("The kitchen prepares this item, as set on the menu.")).toBeVisible();
  // A fee needs no question.
  await teaItem.selectOption({ label: "Tea (TEST) 茶位" });
  await page.getByRole("button", { name: "Save tea charge" }).click();
  await expect(
    page.getByText(
      "Saved. Tea is added for each guest from the next party size recorded. It does not go to the kitchen.",
    ),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeTeaCharge",
    expectedVersion: 1,
    teaSellableReference: id(505),
  });

  // WP-2423 item 8 ⑧ (decision 5): the owner names the kitchen's sections; a name used twice is
  // refused before anything is sent.
  const newSection = page.getByRole("textbox", { name: "New section name" });
  await newSection.fill("炒锅");
  await page.getByRole("button", { name: "Add section" }).click();
  await newSection.fill("炒锅");
  await expect(page.getByRole("button", { name: "Add section" })).toBeDisabled();
  await newSection.fill("蒸柜");
  await page.getByRole("button", { name: "Add section" }).click();
  await expect(page.getByRole("textbox", { name: "Section 2 name" })).toHaveValue("蒸柜");
  await page.getByRole("button", { name: "Save sections" }).click();
  await expect(page.getByText("Saved. Give each dish its section on the menu.")).toBeVisible();
  expect(sectionCommands.at(-1)).toMatchObject({
    action: "ChangeSections",
    expectedVersion: 0,
    sections: [
      { sectionReference: expect.stringMatching(/^[0-9a-f-]{36}$/u), name: "炒锅" },
      { sectionReference: expect.stringMatching(/^[0-9a-f-]{36}$/u), name: "蒸柜" },
    ],
  });
  await expect(page.getByRole("button", { name: "Save sections" })).toBeDisabled();

  // WP-2423 item 8 ⑦ (decision 11): tips 10 / 15 / 18 % at first; the owner sets 12 / 18 / 20.
  const lowest = page.getByRole("textbox", { name: "Lowest tip percentage" });
  const highest = page.getByRole("textbox", { name: "Highest tip percentage" });
  await expect(lowest).toHaveValue("10");
  const saveTips = page.getByRole("button", { name: "Save tips" });
  await expect(saveTips).toBeDisabled();
  // Out of order or out of range: said so, and not sent.
  await lowest.fill("20");
  await expect(
    page.getByText("Enter three different whole numbers from 1 to 50, lowest first."),
  ).toBeVisible();
  await expect(saveTips).toBeDisabled();
  await lowest.fill("12");
  await page.getByRole("textbox", { name: "Middle tip percentage" }).fill("18");
  await highest.fill("20");
  await saveTips.click();
  await expect(
    page.getByText("Saved. Guests and staff are offered these tips from now on."),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeTips",
    expectedVersion: 0,
    enabled: true,
    tierPercents: [12, 18, 20],
  });
  // Tips off: no percentages to set, and the card machine is mentioned.
  await page.getByRole("checkbox", { name: /Guests and staff can add a tip/u }).uncheck();
  await expect(lowest).toBeHidden();
  await expect(page.getByText(/turn that off on the machine too/u)).toBeVisible();
  await saveTips.click();
  await expect(page.getByText("Saved. No one is asked for a tip from now on.")).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeTips",
    expectedVersion: 1,
    enabled: false,
    tierPercents: [12, 18, 20],
  });
});

test("@production the owner sends paid orders straight to the kitchen, and back", async ({
  page,
}) => {
  await session(page);
  let current = {
    version: 0,
    templateCode: null as string | null,
    modules: { counterOrder: true, pickup: true, inventory: true, loyalty: false, alcohol: false },
    changedAt: null as string | null,
    services: {
      version: 0,
      staffCall: false,
      chaseDish: false,
      askPartySize: false,
      changedAt: null as string | null,
    },
    teaCharge: {
      version: 0,
      teaSellableReference: null as string | null,
      changedAt: null as string | null,
    },
    teaChoices: [],
    tips: {
      version: 0,
      enabled: true,
      tierPercents: [10, 15, 18],
      changedAt: null as string | null,
      offInStoreSetup: false,
    },
    autoAccept: {
      version: 0,
      pickup: false,
      dineIn: false,
      changedAt: null as string | null,
    },
    canChange: true,
  };
  const commands: Record<string, unknown>[] = [];
  let conflict = false;
  await page.route("**/merchant/store/features", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (body.action === "ChangeAutoAccept") {
      if (conflict) {
        conflict = false;
        return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
      }
      current = {
        ...current,
        autoAccept: {
          version: current.autoAccept.version + 1,
          pickup: body.pickup === true,
          dineIn: body.dineIn === true,
          changedAt: "2026-11-05T15:00:00.000Z",
        },
      };
    }
    return route.fulfill({ headers, json: current });
  });
  await page.route("**/merchant/commerce/kitchen-sections/command", (route) =>
    route.fulfill({ headers, json: { version: 0, sections: [] } }),
  );
  await page.goto("/app/organization/stores/" + store + "/capabilities");
  const box = page.getByRole("checkbox", { name: /Send paid orders straight to the kitchen/u });
  // Off until the owner turns it on; the row says what it means in two sentences.
  await expect(box).not.toBeChecked();
  await expect(page.getByText(/no kitchen screen has been open for 3 minutes/u)).toBeVisible();
  await expect(page.getByText(/Keep the kitchen screen on with sound/u)).toBeVisible();
  // The owner reads the refund rule here, and no promise of a full refund.
  await expect(
    page.getByText(/A pickup the kitchen screen never marks is refunded 30 minutes after/u),
  ).toBeVisible();
  await expect(page.getByText(/full refund/u)).toBeHidden();
  const save = page.getByRole("button", { name: "Save paid orders" });
  await expect(save).toBeDisabled();
  await box.check();
  await save.click();
  await expect(page.getByText("Saved. Paid orders now go straight to the kitchen.")).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "ChangeAutoAccept",
    expectedVersion: 0,
    pickup: true,
    dineIn: true,
  });
  await expect(box).toBeChecked();
  await expectNoInternalText(page);
  // Someone else changed it in between: said, and asked again.
  conflict = true;
  await box.uncheck();
  await save.click();
  await expect(page.getByText(/Someone else changed these settings/u)).toBeVisible();
  // And back off, against the version on screen.
  await box.uncheck();
  await save.click();
  await expect(page.getByText("Saved. Paid orders wait for Accept on Orders again.")).toBeVisible();
  expect(commands.at(-1)).toMatchObject({ pickup: false, dineIn: false, expectedVersion: 1 });
  // WP-2423 (M178): the owner ticks what the kitchen uses and shares; guests read it on the menu.
  const section = page.getByRole("group", { name: "Kitchen allergens" });
  await expect(section).toContainText("Not set yet.");
  await section.getByRole("group", { name: "Our kitchen uses:" }).getByLabel("Peanuts").check();
  await section.getByRole("group", { name: "Shared in our kitchen:" }).getByLabel("Woks").check();
  await section.getByRole("button", { name: "Save kitchen allergens" }).click();
  await expect(section.getByText("Saved. Guests see it on the menu.")).toBeVisible();
  expect(kitchenStatementSaves.at(-1)).toMatchObject({
    action: "Change",
    handledAllergenCodes: ["PEANUT"],
    sharedEquipment: ["Woks"],
  });
  await expect(section).not.toContainText("Not set yet.");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});

/** DEC-DINING-GUEST-TABLE-START: the switch, only where guests pay each round first. */
const guestStartFeatures = (changes: {
  guestTableStart?: boolean;
  guestTableStartAllowed: boolean;
  version?: number;
}) => ({
  version: 1,
  templateCode: null,
  modules: { counterOrder: true, pickup: true, inventory: true, loyalty: false, alcohol: false },
  changedAt: null,
  services: {
    version: changes.version ?? 0,
    staffCall: false,
    chaseDish: false,
    askPartySize: false,
    ...(changes.guestTableStart === true ? { guestTableStart: true } : {}),
    changedAt: null,
  },
  guestTableStartAllowed: changes.guestTableStartAllowed,
  teaCharge: { version: 0, teaSellableReference: null, changedAt: null },
  teaChoices: [],
  tips: {
    version: 0,
    enabled: true,
    tierPercents: [10, 15, 18],
    changedAt: null,
    offInStoreSetup: false,
  },
  canChange: true,
});

test("@production the owner turns on guests starting tables; it is off where guests pay at the end; a change made meanwhile is shown", async ({
  page,
}) => {
  await session(page);
  const sent: { action: string; guestTableStart?: boolean; expectedVersion?: number }[] = [];
  let answer: "Save" | "Conflict" | "NeedsPayFirst" = "Save";
  let current = guestStartFeatures({ guestTableStartAllowed: true });
  await page.route("**/merchant/store/features", async (route) => {
    const body = route.request().postDataJSON() as (typeof sent)[number];
    if (body.action === "ChangeServices") {
      sent.push(body);
      if (answer !== "Save") {
        await route.fulfill({
          status: 409,
          headers,
          json: {
            error:
              answer === "Conflict"
                ? "store_features_changed"
                : "store_features_guest_start_needs_pay_first",
          },
        });
        return;
      }
      current = guestStartFeatures({
        guestTableStart: body.guestTableStart === true,
        guestTableStartAllowed: true,
        version: (body.expectedVersion ?? 0) + 1,
      });
    }
    await route.fulfill({ headers, json: current });
  });
  await page.goto("/app/organization/stores/" + store + "/capabilities");
  const box = page.getByRole("checkbox", { name: /Guests can start a free table/u });
  await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
  await expect(
    page.getByText("20 minutes after the last activity if nobody ordered"),
  ).toBeVisible();
  // The owner is told, before turning it on, that the next party can end a quiet table.
  await expect(
    page.getByText("even if its guests are still sitting there", { exact: false }),
  ).toBeVisible();
  // ...that serving changes (guests collect by number), and that a staff "Being cleaned" holds.
  await expect(
    page.getByText("guests collect them at the counter by order number", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("stays closed to guests until staff clear it", { exact: false }),
  ).toBeVisible();
  const section = page.getByRole("group", { name: "Guests starting tables" });

  // Off by default; a change someone else made first is said, and nothing is claimed.
  await box.check();
  // Each paid round waits on Orders until a Store can send them straight to the kitchen.
  await expect(section.getByRole("note")).toContainText(
    "Each paid round still waits for Accept on Orders.",
  );
  answer = "Conflict";
  await section.getByRole("button", { name: "Save this setting" }).click();
  await expect(section.getByRole("alert")).toContainText("Someone else changed these settings");
  answer = "NeedsPayFirst";
  await section.getByRole("button", { name: "Save this setting" }).click();
  await expect(section.getByRole("alert")).toContainText(
    "Only for stores where guests pay each round first.",
  );
  answer = "Save";
  await section.getByRole("button", { name: "Save this setting" }).click();
  await expect(section.getByRole("status")).toContainText("Guests can start free tables now.");
  expect(sent.at(-1)?.guestTableStart).toBe(true);
  await expectNoInternalText(page);
  await page.screenshot({ path: "test-results/store-features-guest-start.png", fullPage: true });
});

test("@production where guests pay at the end the switch can't be turned on, and says why", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/store/features", (route) =>
    route.fulfill({ headers, json: guestStartFeatures({ guestTableStartAllowed: false }) }),
  );
  await page.goto("/app/organization/stores/" + store + "/capabilities");
  await expect(
    page.getByRole("checkbox", { name: /Guests can start a free table/u }),
  ).toBeDisabled();
  await expect(page.getByText("Only for stores where guests pay each round first.")).toBeVisible();
});
