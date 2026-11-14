import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 (v15 run 2026-10-16): option prices published alone by a sole operator
// (DEC-SOLE-OPERATOR-APPROVAL), and a published menu never claims customers see items that are not
// offered at this Store.
const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const owner = id(4);
async function session(page: Page, navigation: unknown[]) {
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
          businessDate: "2026-10-16",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date(at).toISOString(), validUntil },
    });
  });
}
async function noOverflow(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production option prices: the author publishes their own prices alone as sole operator", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "PRICE-OPTION-LIST",
      label: "Option prices",
      href: "/app/commerce/option-prices",
      permission: "pricing.price_book.read",
    },
  ]);
  const commands: Record<string, unknown>[] = [];
  let published = false;
  let soleOperator: unknown = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  await page.route("**/merchant/commerce/option-prices/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PRICE-OPTION-LIST",
        sourceAsOf: new Date().toISOString(),
        currency: { code: "CAD", minorUnitExponent: 2 },
        permissions: { mayEdit: true, mayApprove: true },
        soleOperator: published ? null : soleOperator,
        products: [
          {
            productReference: id(30),
            name: "TEST Hot Chocolate",
            optionSets: [
              {
                bindingReference: id(31),
                name: "Toppings",
                options: [
                  {
                    optionReference: id(32),
                    name: "Whipped cream",
                    offered: true,
                    ruleReference: id(33),
                    aggregateVersion: published ? 2 : 1,
                    priceMinor: published ? "50" : null,
                    pending: published ? null : { priceMinor: "50", byViewer: true },
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/commerce/option-prices/command", (route) => {
    commands.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    published = true;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        results: [{ ruleReference: id(33), aggregateVersion: 2, status: "Committed" }],
      },
    });
  });
  await page.goto("/app/commerce/option-prices");
  await expect(
    page.getByText("You run this business alone (sole operator), so you may publish"),
  ).toBeVisible();
  await expect(page.getByText("you are the only person who holds price approval")).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish 1 price on my own" });
  await expect(publish).toBeDisabled();
  await page.getByRole("button", { name: "Verify to approve on your own" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(publish).toBeDisabled();
  await expectNoInternalText(page);
  await noOverflow(page, "option-prices-sole-operator");
  await page.getByLabel("I checked these prices and approve on my own").check();
  await publish.click();
  await expect(page.getByText("Prices published, approved by you alone.")).toBeVisible();
  expect(commands[0]).toMatchObject({
    action: "Publish",
    rules: [{ ruleReference: id(33), expectedAggregateVersion: 1 }],
    approvalMode: "SoleOperator",
  });

  // With someone else holding price approval, the page names them and offers no self-publish.
  published = false;
  soleOperator = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Mia" }],
    verifiedUntil: null,
  };
  await page.reload();
  await expect(
    page.getByText("Sole operator is on, but Mia also holds price approval, so they must approve"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /on my own/u })).toHaveCount(0);
  await expect(page.getByText("A new price takes effect when another person")).toBeVisible();
});

test("@production a published menu lists items not offered at this Store and offers them in one action", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "CAT-MENU-LIST",
      label: "Menus",
      href: "/app/commerce/menus",
      permission: "catalog.menu.read",
    },
  ]);
  let state = "InReview";
  let offered = false;
  const offers: Record<string, unknown>[] = [];
  const menuCommands: Record<string, unknown>[] = [];
  const sellable = (n: number, productName: string, sizeName: string, offeredHere: boolean) => ({
    skuReference: id(n),
    skuCode: "SKU-" + n,
    productName,
    sizeName,
    active: true,
    priceMinor: "400",
    offeredHere,
  });
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-BUILDER",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: {
          mayRead: true,
          mayEdit: true,
          maySubmit: true,
          mayApprove: true,
          mayPublish: true,
        },
        menus: [],
        menu: {
          menuReference: id(40),
          internalCode: "ALL_DAY",
          aggregateVersion: 3,
          versionReference: id(41),
          name: "All day",
          storeReferences: [id(99)],
          channelCodes: ["CUSTOMER_PWA"],
          orderTypeCodes: ["DINE_IN", "PICKUP"],
          sections: [
            {
              sectionReference: id(42),
              code: "DRINKS",
              name: "Drinks",
              items: [
                { placementReference: id(43), skuReference: id(50), featured: true },
                { placementReference: id(44), skuReference: id(51), featured: false },
              ],
            },
          ],
        },
        publication: {
          lifecycleReference: id(45),
          lifecycleVersion: state === "InReview" ? 2 : state === "Approved" ? 3 : 4,
          state,
          snapshotDigest: "sha256:" + "b".repeat(64),
          changedAt: "2026-10-16T17:00:00.000Z",
        },
        latestRelease:
          state === "Published"
            ? {
                releaseReference: id(46),
                sequence: 1,
                menuVersionReference: id(41),
                createdAt: "2026-10-16T18:05:00.000Z",
              }
            : null,
        submittedBy: id(5),
        soleOperator: null,
        sellables: [
          sellable(50, "Latte", "Small", true),
          sellable(51, "TEST Hot Chocolate", "Small (8 oz)", offered),
        ],
        mayOfferHere: true,
        allergenRegistry: true,
      },
    }),
  );
  await page.route("**/merchant/commerce/menus/command", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    menuCommands.push(body);
    state = body.action === "Approve" ? "Approved" : "Published";
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.route("**/merchant/commerce/availability/command", (route) => {
    offers.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    offered = true;
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.goto("/app/commerce/menus/" + id(40));
  // Plain words for channels and order types; a version in review cannot be rearranged.
  await expect(page.getByText("Customer ordering app · Dine-in, Pickup")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Move .* up$/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(
    page.getByText(
      "When this menu is published, customers at this Store won't see these items until they are offered here: TEST Hot Chocolate — Small (8 oz).",
    ),
  ).toBeVisible();
  await expectNoInternalText(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByText(
      "Published. Customers at this Store see this menu, except 1 item not offered here yet: TEST Hot Chocolate — Small (8 oz).",
    ),
  ).toBeVisible();
  await expect(page.getByText("Customers now see this menu.")).toHaveCount(0);
  await expect(page.getByText(/last published Oct 16, 2:05 PM/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "Item availability" })).toBeVisible();
  await expectNoInternalText(page);
  await noOverflow(page, "menu-not-offered-here");
  await page.getByRole("button", { name: "Offer this item at this Store now" }).click();
  await expect(
    page.getByText(
      "1 item is now offered at this Store. Customers here see it on the published menu.",
    ),
  ).toBeVisible();
  expect(offers).toEqual([expect.objectContaining({ action: "Offer", skuReference: id(51) })]);
  await expect(page.getByRole("heading", { name: "Not offered at this Store" })).toHaveCount(0);
  expect(menuCommands.map((command) => command.action)).toEqual(["Approve", "Publish"]);
});

test("@production an open menu draft can be discarded after confirming; customers keep the published menu", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "CAT-MENU-LIST",
      label: "Menus",
      href: "/app/commerce/menus",
      permission: "catalog.menu.read",
    },
  ]);
  let discarded = false;
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CAT-MENU-BUILDER",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: {
          mayRead: true,
          mayEdit: true,
          maySubmit: true,
          mayApprove: false,
          mayPublish: false,
        },
        menus: [],
        menu: {
          menuReference: id(40),
          internalCode: "ALL_DAY",
          aggregateVersion: discarded ? 8 : 7,
          versionReference: discarded ? id(41) : id(47),
          name: "All day",
          storeReferences: [id(99)],
          channelCodes: ["CUSTOMER_PWA"],
          orderTypeCodes: ["PICKUP"],
          sections: [
            {
              sectionReference: discarded ? id(42) : id(48),
              code: "DRINKS",
              name: "Drinks",
              items: [
                {
                  placementReference: discarded ? id(43) : id(49),
                  skuReference: id(50),
                  featured: false,
                },
              ],
            },
          ],
        },
        publication: discarded
          ? {
              lifecycleReference: id(45),
              lifecycleVersion: 4,
              state: "Published",
              snapshotDigest: "sha256:" + "b".repeat(64),
              changedAt: "2026-10-16T18:05:00.000Z",
            }
          : null,
        latestRelease: {
          releaseReference: id(46),
          sequence: 1,
          menuVersionReference: id(41),
          createdAt: "2026-10-16T18:05:00.000Z",
        },
        submittedBy: null,
        soleOperator: null,
        sellables: [
          {
            skuReference: id(50),
            skuCode: "SKU-50",
            productName: "Latte",
            sizeName: "Small",
            active: true,
            priceMinor: "400",
            offeredHere: true,
          },
        ],
        mayOfferHere: true,
        allergenRegistry: true,
      },
    }),
  );
  await page.route("**/merchant/commerce/menus/command", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    commands.push(body);
    discarded = true;
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.goto("/app/commerce/menus/" + id(40));
  await expect(page.getByText("Draft — being edited")).toBeVisible();
  await page.getByRole("button", { name: "Discard this draft" }).click();
  const question = page.getByRole("group", { name: /Discard this draft\?/u });
  await expect(question).toContainText("Customers keep seeing the published menu");
  await expectNoInternalText(page);
  await noOverflow(page, "menu-discard-draft");
  // Changing one's mind sends nothing.
  await question.getByRole("button", { name: "Keep the draft" }).click();
  expect(commands).toEqual([]);
  await page.getByRole("button", { name: "Discard this draft" }).click();
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(
    page.getByText("Draft discarded. The menu is back to its published version."),
  ).toBeVisible();
  expect(commands).toEqual([
    expect.objectContaining({
      action: "DiscardDraft",
      menuReference: id(40),
      expectedAggregateVersion: 7,
    }),
  ]);
  await expect(page.getByRole("button", { name: "Discard this draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start a revision" })).toBeVisible();
  await expectNoInternalText(page);
});
