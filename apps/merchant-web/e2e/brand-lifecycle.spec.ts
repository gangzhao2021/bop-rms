import { expect, test, type Page, type Route } from "@playwright/test";
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  brand = id(1),
  actor = id(2),
  href = `/app/organization/brands/${brand}`,
  prefix = "/merchant/organization/brands";
const reply = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
// Controlled owner HTTP packets, synthetic challenge origin and actual browser
// IndexedDB/App. Genuine Session/IAM/Tenant/Audit/COMMIT behavior is separate native evidence.
async function backend(page: Page) {
  const state = {
    lifecycle: "Draft",
    version: 1,
    currentActor: actor,
    csrf: "c".repeat(43),
    mfa: false,
    deny: false,
    loseReply: false,
    requests: [] as Record<string, unknown>[],
    receipts: new Map<string, Record<string, unknown>>(),
    writes: 0,
    rotations: 0,
    holdReply: false,
    release: (() => undefined) as () => void,
  };
  await page.route("**/merchant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === prefix + "/session")
      return reply(route, {
        authenticated: true,
        csrf: state.csrf,
        recentMfaRequired: state.mfa,
        workspace: state.mfa
          ? null
          : {
              profile: "BrandAdministrationWorkspaceV1",
              selectedScope: {
                tenantReference: brand,
                brandReference: brand,
                actorReference: state.currentActor,
              },
              brand: {
                brandReference: brand,
                label: "Synthetic lifecycle Brand",
                lifecycle: state.lifecycle,
                version: state.version,
              },
              navigation: [
                {
                  screenId: "ORG-BRAND-DETAIL",
                  label: "Brand",
                  href,
                  permission: "organization.manage",
                },
              ],
            },
      });
    if (path === prefix + "/session/rotate") {
      state.rotations++;
      return reply(route, {
        status: "step_up_required",
        authorizationUrl: "https://identity.example.test/fresh-lifecycle",
      });
    }
    if (path === prefix + "/lifecycle") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.requests.push(body);
      expect(Object.keys(body).sort()).toEqual([
        "action",
        "brandReference",
        "expectedBrandVersion",
        "operationReference",
      ]);
      expect(route.request().headers()["x-bop-csrf"]).toBe(state.csrf);
      if (state.deny) return reply(route, { error: "request_denied" }, 403);
      const key = String(body.operationReference),
        prior = state.receipts.get(key);
      if (prior) return reply(route, { ...prior, status: "AlreadyApplied" });
      if (body.expectedBrandVersion !== state.version)
        return reply(route, { error: "brand_lifecycle_conflict" }, 409);
      state.version++;
      state.lifecycle = body.action === "ActivateBrand" ? "Active" : "Archived";
      state.writes++;
      const receipt = {
        profile: "MerchantBrandLifecycleReceiptV1",
        actorReference: state.currentActor,
        brandReference: brand,
        action: body.action,
        operationReference: key,
        expectedBrandVersion: body.expectedBrandVersion,
        status: "Applied",
        lifecycle: state.lifecycle,
        version: state.version,
        occurredAt: await page.evaluate(() => new Date().toISOString()),
      };
      state.receipts.set(key, receipt);
      if (state.holdReply)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (state.loseReply) {
        state.loseReply = false;
        return route.abort("failed");
      }
      return reply(route, receipt);
    }
    return reply(route, {}, 503);
  });
  await page.route("https://identity.example.test/fresh-lifecycle", (route) => {
    state.mfa = false;
    state.csrf = "d".repeat(43);
    return route.fulfill({ status: 302, headers: { location: "http://127.0.0.1:4173" + href } });
  });
  return state;
}
const panel = (page: Page) => page.getByRole("region", { name: "Brand lifecycle" });
async function confirm(page: Page, action: "Activate" | "Archive") {
  await panel(page)
    .getByRole("button", { name: `${action} Brand`, exact: true })
    .click();
  const check = panel(page).getByRole("checkbox", {
    name: `I confirm ${action === "Activate" ? "activating" : "archiving"} Synthetic lifecycle Brand.`,
  });
  await expect(check).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: `Confirm ${action} Brand`, exact: true }),
  ).toBeDisabled();
  await check.locator("..").click();
  await panel(page)
    .getByRole("button", { name: `Confirm ${action} Brand`, exact: true })
    .click();
}
async function originals(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-brand-lifecycle-pending-v1", 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            read = tx.objectStore("originals").getAll();
          read.onsuccess = () => resolve(read.result);
          tx.oncomplete = () => db.close();
        };
        open.onerror = () => reject(new Error("controlled IDB read"));
      }),
  );
}
test("@production explicit lifecycle confirmation changes real current status with keyboard and text reflow", async ({
  page,
}) => {
  const state = await backend(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.goto(href);
  await expect(
    panel(page).getByRole("button", { name: "Activate Brand", exact: true }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Activate Brand", exact: true }).click();
  const checkbox = panel(page).getByRole("checkbox", {
    name: "I confirm activating Synthetic lifecycle Brand.",
  });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.getByRole("button", { name: "Confirm Activate Brand", exact: true }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("brand-lifecycle-confirmation-1440", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await checkbox.boundingBox())?.width).toBe(20);
    expect(
      (
        await page
          .getByRole("button", { name: "Confirm Activate Brand", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("brand-lifecycle-confirmation-320-text200", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Confirm Activate Brand", exact: true }).click();
  await expect(page.getByText("Brand status: Active", { exact: true })).toBeVisible();
  expect(state.writes).toBe(1);
  expect(await originals(page)).toEqual([]);
  await confirm(page, "Archive");
  await expect(page.getByText("Brand status: Archived", { exact: true })).toBeVisible();
  expect(state.writes).toBe(2);
  await expect(
    panel(page).getByRole("button", { name: "Activate Brand", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(actor);
  expect(errors).toEqual([]);
});
test("@production lifecycle lost reply survives reload and historical replay refreshes advanced current status", async ({
  page,
}) => {
  const state = await backend(page);
  state.loseReply = true;
  await page.goto(href);
  await confirm(page, "Activate");
  await expect(
    panel(page).getByRole("button", { name: "Retry original lifecycle request" }),
  ).toBeEnabled();
  const retained = await originals(page);
  expect(retained).toHaveLength(1);
  expect(JSON.stringify(retained)).not.toContain("csrf");
  state.lifecycle = "Archived";
  state.version = 3;
  await page.reload();
  await expect(page.getByText("Brand status: Archived", { exact: true })).toBeVisible();
  await panel(page).getByRole("button", { name: "Retry original lifecycle request" }).click();
  await expect.poll(() => originals(page)).toEqual([]);
  await expect(page.getByText("Brand status: Archived", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]);
  expect(state.writes).toBe(1);
});
test("@production lifecycle denied original waits for fresh challenge and retries identical command", async ({
  page,
}) => {
  const state = await backend(page);
  state.deny = true;
  await page.goto(href);
  await confirm(page, "Activate");
  await expect(
    panel(page).getByText(
      "Current authority or recent verification is required. Refresh or renew your session, then retry the saved original.",
    ),
  ).toBeVisible();
  expect(await originals(page)).toHaveLength(1);
  state.mfa = true;
  await page.getByRole("button", { name: "Refresh Brand access", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  state.deny = false;
  await page.getByRole("button", { name: "Verify identity", exact: true }).click();
  await expect(
    panel(page).getByRole("button", { name: "Retry original lifecycle request" }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Retry original lifecycle request" }).click();
  await expect(page.getByText("Brand status: Active", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]);
  expect(state.rotations).toBe(1);
});
test("@production authoritative stale CAS releases only original then fresh status permits new explicit action", async ({
  page,
}) => {
  const state = await backend(page);
  await page.goto(href);
  await expect(
    panel(page).getByRole("button", { name: "Activate Brand", exact: true }),
  ).toBeEnabled();
  state.lifecycle = "Suspended";
  state.version = 2;
  await confirm(page, "Activate");
  await expect(page.getByText("Brand status: Suspended", { exact: true })).toBeVisible();
  expect(await originals(page)).toEqual([]);
  expect(state.writes).toBe(0);
  await confirm(page, "Activate");
  await expect(page.getByText("Brand status: Active", { exact: true })).toBeVisible();
  expect(state.requests[1]?.operationReference).not.toBe(state.requests[0]?.operationReference);
  expect(state.requests[1]?.expectedBrandVersion).toBe(2);
});
test("@production offline and late Actor scope cannot clear or replace the saved original", async ({
  page,
  context,
}) => {
  const state = await backend(page);
  state.holdReply = true;
  await page.goto(href);
  await confirm(page, "Activate");
  await expect.poll(() => state.writes).toBe(1);
  await context.setOffline(true);
  expect(await originals(page)).toHaveLength(1);
  await context.setOffline(false);
  state.currentActor = id(9);
  await page.getByRole("button", { name: "Refresh Brand access", exact: true }).click();
  state.release();
  await expect(page.getByText("Brand status: Active", { exact: true })).toBeVisible();
  expect(await originals(page)).toHaveLength(1);
  expect(state.requests).toHaveLength(1);
  await expect(
    panel(page).getByRole("button", { name: "Retry original lifecycle request" }),
  ).toHaveCount(0);
});
