import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 C group: the description and photo customers see under the product name, authored on
// the pilot product page and reaching customers after the menu is next published.
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const at = "2026-10-17T14:05:00.000Z";
const previewUrl = "/media/images/" + "d".repeat(64) + ".jpg";
// An 8x6 brown gradient PNG standing in for the 640-pixel preview the server renders.
const previewBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAZ0lEQVR4nA3JoRFEMQhAwevqdYFCoVAoZr6MjIyMRCJp87J2f5+whC0c4QoltDDC71OWspWjXKWUVkZfGMvYxjGuUUYbYy+c5WznONcpp53xF8EKdnCCG1TQwcSLZCU7OclNKulkkj9rfzXRVH1wDAAAAABJRU5ErkJggg==",
  "base64",
);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const rules = [
  {
    orderType: "Pickup",
    taxComponentCode: "SYNTHETIC_TAX",
    treatment: "Taxable",
    rate: "0.13",
    priceInclusion: "Exclusive",
  },
];
function productView(
  version: number,
  presentation: unknown,
  mayEdit = true,
): Record<string, unknown> {
  return {
    screenId: "CAT-PRODUCT-DETAIL",
    sourceAsOf: at,
    locale: "en-CA",
    permissions: {
      mayRead: true,
      mayCreate: mayEdit,
      mayEdit,
      mayAddSize: mayEdit,
      mayStartSelling: mayEdit,
    },
    productTypes: ["NonAlcoholicBeverage"],
    sellingUnits: ["EACH"],
    taxClasses: [{ taxClassificationReference: id(70), rules }],
    product: {
      productReference: id(71),
      internalCode: "FLAT_WHITE",
      productType: "NonAlcoholicBeverage",
      lifecycle: "Active",
      aggregateVersion: version,
      name: "Flat White",
      taxClassificationReference: id(70),
      sizes: [
        {
          skuReference: id(44),
          skuCode: "FLAT_WHITE_S",
          name: "Small",
          lifecycle: "Active",
          unitOfSale: "EACH",
        },
      ],
      optionSets: [],
      presentation,
      createdAt: at,
      updatedAt: at,
    },
    optionSetChoices: [],
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
          businessDate: "2026-10-17",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "CAT-PRODUCT-LIST",
              label: "Products",
              href: "/app/commerce/products",
              permission: "catalog.manage",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/media/images/*", (route) =>
    route.fulfill({ contentType: "image/png", body: previewBytes }),
  );
}
const photoFile = (name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: Buffer.alloc(2048, 7),
});

test("@production staff add a description and a described photo to a product and save them", async ({
  page,
}) => {
  await session(page);
  let view = productView(4, { description: "", photo: null });
  const commands: Record<string, unknown>[] = [];
  const uploads: { headers: Record<string, string>; size: number }[] = [];
  await page.route("**/merchant/commerce/products/query", (route) =>
    route.fulfill({ headers, json: view }),
  );
  await page.route("**/merchant/commerce/products/photo", (route) => {
    const request = route.request();
    uploads.push({ headers: request.headers(), size: request.postDataBuffer()?.length ?? 0 });
    // The first attempt finds storage unavailable; the retry of the same file is recorded.
    if (uploads.length === 1)
      return route.fulfill({ status: 503, json: { error: "PhotoStorageUnavailable" } });
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        photo: { imageReference: id(80), width: 1280, height: 960, previewUrl },
      },
    });
  });
  await page.route("**/merchant/commerce/products/command", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    commands.push(body);
    view = productView(5, {
      description: "Double ristretto with steamed whole milk.",
      photo: {
        imageReference: id(80),
        altText: "Flat white in a white ceramic cup",
        width: 1280,
        height: 960,
        previewUrl,
      },
    });
    return route.fulfill({ headers, json: { status: "Recorded", product: view.product } });
  });

  await page.goto(`/app/commerce/products/${id(71)}/edit`);
  const menu = page.getByRole("group", { name: "Customer menu" });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByText("Customers see the description and photo after the menu is next published."),
  ).toBeVisible();
  await expect(menu.getByText("240 characters left")).toBeVisible();
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();

  await menu
    .getByLabel("Description", { exact: true })
    .fill("Double ristretto with steamed whole milk.");
  await expect(menu.getByText("199 characters left")).toBeVisible();
  await expect(save).toBeEnabled();

  // A type the server does not accept is refused before anything is sent.
  await menu.getByLabel("Add photo").setInputFiles(photoFile("cup.gif", "image/gif"));
  await expect(menu.getByRole("alert")).toHaveText("Use a JPEG, PNG or WebP photo.");
  expect(uploads).toHaveLength(0);

  await menu.getByLabel("Add photo").setInputFiles(photoFile("cup.png", "image/png"));
  await expect(menu.getByRole("alert")).toContainText(
    "The photo didn't upload. Check the connection and try again.",
  );
  await menu.getByRole("button", { name: "Retry" }).click();
  await expect(menu.getByRole("img")).toHaveAttribute("src", previewUrl);
  expect(uploads).toHaveLength(2);
  expect(uploads[0]?.headers).toMatchObject({
    "content-type": "image/png",
    "x-bop-csrf": "a".repeat(43),
    "x-bop-product-reference": id(71),
  });
  expect(uploads[0]?.size).toBe(2048);
  expect(uploads[1]?.headers["x-bop-operation-reference"]).toBe(
    uploads[0]?.headers["x-bop-operation-reference"],
  );
  await expect(menu.getByLabel("Replace photo")).toBeAttached();
  await expect(menu.getByRole("button", { name: "Remove photo" })).toBeVisible();

  // Saving without describing the photo is blocked with an inline error on the field.
  await save.click();
  const alt = menu.getByLabel("Photo description (alt text)");
  await expect(alt).toBeFocused();
  await expect(alt).toHaveAttribute("aria-invalid", "true");
  await expect(menu.getByRole("alert")).toHaveText(
    "Describe the photo before saving. Customers who use a screen reader hear this description.",
  );
  expect(commands).toHaveLength(0);
  await expectNoInternalText(page);

  await alt.fill("Flat white in a white ceramic cup");
  await expect(menu.getByRole("img", { name: "Flat white in a white ceramic cup" })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await menu.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/product-customer-menu-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await save.click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(commands[0]).toMatchObject({
    action: "SaveDraft",
    productReference: id(71),
    expectedAggregateVersion: 4,
    presentation: {
      description: "Double ristretto with steamed whole milk.",
      photo: { imageReference: id(80), altText: "Flat white in a white ceramic cup" },
    },
  });
  await expect(save).toBeDisabled();
  await expect(menu.getByLabel("Description", { exact: true })).toHaveValue(
    "Double ristretto with steamed whole milk.",
  );

  // Removing the photo is an unsaved change until saved again.
  await menu.getByRole("button", { name: "Remove photo" }).click();
  await expect(menu.getByLabel("Add photo")).toBeAttached();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]?.presentation).toEqual({
    description: "Double ristretto with steamed whole milk.",
    // Owner 2026-10-23: the editor always sends its Chinese description ("" = none).
    descriptionZh: "",
    photo: null,
  });
});

test("@production staff who may only read a product see its description and photo without controls", async ({
  page,
}) => {
  await session(page);
  await page.route("**/merchant/commerce/products/query", (route) =>
    route.fulfill({
      headers,
      json: productView(
        4,
        {
          description: "Double ristretto with steamed whole milk.",
          photo: {
            imageReference: id(80),
            altText: "Flat white in a white ceramic cup",
            width: 1280,
            height: 960,
            previewUrl,
          },
        },
        false,
      ),
    }),
  );
  await page.goto(`/app/commerce/products/${id(71)}/edit`);
  const menu = page.getByRole("region", { name: "Customer menu" });
  await expect(menu.getByText("Double ristretto with steamed whole milk.")).toBeVisible();
  await expect(menu.getByRole("img", { name: "Flat white in a white ceramic cup" })).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(0);
  await expect(menu.getByRole("textbox")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/product-customer-menu-read-only-390.png",
    fullPage: true,
  });
  await expectNoInternalText(page);
});
