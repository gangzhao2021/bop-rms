import { expect, test, type Page, type Route } from "@playwright/test";
import {
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceRegisteredIdentity,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceResolve,
} from "../../../packages/rms/catalog/src/contracts/brand-catalog-source.js";

const id = (n: number) => `018f9e90-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(1),
  actor = id(2),
  href = `/app/organization/brands/${brand}`;
const scope = { tenantReference: brand, brandReference: brand, actorReference: actor };
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  await expect(
    page.locator(".vite-error-overlay, vite-error-overlay, [data-nextjs-dialog]"),
  ).toHaveCount(0);
});
const prefix = "/merchant/organization/brands",
  database = "bop-brand-catalog-source-pending-v1";
const response = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
async function backend(page: Page) {
  const state = {
    csrf: "c".repeat(43),
    lifecycle: "Active",
    denied: false,
    signedOut: false,
    recentMfaRequired: false,
    logoutUnknown: false,
    logoutNetworkUnknown: false,
    logouts: 0,
    bootstraps: 0,
    wrongActor: false,
    wrongBrand: false,
    loseRegisterReply: false,
    failBeforeRegister: false,
    registers: 0,
    resolves: 0,
    rotations: 0,
    stores: 0,
  };
  let source: ReturnType<typeof parseBrandCatalogSourceRegisteredIdentity> | null = null,
    sequence = 10;
  const operations = new Map<string, ReturnType<typeof parseBrandCatalogSourceReceipt>>();
  const current = () => {
    const observedAt = new Date().toISOString();
    return {
      profile: "BrandCatalogSourceCurrentV1",
      ...scope,
      source,
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    };
  };
  // Controlled browser Provider navigation only; real crypto/Session native
  // evidence is owned separately. No Provider authentication verdict is claimed.
  let origin = "";
  await page.route("https://identity.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/authorize") {
      state.csrf = "n".repeat(43);
      state.recentMfaRequired = false;
    } else if (url.pathname !== "/logout") return route.abort();
    return route.fulfill({ status: 302, headers: { location: origin + href } });
  });
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    origin = new URL(request.url()).origin;
    if (path === "/merchant/session") {
      state.stores++;
      return response(route, { error: "request_denied" }, 403);
    }
    if (path === prefix + "/session") {
      state.bootstraps++;
      if (state.denied || state.signedOut) return response(route, { error: "request_denied" }, 403);
      const selectedBrand = state.wrongBrand ? id(9) : brand;
      return response(route, {
        authenticated: true,
        csrf: state.csrf,
        recentMfaRequired: state.recentMfaRequired,
        workspace: state.recentMfaRequired
          ? null
          : {
              profile: "BrandAdministrationWorkspaceV1",
              selectedScope: {
                tenantReference: selectedBrand,
                brandReference: selectedBrand,
                actorReference: state.wrongActor ? id(8) : actor,
              },
              brand: {
                brandReference: selectedBrand,
                label: "Synthetic noStore Brand",
                lifecycle: state.lifecycle,
                version: 7,
              },
              navigation: [
                {
                  screenId: "ORG-BRAND-DETAIL",
                  label: "Brand",
                  href: `/app/organization/brands/${selectedBrand}`,
                  permission: "organization.manage",
                },
              ],
            },
      });
    }
    if (!path.startsWith(prefix + "/")) return route.abort();
    if (
      state.denied ||
      (state.signedOut && path !== prefix + "/session/logout") ||
      request.method() !== "POST" ||
      request.headers()["x-bop-csrf"] !== state.csrf
    )
      return response(route, { error: "request_denied" }, 403);
    const body = request.postDataJSON() as Record<string, unknown>;
    if (path === prefix + "/session/rotate") {
      expect(body).toEqual({});
      state.rotations++;
      return response(route, {
        status: "step_up_required",
        authorizationUrl: "https://identity.invalid/authorize?controlled=1",
      });
    }
    if (path === prefix + "/session/logout") {
      expect(body).toEqual({});
      state.signedOut = true;
      state.logouts++;
      if (state.logoutNetworkUnknown) {
        state.logoutNetworkUnknown = false;
        return route.abort("failed");
      }
      return response(
        route,
        state.logoutUnknown
          ? { status: "logout_unknown" }
          : {
              status: "browser_logout_required",
              logoutUrl: "https://identity.invalid/logout?controlled=1",
            },
      );
    }
    if (body.brandReference !== brand) return response(route, { error: "request_denied" }, 403);
    // Draft command composition is still separate work; management admission
    // never supplies a Catalog or Publishing grant in this rendered fixture.
    if (state.lifecycle !== "Active") return response(route, { error: "request_denied" }, 403);
    if (path === prefix + "/configuration/current") {
      const observedAt = new Date().toISOString();
      return response(route, {
        profile: "TenantBrandConfigurationCurrentV1",
        ...scope,
        current: null,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        currentPublication: "NotEvaluated",
        recordedReview: null,
      });
    }
    if (path === prefix + "/configuration/history") {
      const observedAt = new Date().toISOString();
      expect(body).toEqual({ brandReference: brand, beforeRevision: null });
      return response(route, {
        profile: "TenantBrandConfigurationHistoryV1",
        ...scope,
        beforeRevision: null,
        entries: [],
        nextBeforeRevision: null,
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        currentPublication: "NotEvaluated",
      });
    }
    if (path === prefix + "/catalog-source/current") {
      expect(body).toEqual({ brandReference: brand });
      return response(route, current());
    }
    if (path === prefix + "/catalog-source/exact") {
      expect(Object.keys(body).sort()).toEqual(["brandReference", "sourceReference"]);
      const found = current();
      return response(route, {
        ...found,
        profile: "BrandCatalogSourceExactV1",
        source: body.sourceReference === source?.sourceReference ? source : null,
        requestedSourceReference: body.sourceReference,
      });
    }
    if (path === prefix + "/catalog-source/register") {
      expect(Object.keys(body).sort()).toEqual(["brandReference", "command"]);
      const wire = body.command as Record<string, unknown>;
      expect(Object.keys(wire).sort()).toEqual(["code", "label", "operationReference"]);
      state.registers++;
      if (state.failBeforeRegister) {
        state.failBeforeRegister = false;
        return route.abort("failed");
      }
      const command = parseBrandCatalogSourceRegister({
          profile: "BrandCatalogSourceRegisterV1",
          ...scope,
          ...wire,
        }),
        intentDigest = brandCatalogSourceIntentDigest(command),
        prior = operations.get(command.operationReference);
      if (prior) return response(route, prior);
      if (source) return response(route, { error: "brand_configuration_conflict" }, 409);
      const occurredAt = new Date().toISOString(),
        auditReference = id(sequence++);
      source = parseBrandCatalogSourceRegisteredIdentity({
        profile: "BrandCatalogSourceRegisteredIdentityV1",
        tenantReference: brand,
        brandReference: brand,
        sourceReference: id(sequence++),
        code: command.code,
        label: command.label,
        registeredByReference: actor,
        operationReference: command.operationReference,
        auditReference,
        registeredAt: occurredAt,
        dataClassification: "ConfigurationMetadata",
      });
      const receipt = parseBrandCatalogSourceReceipt({
        profile: "BrandCatalogSourceReceiptV1",
        ...scope,
        operationReference: command.operationReference,
        intentDigest,
        outcome: "Committed",
        originalCommand: command,
        source,
        auditReference,
        occurredAt,
      });
      operations.set(command.operationReference, receipt);
      if (state.loseRegisterReply) {
        state.loseRegisterReply = false;
        return route.abort("failed");
      }
      return response(route, receipt);
    }
    if (path === prefix + "/catalog-source/resolve") {
      expect(Object.keys(body).sort()).toEqual(["brandReference", "original"]);
      const wire = body.original as Record<string, unknown>;
      expect(Object.keys(wire).sort()).toEqual(["intentDigest", "operationReference"]);
      const original = parseBrandCatalogSourceResolve({
        profile: "BrandCatalogSourceResolveV1",
        ...scope,
        ...wire,
      });
      state.resolves++;
      let receipt = operations.get(original.operationReference);
      if (!receipt) {
        receipt = parseBrandCatalogSourceReceipt({
          profile: "BrandCatalogSourceReceiptV1",
          ...scope,
          operationReference: original.operationReference,
          intentDigest: original.intentDigest,
          outcome: "Abandoned",
          originalCommand: null,
          source: null,
          auditReference: id(sequence++),
          occurredAt: new Date().toISOString(),
        });
        operations.set(original.operationReference, receipt);
      }
      expect(receipt.intentDigest).toBe(original.intentDigest);
      return response(route, receipt);
    }
    return response(route, { error: "brand_administration_unavailable" }, 503);
  });
  return state;
}
async function originals(page: Page) {
  return page.evaluate(
    async (name) =>
      await new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(new Error("Synthetic journal unavailable"));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("originals")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          tx.oncomplete = () => {
            const result: unknown[] = request.result;
            db.close();
            resolve(result);
          };
          tx.onerror = () => {
            db.close();
            reject(new Error("Synthetic journal failed"));
          };
        };
      }),
    database,
  );
}
async function enter(page: Page) {
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Synthetic noStore Brand", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No catalogue source is registered.", { exact: true })).toBeVisible();
}
async function register(page: Page) {
  await page.getByLabel("Catalogue code", { exact: true }).fill("MAIN");
  await page.getByLabel("Catalogue label", { exact: true }).fill("Synthetic catalogue");
  await page.getByRole("button", { name: "Refresh catalogue source", exact: true }).click();
  await page.getByRole("button", { name: "Register catalogue source", exact: true }).click();
}
test("@production Brand catalogue registration works without an authorized Store and survives Session renewal", async ({
  page,
}) => {
  const state = await backend(page);
  await enter(page);
  await register(page);
  await expect(
    page.getByText("Catalogue source registered and confirmed.", { exact: true }),
  ).toBeVisible();
  expect(state.registers).toBe(1);
  expect(await originals(page)).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("brand-catalog-registered.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Renew session", exact: true }).click();
  await expect(page.getByText("Registered identity", { exact: true })).toBeVisible();
  expect(state.rotations).toBe(1);
  await expect(page.locator("body")).not.toContainText(brand);
  await expect(page.locator("body")).not.toContainText(actor);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in securely", exact: true })).toHaveAttribute(
    "href",
    prefix + "/login",
  );
});
test("@production lost catalogue reply remains payload-free across reload and denied original recovery", async ({
  page,
}) => {
  const state = await backend(page);
  state.loseRegisterReply = true;
  await enter(page);
  await register(page);
  await expect(
    page.getByText(
      "A registration request is pending. Recover its original result before registering again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recover registration", exact: true }),
  ).toBeEnabled();
  const retained = await originals(page);
  expect(retained).toHaveLength(1);
  expect(JSON.stringify(retained)).not.toMatch(/Synthetic catalogue|MAIN|csrf|configuration/u);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recover registration", exact: true }),
  ).toBeEnabled();
  state.denied = true;
  await page.getByRole("button", { name: "Recover registration", exact: true }).click();
  await expect(
    page.getByText(
      "Current access refused this request. Restore access before recovering the original.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await originals(page)).toEqual(retained);
  state.denied = false;
  await page.getByRole("button", { name: "Recover registration", exact: true }).click();
  await expect(
    page.getByText("Catalogue source registered and confirmed.", { exact: true }),
  ).toBeVisible();
  expect(state.registers).toBe(1);
  expect(state.resolves).toBe(1);
  expect(await originals(page)).toEqual([]);
});
test("@production catalogue unknown before commit resolves Abandoned and permits a deliberate new registration", async ({
  page,
}) => {
  const state = await backend(page);
  state.failBeforeRegister = true;
  await enter(page);
  await register(page);
  await expect(
    page.getByRole("button", { name: "Recover registration", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Recover registration", exact: true }).click();
  await expect(
    page.getByText(
      "The original request was abandoned. You may refresh and register a new source.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await originals(page)).toEqual([]);
  await register(page);
  await expect(
    page.getByText("Catalogue source registered and confirmed.", { exact: true }),
  ).toBeVisible();
  expect(state.registers).toBe(2);
});
test("@production wrong Brand is refused; restored access reflows at 320px and offline disables business controls", async ({
  page,
}) => {
  const state = await backend(page);
  state.wrongBrand = true;
  await page.goto(href);
  await expect(page.getByText("Brand access changed", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toHaveCount(0);
  state.wrongBrand = false;
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("button", { name: "Refresh Brand access", exact: true }).click();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("brand-administration-320.png"),
    fullPage: true,
  });
  await page.getByLabel("Catalogue code", { exact: true }).focus();
  await page.keyboard.type("MAIN");
  await expect(page.getByLabel("Catalogue code", { exact: true })).toHaveValue("MAIN");
  await page.context().setOffline(true);
  await expect(page.getByText("Offline read-only", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Register catalogue source", exact: true }),
  ).toHaveCount(0);
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "Refresh Brand access", exact: true }).click();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toBeVisible();
  expect(state.registers).toBe(0);
});

test("@production Draft Brand management keeps its real lifecycle through renewal without granting business commands", async ({
  page,
}) => {
  const state = await backend(page);
  state.lifecycle = "Draft";
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Synthetic noStore Brand", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Brand status: Draft", { exact: true })).toBeVisible();
  // App independently probes Store access for optional topology. Its refusal
  // does not prevent this administrative page or create a Store selection.
  const storeProbes = state.stores;
  await expect(
    page.getByRole("button", { name: "Register catalogue source", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Renew session", exact: true }).click();
  await expect(page.getByText("Brand status: Draft", { exact: true })).toBeVisible();
  expect(state.rotations).toBe(1);
  expect(state.registers).toBe(0);
  // Real Provider return reloads App once, which repeats its independent denied Store probe.
  await expect.poll(() => state.stores).toBe(storeProbes + 1);
  await expect(page.locator("body")).not.toContainText("Brand status: Active");
  await expect(page.locator("body")).not.toContainText(brand);
  await expect(page.locator("body")).not.toContainText(actor);
  await test.info().attach("draft-brand-management", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in securely", exact: true })).toBeVisible();
});

test("@production expired MFA hides business controls until the controlled fresh challenge returns", async ({
  page,
}) => {
  const state = await backend(page);
  state.recentMfaRequired = true;
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Verify your identity", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh Brand access", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Verify identity", exact: true }).click();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toBeVisible();
  expect(state.rotations).toBe(1);
  expect(state.csrf).toBe("n".repeat(43));
  expect(state.registers).toBe(0);
});
test("@production unknown logout hides business state and retries original CSRF without bootstrap", async ({
  page,
}) => {
  const state = await backend(page);
  await enter(page);
  state.logoutUnknown = true;
  const before = state.bootstraps;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign-out result unknown", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Catalogue code", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh Brand access", exact: true })).toHaveCount(
    0,
  );
  expect(state.bootstraps).toBe(before);
  state.logoutUnknown = false;
  await page.getByRole("button", { name: "Retry sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in securely", exact: true })).toBeVisible();
  expect(state.logouts).toBe(2);
  expect(state.registers).toBe(0);
});
test("@production lost logout reply retains retry authority only in memory", async ({ page }) => {
  const state = await backend(page);
  await enter(page);
  state.logoutNetworkUnknown = true;
  const before = state.bootstraps;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry sign out", exact: true })).toBeVisible();
  expect(state.bootstraps).toBe(before);
  await expect(page.getByLabel("Catalogue code", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in securely", exact: true })).toBeVisible();
  expect(state.logouts).toBe(2);
});
