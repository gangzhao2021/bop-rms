import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 (v15 run of cb3f6f2a): an approver reviewing a submitted menu sees, for each item, the
// description and photo customers will see (frozen in the review snapshot) and what changed against
// the menu customers see now, before approving.
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const approver = id(4);
const submitter = id(5);
const image = (c: string) => "/media/images/" + c.repeat(64) + ".jpg";
// An 8x6 PNG standing in for the 320-pixel JPEG thumbnail the server renders.
const thumbnailBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAZ0lEQVR4nA3JoRFEMQhAwevqdYFCoVAoZr6MjIyMRCJp87J2f5+whC0c4QoltDDC71OWspWjXKWUVkZfGMvYxjGuUUYbYy+c5WznONcpp53xF8EKdnCCG1TQwcSLZCU7OclNKulkkj9rfzXRVH1wDAAAAABJRU5ErkJggg==",
  "base64",
);
const photo = (c: string, altText: string) => ({ url: image(c), width: 320, height: 240, altText });
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
          businessDate: "2026-10-17",
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
  await page.route("**/media/images/*", (route) =>
    route.fulfill({ contentType: "image/png", body: thumbnailBytes }),
  );
}
const sellable = (n: number, productName: string, sizeName: string) => ({
  skuReference: id(n),
  skuCode: "SKU-" + n,
  productName,
  sizeName,
  active: true,
  priceMinor: "450",
  offeredHere: true,
});
const customerView = {
  frozenAt: "2026-10-17T13:40:00.000Z",
  comparedWithPublishedAt: "2026-10-16T18:05:00.000Z",
  items: [
    {
      placementReference: id(60),
      skuReference: id(50),
      sectionName: "Drinks",
      name: "Latte — Small",
      description: "Double espresso with steamed whole milk.",
      photo: photo("a", "Latte in a tall glass with latte art"),
      newOnMenu: false,
      descriptionChange: "Changed",
      photoChange: "Replaced",
      before: {
        description: "Espresso and milk.",
        photo: photo("b", "Latte in a paper cup"),
      },
    },
    {
      placementReference: id(61),
      skuReference: id(51),
      sectionName: "Drinks",
      name: "Mocha — Small",
      description: "Espresso, chocolate and steamed milk.",
      photo: photo("c", "Mocha topped with cocoa powder"),
      newOnMenu: true,
      descriptionChange: null,
      photoChange: null,
      before: null,
    },
    {
      placementReference: id(62),
      skuReference: id(52),
      sectionName: "Tea",
      name: "Green Tea",
      description: null,
      photo: null,
      newOnMenu: false,
      descriptionChange: null,
      photoChange: null,
      before: null,
    },
  ],
  removedFromMenu: [{ skuReference: id(53), name: "Scone" }],
};
function menuView(state: string, view: unknown) {
  return {
    screenId: "CAT-MENU-BUILDER",
    sourceAsOf: new Date().toISOString(),
    viewer: approver,
    permissions: {
      mayRead: true,
      mayEdit: false,
      maySubmit: false,
      mayApprove: true,
      mayPublish: false,
    },
    menus: [],
    menu: {
      menuReference: id(40),
      internalCode: "ALL_DAY",
      aggregateVersion: 5,
      versionReference: id(41),
      name: "All day",
      storeReferences: [id(99)],
      channelCodes: ["CUSTOMER_PWA"],
      orderTypeCodes: ["PICKUP"],
      sections: [
        {
          sectionReference: id(42),
          code: "DRINKS",
          name: "Drinks",
          items: [
            { placementReference: id(60), skuReference: id(50), featured: false },
            { placementReference: id(61), skuReference: id(51), featured: false },
          ],
        },
        {
          sectionReference: id(43),
          code: "TEA",
          name: "Tea",
          items: [{ placementReference: id(62), skuReference: id(52), featured: false }],
        },
      ],
    },
    publication: {
      lifecycleReference: id(45),
      lifecycleVersion: state === "InReview" ? 2 : 3,
      state,
      snapshotDigest: "sha256:" + "e".repeat(64),
      changedAt: "2026-10-17T13:40:00.000Z",
    },
    latestRelease: {
      releaseReference: id(46),
      sequence: 1,
      menuVersionReference: id(30),
      createdAt: "2026-10-16T18:05:00.000Z",
      snapshotDigest: "sha256:" + "d".repeat(64),
    },
    submittedBy: submitter,
    soleOperator: null,
    sellables: [
      sellable(50, "Latte", "Small"),
      sellable(51, "Mocha", "Small"),
      sellable(52, "Green Tea", "Green Tea"),
    ],
    mayOfferHere: false,
    allergenRegistry: true,
    customerView: view,
  };
}

test("@production an approver sees each item's customer description and photo, with changes marked, before approving", async ({
  page,
}) => {
  await session(page);
  let state = "InReview";
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({ headers, json: menuView(state, customerView) }),
  );
  await page.route("**/merchant/commerce/menus/command", (route) => {
    commands.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    state = "Approved";
    return route.fulfill({ headers, json: { status: "Applied" } });
  });
  await page.goto("/app/commerce/menus/" + id(40));
  const review = page.getByRole("region", { name: "What customers will see" });
  await expect(review).toBeVisible();
  await expect(review).toContainText(
    "Compared with the menu customers see now (published Oct 16, 2:05 PM): 1 new item, 1 description changed, 1 photo changed, 1 item removed.",
  );
  const items = review.getByRole("listitem").filter({ has: page.getByRole("heading") });
  await expect(items).toHaveCount(3);

  const latte = items.filter({ has: page.getByRole("heading", { name: "Latte — Small" }) });
  await expect(latte.getByText("Double espresso with steamed whole milk.")).toBeVisible();
  await expect(
    latte.getByRole("img", { name: "Latte in a tall glass with latte art" }),
  ).toHaveAttribute("src", image("a"));
  await expect(latte.getByRole("list", { name: "Changes" })).toHaveText(
    /Description changed\s*Photo replaced/u,
  );
  await expect(latte.getByText("Customers see now:")).toBeVisible();
  await expect(latte.getByText("Espresso and milk.")).toBeVisible();
  await expect(latte.getByRole("img", { name: "Latte in a paper cup" })).toBeVisible();
  await expect(
    latte.getByText("Photo description: Latte in a tall glass with latte art"),
  ).toBeVisible();

  const mocha = items.filter({ has: page.getByRole("heading", { name: "Mocha — Small" }) });
  await expect(mocha.getByRole("list", { name: "Changes" })).toHaveText("New on the menu");
  await expect(mocha.getByRole("img", { name: "Mocha topped with cocoa powder" })).toBeVisible();

  const tea = items.filter({ has: page.getByRole("heading", { name: "Green Tea" }) });
  await expect(tea.getByText("No description.")).toBeVisible();
  await expect(tea.getByText("No photo")).toBeVisible();
  await expect(tea.getByRole("list", { name: "Changes" })).toHaveCount(0);

  await expect(
    review.getByText("Removed from the menu (customers no longer see them): Scone."),
  ).toBeVisible();
  // Every thumbnail has finished loading with its intrinsic size reserved (no layout shift).
  await expect
    .poll(() =>
      review
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (element) =>
              (element as HTMLImageElement).complete &&
              element.getAttribute("width") === "320" &&
              element.getAttribute("height") === "240",
          ),
        ),
    )
    .toBe(true);
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/menu-review-customer-view-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The approval still binds the exact snapshot that was shown.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  expect(commands).toEqual([
    expect.objectContaining({
      action: "Approve",
      menuVersionReference: id(41),
      snapshotDigest: "sha256:" + "e".repeat(64),
    }),
  ]);
  await expect(page.getByRole("region", { name: "What customers will see" })).toBeVisible();
});

test("@production a menu in review whose customer view cannot be read says so instead of showing items unseen", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/commerce/menus/query", (route) =>
    route.fulfill({ headers, json: menuView("InReview", null) }),
  );
  await page.goto("/app/commerce/menus/" + id(40));
  await expect(page.getByRole("heading", { name: "Customer view not shown" })).toBeVisible();
  await expect(
    page.getByText(
      "What customers will see for this version could not be shown. Refresh before approving or publishing.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "What customers will see" })).toHaveCount(0);
  await expectNoInternalText(page);
});
