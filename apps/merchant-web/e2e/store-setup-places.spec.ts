import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { createStoreConfigurationVersion } from "../../../packages/rms/store/src/contracts/store-configuration-administration.js";
import { canonicalPublicationValue as canonical } from "../src/product-publication-command-client-v2.js";
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

/**
 * b18 review: 160 records, the first 50 all looks; two changes and a refused attempt are older
 * than every one of them, so a summary of the page on screen alone would say support changed
 * nothing. The server's summary is of the whole log; the rest is read page by page.
 */
function supportLog() {
  const log: { occurredAt: string; supportName: string; kind: string; subjectCode: string }[] = [];
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 18, 0) - minutes * 60_000);
  for (let i = 0; i < 160; i++) {
    const kind = i === 120 ? "Changed" : i === 140 ? "Changed" : i === 155 ? "Refused" : "Viewed";
    log.push({
      occurredAt: at(i * 37).toISOString(),
      supportName: "Platform support (TEST ONLY)",
      kind,
      subjectCode: kind === "Changed" ? (i === 120 ? "Pickup" : "KitchenLine") : "MerchantOverview",
    });
  }
  return log;
}
const fullSupportLog = supportLog();
const micro = (iso: string) => iso.replace("Z", "000Z");
function supportPage(from: number) {
  const log = fullSupportLog.slice(from, from + 50);
  const last = log.at(-1);
  return {
    log,
    logNext:
      from + 50 < fullSupportLog.length && last !== undefined
        ? { before: micro(last.occurredAt), skip: 1 }
        : null,
  };
}
const supportReads: string[] = [];

/** b18 review: the configuration the Store runs on today (business day from 05:00). */
function liveConfiguration() {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return createStoreConfigurationVersion({
    configurationReference: id(20),
    brandReference: id(2),
    storeReference: store,
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(21),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "05:00:00",
    addressReference: id(22),
    contactReference: id(23),
    receiptReference: id(24),
    taxConfigurationReference: id(25),
    paymentConfigurationReference: id(26),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals: [
        {
          startLocalTime: "11:00:00",
          endLocalTime: "21:00:00",
          endsNextDay: false,
          serviceModes: ["DineIn", "Pickup"],
          orderCutoffSeconds: 0,
          leadTimeSeconds: 0,
        },
      ],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST_STORE_SETUP",
    authoredByReference: id(30),
    approvedByReference: id(31),
    approvalEvidenceReference: id(32),
    publicationReference: id(33),
    liveGateEvidenceReference: id(34),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
}
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");

/** The record holds 36 changes; the first read returns the newest 10, then pages of 20. */
function soleOperatorHistory(before = 37, count = 10) {
  return Array.from({ length: Math.min(count, before - 1) }, (_, i) => before - 1 - i).map(
    (version) => ({
      version,
      state: version % 2 === 0 ? "Off" : "On",
      reasonCode: version % 2 === 0 ? "OWNER_CHOICE" : "OWNER_RUNS_STORE_ALONE",
      recordedAt: new Date(Date.UTC(2026, 10, 13, 15) - (36 - version) * 86_400_000).toISOString(),
      changedByYou: true,
      changedByName: "Sam",
    }),
  );
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
            {
              screenId: "IAM-ROLE-LIST",
              label: "Roles",
              href: "/app/organization/roles",
              permission: "identity.role.read",
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
    if (path === "/merchant/store/support-access") {
      if (options.manager) return respond(route, { error: "request_denied" }, 403);
      const url = new URL(request.url());
      const before = url.searchParams.get("before");
      if (before !== null) {
        supportReads.push(url.search);
        const from = fullSupportLog.findIndex((entry) => micro(entry.occurredAt) === before);
        return respond(route, supportPage(from + Number(url.searchParams.get("skip"))));
      }
      const acted = fullSupportLog.filter((entry) => entry.kind !== "Viewed");
      const looks = fullSupportLog.filter((entry) => entry.kind === "Viewed");
      return respond(route, {
        version: 4,
        mode: "Off",
        allowedUntil: null,
        ...supportPage(0),
        summary: {
          total: fullSupportLog.length,
          looks: looks.length,
          lastLookAt: looks[0]?.occurredAt ?? null,
          actedCount: acted.length,
          acted,
        },
      });
    }
    if (path === "/merchant/organization/sole-operator") {
      const before = new URL(request.url()).searchParams.get("before");
      return respond(route, {
        observedAt: new Date().toISOString(),
        state: "Off",
        version: 36,
        changeCount: 36,
        history: before === null ? soleOperatorHistory() : soleOperatorHistory(Number(before), 20),
        refundApproval: { status: "NotSet", youHoldApproval: true, otherApprovers: [] },
        verifiedUntil: null,
        reasons: {
          On: ["OWNER_RUNS_STORE_ALONE"],
          Off: ["SECOND_APPROVER_AVAILABLE", "OWNER_CHOICE", "ENTERED_IN_ERROR"],
        },
      });
    }
    if (path === "/merchant/store-configuration/ordinary") {
      if (options.manager) return respond(route, { error: "request_denied" }, 403);
      const current = liveConfiguration(),
        observedAt = new Date().toISOString();
      return respond(route, {
        profile: "StoreConfigurationOrdinaryWorkspaceV1",
        scope: {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: store,
          actorReference: id(4),
        },
        latest: null,
        current,
        expectedHead: {
          configurationReference: current.configurationReference,
          configurationVersion: current.configurationVersion,
          contentDigest: hash(current),
        },
        original: null,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        businessReferenceValidation: "NotEvaluated",
        storeTaxConfigurationReference: id(25),
      });
    }
    // b18 review: nothing saved for the setup's address and contact yet.
    if (path === "/merchant/store-setup/references") {
      const observedAt = new Date().toISOString();
      return respond(route, {
        profile: "StoreSetupReferencesCurrentV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: store,
        actorReference: id(4),
        address: null,
        contact: null,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        businessReferenceValidation: "NotEvaluated",
      });
    }
    // b24: what the fees step reads (choices, payment methods, receipt templates).
    const ids = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: store,
      actorReference: id(4),
    };
    const observedAt = new Date().toISOString(),
      validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
    if (path === "/merchant/store-setup" && request.method() === "POST") {
      setupWrites.push(path);
      return respond(route, { error: "fixture_unavailable" }, 503);
    }
    if (path === "/merchant/store-setup/fee-context-classifications")
      return respond(route, {
        profile: "TaxConfigClassificationChoicesV1",
        ...ids,
        registryReference: id(40),
        versionReference: id(41),
        registryVersion: 1,
        snapshotDigest: "sha256:" + "a".repeat(64),
        defaultLocale: "en-CA",
        choices: [
          {
            classificationReference: id(42),
            code: "SYNTH_FEE_CLASS",
            // b24: the Brand named it in both languages; each screen shows its own.
            localizedNames: { "en-CA": "Standard taxable", "zh-Hans-CA": "标准应税" },
            lifecycle: "Active",
          },
        ],
        observedAt,
        validUntil,
        sourceQualification: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/payment-configuration" && request.method() === "GET")
      return respond(route, {
        profile: "StorePaymentConfigurationCurrentV1",
        ...ids,
        snapshot: {
          profile: "StorePaymentConfigurationV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: store,
          configurationReference: id(26),
          revision: 1,
          authoredByReference: id(4),
          previousConfigurationReference: null,
          content: {
            customerOnlineCardEnabled: true,
            staffTerminalCardPresentEnabled: true,
            staffTerminalInteracEnabled: false,
          },
          currencyCode: "CAD",
          createdAt: observedAt,
          updatedAt: observedAt,
          dataClassification: "Internal",
        },
        observedAt,
        validUntil,
        providerReadiness: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/receipt-template-drafts")
      return respond(route, {
        profile: "DigitalReceiptTemplateDraftRosterV1",
        ...ids,
        afterTemplate: null,
        entries: [],
        nextAfter: null,
        observedAt,
        validUntil,
        sourceQualification: "NotEvaluated",
      });
    if (
      path === "/merchant/store-setup/receipt-template-published" &&
      new URL(request.url()).searchParams.get("installed") === "true"
    )
      return respond(route, { error: "receipt_template_installed_none" }, 404);
    return respond(route, { error: "fixture_unavailable" }, 503);
  });
  return errors;
}
const setupWrites: string[] = [];

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
  await expect(page.getByRole("region", { name: "Receipts and tax numbers" })).toBeHidden();
  // b18 polish: the link and its one-line lead name Store details; the section doesn't repeat its
  // name or explain itself again. The title row ends with the language switch.
  await expect(page.getByRole("heading", { name: "Store details" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Store details" })).toBeVisible();
  await expect(page.getByText(/Customers see this name on the menu/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换到中文" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the last saved draft" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Platform support" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
  // The store-type question is asked while a Store is being opened, not on an open Store's setup.
  await expect(page.getByText("What kind of shop is this?")).toHaveCount(0);
  await expect(page.locator("section.starter-roles")).toHaveCount(0);
  await expect(page.getByText("Saving a draft does not change the live Store.")).toHaveCount(0);

  // Receipts: one save, live for receipts issued from then on.
  await nav.getByRole("link", { name: "Receipts and tax numbers" }).click();
  await expect(page).toHaveURL(/\?section=receipts$/u);
  // b19: the link and lead name the place; the section has no heading repeating it.
  await expect(page.getByRole("region", { name: "Receipts and tax numbers" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Receipts and tax numbers" })).toHaveCount(0);
  await expect(page.getByLabel("GST/HST registration number")).toHaveValue("123456789RT0001");
  await expect(page.getByRole("button", { name: "Save and make live" })).toBeVisible();
  await expect(page.getByLabel("Store name customers see (English)")).toBeHidden();

  // Kitchen.
  await nav.getByRole("link", { name: "Kitchen setup" }).click();
  await expect(page.locator("#kitchen-setup")).toBeVisible();
  await expect(page.locator("#kitchen-setup")).toContainText("Every dish with a recipe");
  await expect(page.getByRole("region", { name: "Kitchen setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kitchen setup" })).toHaveCount(0);

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
  await expect(support).toContainText("Support looked at your Store 157 times, last");
  await expect(support).not.toContainText("hasn't changed or tried");
  // b18 polish: the access log repeats the looks counted above, so it starts folded.
  await expect(support.locator("table.support-access__log")).toHaveCount(1);
  await expect(support.getByRole("heading", { name: "Support access log" })).toHaveCount(0);
  await support.getByRole("button", { name: "View all 160 access records" }).click();
  const fullLog = support.locator("table.support-access__log").last();
  await expect(fullLog.locator("tbody tr")).toHaveCount(50);
  await expect(support).toContainText("Showing 50 of 160 records.");
  // "Show all" reaches every record: the earlier ones are read a page at a time.
  for (const shown of [100, 150, 160]) {
    await support.getByRole("button", { name: "Show earlier records" }).click();
    await expect(fullLog.locator("tbody tr")).toHaveCount(shown);
  }
  await expect(support.getByRole("button", { name: "Show earlier records" })).toHaveCount(0);
  await expect(support).not.toContainText("Showing");
  expect(supportReads).toHaveLength(3);
  await support.getByRole("button", { name: "Hide the access records" }).click();
  await expect(support.locator("table.support-access__log")).toHaveCount(1);
  // Platform support's two grants are named by what they do and for how long.
  await expect(
    support.getByRole("button", {
      name: "Let platform support change my settings for the next hour",
    }),
  ).toBeVisible();
  await expect(
    support.getByRole("button", {
      name: "Let platform support change my settings until I turn it off",
    }),
  ).toBeVisible();
  // Sole operator: no change numbers; the newest five, then every change of the record.
  const sole = page.locator("section.sole-operator");
  await expect(sole.getByRole("heading", { name: "Sole operator" })).toBeVisible();
  // b18 polish: one short lead, the full list behind "What this covers", the state in one sentence.
  await expect(sole).toContainText("you can approve your own refunds, prices, menus");
  await expect(sole).toContainText("Now: Off. Refunds that need approval");
  await expect(sole.getByText(/price books and option prices/u)).toBeHidden();
  await sole.getByText("What this covers").click();
  await expect(sole.getByText(/price books and option prices/u)).toBeVisible();
  await expect(sole).not.toContainText("setting change 36");
  await expect(sole.locator(".sole-operator-history li")).toHaveCount(5);
  await sole.getByRole("button", { name: "Show all 36 changes" }).click();
  await expect(sole.locator(".sole-operator-history li")).toHaveCount(10);
  await expect(sole).toContainText("Showing 10 of 36 changes.");
  for (const shown of [30, 36]) {
    await sole.getByRole("button", { name: "Show earlier changes" }).click();
    await expect(sole.locator(".sole-operator-history li")).toHaveCount(shown);
  }
  await expect(sole.getByRole("button", { name: "Show earlier changes" })).toHaveCount(0);
  await expect(sole.locator(".sole-operator-history li").last()).toContainText(
    "I run this business on my own",
  );
  await sole.getByRole("button", { name: "Show fewer" }).click();
  // One action at a time: verify first; the solid button comes only after.
  await expect(sole.getByRole("button", { name: /Verify to turn it on/u })).toBeVisible();
  await expect(sole.getByRole("button", { name: "Turn on sole operator" })).toHaveCount(0);

  // Settings that need approval: the only place that keeps a draft, and it says so.
  await nav.getByRole("link", { name: "Settings that need approval" }).click();
  await expect(page.getByText(/saved as a draft first; it takes effect only after/u)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard unsaved changes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the last saved draft" })).toBeVisible();
  await expect(page.getByText(/Revision \d/u)).toHaveCount(0);
  // Only the settings that need approval: no opening steps, and hours live in Hours & ordering.
  await expect(
    page.getByRole("navigation", { name: "Setup steps" }).getByRole("button"),
  ).toHaveText([
    "1. Time zone and business day",
    "2. Services",
    "3. Fees, tax and payment",
    "4. Review and publish",
  ]);
  // b18 polish: the draft starts from the time zone the Store runs on, never "Not configured".
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toHaveValue(
    "America/Toronto",
  );
  await expect(
    page.getByRole("combobox", { name: "Time zone", exact: true }).locator("option[value='']"),
  ).toHaveCount(0);
  // b18 review: and from the business day start it runs on, on this first step already.
  await expect(page.getByLabel("Business day starts at (local time)")).toHaveValue("05:00");
  await expect(
    page.getByText(
      "Filled in with the time zone and business day start the Store runs on today; saving the draft keeps them.",
    ),
  ).toBeVisible();
  // Review says they are filled in but not saved, so it agrees with the publication below.
  await page.getByRole("button", { name: "4. Review and publish" }).click();
  const unsaved = page.getByRole("region", { name: "Filled in, not saved yet" });
  await expect(unsaved).toContainText("Time zone");
  await expect(unsaved).toContainText("Business day start");
  await expect(
    page.getByRole("region", { name: "Settings not set yet" }).getByText(/^Time zone/u),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "1. Time zone and business day" }).click();
  // The step controls: "Previous step" is disabled on the first step only, "Next step" is not.
  await expect(page.getByRole("button", { name: "Previous step" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next step" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Hours & ordering" }).first()).toHaveAttribute(
    "href",
    "/app/organization/stores/" + store + "/service",
  );
  await page.getByRole("button", { name: "2. Services" }).click();
  await expect(page.getByLabel("Order limits")).toBeVisible();
  await expect(page.getByRole("link", { name: "Store features" })).toBeVisible();
  // The address and phone these settings carry are filled in from Store details, not asked again.
  await page.getByRole("button", { name: "4. Review and publish" }).click();
  await expect(page.getByRole("heading", { name: "Still needed" })).toBeVisible();
  await expect(page.getByLabel("Address line 1", { exact: true })).toHaveValue(
    "100 King Street West",
  );
  await expect(page.getByLabel("Business phone with country code", { exact: true })).toHaveValue(
    "+14165550100",
  );
  await expect(page.getByText(/step [5-8]/u)).toHaveCount(0);
  await page.getByRole("link", { name: "Store details" }).last().click();
  await expect(page.getByLabel("Store name customers see (English)")).toBeVisible();

  // The anchors other pages link to still open their place.
  await page.goto(setupHref + "#kitchen-setup");
  await expect(nav.getByRole("link", { name: "Kitchen setup" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto(setupHref + "#receipts-and-privacy");
  await expect(page.getByRole("region", { name: "Receipts and tax numbers" })).toBeVisible();
  // Approvals' sole-operator link opens Permissions and safety.
  // b19: and brings the Sole operator section into view (it loads after the page).
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(setupHref + "?section=access#sole-operator");
    await expect(nav.getByRole("link", { name: "Permissions and safety" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("section#sole-operator")).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
        // v3: the title row ends with the language switch (in the top bar on a phone).
        if (width > 768)
          await expect(page.locator(".screen-heading .language-switch")).toBeVisible();
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

// b24 (Owner 2026-11-16 "服务费的订单类型为什么可以勾选服务方式没有勾选的选项？" and "3. 费用、税务和付
// 款 这个页面还是很难看"): the fees step offers a fee only the orders the store offers (step 2, saved or
// not), names one that no longer fits at the fee and in Review and never sends it, and reads as four
// calm sections. Shots go to BOP_B24_SHOTS when it names a folder.
const b24Shots = process.env.BOP_B24_SHOTS ?? "";
async function b24Shot(page: Page, name: string) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await noOverflow(page);
    if (b24Shots) {
      mkdirSync(b24Shots, { recursive: true });
      await page.screenshot({ path: `${b24Shots}/${name}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
/**
 * b24 (coordinator review): Fees, Tax, Payment and Receipts share one grid: the names start at one
 * x, the fields at another, and the fields are equally wide, at 1440 and 1024; stacked at 390.
 */
async function sectionsShareOneGrid(page: Page) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const boxes = await page.evaluate(() => {
      const content = document.querySelector(".store-setup-step-content");
      const box = (node: Element | null | undefined) => {
        const r = node?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), width: Math.round(r.width) } : null;
      };
      const rows = [...(content?.querySelectorAll(".store-setup-block .store-setup-row") ?? [])]
        .filter((row) => (row as HTMLElement).offsetParent !== null)
        .map((row) => ({
          name: box(row.querySelector(".store-setup-row__name")),
          fields: box(row.querySelector(".store-setup-row__fields")),
        }));
      const selects = [...(content?.querySelectorAll(".store-setup-block select") ?? [])]
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => box(node));
      const sections = [...(content?.querySelectorAll(".store-setup-block") ?? [])]
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => node.getAttribute("aria-label"));
      return { rows, selects, sections };
    });
    expect(boxes.sections.length).toBe(4);
    const xs = (values: readonly ({ x: number } | null)[]) => new Set(values.map((v) => v?.x));
    expect(xs(boxes.rows.map((row) => row.name)).size).toBe(1);
    expect(xs(boxes.rows.map((row) => row.fields)).size).toBe(1);
    expect(new Set(boxes.selects.map((v) => v?.width)).size).toBe(1);
    if (width === 390)
      // Stacked: names and fields start at the same x.
      expect(boxes.rows[0]?.name?.x).toBe(boxes.rows[0]?.fields?.x);
    else expect(boxes.rows[0]?.fields?.x).toBeGreaterThan((boxes.rows[0]?.name?.x ?? 0) + 200);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const b24Words = {
  en: {
    services: "2. Services",
    servicesGroup: "Service modes",
    fees: "3. Fees, tax and payment",
    review: "4. Review and publish",
    dineIn: "Dine in",
    pickup: "Pickup",
    delivery: "Delivery",
    serviceCharge: "Service charge",
    orderTypes: "Service charge order types",
    taxClass: "Service charge tax classification",
    noDelivery: "This store does not offer delivery, so it charges no delivery fee.",
    notOffered:
      "This store does not offer Pickup. Untick it here, or offer it in step 2, Services.",
    fix: "Service charge applies to Pickup orders, but this setup does not offer Pickup.",
    regions: ["Fees", "Tax", "Payment methods", "Receipts"],
    known: "Guests pay online by card",
    taxClassName: "Standard taxable",
    tax: "Orders are taxed with the tax settings this store uses today.",
    save: "Save as draft",
    // b26: one short sentence; what to fix is listed in step 4 and said at the fee.
    alert:
      "This draft was not saved: 1 fee setting needs fixing first, see “Needs fixing first” below.",
  },
  "zh-Hans": {
    services: "2. 服务方式",
    servicesGroup: "服务方式",
    fees: "3. 费用、税务和付款",
    review: "4. 核对并发布",
    dineIn: "堂食",
    pickup: "自取",
    delivery: "配送",
    serviceCharge: "服务费",
    orderTypes: "服务费的订单类型",
    taxClass: "服务费的税类",
    noDelivery: "本店不提供配送，所以不收配送费。",
    notOffered: "本店不提供自取。请在这里取消勾选，或在第 2 步，服务方式中提供自取。",
    fix: "服务费适用于自取订单，但这份设置没有提供自取。",
    regions: ["费用", "税", "付款方式", "收据"],
    known: "顾客在线刷卡",
    taxClassName: "标准应税",
    tax: "订单按本店现在用的税务设置计税。",
    save: "存为草稿",
    alert: "这份草稿没有保存：有 1 处要先改正，见下方“需要先改正”。",
  },
} as const;
for (const lang of ["en", "zh-Hans"] as const)
  test(`@production b24: the fees step offers a fee only the orders the store offers, and reads at a glance (${lang})`, async ({
    page,
  }) => {
    const w = b24Words[lang];
    const errors = await install(page);
    await language(page, lang);
    await page.goto(setupHref + "?section=changes");
    const step = (name: string) => page.getByRole("button", { name, exact: true }).click();
    await step(w.services);
    const services = page.getByRole("group", { name: w.servicesGroup, exact: true });
    await services.getByRole("checkbox", { name: w.dineIn, exact: true }).check();
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).check();
    await services.getByRole("checkbox", { name: w.delivery, exact: true }).uncheck();
    await step(w.fees);
    const content = page.locator(".store-setup-step-content");
    for (const name of w.regions)
      await expect(content.getByRole("region", { name, exact: true })).toBeVisible();
    // Loaded by themselves: no refresh, next-batch or tool buttons, no internal words.
    await expect(page.getByRole("checkbox", { name: w.known, exact: true })).toBeChecked();
    await expect(
      content.getByRole("button", { name: /Refresh|Next|刷新|下一批/u }).filter({ visible: true }),
    ).toHaveCount(0);
    await expect(content).not.toContainText(/配置|预设|模板草稿|en-CA|yyyy|draft \d/u, {
      useInnerText: true,
    });
    await expect(content.getByText(w.noDelivery)).toBeVisible();
    const fees = content.getByRole("region", { name: w.regions[0], exact: true });
    await fees
      .getByRole("combobox", { name: w.serviceCharge, exact: true })
      .selectOption("Enabled");
    const orders = fees.getByRole("group", { name: w.orderTypes, exact: true });
    await expect(orders.getByRole("checkbox")).toHaveCount(2);
    await expect(orders.getByRole("checkbox", { name: w.delivery, exact: true })).toHaveCount(0);
    await orders.getByRole("checkbox", { name: w.pickup, exact: true }).check();
    await fees
      .getByRole("combobox", { name: w.taxClass, exact: true })
      .selectOption({ label: w.taxClassName });
    // Tax says plainly what the store is taxed with, with no step or internal words.
    await expect(content.getByText(w.tax, { exact: true })).toBeVisible();
    await expect(content).not.toContainText(/第 4 步：|step 4: Use/u, { useInnerText: true });
    await sectionsShareOneGrid(page);
    await b24Shot(page, `fees-step-${lang}`);
    // Step 2 stops pickup (not saved yet): the fee says so where it is set.
    await step(w.services);
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).uncheck();
    await step(w.fees);
    await expect(fees.getByText(w.notOffered)).toBeVisible();
    await expect(orders.getByRole("checkbox", { name: w.pickup, exact: true })).toBeChecked();
    await b24Shot(page, `fees-step-not-offered-${lang}`);
    await step(w.review);
    await expect(page.getByText(w.fix, { exact: false }).first()).toBeVisible();
    // Never sent.
    await page.getByRole("button", { name: w.save, exact: true }).click();
    await expect(page.locator("#setup-validation-error")).toContainText(w.alert);
    expect(setupWrites).toEqual([]);
    // Untick it at the fee: it can be saved again.
    await step(w.fees);
    // Unticked, it is no longer offered, so it leaves the list.
    await orders.getByRole("checkbox", { name: w.pickup, exact: true }).click();
    await expect(fees.getByText(w.notOffered)).toHaveCount(0);
    await expect(orders.getByRole("checkbox")).toHaveCount(1);
    await expectNoInternalText(page);
    expect(errors).toEqual([]);
  });

// b25 (v15 live check of b24): a save the server refuses outright never happened, so staff are not
// blocked behind "An earlier save has not been cleared"; a save the page refuses names the fee and
// the service; payment methods read as what guests and cashiers do; the receipt template tools have
// no Refresh buttons. Shots go to BOP_B25_SHOTS when it names a folder.
const b25Shots = process.env.BOP_B25_SHOTS ?? "";
async function b25Shot(page: Page, name: string) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await noOverflow(page);
    if (b25Shots) {
      mkdirSync(b25Shots, { recursive: true });
      await page.screenshot({ path: `${b25Shots}/${name}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
for (const lang of ["en", "zh-Hans"] as const)
  test(`@production b25: a refused Store setup save can be put right and saved again, and says what is wrong (${lang})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const w = b24Words[lang],
      zh = lang === "zh-Hans";
    const errors = await install(page);
    await language(page, lang);
    // The server refuses the save outright (a rule only it knows): 400, nothing written.
    const refused: string[] = [];
    await page.route("**/merchant/store-setup", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      refused.push(String((route.request().postDataJSON() as { command?: unknown }).command));
      return respond(route, { error: "store_setup_invalid" }, 400);
    });
    await page.goto(setupHref + "?section=changes");
    const step = (name: string) => page.getByRole("button", { name, exact: true }).click();
    await step(w.services);
    const services = page.getByRole("group", { name: w.servicesGroup, exact: true });
    await services.getByRole("checkbox", { name: w.dineIn, exact: true }).check();
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).check();
    await services.getByRole("checkbox", { name: w.delivery, exact: true }).uncheck();
    const save = page.getByRole("button", { name: w.save, exact: true });
    await save.click();
    await expect(page.locator("#setup-validation-error")).toContainText(
      // b28 (v15 live26): one sentence saying where to look, never every rule.
      zh ? "检查你改过的时间、等待时间和费用" : "check the times, wait times and fees you changed",
    );
    expect(refused).toEqual(["SaveDraft"]);
    await expect(
      page.getByText(zh ? "之前的保存尚未清除" : "An earlier save has not been cleared"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: zh ? "恢复原来的保存" : "Recover original save" }),
    ).toHaveCount(0);
    await expect(save).toBeEnabled();
    await expect(
      page.getByRole("button", { name: zh ? "放弃未保存的修改" : "Discard unsaved changes" }),
    ).toBeEnabled();
    await b25Shot(page, `server-refused-${lang}`);
    // Payment methods in plain words.
    await step(w.fees);
    const payment = page.getByRole("region", { name: w.regions[2], exact: true });
    for (const name of zh
      ? ["顾客在线刷卡", "门店刷卡机刷卡", "门店刷卡机 Interac"]
      : [
          "Guests pay online by card",
          "Card on the store terminal",
          "Interac on the store terminal",
        ])
      await expect(payment.getByRole("checkbox", { name, exact: true })).toBeVisible();
    await expect(payment).not.toContainText(/Staff terminal|Customer online|员工终端/u);
    await b25Shot(page, `fees-step-${lang}`);
    // A fee on a service this setup does not offer: the page refuses it and says which.
    const fees = page.getByRole("region", { name: w.regions[0], exact: true });
    await fees
      .getByRole("combobox", { name: w.serviceCharge, exact: true })
      .selectOption("Enabled");
    const orders = fees.getByRole("group", { name: w.orderTypes, exact: true });
    await orders.getByRole("checkbox", { name: w.pickup, exact: true }).check();
    await fees
      .getByRole("combobox", { name: w.taxClass, exact: true })
      .selectOption({ label: w.taxClassName });
    await step(w.services);
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).uncheck();
    await save.click();
    const alert = page.locator("#setup-validation-error");
    // b26: the detail is in step 4 only, not repeated above the steps.
    await expect(alert).toHaveText(w.alert);
    await expect(
      page.getByRole("region", { name: zh ? "需要先改正" : "Needs fixing first", exact: true }),
    ).toContainText(w.fix);
    await expect(alert).not.toContainText(zh ? "每个服务时段" : "Each service interval");
    expect(refused).toEqual(["SaveDraft"]);
    await b25Shot(page, `save-refused-${lang}`);
    // The receipt template tools: no Refresh buttons of their own.
    // No preset saved yet (the presets' own spec covers saving them).
    await page.route("**/merchant/store-setup/receipt-artifacts**", (route) => {
      const observedAt = new Date().toISOString();
      return respond(route, {
        profile: "DigitalReceiptTemplateArtifactsCurrentV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: store,
        actorReference: id(4),
        layout: null,
        compliance: null,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        sourceQualification: "NotEvaluated",
      });
    });
    await page.goto(setupHref + "?section=receipts");
    const tools = page.locator("#receipt-templates");
    await expect(tools).toBeVisible();
    // The presets read again by themselves; only the template list and the saved template draft
    // keep a way to read what another person or device did meanwhile (approved, saved elsewhere).
    await expect(
      tools
        .getByRole("region", { name: zh ? "收据样式" : "Receipt presets", exact: true })
        .getByRole("button", { name: /Refresh|刷新/u }),
    ).toHaveCount(0);
    await expect(tools.getByRole("button", { name: /Refresh|刷新/u })).toHaveCount(0);
    // b28 (v15 live26): in plain words.
    await expect(
      tools.getByRole("button", {
        name: zh
          ? /^(重新读取列表|重新读取已保存的草稿)$/u
          : /^(Read the list again|Read the saved draft again)$/u,
      }),
    ).toHaveCount(2);
    await expect(
      tools.getByText(zh ? "还没有已保存的样式。" : "No saved preset yet.").first(),
    ).toBeVisible();
    await b25Shot(page, `receipts-${lang}`);
    await expectNoInternalText(page);
    expect(errors).toEqual([]);
  });

// b26 (v15 live check of b25): a refused save says first that the draft was not saved, in one
// short sentence when the page knows what to fix (listed once, in step 4); step 4 says what reads
// again by itself and why its one check button stays; the receipt tools say an outage once and that
// they read again by themselves. Shots go to BOP_B26_SHOTS when it names a folder.
const b26Shots = process.env.BOP_B26_SHOTS ?? "";
async function b26Shot(page: Page, name: string) {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await noOverflow(page);
    if (b26Shots) {
      mkdirSync(b26Shots, { recursive: true });
      await page.screenshot({ path: `${b26Shots}/${name}-${width}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
for (const lang of ["en", "zh-Hans"] as const)
  test(`@production b26: Store setup says plainly a draft was not saved, and what reads again by itself (${lang})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const w = b24Words[lang],
      zh = lang === "zh-Hans";
    const errors = await install(page);
    await language(page, lang);
    await page.route("**/merchant/store-setup", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return respond(route, { error: "store_setup_invalid" }, 400);
    });
    await page.goto(setupHref + "?section=changes");
    const step = (name: string) => page.getByRole("button", { name, exact: true }).click();
    await step(w.services);
    const services = page.getByRole("group", { name: w.servicesGroup, exact: true });
    await services.getByRole("checkbox", { name: w.dineIn, exact: true }).check();
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).check();
    await services.getByRole("checkbox", { name: w.delivery, exact: true }).uncheck();
    const save = page.getByRole("button", { name: w.save, exact: true });
    await save.click();
    const alert = page.locator("#setup-validation-error");
    await expect(alert).toContainText(
      zh
        ? "这份草稿没有保存：请对照这份设置提供的服务方式，检查你改过的时间、等待时间和费用；最后一步会列出还需要改的地方。"
        : "This draft was not saved: check the times, wait times and fees you changed against the services this setup offers; the last step lists anything still needed.",
    );
    await b26Shot(page, `server-refused-${lang}`);
    // Two fees on a service this setup does not offer: one sentence above the steps.
    await step(w.fees);
    const fees = page.getByRole("region", { name: w.regions[0], exact: true });
    await fees
      .getByRole("combobox", { name: w.serviceCharge, exact: true })
      .selectOption("Enabled");
    await fees
      .getByRole("group", { name: w.orderTypes, exact: true })
      .getByRole("checkbox", { name: w.pickup, exact: true })
      .check();
    await fees
      .getByRole("combobox", { name: w.taxClass, exact: true })
      .selectOption({ label: w.taxClassName });
    await fees
      .getByRole("combobox", { name: zh ? "小费" : "Tip", exact: true })
      .selectOption("Enabled");
    await fees
      .getByRole("group", { name: zh ? "小费的订单类型" : "Tip order types", exact: true })
      .getByRole("checkbox", { name: w.pickup, exact: true })
      .check();
    await step(w.services);
    await services.getByRole("checkbox", { name: w.pickup, exact: true }).uncheck();
    await save.click();
    await expect(alert).toHaveText(
      zh
        ? "这份草稿没有保存：有 2 处要先改正，见下方“需要先改正”。"
        : "This draft was not saved: 2 fee settings need fixing first, see “Needs fixing first” below.",
    );
    const fixes = page.getByRole("region", {
      name: zh ? "需要先改正" : "Needs fixing first",
      exact: true,
    });
    await expect(fixes.getByRole("listitem")).toHaveCount(2);
    await expect(fixes).toContainText(w.fix);
    // Step 4: no "Refresh the status"; the check button says why it stays.
    await expect(page.getByRole("button", { name: /Refresh the status|刷新状态/u })).toHaveCount(0);
    const check = page.getByRole("button", {
      name: zh ? "查看最新审批情况" : "Check for approval updates",
      exact: true,
    });
    await expect(check).toBeVisible();
    await expect(page.locator("#store-configuration-others-note")).toContainText(
      zh ? "别人在其他设备上批准、拒绝或发布后" : "What someone else does on another device",
    );
    await b26Shot(page, `save-refused-${lang}`);
    // Receipts: presets and the template draft cannot be read; each says so once, and that it is
    // read again by itself.
    await page.route("**/merchant/store-setup/receipt-artifacts**", (route) =>
      respond(route, { error: "unavailable" }, 503),
    );
    await page.route("**/merchant/store-setup/receipt-template-draft**", (route) =>
      respond(route, { error: "unavailable" }, 503),
    );
    await page.goto(setupHref + "?section=receipts");
    const tools = page.locator("#receipt-templates");
    const presets = tools.getByRole("region", {
      name: zh ? "收据样式" : "Receipt presets",
      exact: true,
    });
    await expect(presets.getByRole("alert")).toHaveCount(1);
    await expect(presets.getByRole("alert")).toContainText(
      zh ? "网络恢复后会自动重新读取" : "They are read again once the connection is back",
    );
    await expect(
      tools.getByRole("alert").filter({ hasText: zh ? "收据草稿" : "template draft" }),
    ).toContainText(
      zh ? "网络恢复后会自动重新读取" : "It is read again by itself once the connection is back",
    );
    await expect(tools).not.toContainText(zh ? "联网后请刷新" : "Refresh when connected");
    await b26Shot(page, `receipts-outage-${lang}`);
    await expectNoInternalText(page);
    expect(errors).toEqual([]);
  });

// b24 (v15 live check of b23): Store setup opened while offline read every section again by itself
// once the connection was back; nothing says "could not be loaded" or "refresh" on a page online again.
for (const lang of ["en", "zh-Hans"] as const)
  test(`@production b24: Store setup opened offline reads every section again once the connection is back (${lang})`, async ({
    page,
    context,
  }) => {
    const errors = await install(page);
    await language(page, lang);
    const zh = lang === "zh-Hans";
    const failures =
      /could not be loaded|can't show|didn't load|Refresh|无法加载|暂时无法显示|没有加载|刷新/u;
    const nav = page.getByRole("navigation", {
      name: zh ? "门店设置分区" : "Store setup sections",
    });
    const place = (en: string, zhName: string) =>
      nav.getByRole("link", { name: zh ? zhName : en, exact: true }).click();
    // Case 2 of the live check: Store setup is open; the Wi-Fi drops; "Settings that need
    // approval" is opened, so the fees step's sections read while offline.
    await page.goto(setupHref);
    await expect(
      page.getByRole("region", { name: zh ? "门店资料" : "Store details" }),
    ).toBeVisible();
    await context.setOffline(true);
    await place("Settings that need approval", "需审批的设置");
    await page.waitForTimeout(2500);
    await context.setOffline(false);
    await page
      .getByRole("button", { name: zh ? "3. 费用、税务和付款" : "3. Fees, tax and payment" })
      .click();
    await expect(
      page.getByRole("checkbox", { name: zh ? "顾客在线刷卡" : "Guests pay online by card" }),
    ).toBeChecked();
    await expect(page.locator(".store-setup-step-content")).not.toContainText(failures, {
      useInnerText: true,
    });
    await b24Shot(page, `reconnected-fees-step-${lang}`);
    // Case 1: Store setup opened from the sidebar while offline: every place reads by itself.
    await page
      .getByRole("link", { name: zh ? "首页" : "Home", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/app$/u);
    await context.setOffline(true);
    await page
      .getByRole("link", { name: zh ? "门店设置" : "Store setup", exact: true })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await context.setOffline(false);
    for (const [, en, zhName] of places.slice(0, 4)) {
      await place(en, zhName);
      await expect(page.locator(".store-setup-place__panel:not([hidden])").first()).toBeVisible();
      // The receipt template tools (served by receipt-template-*.spec.ts, not this fixture) aside.
      const shown = page.locator(
        ".store-setup-place__panel:not([hidden]):not(:has(#receipt-templates))",
      );
      for (const panel of await shown.all())
        await expect(panel).not.toContainText(failures, { useInnerText: true });
    }
    await expect(
      page.getByLabel(zh ? "GST/HST 登记号" : "GST/HST registration number"),
    ).toBeAttached();
    await expect(page.locator("#sole-operator")).toBeVisible();
    await b24Shot(page, `reconnected-access-${lang}`);
    expect(errors).toEqual([]);
  });
