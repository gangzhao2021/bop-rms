import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 Store setup in product: the Brand Owner adds, renames, sets the default and retires the
 * Brand's tax classifications (CAT-TAX-CLASSIFICATION-LIST). Production-built React and the real
 * browser client; the server answers are a synthetic in-browser fixture that mirrors the merchant
 * BFF contract (append-only versions, expected version, operation replay). The restricted-role
 * database acceptance proves persistence, permissions and grants.
 */
const id = (n: number) => "018f7716-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const csrf = "a".repeat(43);
const headers = { "cache-control": "no-store" };
interface Entry {
  classificationReference: string;
  names: Record<string, string>;
  lifecycle: "Active" | "Retired";
  isDefault: boolean;
}

async function install(page: Page, mayManage = true) {
  const state = {
    version: 0,
    entries: [] as Entry[],
    operations: new Map<string, string>(),
    commands: [] as Record<string, unknown>[],
    errors: [] as string[],
    conflictNext: false,
    pinSessionNext: false,
    next: 1,
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  const view = () => ({
    screenId: "CAT-TAX-CLASSIFICATION-LIST",
    sourceAsOf: new Date().toISOString(),
    permissions: { mayManage },
    registryVersion: state.version,
    defaultLocale: "en-CA",
    locales: ["en-CA", "fr-CA"],
    classifications: [...state.entries].sort(
      (a, b) =>
        Number(a.lifecycle === "Retired") - Number(b.lifecycle === "Retired") ||
        (a.names["en-CA"] ?? "").localeCompare(b.names["en-CA"] ?? ""),
    ),
    // v15: products name a class from the Store's tax configuration that the list does not have.
    productTaxClasses: mayManage
      ? [{ classificationReference: id(200), productNames: ["Flat White", "Mocha"] }]
      : null,
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: {
            brandLabel: "Synthetic Brand",
            storeLabel: "Training Store",
            storeReference: store,
            timeZone: "America/Toronto",
          },
          authorizedStores: [
            { brandLabel: "Synthetic Brand", storeLabel: "Training Store", storeReference: store },
          ],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: mayManage
            ? [
                {
                  screenId: "CAT-TAX-CLASSIFICATION-LIST",
                  label: "Tax classifications",
                  href: "/app/commerce/tax-classifications",
                  permission: "catalog.tax-classification.manage",
                },
              ]
            : [],
        },
      },
    }),
  );
  await page.route("**/merchant/commerce/tax-classifications/query", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    return route.fulfill({ headers, json: view() });
  });
  await page.route("**/merchant/commerce/tax-classifications/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.commands.push(body);
    if (state.pinSessionNext) {
      state.pinSessionNext = false;
      return route.fulfill({ status: 403, headers, json: { error: "full_sign_in_required" } });
    }
    const key = String(body.operationReference);
    const intent = JSON.stringify(body);
    if (state.operations.has(key)) {
      if (state.operations.get(key) !== intent)
        return route.fulfill({ status: 409, headers, json: { error: "Conflict" } });
      return route.fulfill({ headers, json: { status: "Replayed", view: view() } });
    }
    if (state.conflictNext || body.expectedRegistryVersion !== state.version) {
      state.conflictNext = false;
      return route.fulfill({ status: 409, headers, json: { error: "Conflict" } });
    }
    const target = state.entries.find(
      (e) => e.classificationReference === body.classificationReference,
    );
    if (body.action === "Add") {
      for (const c of body.classifications as { names: Record<string, string> }[]) {
        if (
          state.entries.some(
            (e) =>
              e.lifecycle !== "Retired" &&
              e.names["en-CA"]?.toLowerCase() === c.names["en-CA"]?.toLowerCase(),
          )
        )
          return route.fulfill({ status: 409, headers, json: { error: "NameTaken" } });
        state.entries.push({
          classificationReference: id(state.next++),
          names: c.names,
          lifecycle: "Active",
          isDefault: false,
        });
      }
    } else if (body.action === "Rename" && target) {
      target.names = body.names as Record<string, string>;
    } else if (body.action === "SetDefault") {
      for (const e of state.entries)
        e.isDefault = e.classificationReference === body.classificationReference;
    } else if (body.action === "Retire" && target) {
      target.lifecycle = "Retired";
      target.isDefault = false;
    }
    state.version += 1;
    state.operations.set(key, intent);
    return route.fulfill({ headers, json: { status: "Applied", view: view() } });
  });
  return state;
}
async function checkLayout(page: Page) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Tax classifications", level: 2 }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      axe.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => violation.id),
      `axe at ${width}`,
    ).toEqual([]);
    await expectNoInternalText(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production the Brand Owner adds, renames, sets the default and retires tax classifications", async ({
  page,
}) => {
  const state = await install(page);
  await page.goto("/app");
  const workspaceNav = page.getByRole("navigation", { name: "Workspace" });
  await workspaceNav.waitFor();
  const compactMenu = workspaceNav.locator(".workspace-sidebar__compact > summary");
  if (await compactMenu.isVisible()) await compactMenu.click();
  await page
    .getByRole("link", { name: "Tax classifications", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app\/commerce\/tax-classifications$/u);
  await expect(page.getByText("No tax classifications yet.")).toBeVisible();
  await expect(page.getByText("No rates are set here")).toBeVisible();
  const notListed = page.getByRole("region", {
    name: "Tax classes your products use that are not listed above",
  });
  await expect(notListed).toContainText("Unnamed tax class: Flat White, Mocha");
  await expect(notListed.getByRole("link", { name: "See rates in Tax review" })).toBeVisible();
  await checkLayout(page);

  const addForm = page.getByRole("form", { name: "Add a classification" });
  await expect(addForm.getByRole("button", { name: "Add classification" })).toBeDisabled();
  await addForm.getByLabel("English name", { exact: true }).fill("Prepared food");
  await addForm.getByLabel("French name (optional)").fill("Aliments préparés");
  await addForm.getByRole("button", { name: "Add classification" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added Prepared food." })).toBeVisible();
  await addForm.getByLabel("English name", { exact: true }).fill("Fees");
  await addForm.getByRole("button", { name: "Add classification" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added Fees." })).toBeVisible();
  expect(state.commands[0]).toMatchObject({
    action: "Add",
    expectedRegistryVersion: 0,
    classifications: [{ names: { "en-CA": "Prepared food", "fr-CA": "Aliments préparés" } }],
  });
  // An optional name left blank is not sent.
  expect(state.commands[1]).toMatchObject({
    classifications: [{ names: { "en-CA": "Fees" } }],
    expectedRegistryVersion: 1,
  });

  // A name already in use is refused in plain words.
  await addForm.getByLabel("English name", { exact: true }).fill("FEES");
  await addForm.getByRole("button", { name: "Add classification" }).click();
  await expect(
    page.getByText("Another classification in use already has that name."),
  ).toBeVisible();

  // Rename keeps the classification; then make it the default.
  await page.getByRole("button", { name: "Rename Fees" }).click();
  const rename = page.getByRole("form", { name: "Rename Fees" });
  await rename.getByLabel("English name", { exact: true }).fill("Store fees");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Renamed to Store fees." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Make Prepared food the default" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Prepared food is now the Brand default." }),
  ).toBeVisible();
  await expect(page.getByText("Default for products without their own")).toBeVisible();

  // Someone else changed the list: a plain conflict with a reload, nothing applied.
  state.conflictNext = true;
  await page.getByRole("button", { name: "Rename Store fees" }).click();
  await page
    .getByRole("form", { name: "Rename Store fees" })
    .getByLabel("French name (optional)")
    .fill("Frais");
  await page
    .getByRole("form", { name: "Rename Store fees" })
    .getByRole("button", { name: "Save name" })
    .click();
  await expect(page.getByText("Someone else changed the list.")).toBeVisible();
  await page.getByRole("button", { name: "Reload the list" }).click();
  await expect(page.getByText("Someone else changed the list.")).toHaveCount(0);

  // A PIN sign-in must confirm it is them first.
  state.pinSessionNext = true;
  await page.getByRole("button", { name: "Retire Prepared food" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Retire Prepared food for good?" });
  await expect(confirm).toContainText(
    "must be moved to another classification before they are next published",
  );
  await expect(confirm).toContainText("the Brand will have no default");
  await checkLayout(page);
  await confirm.getByRole("button", { name: "Retire for good" }).click();
  await expect(page.getByRole("region", { name: "Confirm it's you" })).toBeVisible();
  // Retrying the same change after confirming reuses its operation reference.
  await page.getByRole("button", { name: "Retire Prepared food" }).click();
  await page
    .getByRole("alertdialog", { name: "Retire Prepared food for good?" })
    .getByRole("button", { name: "Retire for good" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retired Prepared food." }),
  ).toBeVisible();
  const retires = state.commands.filter((c) => c.action === "Retire");
  expect(retires).toHaveLength(2);
  expect(retires[0]?.operationReference).toBe(retires[1]?.operationReference);
  const retired = page.getByRole("region", { name: "Retired" });
  await expect(retired).toContainText("Prepared food");
  await expect(page.getByRole("button", { name: "Retire Prepared food" })).toHaveCount(0);
  await checkLayout(page);
  expect(state.errors).toEqual([]);
});

test("@production a reader without the manage permission sees the list without change controls", async ({
  page,
}) => {
  const state = await install(page, false);
  await page.goto("/app/commerce/tax-classifications");
  await expect(
    page.getByText("Only the Brand Owner can add or change tax classifications."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add classification" })).toHaveCount(0);
  await checkLayout(page);
  expect(state.commands).toEqual([]);
  expect(state.errors).toEqual([]);
});
