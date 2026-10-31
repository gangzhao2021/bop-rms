import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { URL } from "node:url";

const webRequire = createRequire(
  new URL("../../../apps/merchant-web/package.json", import.meta.url),
);

/** Actual production TLS application and owning HTTP journey. Only an already
 * issued, unselected Session cookie is restored in memory; no route interception
 * or Provider success is constructed here. The synthetic TLS certificate is
 * accepted only by these isolated browser contexts. */
export async function openBrandStartupBrowser({
  origin,
  browserCookie,
  brandReference,
  displayName,
  lifecycle,
  version,
}) {
  const parsed = new URL(origin);
  assert(
    parsed.protocol === "https:" &&
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      ["127.0.0.1", "localhost"].includes(parsed.hostname),
    "STARTUP_BROWSER_ORIGIN_INVALID",
  );
  assert(
    typeof browserCookie === "string" &&
      /^__Host-bop-merchant=[A-Za-z0-9_-]{43}$/u.test(browserCookie),
    "STARTUP_BROWSER_COOKIE_INVALID",
  );
  assert(
    typeof brandReference === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(brandReference),
    "STARTUP_BROWSER_BRAND_INVALID",
  );
  assert(
    typeof displayName === "string" &&
      displayName.length > 0 &&
      ["Draft", "Active", "Suspended", "Archived"].includes(lifecycle) &&
      Number.isSafeInteger(version) &&
      version > 0,
    "STARTUP_BROWSER_EXPECTATION_INVALID",
  );
  const { chromium, expect } = webRequire("@playwright/test");
  let browser, anonymous, context, page, closePromise;
  const close = () => {
    closePromise ??= (async () => {
      let failure;
      for (const resource of [anonymous, context, browser]) {
        if (!resource) continue;
        try {
          await resource.close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    return closePromise;
  };
  const verifyDetail = async () => {
    await expect(page).toHaveURL(`${origin}/app/organization/brands/${brandReference}`);
    await expect(page.getByRole("heading", { name: displayName, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Brand session", exact: true })).toContainText(
      `Brand status: ${lifecycle}`,
    );
    await expect(page.getByRole("region", { name: "Brand lifecycle", exact: true })).toContainText(
      `Current ${displayName}: ${lifecycle} · version ${version}`,
    );
    await expect(
      page.getByRole("region", { name: "Brand configuration", exact: true }).getByRole("status"),
    ).toHaveText("Saved configuration loaded.");
  };
  try {
    browser = await chromium.launch({ headless: true });
    anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(`${origin}/`);
    await expect(anonymousPage.getByRole("heading", { name: "Brands", exact: true })).toBeVisible();
    await expect(
      anonymousPage.getByRole("link", { name: "Sign in securely", exact: true }),
    ).toBeVisible();
    await anonymous.close();
    anonymous = undefined;
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      {
        name: "__Host-bop-merchant",
        value: browserCookie.slice("__Host-bop-merchant=".length),
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    const choose = page.getByRole("button", { name: `Choose ${displayName}`, exact: true });
    await expect(choose).toBeEnabled();
    await choose.focus();
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${origin}/merchant/organization/brands/discovery/select` &&
          response.request().method() === "POST",
      ),
      page.keyboard.press("Enter"),
    ]);
    // The ordinary client navigates immediately after consuming the packet.
    // Verify its actual response status and rendered destination; the native
    // parent then resolves the same selection through its owning HTTP command.
    const selected = Object.freeze({ status: response.status() });
    assert.equal(selected.status, 200, "STARTUP_BROWSER_SELECTION_FAILED");
    await verifyDetail();
    return Object.freeze({
      selected,
      async verifyRestored() {
        if (closePromise) throw new Error("STARTUP_BROWSER_CLOSED");
        await page.reload();
        await verifyDetail();
        await mkdir("/private/tmp/wp2421-m133", { recursive: true, mode: 0o700 });
        for (const [name, width, height, textSize] of [
          ["desktop", 1440, 1000, "100%"],
          ["mobile", 320, 900, "200%"],
        ]) {
          await page.setViewportSize({ width, height });
          await page.evaluate((size) => {
            globalThis.document.documentElement.style.fontSize = size;
          }, textSize);
          await verifyDetail();
          const dimensions = await page.evaluate(() => ({
            document: globalThis.document.documentElement.scrollWidth,
            body: globalThis.document.body.scrollWidth,
            viewport: globalThis.document.documentElement.clientWidth,
          }));
          assert(
            dimensions.document <= dimensions.viewport + 1 &&
              dimensions.body <= dimensions.viewport + 1,
            "STARTUP_BROWSER_HORIZONTAL_OVERFLOW",
          );
          await page.screenshot({
            path: `/private/tmp/wp2421-m133/brand-startup-${name}.png`,
            fullPage: true,
          });
        }
      },
      close,
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
