import { expect, test } from "@playwright/test";
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
    expect(body.configuration.businessDayStartLocalTime).toBe("05:00:00");
    expect(body.configuration.effectiveUntil).toBe("2026-12-31T23:59:00.000Z");
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
  await editor.getByLabel("Business day starts").fill("05:00");
  await editor.getByLabel("Effective until (UTC, optional)").fill("2026-12-31T23:59");
  await editor.getByRole("button", { name: "Add dated exception" }).click();
  const exception = editor.getByRole("group", { name: "Exception 1", exact: true });
  await exception.getByLabel("Exception date").fill("2026-12-25");
  await exception.getByRole("button", { name: "Add exception interval" }).click();
  await exception.getByLabel("Start 1", { exact: true }).fill("10:00");
  await exception.getByLabel("DineIn", { exact: true }).uncheck();

  await editor.getByRole("button", { name: "Save hours draft" }).click();
  await expect(editor.getByRole("button", { name: "Retry configuration request" })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save hours draft" })).toBeDisabled();
  await editor.getByRole("button", { name: "Retry configuration request" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    editor.getByText("Draft saved. It takes effect only after approval and publication."),
  ).toBeVisible();
  await expect(editor.getByText("Published version: 1 · Latest version: 2")).toBeVisible();
  await page.reload();
  await editor.getByRole("button", { name: "Edit operating hours" }).click();
  await expect(editor.getByLabel("Business day starts")).toHaveValue("05:00");
  expect(requests).toHaveLength(2);
});
