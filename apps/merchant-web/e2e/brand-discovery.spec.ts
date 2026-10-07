import { expect, test, type Page, type Route } from "@playwright/test";
const id = (n: number) => `018f9e90-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  actor = id(1),
  brand = id(2),
  other = id(3),
  prefix = "/merchant/organization/brands";
const reply = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
// Controlled HTTP owner packets exercise the production App; actual PG/IAM/Provider sources are covered separately.
async function backend(page: Page) {
  const state = {
    authenticated: true,
    mfa: false,
    selected: null as string | null,
    csrf: "c".repeat(43),
    currentActor: actor,
    empty: false,
    scanned: false,
    loseChoice: false,
    conflict: false,
    choices: 0,
    rotations: 0,
    lists: 0,
    sessionReads: 0,
  };
  await page.route("**/merchant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === prefix + "/discovery/session") {
      state.sessionReads++;
      return reply(
        route,
        state.authenticated
          ? {
              authenticated: true,
              csrf: state.csrf,
              recentMfaRequired: state.mfa,
              actorReference: state.currentActor,
              selectedBrandReference: state.selected,
            }
          : {},
        state.authenticated ? 200 : 403,
      );
    }
    if (path === prefix + "/discovery/list") {
      state.lists++;
      expect(route.request().headers()["x-bop-csrf"]).toBe(state.csrf);
      const body = route.request().postDataJSON() as { afterBrandReference: string | null };
      expect(Object.keys(body)).toEqual(["afterBrandReference"]);
      const first = body.afterBrandReference === null,
        at = await page.evaluate(() => new Date().toISOString());
      return reply(route, {
        profile: "MerchantBrandDiscoveryV1",
        actorReference: state.currentActor,
        afterBrandReference: body.afterBrandReference,
        items:
          state.empty || (first && state.scanned)
            ? []
            : [
                {
                  brandReference: first ? brand : other,
                  code: first ? "FIRST-BRAND" : "SECOND-BRAND",
                  displayName: first ? "First synthetic Brand" : "Second synthetic Brand",
                  lifecycle: "Draft",
                  defaultLocale: "en-CA",
                  version: 1,
                },
              ],
        hasMore: first && state.scanned,
        nextAfterBrandReference: first && state.scanned ? brand : null,
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      });
    }
    if (path === prefix + "/discovery/select") {
      state.choices++;
      const body = route.request().postDataJSON() as {
        brandReference: string;
        expectedSelectedBrandReference: string | null;
      };
      expect(Object.keys(body).sort()).toEqual([
        "brandReference",
        "expectedSelectedBrandReference",
      ]);
      expect(route.request().headers()["x-bop-csrf"]).toBe(state.csrf);
      if (state.conflict) return reply(route, {}, 409);
      state.selected = body.brandReference;
      if (state.loseChoice) {
        state.loseChoice = false;
        return route.abort("failed");
      }
      return reply(route, {
        actorReference: state.currentActor,
        brandReference: body.brandReference,
        href: `/app/organization/brands/${body.brandReference}`,
      });
    }
    if (path === prefix + "/session/rotate") {
      state.rotations++;
      return reply(route, {
        status: "step_up_required",
        authorizationUrl: "https://identity.example.test/authorize",
      });
    }
    if (path === prefix + "/session") {
      return reply(route, {
        authenticated: true,
        csrf: state.csrf,
        recentMfaRequired: false,
        workspace: {
          profile: "BrandAdministrationWorkspaceV1",
          selectedScope: {
            tenantReference: state.selected,
            brandReference: state.selected,
            actorReference: state.currentActor,
          },
          brand: {
            brandReference: state.selected,
            label: "Selected synthetic Brand",
            lifecycle: "Draft",
            version: 1,
          },
          navigation: [
            {
              screenId: "ORG-BRAND-DETAIL",
              label: "Brand",
              href: `/app/organization/brands/${state.selected}`,
              permission: "organization.manage",
            },
          ],
        },
      });
    }
    return reply(route, {}, 503);
  });
  await page.route("https://identity.example.test/authorize", (route) => {
    state.selected = null;
    state.mfa = false;
    state.conflict = false;
    state.csrf = "d".repeat(43);
    return route.fulfill({
      status: 302,
      headers: { location: "http://127.0.0.1:4173/app/organization/brands" },
    });
  });
  return state;
}
test("@production discovery explicit choice reaches actual detail without a Store", async ({
  page,
}) => {
  const state = await backend(page);
  await page.goto("/app/organization/brands");
  await expect(page.getByRole("button", { name: "Choose First synthetic Brand" })).toBeVisible();
  await page.getByRole("button", { name: "Choose First synthetic Brand" }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("brand-discovery-list-1440", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Choose First synthetic Brand" }).click();
  await expect(page).toHaveURL(`/app/organization/brands/${brand}`);
  await expect(
    page.getByRole("heading", { name: "Selected synthetic Brand", exact: true }),
  ).toBeVisible();
  expect(state.choices).toBe(1);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Refresh Brand access", exact: true }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await test.info().attach("brand-discovery-selected-detail-320-200-percent", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
test("@production discovery login MFA empty and scanned empty pages remain truthful", async ({
  page,
}) => {
  const state = await backend(page);
  state.authenticated = false;
  await page.goto("/app/organization/brands");
  await expect(page.getByRole("link", { name: "Sign in securely" })).toHaveAttribute(
    "href",
    prefix + "/login",
  );
  state.authenticated = true;
  state.mfa = true;
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(
    page.getByText("Recent verification is required before choosing a Brand."),
  ).toBeVisible();
  expect(state.lists).toBe(0);
  state.mfa = false;
  state.scanned = true;
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(page.getByRole("heading", { name: "No Brands on this page" })).toBeVisible();
  await page.getByRole("button", { name: "More Brands" }).click();
  await expect(page.getByRole("button", { name: "Choose Second synthetic Brand" })).toBeVisible();
  state.empty = true;
  state.scanned = false;
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(page.getByRole("button", { name: "More Brands" })).toHaveCount(0);
});
test("@production discovery unknown choice recovers actual selection before navigating", async ({
  page,
}) => {
  const state = await backend(page);
  state.loseChoice = true;
  await page.goto("/app/organization/brands");
  await page.getByRole("button", { name: "Choose First synthetic Brand" }).click();
  await expect(
    page.getByText("Selection result unknown. Refresh to recover the actual session selection."),
  ).toBeVisible();
  await expect(page).toHaveURL("/app/organization/brands");
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(page).toHaveURL(`/app/organization/brands/${brand}`);
  expect(state.choices).toBe(1);
});
test("@production discovery conflict requires genuine challenge and new selection", async ({
  page,
}) => {
  const state = await backend(page);
  state.selected = other;
  state.conflict = true;
  await page.goto("/app/organization/brands");
  await page.getByRole("button", { name: "Choose First synthetic Brand" }).click();
  await expect(
    page.getByText(
      "This session already has a different Brand selection. Renew your session to choose again.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Renew session" }).click();
  await expect(page.getByRole("button", { name: "Choose First synthetic Brand" })).toBeVisible();
  await page.getByRole("button", { name: "Choose First synthetic Brand" }).click();
  await expect(page).toHaveURL(`/app/organization/brands/${brand}`);
  expect(state.rotations).toBe(1);
});
test("@production discovery stale, offline and account changes fence choices", async ({
  page,
  context,
}) => {
  const state = await backend(page);
  await page.clock.install();
  await page.goto("/app/organization/brands");
  const choice = page.getByRole("button", { name: "Choose First synthetic Brand" });
  await expect(choice).toBeEnabled();
  await page.clock.fastForward(6000);
  await expect(choice).toBeDisabled();
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(choice).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText("Offline. Reconnect and refresh before choosing.")).toBeVisible();
  await context.setOffline(false);
  state.currentActor = id(8);
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(page.getByRole("button", { name: "Choose First synthetic Brand" })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh Brands" }).click();
  await expect(choice).toBeEnabled();
  expect(state.choices).toBe(0);
});
test("@production discovery keyboard targets and 320 390 1440 text reflow expose no secret text", async ({
  page,
}) => {
  await backend(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.goto("/app/organization/brands");
  const choice = page.getByRole("button", { name: "Choose First synthetic Brand" });
  await expect(choice).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await choice.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await choice.focus();
  await expect(choice).toBeFocused();
  await expect(page.locator("body")).not.toContainText(actor);
  await expect(page.locator("body")).not.toContainText("c".repeat(43));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/app/organization/brands/${brand}`);
  expect(errors).toEqual([]);
});

const invitationOrigin = "https://merchant.example.test",
  invitationEntry = invitationOrigin + "/app/organization/brands",
  invitationSecret = "i".repeat(43),
  invitationProvider = "https://identity.example.test/oauth2/authorize";
function invitationAuthorizationUrl() {
  const url = new URL(invitationProvider);
  const parameters = {
    client_id: "controlledclient",
    redirect_uri: invitationOrigin + prefix + "/callback",
    response_type: "code",
    scope: "openid",
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    code_challenge: "k".repeat(43),
    code_challenge_method: "S256",
    identity_provider: "COGNITO",
    prompt: "login",
    max_age: "0",
    acr_values: "urn:cognito:loa:4",
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}
/** Unchanged production assets are transported over an intercepted HTTPS origin.
 * API replies, auth cookie and Provider destination are explicitly controlled;
 * this exercises ordinary rendered entry, not real Provider/acceptance completion. */
async function invitationBackend(page: Page) {
  const state = {
    mode: "hold" as "hold" | "unavailable" | "lost",
    submissions: 0,
    providerNavigations: 0,
    held: [] as Route[],
    requestUrls: [] as string[],
  };
  page.on("request", (request) => state.requestUrls.push(request.url()));
  await page.route(invitationOrigin + "/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(request.method()).toBe("GET");
    const response = await route.fetch({
      url: `http://127.0.0.1:4173${url.pathname}${url.search}`,
      headers: { ...request.headers(), host: "127.0.0.1:4173" },
    });
    await route.fulfill({ response });
  });
  // More specific API handler registered last so assets still use the real build.
  await page.route(invitationOrigin + "/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === prefix + "/discovery/session") return reply(route, {}, 403);
    if (url.pathname !== prefix + "/invitation") return reply(route, {}, 503);
    state.submissions++;
    expect(url.origin).toBe(invitationOrigin);
    expect(url.search).toBe("");
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual({ secret: invitationSecret });
    const headers = await request.allHeaders();
    expect(headers["origin"]).toBe(invitationOrigin);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-bop-csrf"]).toBeUndefined();
    // Chromium interception does not expose fetch metadata on every host;
    // actual HTTP/native coverage enforces its mandatory presence server-side.
    if (headers["sec-fetch-site"] !== undefined)
      expect(headers["sec-fetch-site"]).toBe("same-origin");
    if (headers["referer"] !== undefined)
      expect(new URL(headers["referer"]).origin).toBe(invitationOrigin);
    if (state.mode === "unavailable")
      return reply(route, { error: "brand_administration_unavailable" }, 503);
    if (state.mode === "lost") return route.abort("failed");
    state.held.push(route);
  });
  await page.route("https://identity.example.test/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().url()).toBe(invitationAuthorizationUrl());
    state.providerNavigations++;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
        "referrer-policy": "no-referrer",
      },
      body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Controlled secure sign-in</title><main><h1>Controlled secure sign-in</h1><p>No real Provider or account operation is performed.</p></main></html>',
    });
  });
  return {
    state,
    async release() {
      const route = state.held.shift();
      if (!route) throw new Error("controlled invitation request was not held");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          "set-cookie": `__Host-bop-auth=${"a".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
        body: JSON.stringify({ authorizationUrl: invitationAuthorizationUrl() }),
      });
    },
    async close() {
      await Promise.allSettled(state.held.splice(0).map((route) => route.abort("failed")));
    },
  };
}
async function assertInvitationTransient(page: Page, requestUrls: readonly string[]) {
  expect(page.url()).not.toContain(invitationSecret);
  expect(requestUrls.every((url) => !url.includes(invitationSecret))).toBe(true);
  const visibleStorage = await page.evaluate(() =>
    JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      cookie: document.cookie,
    }),
  );
  expect(visibleStorage).not.toContain(invitationSecret);
  await expect(page.locator("body")).not.toContainText(invitationSecret);
}

test("@production invitation keyboard entry clears the secret before safe Provider navigation at 320 and 200 percent", async ({
  page,
  context,
}, testInfo) => {
  const backend = await invitationBackend(page);
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(invitationEntry);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect(page.getByRole("link", { name: "Sign in securely" })).toBeVisible();
    const input = page.getByLabel("Invitation code", { exact: true }),
      submit = page.getByRole("button", { name: "Accept invitation", exact: true });
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.focus();
    await page.keyboard.type(invitationSecret);
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => backend.state.submissions).toBe(1);
    await expect(page.getByText("Starting invitation sign-in…", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(submit).toBeDisabled();
    await expect(page).toHaveURL(invitationEntry);
    await assertInvitationTransient(page, backend.state.requestUrls);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await submit.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const heldSkip = page.getByRole("link", { name: "Skip to main content", exact: true });
    await expect(heldSkip).not.toBeFocused();
    expect(
      await heldSkip.evaluate((element) => element.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    const heldScreenshot = testInfo.outputPath("brand-invitation-held-320-200-percent.png");
    await page.screenshot({ path: heldScreenshot, fullPage: true });
    await testInfo.attach("brand-invitation-held-320-200-percent", {
      path: heldScreenshot,
      contentType: "image/png",
    });
    await backend.release();
    await expect(page).toHaveURL(invitationAuthorizationUrl());
    await expect(page.getByRole("heading", { name: "Controlled secure sign-in" })).toBeVisible();
    expect(backend.state.providerNavigations).toBe(1);
    expect(backend.state.submissions).toBe(1);
    expect(backend.state.requestUrls.every((url) => !url.includes(invitationSecret))).toBe(true);
    expect(
      (await context.cookies(invitationOrigin)).find((cookie) => cookie.name === "__Host-bop-auth"),
    ).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  } finally {
    await backend.close();
  }
});

test("@production invitation unavailable and lost replies clear input and require explicit retry", async ({
  page,
}, testInfo) => {
  const backend = await invitationBackend(page);
  try {
    await page.clock.install();
    await page.goto(invitationEntry);
    const input = page.getByLabel("Invitation code", { exact: true }),
      submit = page.getByRole("button", { name: "Accept invitation", exact: true });
    await input.fill("short");
    await submit.click();
    await expect(
      page.getByText("Enter the complete 43-character invitation code.", { exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("");
    expect(backend.state.submissions).toBe(0);
    backend.state.mode = "unavailable";
    await input.fill(invitationSecret);
    await submit.click();
    await expect(
      page.getByText("Invitation sign-in is unavailable. Re-enter your code to try again.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(input).toHaveValue("");
    expect(backend.state.submissions).toBe(1);
    await page.clock.fastForward(20000);
    expect(backend.state.submissions).toBe(1);
    backend.state.mode = "lost";
    await input.fill(invitationSecret);
    await submit.click();
    await expect(
      page.getByText(
        "The result is unknown. No retry was sent. Start again when you are ready to retry.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(input).toBeDisabled();
    await expect(submit).toBeDisabled();
    expect(backend.state.submissions).toBe(2);
    await page.clock.fastForward(60000);
    expect(backend.state.submissions).toBe(2);
    await expect(page).toHaveURL(invitationEntry);
    await assertInvitationTransient(page, backend.state.requestUrls);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Start again", exact: true }).focus();
    const unknownSkip = page.getByRole("link", { name: "Skip to main content", exact: true });
    await expect(unknownSkip).not.toBeFocused();
    expect(
      await unknownSkip.evaluate((element) => element.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeFocused();
    const unknownScreenshot = testInfo.outputPath("brand-invitation-unknown-320-200-percent.png");
    await page.screenshot({ path: unknownScreenshot, fullPage: true });
    await testInfo.attach("brand-invitation-unknown-320-200-percent", {
      path: unknownScreenshot,
      contentType: "image/png",
    });
    await page.keyboard.press("Enter");
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    backend.state.mode = "unavailable";
    await input.fill(invitationSecret);
    await submit.click();
    await expect(
      page.getByText("Invitation sign-in is unavailable. Re-enter your code to try again.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(backend.state.submissions).toBe(3);
    expect(backend.state.providerNavigations).toBe(0);
    await assertInvitationTransient(page, backend.state.requestUrls);
  } finally {
    await backend.close();
  }
});
