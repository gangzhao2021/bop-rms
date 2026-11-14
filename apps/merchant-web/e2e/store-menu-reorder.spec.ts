import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q31/Q32: a manager reorders a menu by dragging or with the Move buttons, and unsaved
// changes survive leaving the page on the same device until they are saved or discarded.
const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-10-25T14:05:00.000Z";
const MENU = id(1);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const sellable = (n: number, productName: string) => ({
  skuReference: id(n),
  skuCode: "SKU_" + n,
  productName,
  sizeName: productName,
  active: true,
  priceMinor: "450",
  offeredHere: true,
});
function builderView(version: number) {
  return {
    screenId: "CAT-MENU-BUILDER",
    sourceAsOf: at,
    viewer: id(50),
    permissions: {
      mayRead: true,
      mayEdit: true,
      maySubmit: true,
      mayApprove: true,
      mayPublish: true,
    },
    menus: [],
    menu: {
      menuReference: MENU,
      internalCode: "SYNTHETIC_MENU",
      aggregateVersion: version,
      versionReference: id(2),
      name: "Synthetic menu",
      storeReferences: [scope.storeReference],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["PICKUP"],
      sections: [
        {
          sectionReference: id(10),
          code: "COFFEE",
          name: "Coffee",
          nameZh: "",
          items: [
            { placementReference: id(20), skuReference: id(30), featured: false },
            { placementReference: id(21), skuReference: id(31), featured: false },
            { placementReference: id(22), skuReference: id(32), featured: false },
          ],
        },
        {
          sectionReference: id(11),
          code: "TEA",
          name: "Tea",
          nameZh: "",
          items: [{ placementReference: id(23), skuReference: id(33), featured: false }],
        },
      ],
    },
    publication: null,
    latestRelease: null,
    submittedBy: null,
    soleOperator: null,
    sellables: [
      sellable(30, "Latte"),
      sellable(31, "Mocha"),
      sellable(32, "Flat White"),
      sellable(33, "Green Tea"),
    ],
    mayOfferHere: false,
    allergenRegistry: true,
    customerView: null,
  };
}
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
          authorizedStores: [
            { brandLabel: scope.brandLabel, storeLabel: scope.storeLabel, storeReference: id(99) },
          ],
          businessDate: "2026-10-25",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "CAT-MENU-LIST",
              label: "Menus",
              href: "/app/commerce/menus",
              permission: "catalog.menu.read",
            },
          ],
        },
      },
    }),
  );
}
const coffeeOrder = (page: Page) =>
  page
    .getByRole("group", { name: "Section 1" })
    .locator("tbody tr td:first-child")
    .allInnerTexts()
    .then((cells) => cells.map((cell) => cell.replace("⠿", "").trim()));

test("@production a manager drags and moves menu items, and unsaved changes come back on this device", async ({
  page,
}) => {
  await session(page);
  let version = 3;
  const saved: unknown[] = [];
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({ headers, json: builderView(version) }),
  );
  await page.route("**/merchant/commerce/menus/command", (route) => {
    saved.push(route.request().postDataJSON());
    version += 1;
    return route.fulfill({ headers, json: { ok: true } });
  });
  await page.goto(`/app/commerce/menus/${MENU}`);
  await expect(page.getByRole("group", { name: "Section 1" })).toBeVisible();
  expect(await coffeeOrder(page)).toEqual(["Latte", "Mocha", "Flat White"]);
  await expect(page.getByRole("button", { name: "Move Latte up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Flat White to the bottom" })).toBeDisabled();

  await page.getByRole("button", { name: "Move Flat White to the top" }).click();
  expect(await coffeeOrder(page)).toEqual(["Flat White", "Latte", "Mocha"]);
  await expect(
    page.getByText("Unsaved changes — kept on this device until you save."),
  ).toBeVisible();

  // Drag Flat White (now first) below Mocha by its handle.
  const rows = page.getByRole("group", { name: "Section 1" }).locator("tbody tr");
  const handle = rows.nth(0).locator(".drag-handle");
  const target = await rows.nth(2).boundingBox();
  const start = await handle.boundingBox();
  if (target === null || start === null) throw new Error("rows not laid out");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 4, target.y + target.height - 2, { steps: 8 });
  await page.mouse.up();
  expect(await coffeeOrder(page)).toEqual(["Latte", "Mocha", "Flat White"]);
  await page.getByRole("button", { name: "Move section to the bottom" }).first().click();
  await expect(
    page.getByRole("group", { name: "Section 1" }).getByLabel("Section name"),
  ).toHaveValue("Tea");

  // Leave and come back: the changes are offered back, not applied on their own.
  await page.goto(`/app/commerce/menus`);
  await page.goto(`/app/commerce/menus/${MENU}`);
  await expect(page.getByRole("heading", { name: "Unsaved changes on this device" })).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Section 1" }).getByLabel("Section name"),
  ).toHaveValue("Coffee");
  await page.getByRole("button", { name: "Bring back unsaved changes" }).click();
  await expect(
    page.getByRole("group", { name: "Section 1" }).getByLabel("Section name"),
  ).toHaveValue("Tea");
  expect(
    await page
      .getByRole("group", { name: "Section 2" })
      .locator("tbody tr td:first-child")
      .allInnerTexts()
      .then((cells) => cells.map((cell) => cell.replace("⠿", "").trim())),
  ).toEqual(["Latte", "Mocha", "Flat White"]);

  await page.getByRole("button", { name: "Save menu" }).click();
  await expect(page.getByText("Menu saved.")).toBeVisible();
  expect(saved).toHaveLength(1);
  const body = saved[0] as { action: string; sections: { name: string; items: unknown[] }[] };
  expect(body.action).toBe("SaveDraft");
  expect(body.sections.map((section) => section.name)).toEqual(["Tea", "Coffee"]);
  // Saved: nothing is kept on the device any more.
  expect(
    await page.evaluate((menu) => localStorage.getItem(`bop.menu-draft.${menu}`), MENU),
  ).toBeNull();

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

test("@production changes kept on an older menu version are not brought back over newer ones", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({ headers, json: builderView(7) }),
  );
  await page.addInitScript(([menu, kept]) => localStorage.setItem(`bop.menu-draft.${menu}`, kept), [
    MENU,
    JSON.stringify({
      name: "Synthetic menu",
      aggregateVersion: 6,
      keptAt: at,
      sections: [{ sectionReference: id(11), code: "TEA", name: "Tea", nameZh: "", items: [] }],
    }),
  ] as const);
  await page.goto(`/app/commerce/menus/${MENU}`);
  await expect(page.getByRole("heading", { name: "Unsaved changes on this device" })).toBeVisible();
  await expect(page.getByText("the menu has been saved since")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bring back unsaved changes" })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Section 1" }).getByLabel("Section name"),
  ).toHaveValue("Coffee");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("heading", { name: "Unsaved changes on this device" })).toHaveCount(
    0,
  );
});
