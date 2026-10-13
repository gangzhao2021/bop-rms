import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL): Brand gates — the author publishing their own
// price book alone as sole operator, and the allergen list recorded by one person and approved by
// another (or by its recorder alone as sole operator).
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
          businessDate: "2026-10-13",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
  const stepUps: string[] = [];
  let validUntil: string | null = null;
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ headers, json: { validUntil } });
    stepUps.push(route.request().postData() ?? "");
    const at = Date.now();
    validUntil = new Date(at + 15 * 60_000).toISOString();
    return route.fulfill({
      headers,
      json: { status: "Verified", verifiedAt: new Date(at).toISOString(), validUntil },
    });
  });
  return stepUps;
}
async function verify(page: Page, label: string) {
  await page.getByRole("button", { name: label }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
}

test("@production the price book author publishes alone as sole operator after confirming", async ({
  page,
}) => {
  const stepUps = await session(page, [
    {
      screenId: "PRICE-BOOK-LIST",
      label: "Prices",
      href: "/app/commerce/pricing",
      permission: "pricing.price_book.read",
    },
  ]);
  const commands: string[] = [];
  let soleOperator: unknown = { status: "Effective", otherApprovers: [], verifiedUntil: null };
  await page.route("**/merchant/commerce/pricing/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "PRICE-BOOK-EDITOR",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: { mayRead: true, mayEdit: true, mayApprove: true },
        currencyCode: "CAD",
        storeAssignment: null,
        assignmentHistory: [],
        sellables: [
          {
            sellableReference: id(20),
            skuCode: "LATTE-S",
            productReference: id(21),
            productName: "Latte",
            sizeName: "Small",
            active: true,
          },
        ],
        menuSellables: [id(20)],
        book: {
          priceBookReference: id(10),
          versionReference: id(11),
          stableCode: "PRICES-20261013",
          lifecycle: "Draft",
          aggregateVersion: 2,
          createdAt: new Date().toISOString(),
          prices: [{ sellableReference: id(20), amountMinor: "450" }],
          otherEntries: 0,
        },
        draftAuthor: owner,
        soleOperator,
        uncovered: [],
      },
    }),
  );
  await page.route("**/merchant/commerce/pricing/command", (route) => {
    commands.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        priceBookReference: id(10),
        aggregateVersion: 3,
        lifecycle: "Published",
      },
    });
  });
  await page.goto("/app/commerce/pricing/" + id(10));
  const publish = page.getByRole("button", { name: "Publish on my own" });
  await expect(page.getByText("you are the only person who holds price approval")).toBeVisible();
  await expect(publish).toBeDisabled();
  await verify(page, "Verify to approve on your own");
  expect(JSON.parse(stepUps[0] ?? "{}")).toEqual({
    purpose: "SoleOperatorApproval",
    code: "123456",
  });
  await expect(publish).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/sole-operator-price-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("I checked these prices and approve on my own").check();
  await publish.click();
  await expect(page.getByText("Published.")).toBeVisible();
  expect(JSON.parse(commands[0] ?? "{}")).toMatchObject({
    action: "Publish",
    priceBookReference: id(10),
    expectedAggregateVersion: 2,
    approvalMode: "SoleOperator",
  });
  // When someone else holds price approval, the page names them and offers no self-publish.
  soleOperator = {
    status: "OtherApprovers",
    otherApprovers: [{ displayName: "Mia" }],
    verifiedUntil: null,
  };
  await page.reload();
  await expect(
    page.getByText("Sole operator is on, but Mia also holds price approval, so they must approve"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish on my own" })).toHaveCount(0);
});

test("@production the allergen list is recorded by one person and approved by another", async ({
  page,
}) => {
  await session(page, [
    {
      screenId: "CMP-ALLERGEN-REVIEW",
      label: "Allergens",
      href: "/app/compliance/allergens",
      permission: "catalog.allergen.read",
    },
  ]);
  let proposal: unknown = null;
  let recordedByYou = true;
  const commands: string[] = [];
  await page.route("**/merchant/compliance/allergens/query", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "CMP-ALLERGEN-REVIEW",
        sourceAsOf: new Date().toISOString(),
        viewer: owner,
        permissions: { mayRead: true, mayDeclare: true, mayManageRegistry: true },
        locale: "en-CA",
        registryProposal: proposal,
        soleOperator:
          proposal !== null && recordedByYou
            ? { status: "NotSet", otherApprovers: [], verifiedUntil: null }
            : null,
        registry: null,
        registryTemplate: {
          template: "CA_PRIORITY_TEST",
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic list.",
          allergens: [{ code: "MILK", name: "Milk" }],
        },
        sources: ["SupplierSpecification"],
        items: [],
      },
    }),
  );
  await page.route("**/merchant/compliance/allergens/command", (route) => {
    const body = route.request().postData() ?? "";
    commands.push(body);
    if (JSON.parse(body).action === "RecordRegistry") {
      proposal = {
        proposalReference: id(30),
        recordedAt: new Date().toISOString(),
        recordedByYou: true,
      };
      return route.fulfill({ headers, json: { status: "Applied", proposalReference: id(30) } });
    }
    return route.fulfill({
      headers,
      json: { status: "Applied", registryVersionReference: id(31) },
    });
  });
  await page.goto("/app/compliance/allergens");
  await page.getByRole("button", { name: "Record this allergen list for approval" }).click();
  await expect(
    page.getByText("You made this change, so someone else who holds allergen list approval"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve the recorded allergen list" }),
  ).toHaveCount(0);
  // Another roster manager sees the recorded list and approves it.
  recordedByYou = false;
  proposal = { ...(proposal as object), recordedByYou: false };
  await page.reload();
  await page.getByRole("button", { name: "Approve the recorded allergen list" }).click();
  await expect(page.getByText("Allergen list approved.")).toBeVisible();
  expect(commands.map((body) => JSON.parse(body))).toEqual([
    expect.objectContaining({ action: "RecordRegistry", template: "CA_PRIORITY_TEST" }),
    expect.objectContaining({ action: "ApproveRegistry", proposalReference: id(30) }),
  ]);
  expect(JSON.parse(commands[1] ?? "{}")).not.toHaveProperty("approvalMode");
});
