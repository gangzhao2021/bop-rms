import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { establishedOpeningList } from "./store-setup-panels";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * b18 (Owner 2026-11-14 "先改吧，太多了我记不住"): an open Store's setup is a few places, each doing
 * one thing and saying whether a change there is live at once or a draft that needs approval. The
 * long logs lead with what matters and still reach every record. Synthetic TEST-ONLY values; the
 * server answers are routed in the browser (each section's own spec covers its saves).
 */
const id = (n: number) => "018f7718-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const csrf = "a".repeat(43);
const headers = { "cache-control": "no-store" };
const setupHref = "/app/organization/stores/" + store + "/setup";
const shots = process.env.BOP_B18_SHOTS ?? "";
const respond = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, headers, json });

function supportLog() {
  const log: { occurredAt: string; supportName: string; kind: string; subjectCode: string }[] = [];
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 18, 0) - minutes * 60_000);
  for (let i = 0; i < 49; i++) {
    const kind = i === 6 ? "Changed" : i === 20 ? "Changed" : i === 31 ? "Refused" : "Viewed";
    log.push({
      occurredAt: at(i * 37).toISOString(),
      supportName: "Platform support (TEST ONLY)",
      kind,
      subjectCode: kind === "Changed" ? (i === 6 ? "Pickup" : "KitchenLine") : "MerchantOverview",
    });
  }
  return log;
}

function soleOperatorHistory() {
  return Array.from({ length: 10 }, (_, i) => ({
    version: 36 - i,
    state: i % 2 === 0 ? "Off" : "On",
    reasonCode: i % 2 === 0 ? "OWNER_CHOICE" : "OWNER_RUNS_STORE_ALONE",
    recordedAt: new Date(Date.UTC(2026, 10, 13 - i, 15)).toISOString(),
    changedByYou: true,
    changedByName: "Sam",
  }));
}

async function install(page: Page, options: { readonly manager?: boolean } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: store,
  };
  await page.route("**/merchant/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/merchant/session")
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-11-14",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: setupHref,
              permission: "organization.manage",
            },
            ...(options.manager
              ? []
              : [
                  {
                    screenId: "APPROVAL-INBOX",
                    label: "Approvals",
                    href: "/app/approvals",
                    permission: "workflow.operate",
                  },
                ]),
          ],
        },
      });
    if (path === "/merchant/store/opening-list") return respond(route, establishedOpeningList);
    if (path === "/merchant/store-setup") {
      if (options.manager) return respond(route, { error: "request_denied" }, 403);
      const observedAt = new Date().toISOString();
      const ids = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: store,
        actorReference: id(4),
      };
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope: ids,
        store: {
          storeReference: store,
          code: "SYNTH_STORE",
          displayName: "Training Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: {
          profile: "StoreSetupCurrentV1",
          tenantReference: ids.tenantReference,
          brandReference: ids.brandReference,
          storeReference: store,
          readerActorReference: ids.actorReference,
          snapshot: null,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        },
      });
    }
    if (path === "/merchant/store/public-profile")
      return respond(route, {
        observedAt: "2026-11-14T16:00:00.000Z",
        canChange: !options.manager,
        locales: ["en-CA", "zh-Hans-CA"],
        current: {
          version: 3,
          publishedAt: "2026-11-10T16:00:00.000Z",
          defaultLocale: "en-CA",
          names: [
            { locale: "en-CA", storeDisplayName: "Maple Noodle House – King Street" },
            { locale: "zh-Hans-CA", storeDisplayName: "枫叶面馆 国王街店" },
          ],
          address: {
            addressLines: ["100 King Street West"],
            locality: "Toronto",
            regionCode: "ON",
            postalCode: "M5X 1A9",
            countryCode: "CA",
          },
          businessPhone: "+14165550100",
        },
        regionCodes: ["ON", "QC", "BC"],
      });
    if (path === "/merchant/store/receipt-profile")
      return respond(route, {
        observedAt: "2026-11-14T16:00:00.000Z",
        canChange: !options.manager,
        version: 2,
        recordedAt: "2026-11-10T16:00:00.000Z",
        details: {
          gstHstNumber: "123456789RT0001",
          qstNumber: null,
          pstNumber: null,
          privacyNoticeUrl: "https://example.test/privacy",
        },
        gaps: { taxRegistrationMissing: false, privacyNoticeMissing: false },
        issuer: { businessName: "Synthetic Brand Inc.", suggestedBusinessName: "Synthetic Brand" },
      });
    if (path === "/merchant/store/kitchen-setup")
      return respond(route, {
        canChange: true,
        version: 1,
        inEffectFrom: "2026-11-01T15:00:00.000Z",
        uncoveredDishes: [],
      });
    if (path === "/merchant/store/support-access")
      return options.manager
        ? respond(route, { error: "request_denied" }, 403)
        : respond(route, { version: 4, mode: "Off", allowedUntil: null, log: supportLog() });
    if (path === "/merchant/organization/sole-operator")
      return respond(route, {
        observedAt: new Date().toISOString(),
        state: "Off",
        version: 36,
        changeCount: 36,
        history: soleOperatorHistory(),
        refundApproval: { status: "NotSet", youHoldApproval: true, otherApprovers: [] },
        verifiedUntil: null,
        reasons: {
          On: ["OWNER_RUNS_STORE_ALONE"],
          Off: ["SECOND_APPROVER_AVAILABLE", "OWNER_CHOICE", "ENTERED_IN_ERROR"],
        },
      });
    return respond(route, { error: "fixture_unavailable" }, 503);
  });
  return errors;
}

async function language(page: Page, value: "en" | "zh-Hans") {
  await page.addInitScript((chosen) => {
    try {
      localStorage.setItem("bop.merchant.language", chosen);
    } catch {
      /* the page still renders in its default language */
    }
  }, value);
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

const places = [
  ["profile", "Store details", "门店资料", ""],
  ["receipts", "Receipts and tax numbers", "收据与税号", "?section=receipts"],
  ["kitchen", "Kitchen setup", "后厨", "?section=kitchen"],
  ["access", "Permissions and safety", "权限与安全", "?section=access"],
  ["changes", "Settings that need approval", "需审批的设置", "?section=changes"],
] as const;

test("@production an open Store's setup is a few places, each saying whether a change is live or a draft", async ({
  page,
}) => {
  const errors = await install(page);
  await language(page, "en");
  await page.goto(setupHref);
  const nav = page.getByRole("navigation", { name: "Store setup sections" });
  await expect(nav.getByRole("link")).toHaveText(places.map((place) => place[1]));
  await expect(nav.getByRole("link", { name: "Store details" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Store details: name, address and phone, live as soon as saved; nothing else on the page.
  await expect(page.getByText("A change is live as soon as you save it.").first()).toBeVisible();
  await expect(page.getByLabel("Store name customers see (English)")).toHaveValue(
    "Maple Noodle House – King Street",
  );
  await expect(page.getByText("For example “Maple Noodle House – King Street”.")).toBeVisible();
  await expect(page.getByText("For example “枫叶面馆 国王街店”.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and make live" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Receipts and privacy" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Platform support" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
  await expect(page.getByText("What kind of store is this?")).toHaveCount(0);
  await expect(page.getByText("Saving a draft does not change the live Store.")).toHaveCount(0);

  // Receipts: one save, live for receipts issued from then on.
  await nav.getByRole("link", { name: "Receipts and tax numbers" }).click();
  await expect(page).toHaveURL(/\?section=receipts$/u);
  await expect(page.getByRole("heading", { name: "Receipts and privacy" })).toBeVisible();
  await expect(page.getByLabel("GST/HST registration number")).toHaveValue("123456789RT0001");
  await expect(page.getByRole("button", { name: "Save and make live" })).toBeVisible();
  await expect(page.getByLabel("Store name customers see (English)")).toBeHidden();

  // Kitchen.
  await nav.getByRole("link", { name: "Kitchen setup" }).click();
  await expect(page.locator("#kitchen-setup")).toBeVisible();
  await expect(page.locator("#kitchen-setup")).toContainText("Every dish with a recipe");

  // Permissions and safety: support leads with what it changed or tried; every record one click away.
  await nav.getByRole("link", { name: "Permissions and safety" }).click();
  const support = page.locator("#support-access");
  await expect(
    support.getByRole("heading", { name: "What support changed or tried" }),
  ).toBeVisible();
  await expect(
    support.getByRole("cell", { name: "Changed whether guests can order pickup" }),
  ).toBeVisible();
  await expect(support.getByRole("cell", { name: "Set up your kitchen" })).toBeVisible();
  await expect(
    support.getByRole("cell", { name: /Tried something that was refused/u }).first(),
  ).toBeVisible();
  await expect(support).toContainText("Support looked at your Store 46 times, last");
  const fullLog = support.locator("table.support-access__log").last();
  await expect(fullLog.locator("tbody tr")).toHaveCount(5);
  await support.getByRole("button", { name: "Show all 49 records" }).click();
  await expect(fullLog.locator("tbody tr")).toHaveCount(49);
  await support.getByRole("button", { name: "Show fewer" }).click();
  await expect(fullLog.locator("tbody tr")).toHaveCount(5);
  // Sole operator: no change numbers; the newest five, the rest one click away and counted.
  const sole = page.locator("section.sole-operator");
  await expect(sole.getByRole("heading", { name: "Sole operator" })).toBeVisible();
  await expect(sole).not.toContainText("setting change 36");
  await expect(sole.locator(".sole-operator-history li")).toHaveCount(5);
  await sole.getByRole("button", { name: "Show 5 more" }).click();
  await expect(sole.locator(".sole-operator-history li")).toHaveCount(10);
  await expect(sole).toContainText("26 earlier changes are kept in the record.");
  await expect(sole.getByRole("button", { name: /Verify to turn it on/u })).toBeVisible();

  // Settings that need approval: the only place that keeps a draft, and it says so.
  await nav.getByRole("link", { name: "Settings that need approval" }).click();
  await expect(page.getByText(/saved as a draft first; it takes effect only after/u)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard unsaved changes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload the saved draft" })).toBeVisible();
  await expect(page.getByText("No draft saved yet")).toBeVisible();
  await expect(page.getByText(/Revision \d/u)).toHaveCount(0);
  await page.getByRole("link", { name: "Store details" }).last().click();
  await expect(page.getByLabel("Store name customers see (English)")).toBeVisible();

  // The anchors other pages link to still open their place.
  await page.goto(setupHref + "#kitchen-setup");
  await expect(nav.getByRole("link", { name: "Kitchen setup" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto(setupHref + "#receipts-and-privacy");
  await expect(page.getByRole("heading", { name: "Receipts and privacy" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("@production a Store Manager is offered only the places they may see", async ({ page }) => {
  await install(page, { manager: true });
  await language(page, "en");
  await page.goto(setupHref + "?section=access");
  const nav = page.getByRole("navigation", { name: "Store setup sections" });
  await expect(nav.getByRole("link")).toHaveText([
    "Store details",
    "Receipts and tax numbers",
    "Kitchen setup",
  ]);
  // An address for a place they aren't offered shows the first one they are.
  await expect(page.getByLabel("Store name customers see (English)")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByText("Only the Owner can change Store setup.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and make live" })).toHaveCount(0);
});

for (const lang of ["en", "zh-Hans"] as const)
  test(`@production the Store setup places read plainly at 1440, 1024 and 390 (${lang})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await install(page);
    await language(page, lang);
    if (shots !== "") mkdirSync(shots, { recursive: true });
    for (const [place, en, zh, query] of places)
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(setupHref + query);
        const nav = page.getByRole("navigation", {
          name: lang === "en" ? "Store setup sections" : "门店设置分区",
        });
        await expect(nav.getByRole("link", { name: lang === "en" ? en : zh })).toHaveAttribute(
          "aria-current",
          "page",
        );
        await expect(page.getByText(/Loading|正在加载/u)).toHaveCount(0);
        await noOverflow(page);
        if (lang === "zh-Hans") {
          const text = await page.locator("main").innerText();
          expect(text).not.toContain("厨房线");
          expect(text).not.toContain("修订版");
          expect(text).not.toContain("加拿大英语");
        }
        await expectNoInternalText(page);
        if (shots !== "")
          await page.screenshot({
            path: `${shots}/store-setup-${place}-${lang}-${width}.png`,
            fullPage: true,
          });
      }
  });
