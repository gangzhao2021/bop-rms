import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

test("@production configuration editor preserves uncertain request and reloads saved draft", async ({
  page,
}) => {
  const store = "018f8100-0000-7000-8000-000000000001";
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: store,
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-09-12",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [],
        },
      },
      headers,
    }),
  );

  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  const current = {
    ...configuration("Published"),
    storeReference: store,
    enabledServiceModes: ["DineIn", "Pickup"],
  };
  let latest: typeof current | null = null;
  const requests: string[] = [];
  await page.route("**/merchant/store-configuration", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        headers,
        json: {
          screenId: "STORE-HOURS-SERVICE",
          storeReference: store,
          current,
          latest,
          expectedVersion: latest?.configurationVersion ?? 1,
          observedAt: new Date().toISOString(),
        },
      });
      return;
    }
    requests.push(route.request().postData() ?? "");
    const body = route.request().postDataJSON();
    expect(body.actorReference).toBeUndefined();
    expect(body.occurredAt).toBeUndefined();
    // WP-2423 Q4: hours only — business-day start unchanged, effective from the read, no end.
    expect(body.configuration.businessDayStartLocalTime).toBe("04:00:00");
    expect(body.configuration.effectiveUntil).toBeNull();
    expect(body.configuration.effectiveFrom).toBe(body.configuration.createdAt);
    expect(body.configuration.reasonCode).toBe("STORE_HOURS_UPDATE");
    expect(body.configuration.exceptions).toEqual([
      {
        localDate: "2026-12-25",
        kind: "Holiday",
        intervals: [
          {
            startLocalTime: "10:00:00",
            endLocalTime: "17:00:00",
            endsNextDay: false,
            serviceModes: ["Pickup"],
            orderCutoffSeconds: 0,
            leadTimeSeconds: 0,
          },
        ],
      },
    ]);

    if (requests.length === 1) {
      latest = body.configuration;
      await route.abort("failed");
    } else {
      expect(requests[1]).toBe(requests[0]);
      await route.fulfill({ headers, json: { status: "AlreadyApplied", resultingVersion: 2 } });
    }
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const editor = page.getByRole("region", { name: "Operating hours draft" });
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await editor.getByRole("button", { name: "Add dated exception" }).click();
  const exception = editor.getByRole("group", { name: "Exception 1", exact: true });
  await exception.getByLabel("Exception date").fill("2026-12-25");
  await exception.getByRole("button", { name: "Add exception interval" }).click();
  await exception.getByLabel("Start 1", { exact: true }).fill("10:00");
  await exception.getByLabel("Dine-in", { exact: true }).uncheck();

  await editor.getByRole("button", { name: "Save hours draft" }).click();
  await expect(editor.getByRole("button", { name: "Retry configuration request" })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save hours draft" })).toBeDisabled();
  await editor.getByRole("button", { name: "Retry configuration request" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    editor.getByText("Draft saved. It takes effect only after approval and publication."),
  ).toBeVisible();
  await expect(editor.getByText("Latest change: Draft, not yet sent for approval")).toBeVisible();
  await page.reload();
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await expect(
    editor.getByRole("group", { name: "Exception 1", exact: true }).getByLabel("Exception date"),
  ).toHaveValue("2026-12-25");
  expect(requests).toHaveLength(2);
});

const setupBasis = {
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(30),
  setupDraftReference: id(31),
  sourceRevision: 4,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
  feeContexts: [
    { chargeType: "ServiceCharge", state: "Disabled" },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
};
async function hoursPage(page: Page, store: string) {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: store,
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-09-12",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [],
        },
      },
      headers,
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
  );
  return headers;
}
async function expectHoursLayout(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("button", { name: "Save hours draft" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
  await expectNoInternalText(page);
}

test("@production WP-2423 Q4: hours of a configuration from Store setup are saved as an hours draft", async ({
  page,
}) => {
  const store = "018f8100-0000-7000-8000-000000000002";
  const headers = await hoursPage(page, store);
  const current = {
    ...configuration("Published"),
    storeReference: store,
    enabledServiceModes: ["DineIn", "Pickup"],
    setupBasis,
  };
  let latest: Record<string, unknown> | null = null;
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/store-configuration", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      headers,
      json: {
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        current,
        latest,
        expectedVersion: latest ? 2 : 1,
        observedAt,
      },
    });
  });
  await page.route("**/merchant/store-configuration/hours-draft", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (bodies.length === 1) {
      await route.fulfill({
        status: 409,
        headers,
        json: { error: "store_setup_has_unpublished_changes" },
      });
      return;
    }
    latest = {
      ...current,
      configurationReference: body.configurationReference,
      configurationVersion: 2,
      lifecycle: "Draft",
      supersedesConfigurationReference: current.configurationReference,
      reasonCode: "STORE_HOURS_UPDATE",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
      liveGateEvidenceReference: null,
      exceptions: body.exceptions,
      effectiveFrom: body.effectiveFrom,
      setupBasis: {
        ...setupBasis,
        sourceRevision: 5,
        sourceSnapshotDigest: "sha256:" + "b".repeat(64),
      },
    };
    await route.fulfill({ headers, json: { status: "Applied", resultingVersion: 2 } });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const editor = page.getByRole("region", { name: "Operating hours draft" });
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await expect(editor.getByText("These hours are also the hours in Store setup.")).toBeVisible();
  await expect(editor.getByText("Fees in the published settings")).toBeVisible();
  await editor.getByRole("button", { name: "Add dated exception" }).click();
  const exception = editor.getByRole("group", { name: "Exception 1", exact: true });
  await exception.getByLabel("Exception date").fill("2026-12-25");
  await expectHoursLayout(page, "store-hours-setup-basis");

  // Store setup holds changes the Owner has not published: a plain answer, the form is kept.
  await editor.getByRole("button", { name: "Save hours draft" }).click();
  await expect(
    editor.getByText(
      "Store setup has changes that are not published yet. Ask the Owner to publish or finish them in Store setup first.",
    ),
  ).toBeVisible();
  await expect(exception.getByLabel("Exception date")).toHaveValue("2026-12-25");
  await expectNoInternalText(page);

  await editor.getByRole("button", { name: "Save hours draft" }).click();
  await expect(
    editor.getByText("Draft saved. It takes effect only after approval and publication."),
  ).toBeVisible();
  await expect(editor.getByText("Latest change: Draft, not yet sent for approval")).toBeVisible();
  // Only the hours change and the Store setup version it was made from are sent.
  expect(Object.keys(bodies[1] ?? {}).sort()).toEqual([
    "auditReference",
    "configurationReference",
    "effectiveFrom",
    "exceptions",
    "expectedSetup",
    "expectedVersion",
    "operationReference",
    "setupOperationReference",
    "weeklySchedule",
  ]);
  expect(bodies[1]?.expectedSetup).toEqual({
    setupDraftReference: setupBasis.setupDraftReference,
    sourceRevision: 4,
    sourceSnapshotDigest: setupBasis.sourceSnapshotDigest,
  });
  expect(bodies[1]?.effectiveFrom).toBe(observedAt);
  expect(bodies[1]?.exceptions).toEqual([
    { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
  ]);
  // A new request after a definite refusal: new references.
  expect(bodies[1]?.operationReference).not.toBe(bodies[0]?.operationReference);
  await expect(editor.getByRole("button", { name: "Submit saved draft" })).toBeEnabled();
  await expectHoursLayout(page, "store-hours-setup-basis-saved");
});

test("@production WP-2423 v15: your own hours change is approved alone; a refusal keeps the editor", async ({
  page,
}) => {
  const store = "018f8100-0000-7000-8000-000000000003";
  const headers = await hoursPage(page, store);
  const viewer = id(10);
  const current = {
    ...configuration("Published"),
    storeReference: store,
    enabledServiceModes: ["DineIn", "Pickup"],
  };
  const latest = {
    ...current,
    configurationReference: id(20),
    configurationVersion: 2,
    lifecycle: "PendingApproval",
    supersedesConfigurationReference: current.configurationReference,
    reasonCode: "STORE_HOURS_UPDATE",
    authoredByReference: viewer,
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
  };
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/store-configuration", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        headers,
        json: {
          screenId: "STORE-HOURS-SERVICE",
          storeReference: store,
          current,
          latest,
          expectedVersion: 2,
          observedAt,
          viewerActorReference: viewer,
          latestWithdrawal: null,
          latestAuthorName: null,
          soleOperator: {
            status: "Effective",
            otherApprovers: [],
            verifiedUntil: new Date(Date.now() + 10 * 60000).toISOString(),
          },
        },
      });
      return;
    }
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    // Sole operator was turned off meanwhile: refused, and said so.
    await route.fulfill({ status: 403, headers, json: { error: "sole_operator_off" } });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const editor = page.getByRole("region", { name: "Operating hours draft" });
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  const own = page.getByRole("region", { name: "Approve your own change" });
  await expect(own.getByText("you are the only person who holds Owner access")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Approve reviewed configuration" })).toHaveCount(
    0,
  );
  await expectHoursLayout(page, "store-hours-own-approval");
  await own.getByLabel("I checked these opening hours and approve on my own").check();
  await own.getByRole("button", { name: "Approve hours on my own" }).click();
  await expect(editor.getByText(/^Sole operator is off, so another person/u)).toBeVisible();
  // The editor and the waiting change stay on screen.
  await expect(editor.getByRole("button", { name: "Save hours draft" })).toBeVisible();
  await expect(own).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.approvalMode).toBe("SoleOperator");
  expect(bodies[0]?.command).toBe("Approve");
  await expectNoInternalText(page);
});

test("@production WP-2423 v15: after a refused publication your change can still be withdrawn and reloaded", async ({
  page,
}) => {
  const store = "018f8100-0000-7000-8000-000000000005";
  const headers = await hoursPage(page, store);
  const viewer = id(10);
  const current = {
    ...configuration("Published"),
    storeReference: store,
    enabledServiceModes: ["DineIn", "Pickup"],
  };
  // Approved by the viewer alone while Sole operator was on; it was turned off before publishing.
  const latest = {
    ...current,
    configurationReference: id(22),
    configurationVersion: 2,
    lifecycle: "Approved",
    supersedesConfigurationReference: current.configurationReference,
    reasonCode: "STORE_HOURS_UPDATE",
    authoredByReference: viewer,
    approvedByReference: viewer,
    approvalEvidenceReference: id(23),
    publicationReference: null,
    liveGateEvidenceReference: null,
  };
  let withdrawn = false;
  let reads = 0;
  const commands: Record<string, unknown>[] = [];
  const withdrawals: Record<string, unknown>[] = [];
  await page.route("**/merchant/store-configuration", async (route) => {
    if (route.request().method() === "GET") {
      reads += 1;
      await route.fulfill({
        headers,
        json: {
          screenId: "STORE-HOURS-SERVICE",
          storeReference: store,
          current,
          latest,
          expectedVersion: 2,
          observedAt: new Date(Date.now() - 1000).toISOString(),
          viewerActorReference: viewer,
          latestWithdrawal: withdrawn
            ? {
                kind: "Withdrawn",
                withdrawnAt: new Date().toISOString(),
                byYou: true,
                reason: null,
              }
            : null,
          latestAuthorName: null,
          soleOperator: null,
        },
      });
      return;
    }
    commands.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 409,
      headers,
      json: { error: "sole_operator_approval_invalid" },
    });
  });
  await page.route("**/merchant/store-configuration/withdrawal", async (route) => {
    withdrawals.push(route.request().postDataJSON() as Record<string, unknown>);
    withdrawn = true;
    // Its hours were an hours-only Store setup change: Store setup returns to the published hours.
    await route.fulfill({
      headers,
      json: { status: "Applied", kind: "Withdrawn", setupHoursRestored: true },
    });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const editor = page.getByRole("region", { name: "Operating hours draft" });
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await editor.getByRole("button", { name: "Publish approved configuration" }).click();
  await expect(
    editor.getByText(/^This change was approved by you alone while Sole operator was off/u),
  ).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.command).toBe("Publish");
  // Nothing was published and nothing is in doubt: no retry, and both next steps stay usable.
  await expect(editor.getByRole("button", { name: "Retry configuration request" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Reload configuration" })).toBeEnabled();
  const withdraw = editor.getByRole("button", { name: "Withdraw my change" });
  await expect(withdraw).toBeEnabled();
  await expectHoursLayout(page, "store-hours-publish-refused");
  const readsBefore = reads;
  await withdraw.click();
  await expect(editor.getByText("Your change was withdrawn.", { exact: false })).toBeVisible();
  await expect(
    editor.getByText("Store setup is back to the published opening hours too.", { exact: false }),
  ).toBeVisible();
  expect(withdrawals).toHaveLength(1);
  expect(withdrawals[0]?.configurationReference).toBe(id(22));
  expect(reads).toBe(readsBefore + 1);
  await expect(editor.getByRole("button", { name: "Reload configuration" })).toBeEnabled();
  await expectNoInternalText(page);
});

test("@production WP-2423 v15: someone else's open change names them; declining is confirmed", async ({
  page,
}) => {
  const store = "018f8100-0000-7000-8000-000000000004";
  const headers = await hoursPage(page, store);
  const current = {
    ...configuration("Published"),
    storeReference: store,
    enabledServiceModes: ["DineIn", "Pickup"],
  };
  const latest = {
    ...current,
    configurationReference: id(21),
    configurationVersion: 2,
    lifecycle: "Draft",
    supersedesConfigurationReference: current.configurationReference,
    reasonCode: "STORE_HOURS_UPDATE",
    authoredByReference: id(40),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
  };
  let declined = false;
  const withdrawals: Record<string, unknown>[] = [];
  await page.route("**/merchant/store-configuration", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "STORE-HOURS-SERVICE",
        storeReference: store,
        current,
        latest,
        expectedVersion: 2,
        observedAt: new Date(Date.now() - 1000).toISOString(),
        viewerActorReference: id(10),
        latestWithdrawal: declined
          ? {
              kind: "Declined",
              withdrawnAt: new Date().toISOString(),
              byYou: true,
              reason: "NotRight",
            }
          : null,
        latestAuthorName: "Mia Chen",
        soleOperator: null,
        // v15 D9: this reader holds Store configuration approval, so may decline.
        viewerMayDecline: true,
      },
    }),
  );
  await page.route("**/merchant/store-configuration/withdrawal", async (route) => {
    withdrawals.push(route.request().postDataJSON() as Record<string, unknown>);
    declined = true;
    await route.fulfill({ headers, json: { status: "Applied", kind: "Declined" } });
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const editor = page.getByRole("region", { name: "Operating hours draft" });
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await expect(editor.getByText("Mia Chen’s change (version 2", { exact: false })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Validate saved draft" })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Submit saved draft" })).toBeDisabled();
  await editor.getByRole("button", { name: "Decline this change" }).click();
  // Nothing is sent until the decline is confirmed.
  expect(withdrawals).toHaveLength(0);
  const confirm = editor.getByRole("group", { name: "Decline this change" });
  await expectHoursLayout(page, "store-hours-decline-confirm");
  await confirm.getByLabel("Reason (optional)").selectOption("NotRight");
  await confirm.getByRole("button", { name: "Decline version 2" }).click();
  await expect(editor.getByText("The change was declined.", { exact: false })).toBeVisible();
  expect(withdrawals).toHaveLength(1);
  expect(withdrawals[0]?.declineReason).toBe("NotRight");
  await expect(editor.getByText("(Something in it is not right)", { exact: false })).toBeVisible();
  await expectNoInternalText(page);
});
