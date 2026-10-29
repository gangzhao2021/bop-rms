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

async function session(page: Page) {
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
    modules: { counterOrder: true, pickup: true, inventory: true },
    changedAt: null as string | null,
    services: {
      version: 0,
      staffCall: false,
      chaseDish: false,
      askPartySize: false,
      changedAt: null as string | null,
    },
    tips: {
      version: 0,
      enabled: true,
      tierPercents: [10, 15, 18],
      changedAt: null as string | null,
    },
    canChange: true,
  };
  const commands: Record<string, unknown>[] = [];
  let conflictOnce = false;
  await page.route("**/merchant/store/features", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (body.action === "Read") return route.fulfill({ headers, json: current });
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
            modules: { counterOrder: false, pickup: false, inventory: false },
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
    modules: { counterOrder: false, pickup: false, inventory: true },
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
