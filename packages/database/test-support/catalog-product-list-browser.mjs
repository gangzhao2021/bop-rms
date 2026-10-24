import { Buffer } from "node:buffer";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { CatalogProductListError } from "../../rms/catalog/src/index.ts";
import { merchantSessionCookie, parseRawBrowserCredential } from "../../bop/identity/src/index.ts";

/** Production build + real BFF HTTP + real owning RLS SQL. IAM/Phase/Store facts
 * below are explicitly isolated fixture authority, never a live deployment grant. */
export async function exerciseProductListBrowser({
  root,
  store,
  request,
  seed,
  rebuild,
  setAllowed,
  setPhase,
  getSqlCalls,
  reference,
  journey,
}) {
  const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
  const webRequire = createRequire(path.join(root, "apps/merchant-web/package.json"));
  const { default: express } = await import(apiRequire.resolve("express"));
  const { chromium, expect } = await import(webRequire.resolve("@playwright/test"));
  const id = reference ?? ((n) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
  if (journey === undefined) {
    for (let n = 300; n < 351; n++)
      await seed(n, `SYNTH_PAGE_${n}`, `Synthetic page ${n}`, "2026-08-01T00:00:00.000Z");
    await rebuild();
  }
  const tlsDirectory = await mkdtemp(path.join(tmpdir(), "wp2407_https_"));
  let server, browser, zoomContext;
  let closeError = null;
  try {
    const keyPath = path.join(tlsDirectory, "key.pem"),
      certPath = path.join(tlsDirectory, "cert.pem");
    // Fresh isolated fixture certificate only. Private material never enters output/artifacts.
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { timeout: 15000 },
    );
    const app = express();
    server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      app,
    ).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const host = `127.0.0.1:${address.port}`,
      origin = `https://${host}`;
    let selected = id(3),
      credential = parseRawBrowserCredential(Buffer.alloc(32, 18).toString("base64url")),
      mode = "Current";
    const csrf = parseRawBrowserCredential(Buffer.alloc(32, 21).toString("base64url"));
    const selection = (ref) => ({
      brandLabel: "Synthetic Brand",
      storeLabel: ref === id(3) ? "Synthetic Store" : "Synthetic Second Store",
      storeReference: ref,
    });
    let navigationAllowed = true;
    const workspace = () => ({
      screenId: "HOME-OVERVIEW",
      selectedScope: selection(selected),
      authorizedStores: [selection(id(3)), selection(id(30))],
      businessDate: "2026-08-01",
      storeStatus: "Unavailable",
      freshness: "Current",
      dashboardAvailability: "UnavailableUntilWP1905",
      navigation: [
        ...(navigationAllowed
          ? [
              {
                screenId: "CAT-PRODUCT-LIST",
                label: "Products",
                href: "/app/commerce/products",
                permission: "catalog.manage",
              },
            ]
          : []),
        {
          screenId: "HOME-OVERVIEW",
          label: "Workspace",
          href: "/app",
          permission: "merchant.access",
        },
      ],
    });
    const service = {
      async bootstrap(cookie) {
        assert.equal(cookie, credential);
        return { session: {}, csrf, workspace: workspace() };
      },
      async switchStore(input) {
        assert.equal(input.sessionCookie, credential);
        assert.equal(input.csrf, csrf);
        assert.equal(input.targetStoreReference, id(30));
        selected = id(30);
        credential = parseRawBrowserCredential(Buffer.alloc(32, 19).toString("base64url"));
        return {
          cookie: { descriptor: merchantSessionCookie, value: credential, clear: false },
          workspace: workspace(),
        };
      },
    };
    app.use(
      "/merchant",
      createMerchantBffRouter({
        service,
        acceptedHost: host,
        exactOrigin: origin,
        async productList(input) {
          assert.equal(input.sessionCookie, credential);
          const captured = selected;
          const value = await store({
            brandReference: id(2),
            storeReference: mode === "ForeignScope" ? id(99) : captured,
          }).load(request({ ...input.filters }));
          if (mode === "Stale")
            return { ...value, projection: { ...value.projection, stale: true } };
          if (mode === "Malformed") return { ...value, hidden: "synthetic-private-source" };
          if (mode === "Conflict") throw new CatalogProductListError("Invalid");
          return value;
        },
      }),
    );
    app.use(express.static(path.join(root, "apps/merchant-web/dist")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile("index.html", { root: path.join(root, "apps/merchant-web/dist") }),
    );
    const directory = path.join(root, ".local/wp-2407-product-list");
    await mkdir(directory, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await context.addCookies([
      {
        name: "__Host-bop-merchant",
        value: credential,
        url: origin + "/",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    await page.clock.install({ time: new Date(Date.now() + 1000) });
    page.on("pageerror", (error) => errors.push(error.message));
    // Reuse the same isolated native tab zoom for both normal list and classified rows.
    const openNativeZoom = async () => {
      // No CSS zoom, viewport substitution, pinch or user's installed browser profile.
      const extension = path.join(tlsDirectory, "zoom-extension");
      await mkdir(extension);
      await writeFile(
        path.join(extension, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "WP2407 isolated zoom proof",
          version: "1.0",
          permissions: ["tabs"],
          background: { service_worker: "worker.js" },
        }),
      );
      await writeFile(
        path.join(extension, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {});\n",
      );
      zoomContext = await chromium.launchPersistentContext(
        path.join(tlsDirectory, "zoom-profile"),
        {
          channel: "chromium",
          headless: true,
          ignoreHTTPSErrors: true,
          viewport: { width: 1440, height: 900 },
          ignoreDefaultArgs: ["--disable-extensions"],
          args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension],
        },
      );
      await zoomContext.addCookies([
        {
          name: "__Host-bop-merchant",
          value: credential,
          url: origin + "/",
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const zoomPage = await zoomContext.newPage();
      await zoomPage.goto(origin + "/app/commerce/products");
      return {
        page: zoomPage,
        captureNativeZoom: async (outputPath) => {
          // Playwright's fullPage clip uses CSS dimensions and crops native tab zoom.
          // Capture native compositor pixels with CDP content dimensions; keep zoom=2.
          const zoomSession = await zoomContext.newCDPSession(zoomPage);
          const layout = await zoomSession.send("Page.getLayoutMetrics");
          assert.equal(layout.contentSize.width, layout.cssContentSize.width * 2);
          const capture = await zoomSession.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { ...layout.contentSize, scale: 1 },
          });
          const png = Buffer.from(capture.data, "base64");
          assert.equal(png.readUInt32BE(16), layout.contentSize.width);
          await writeFile(outputPath, png);
          await zoomSession.detach();
        },
        setNativeZoom: async () => {
          const worker =
            zoomContext.serviceWorkers()[0] ?? (await zoomContext.waitForEvent("serviceworker"));
          return await worker.evaluate(async (url) => {
            const tabs = await globalThis.chrome.tabs.query({ url: url + "/*" });
            if (tabs.length !== 1 || tabs[0].id === undefined)
              throw new Error("isolated zoom target unavailable");
            await globalThis.chrome.tabs.setZoom(tabs[0].id, 2);
            return globalThis.chrome.tabs.getZoom(tabs[0].id);
          }, origin);
        },
      };
    };
    const before = getSqlCalls();
    await page.goto(origin + "/app");
    await page.getByRole("link", { name: "Products", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeVisible();
    if (journey !== undefined) {
      await journey({ page, context, origin, directory, expect, openNativeZoom });
      assert.deepEqual(errors, [], "no classified browser runtime error");
      await context.close();
    } else {
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      assert.ok(getSqlCalls() > before, "real owner SQL must execute through HTTP");
      await page.getByRole("button", { name: "Next page", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("5 on this page", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh products" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Sort products by", { exact: true }).selectOption("internalCode");
      await page.getByLabel("Sort direction", { exact: true }).selectOption("ASC");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("rowheader").first()).toContainText("Synthetic exact code");
      await expect(page.getByText("Internal code ascending", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText("5 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Sort products by", { exact: true }).selectOption("name");
      await page.getByLabel("Sort direction", { exact: true }).selectOption("ASC");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("rowheader").first()).toContainText("Synthetic Alpha");
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText("5 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Draft name missing locale", { exact: true }).fill("fr_ca");
      const beforeInvalidLocale = getSqlCalls();
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("alert")).toContainText("Filters were not applied");
      assert.equal(getSqlCalls(), beforeInvalidLocale);
      await page.getByLabel("Draft name missing locale", { exact: true }).fill("zh-CN");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      await expect(page.getByRole("rowheader").first()).toContainText("Synthetic exact code");
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText("3 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Draft name missing locale", { exact: true }).fill("en-CA");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("heading", { name: "No products", exact: true })).toBeVisible();
      await page.getByLabel("Draft name missing locale", { exact: true }).fill("");
      await page.getByLabel("Sort products by", { exact: true }).selectOption("createdAt");
      await page.getByLabel("Sort direction", { exact: true }).selectOption("DESC");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      await expect(page.getByRole("rowheader").first()).toContainText("Synthetic Beta");
      await expect(page.getByText("Created time descending", { exact: false })).toBeVisible();
      await page
        .getByRole("button", { name: "First page", exact: true })
        .isDisabled()
        .then((disabled) => assert.equal(disabled, true));
      await page.getByRole("button", { name: "Refresh products" }).click();
      await expect(page.getByRole("rowheader").first()).toContainText("Synthetic Beta");
      await page.getByLabel("Sort products by", { exact: true }).selectOption("updatedAt");
      await page.getByLabel("Product / code / SKU", { exact: true }).fill("Beta");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("rowheader", { name: /Synthetic Beta/ })).toBeVisible();
      await expect(page.getByText("1 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Active SKUs", { exact: true }).selectOption("true");
      await page
        .getByLabel("Updated from (UTC, included)", { exact: true })
        .fill("2026-08-02T12:00");
      await page
        .getByLabel("Updated until (UTC, excluded)", { exact: true })
        .fill("2026-08-02T12:00");
      const beforeInvalidFilters = getSqlCalls();
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("alert")).toContainText("Filters were not applied");
      assert.equal(getSqlCalls(), beforeInvalidFilters);
      await page
        .getByLabel("Updated until (UTC, excluded)", { exact: true })
        .fill("2026-08-02T12:01");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("1 on this page", { exact: false })).toBeVisible();
      await page.getByLabel("Active SKUs", { exact: true }).selectOption("false");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("heading", { name: "No products", exact: true })).toBeVisible();
      await page.getByLabel("Active SKUs", { exact: true }).selectOption("true");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("rowheader", { name: /Synthetic Beta/ })).toBeVisible();
      await page
        .getByLabel("Created from (UTC, included)", { exact: true })
        .fill("2026-08-01T00:00");
      await page
        .getByLabel("Created until (UTC, excluded)", { exact: true })
        .fill("2026-08-01T00:00");
      const beforeInvalidCreation = getSqlCalls();
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("alert")).toContainText("Filters were not applied");
      assert.equal(getSqlCalls(), beforeInvalidCreation);
      await page
        .getByLabel("Created until (UTC, excluded)", { exact: true })
        .fill("2026-08-01T00:01");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByText("1 on this page", { exact: false })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      assert.equal(await page.locator(".vite-error-overlay").count(), 0);
      await expect(page.getByText("Partial product data", { exact: true })).toBeVisible();
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
        [320, 844],
      ]) {
        await page.setViewportSize({ width, height });
        const extent = await page.evaluate(() => ({
          width: globalThis.innerWidth,
          scroll: globalThis.document.documentElement.scrollWidth,
        }));
        assert.ok(extent.scroll <= extent.width, `no horizontal overflow at ${width}`);
        if (width < 1000)
          await expect(
            page.getByRole("heading", { name: "Synthetic Beta", exact: true }),
          ).toBeVisible();
        const targets = await page
          .locator("button, select, input:not([type=checkbox]), .product-list-filter-actions label")
          .evaluateAll((elements) =>
            elements.every((element) => {
              const box = element.getBoundingClientRect();
              return box.width >= 44 && box.height >= 44;
            }),
          );
        assert.equal(targets, true, `minimum44pixel targets at ${width}`);
        // Full-page capture after focused lower controls can paint offscreen fixed
        // elements into earlier document pixels. Capture from actual document top.
        await page.evaluate(() => globalThis.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => globalThis.scrollY)).toBe(0);
        const skip = await page.locator(".bop-skip-link").evaluate((element) => ({
          focused: element === globalThis.document.activeElement,
          bottom: element.getBoundingClientRect().bottom,
        }));
        assert.equal(skip.focused, false);
        assert.ok(skip.bottom <= 0, "unfocused skip link must be offscreen before capture");
        await page.screenshot({
          path: path.join(directory, `product-list-${width}.png`),
          fullPage: true,
        });
      }
      // Native Chromium tab zoom via a temporary extension in an isolated profile.
      const { page: zoomPage, setNativeZoom, captureNativeZoom } = await openNativeZoom();
      await expect(zoomPage.getByText("50 on this page", { exact: false })).toBeVisible();
      await zoomPage.getByLabel("Product / code / SKU", { exact: true }).fill("Beta");
      await zoomPage.getByLabel("Active SKUs", { exact: true }).selectOption("true");
      await zoomPage
        .getByLabel("Updated from (UTC, included)", { exact: true })
        .fill("2026-08-02T12:00");
      await zoomPage
        .getByLabel("Updated until (UTC, excluded)", { exact: true })
        .fill("2026-08-02T12:01");
      await zoomPage
        .getByLabel("Created from (UTC, included)", { exact: true })
        .fill("2026-08-01T00:00");
      await zoomPage
        .getByLabel("Created until (UTC, excluded)", { exact: true })
        .fill("2026-08-01T00:01");
      await zoomPage.getByLabel("Sort products by", { exact: true }).selectOption("activeSkuCount");
      await zoomPage.getByRole("button", { name: "Apply filters" }).click();
      await expect(zoomPage.getByText("1 on this page", { exact: false })).toBeVisible();
      const actualZoom = await setNativeZoom();
      assert.equal(actualZoom, 2, "native browser tab zoom must be200percent");
      await expect(
        zoomPage.getByRole("heading", { name: "Synthetic Beta", exact: true }),
      ).toBeVisible();
      const zoomMetrics = await zoomPage.evaluate(() => ({
        width: globalThis.innerWidth,
        scroll: globalThis.document.documentElement.scrollWidth,
        dpr: globalThis.devicePixelRatio,
      }));
      assert.equal(zoomMetrics.width, 720);
      assert.equal(zoomMetrics.dpr, 2);
      assert.ok(zoomMetrics.scroll <= zoomMetrics.width);
      await captureNativeZoom(path.join(directory, "product-list-native-200percent.png"));
      await zoomContext.close();
      zoomContext = undefined;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByLabel("Product / code / SKU", { exact: true }).fill("茶 ☕");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("heading", { name: "No products", exact: true })).toBeVisible();
      await page.getByLabel("Product / code / SKU", { exact: true }).fill("Beta");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page.getByRole("rowheader", { name: /Synthetic Beta/ })).toBeVisible();
      await page.reload();
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      const beforeDenied = getSqlCalls();
      setAllowed(false);
      await page.getByRole("button", { name: "Refresh products" }).click();
      await expect(
        page.getByRole("heading", { name: "Permission denied", exact: true }),
      ).toBeVisible();
      assert.equal(getSqlCalls(), beforeDenied);
      await expect(page.getByRole("rowheader")).toHaveCount(0);
      setAllowed(true);
      setPhase(false);
      await page.getByRole("button", { name: "Refresh products" }).click();
      await expect(
        page.getByRole("heading", { name: "Product management disabled", exact: true }),
      ).toBeVisible();
      assert.equal(getSqlCalls(), beforeDenied);
      setPhase(true);
      for (const [value, heading] of [
        ["Stale", "Product data stale"],
        ["Malformed", "Product data unavailable"],
        ["ForeignScope", "Product data unavailable"],
        ["Conflict", "Product data unavailable"],
      ]) {
        mode = value;
        await page.getByRole("button", { name: "Refresh products" }).click();
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expect(page.getByRole("rowheader")).toHaveCount(0);
      }
      mode = "Current";
      await page.getByRole("button", { name: "Refresh products" }).click();
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      await context.setOffline(true);
      await expect(page.getByRole("heading", { name: "Offline", exact: true })).toBeVisible();
      await expect(page.getByRole("rowheader")).toHaveCount(0);
      await context.setOffline(false);
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      // Exercise actual normal App -> workspace -> POST selection -> fresh cookie/bootstrap -> normal route.
      await page.getByRole("link", { name: "Workspace", exact: true }).click();
      await page.getByLabel("Authorized Store").selectOption(id(30));
      await page.getByRole("button", { name: "Switch Store", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Synthetic Second Store/ })).toBeVisible();
      await page.goto(origin + "/app/commerce/products");
      await expect(
        page.getByText("Synthetic Brand · Synthetic Second Store", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      navigationAllowed = false;
      await page.goto(origin + "/app");
      await expect(page.getByRole("heading", { name: /Synthetic Second Store/ })).toBeVisible();
      await expect(page.getByRole("link", { name: "Products", exact: true })).toHaveCount(0);
      const beforeNoNavigation = getSqlCalls();
      await page.goto(origin + "/app/commerce/products");
      await expect(
        page.getByRole("heading", { name: "Permission denied", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("rowheader")).toHaveCount(0);
      assert.equal(getSqlCalls(), beforeNoNavigation);
      navigationAllowed = true;
      await page.reload();
      await expect(page.getByText("50 on this page", { exact: false })).toBeVisible();
      const beforeExpiry = getSqlCalls();
      await page.clock.fastForward(30001);
      await expect(
        page.getByRole("heading", { name: "Product data stale", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("rowheader")).toHaveCount(0);
      assert.equal(
        getSqlCalls(),
        beforeExpiry,
        "age timer clears prior data without inventing a fresh read",
      );
      assert.deepEqual(errors, [], "no browser runtime error");
      await context.close();
    }
  } finally {
    setAllowed(true);
    setPhase(true);
    try {
      const closed = await Promise.allSettled([zoomContext?.close(), browser?.close()]);
      const failed = closed.find((result) => result.status === "rejected");
      if (failed) closeError = failed.reason;
    } finally {
      try {
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      } finally {
        await rm(tlsDirectory, { recursive: true, force: true });
      }
    }
  }
  if (closeError !== null) throw closeError;
}
