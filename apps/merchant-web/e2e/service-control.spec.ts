import { expect, test } from "@playwright/test";
test("@production service controls retry uncertain writes and recover from version conflict", async ({
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
  let version = 0;
  let pause: {
    closureReference: string;
    effectiveFrom: string;
    effectiveUntil: string;
    serviceModes: null;
  } | null = null;
  const requests: string[] = [];
  await page.route("**/merchant/service-control", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        headers,
        json: {
          hours: {
            configurationSource: "StoreOverride",
            effectiveFrom: "2026-07-01T00:00:00.000Z",
            effectiveUntil: null,
            businessDayStartLocalTime: "04:00:00",
            weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
              isoWeekday: index + 1,
              intervals: [],
            })),
            exceptions: [],
          },
          screenId: "STORE-HOURS-SERVICE",
          storeReference: store,
          configurationReference: store,
          timeZone: "America/Toronto",
          enabledServiceModes: ["DineIn", "Pickup"],
          observedAt: new Date().toISOString(),
          expectedVersion: version,
          activePauses: pause ? [pause] : [],
        },
      });
      return;
    }
    requests.push(route.request().postData() ?? "");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    const body = route.request().postDataJSON();
    expect(body.actorReference).toBeUndefined();
    expect(body.storeReference).toBeUndefined();
    if (requests.length === 1) {
      version = 1;
      pause = {
        closureReference: body.operationReference,
        effectiveFrom: new Date().toISOString(),
        effectiveUntil: body.content.effectiveUntil,
        serviceModes: null,
      };
      await route.abort("failed");
    } else if (requests.length === 2) {
      expect(requests[1]).toBe(requests[0]);
      await route.fulfill({ headers, json: { status: "AlreadyApplied", resultingVersion: 1 } });
    } else if (requests.length === 3) {
      expect(body.command).toBe("ResumeService");
      expect(body.content.pauseOperationReference).toBe(pause?.closureReference);
      expect(body.expectedVersion).toBe(1);
      version = 2;
      pause = null;
      await route.fulfill({ headers, json: { status: "Applied", resultingVersion: 2 } });
    } else {
      await route.fulfill({ status: 409, headers, json: { error: "service_control_conflict" } });
    }
  });
  await page.goto("/app/organization/stores/" + store + "/service");
  const panel = page.getByRole("region", { name: "Service controls" });
  await expect(panel.getByText("No active pauses.")).toBeVisible();
  await panel.getByLabel("Pause duration (minutes)").fill("15");
  await panel.getByRole("button", { name: "Pause service", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry same request" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pause service", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Retry same request" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: "Resume all services" })).toBeVisible();
  await panel.getByRole("button", { name: "Resume all services" }).click();
  await expect(panel.getByText("No active pauses.")).toBeVisible();
  await panel.getByRole("button", { name: "Pause service", exact: true }).click();
  await expect(panel.getByText("Source changed. Refresh before trying again.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pause service", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Refresh service status" }).click();
  await expect(panel.getByText("No active pauses.")).toBeVisible();
  expect(requests).toHaveLength(4);
});
