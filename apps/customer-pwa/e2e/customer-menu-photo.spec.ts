import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// Synthetic menu and synthetic generated image bytes (a beige circle on brown); no Store authority.
const storeReference = "018f7600-0000-7000-8000-000000000001";
const instant = "2026-10-17T12:00:00.000Z";
const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const photographedReference = id(20);
const plainReference = id(21);
const hash = (seed: string) => seed.repeat(64);
const syntheticJpeg = Buffer.from(
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYV" +
    "pQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P" +
    "T09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAGQABAAMBAQAAAAAAAAAAAAAAAAQGBwIF/8QAJxAAAg" +
    "ICAAQGAwEAAAAAAAAAAQIAAwQFBhETMRIhIjJRkUFx8GH/xAAXAQEBAQEAAAAAAAAAAAAAAAAAAQIE/8QAFhEB" +
    "AQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIRAxEAPwDwoiJyOsiTNZrcjZX9OgAKvvc9lEtWNwvr6kHW6l7fkl" +
    "io+hImqTEu2Twvr7UPR6lDfghiw+jKrstbka2/p3jmp9jjswg1DiIlUiIgaHpsNcHW1VAcnI8Tn5Y/3KTpxTYt" +
    "tFdqe11DD9ETuRgkHc4S52ttqI9ajxIfhh/cpOnF1i1UWWv7UUsf0BAzGIiVsiIgWnhndVrUuDluFK+VTnsf8M" +
    "tEy6TcbbbDFQJRlWBR2U8mA+5GbGiSr8TbqtqmwcRwxbytcdgPgTw8nbbDKUpdlWFT3A9IP1IUEhERK0//2Q==",
  "base64",
);
const syntheticWebp = Buffer.from(
  "UklGRr4AAABXRUJQVlA4ILIAAAAQBgCdASpAADAAPqVCmUmmJCKhNUgAwBSJZwDO9EAC/DrgXxqWPaDwByLEwO" +
    "yPfmuDo6L7yG9tvYAA/u0HL6qp6+mvBrvScvCbL8e7dycgTHP9UZaws/i4bgF2/XGJ5mxP8O2tEminS3nq7Sjf" +
    "Vs+8vMGuTTN5FrxWSbm5DVZOtuYGAarUfThSngSKrGIaSrPRCAlnftTdc+npWpXG/FYpLRfz8s3mfGQSmBqCji" +
    "J/HcAA",
  "base64",
);
const description =
  "Steamed rice with roasted mushrooms, pickled carrot and a soy-sesame glaze, finished with green onion and toasted sesame seeds. Ask staff about spice.";
const altText = "Rice bowl topped with roasted mushrooms in a dark ceramic bowl";

function rendition(seed: string, contentType: "image/jpeg" | "image/webp", width: number) {
  const extension = contentType === "image/jpeg" ? "jpg" : "webp";
  return {
    url: `/media/images/${hash(seed)}.${extension}`,
    contentType,
    width,
    height: (width * 3) / 4,
  };
}

function sellable(
  reference: string,
  name: string,
  presentation: { description: string | null; photo: unknown },
) {
  return {
    sellableReference: reference,
    productVersionReference: id(30),
    name,
    ...presentation,
    presentationRole: "Standard",
    pinned: false,
    availability: "Available",
    optionRules: [],
    allergenDisclosure: {
      registryVersionReference: id(31),
      items: [{ allergenReference: id(32), code: "SOY", name: "Soy", classification: "Contains" }],
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
    },
    displayPrice: { status: "Available", amount: "13.50", currency: "CAD", reason: null },
    taxDisplayContext: {
      status: "Unavailable",
      taxInclusive: null,
      reason: "FINAL_QUOTE_REQUIRED",
    },
  };
}

function menuBody() {
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: instant,
      sourceCheckpoint: id(5),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: storeReference,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: instant,
    },
    menu: {
      menuReference: id(6),
      menuVersionReference: id(7),
      releaseReference: id(8),
      locale: "en-CA",
      name: "Synthetic menu",
      effectiveFrom: instant,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(9),
          name: "Bowls",
          sellables: [
            sellable(photographedReference, "Synthetic mushroom rice bowl", {
              description,
              photo: {
                altText,
                width: 1280,
                height: 960,
                renditions: [
                  rendition("a", "image/jpeg", 320),
                  rendition("b", "image/webp", 320),
                  rendition("c", "image/jpeg", 640),
                  rendition("d", "image/webp", 640),
                  rendition("e", "image/jpeg", 1280),
                  rendition("f", "image/webp", 1280),
                ],
              },
            }),
            sellable(plainReference, "Synthetic green tea", { description: null, photo: null }),
          ],
        },
      ],
    },
  };
}

async function setUp(page: Page, images: (route: Route) => Promise<void>) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        schemaVersion: 1,
        csrfToken: "a".repeat(43),
        menuContext: {
          publicStoreReference: storeReference,
          channel: "DineIn",
          locale: "en-CA",
          brandDisplayName: "Synthetic brand",
          storeDisplayName: "Synthetic Store",
        },
      }),
    }),
  );
  await page.context().route(`**/api/v1/public/stores/${storeReference}/menu**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(menuBody()),
    }),
  );
  await page.context().route("**/media/images/*", images);
  return errors;
}

function serveImage(route: Route): Promise<void> {
  const webp = route.request().url().endsWith(".webp");
  return route.fulfill({
    status: 200,
    contentType: webp ? "image/webp" : "image/jpeg",
    headers: { "cache-control": "public, max-age=31536000, immutable" },
    body: webp ? syntheticWebp : syntheticJpeg,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test.use({ serviceWorkers: "block" });

test("CUST-MENU shows the published photo and description on the card and detail without layout shift @production", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const requested: string[] = [];
  const errors = await setUp(page, async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    await held;
    await serveImage(route);
  });
  await page.goto("/menu");
  const photoCard = page
    .locator("article.menu-card")
    .filter({ hasText: "Synthetic mushroom rice bowl" });
  const plainCard = page.locator("article.menu-card").filter({ hasText: "Synthetic green tea" });
  await expect(
    photoCard.getByRole("link", { name: "View Synthetic mushroom rice bowl" }),
  ).toBeVisible();

  // The square box is laid out before any image byte arrives.
  const media = photoCard.locator(".menu-card__media");
  await expect(media).toBeVisible();
  const before = { media: await media.boundingBox(), card: await photoCard.boundingBox() };
  expect(before.media?.width).toBe(96);
  expect(before.media?.height).toBe(96);
  release();
  const image = media.locator("img");
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await media.boundingBox()).toEqual(before.media);
  expect(await photoCard.boundingBox()).toEqual(before.card);

  await expect(image).toHaveAttribute("alt", "");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("decoding", "async");
  await expect(image).toHaveAttribute("width", "1280");
  await expect(image).toHaveAttribute("height", "960");
  await expect(image).toHaveAttribute("sizes", "96px");
  await expect(media).toHaveAttribute("aria-hidden", "true");
  // Chromium prefers the WebP source at 320w for a 96px box.
  expect(requested).toContain(`/media/images/${hash("b")}.webp`);
  expect(requested.some((path) => path.includes(hash("e")) || path.includes(hash("f")))).toBe(
    false,
  );
  const clamp = photoCard.locator(".menu-card__description");
  await expect(clamp).toHaveText(description);
  await expect(clamp).toHaveCSS("-webkit-line-clamp", "2");
  await expect(photoCard).toContainText("Contains Soy");
  await expect(plainCard.locator(".menu-card__media")).toHaveCount(0);
  await expect(plainCard.locator(".menu-card__description")).toHaveCount(0);
  await expect(page.getByText("Image not available")).toHaveCount(0);
  await expectNoInternalText(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    // The name keeps a readable column beside the thumbnail.
    const nameBox = await photoCard.locator("h4").boundingBox();
    expect(nameBox?.width ?? 0).toBeGreaterThan(150);
    await page.screenshot({
      path: `test-results/customer-menu-photo-${viewport.width}.png`,
      fullPage: true,
    });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await photoCard.getByRole("link", { name: "View Synthetic mushroom rice bowl" }).click();
  const detail = page.locator("article.sellable-detail");
  await expect(detail.getByRole("heading", { name: "Synthetic mushroom rice bowl" })).toBeVisible();
  const hero = detail.locator(".sellable-detail__media img");
  await expect(hero).toHaveAttribute("alt", altText);
  await expect(hero).toHaveAttribute("loading", "eager");
  await expect(hero).toHaveAttribute("fetchpriority", "high");
  await expect(hero).toHaveAttribute("width", "1280");
  await expect(hero).toHaveAttribute("height", "960");
  await expect
    .poll(() => hero.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const heroBox = await detail.locator(".sellable-detail__media").boundingBox();
  const headingBox = await detail
    .getByRole("heading", { name: "Synthetic mushroom rice bowl" })
    .boundingBox();
  expect(heroBox?.width).toBeLessThanOrEqual(640);
  // Wide screens place the photo beside the details.
  expect(headingBox?.x ?? 0).toBeGreaterThan((heroBox?.x ?? 0) + (heroBox?.width ?? 0));
  await expect(detail.locator(".sellable-detail__description")).toHaveText(description);
  await expect(detail).toContainText("Allergen information");
  await expectNoInternalText(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    const box = await detail.locator(".sellable-detail__media").boundingBox();
    expect(Math.abs((box?.width ?? 0) * 3 - (box?.height ?? 0) * 4)).toBeLessThan(4);
    await page.screenshot({
      path: `test-results/customer-menu-photo-detail-${viewport.width}.png`,
      fullPage: true,
    });
  }

  await page.goBack();
  await plainCard.getByRole("link", { name: "View Synthetic green tea" }).click();
  await expect(detail.getByRole("heading", { name: "Synthetic green tea" })).toBeVisible();
  await expect(detail.locator(".sellable-detail__media")).toHaveCount(0);
  await expect(detail.locator("img")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CUST-MENU removes a photo that cannot be loaded instead of showing a broken image @production", async ({
  page,
}) => {
  const errors = await setUp(page, (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "" }),
  );
  await page.goto("/menu");
  const photoCard = page
    .locator("article.menu-card")
    .filter({ hasText: "Synthetic mushroom rice bowl" });
  await expect(
    photoCard.getByRole("link", { name: "View Synthetic mushroom rice bowl" }),
  ).toBeVisible();
  await expect(photoCard.locator(".menu-card__media")).toHaveCount(0);
  // The card falls back to the ordinary text layout rather than keeping an empty photo column.
  await expect(photoCard).not.toHaveClass(/menu-card--with-photo/u);
  await expect(photoCard.locator(".menu-card__description")).toHaveText(description);
  await expect(page.locator("main img")).toHaveCount(0);
  await expectNoInternalText(page);
  await page.screenshot({
    path: "test-results/customer-menu-photo-missing-1440.png",
    fullPage: true,
  });

  await photoCard.getByRole("link", { name: "View Synthetic mushroom rice bowl" }).click();
  const detail = page.locator("article.sellable-detail");
  await expect(detail.getByRole("heading", { name: "Synthetic mushroom rice bowl" })).toBeVisible();
  await expect(detail.locator(".sellable-detail__media")).toHaveCount(0);
  await expect(detail).not.toHaveClass(/sellable-detail--with-photo/u);
  await expect(detail.locator("img")).toHaveCount(0);
  await expect(detail.locator(".sellable-detail__description")).toHaveText(description);
  await expectNoInternalText(page);
  expect(errors).toEqual([]);
});

/** Sum of every layout-shift entry since the last reset, including shifts right after a tap. */
async function recordLayoutShifts(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { __shift: number };
    state.__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        state.__shift += (entry as unknown as { value: number }).value;
    }).observe({ type: "layout-shift", buffered: true });
  });
}
const settledShift = async (page: Page) => {
  // Two frames after the last change, so a late shift is still counted.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(300);
  return page.evaluate(() => (window as unknown as { __shift: number }).__shift);
};
const resetShift = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __shift: number }).__shift = 0;
  });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`CUST-MENU keeps the page still from menu to item and back at ${viewport.width} px @production`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await recordLayoutShifts(page);
    const errors = await setUp(page, serveImage);
    await page.goto("/menu");
    const detail = page.locator("article.sellable-detail");
    for (const name of ["Synthetic mushroom rice bowl", "Synthetic green tea"]) {
      const card = page.locator("article.menu-card").filter({ hasText: name });
      await expect(card.getByRole("link", { name: `View ${name}` })).toBeVisible();
      await expect(page.locator(".menu-help")).toBeVisible();
      await settledShift(page);
      await resetShift(page);
      await card.getByRole("link", { name: `View ${name}` }).click();
      await expect(detail.getByRole("heading", { name })).toBeVisible();
      await expect(page.locator(".menu-help")).toBeVisible();
      expect(await settledShift(page), `menu → ${name}`).toBeLessThan(0.02);
      await resetShift(page);
      await page.goBack();
      await expect(card.getByRole("link", { name: `View ${name}` })).toBeVisible();
      expect(await settledShift(page), `${name} → menu`).toBeLessThan(0.02);
    }
    expect(errors).toEqual([]);
  });
}
