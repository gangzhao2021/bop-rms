import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout } from "node:timers";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL, fileURLToPath } from "node:url";
import { createServer, resolveConfig } from "vite";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function startCustomerLab({
  apiOrigin,
  token,
  stop,
  diningAdmissionEnabled = false,
  cartEnabled = false,
}) {
  assert.equal(process.env.BOP_LOCAL_CUSTOMER_LAB, "1");
  assert(["development", "test"].includes(process.env.NODE_ENV));
  assert.match(apiOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  let origin;
  const directory = await mkdtemp(join(tmpdir(), "bop-customer-lab-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  let https;
  try {
    await chmod(directory, 0o700);
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
        "subjectAltName=IP:127.0.0.1",
      ],
      { timeout: 15_000 },
    );
    https = { key: await readFile(keyPath), cert: await readFile(certPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const server = await createServer({
    root,
    logLevel: "silent",
    server: {
      https,
      host: "127.0.0.1",
      port: 5184,
      strictPort: true,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      proxy: { "/bff/": apiOrigin, "/api/": apiOrigin, "/ready": apiOrigin },
    },
    plugins: [
      {
        name: "isolated-customer-entry-bootstrap",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/__local/")) return next();
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "application/json");
            const allowed =
              typeof origin === "string" &&
              ["/__local/customer-entry", "/__local/stop"].includes(request.url) &&
              request.method === "POST" &&
              request.headers.origin === origin &&
              (request.headers[":authority"] ?? request.headers.host) === new URL(origin).host &&
              request.headers["sec-fetch-site"] === "same-origin";
            response.statusCode = allowed ? 200 : 404;
            const stopping = allowed && request.url === "/__local/stop";
            response.end(
              JSON.stringify(
                allowed
                  ? stopping
                    ? { status: "stopping" }
                    : {
                        qrToken: token(),
                        diningAdmissionEnabled: diningAdmissionEnabled === true,
                        cartEnabled: cartEnabled === true,
                      }
                  : { error: "unavailable" },
              ),
            );
            // Allow the HTTPS acknowledgement to reach the browser before Vite closes sockets.
            if (stopping) setTimeout(stop, 250).unref();
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert(address && typeof address === "object" && address.address === "127.0.0.1");
    origin = `https://127.0.0.1:${address.port}`;
    return { origin, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export async function verifyCustomerLab(origin, sessionCount, stopAfter = false, dining, cart) {
  const production = await resolveConfig({ root, logLevel: "silent" }, "build", "production");
  const entryPlugin = production.plugins.find(
    (plugin) => plugin.name === "bop-local-customer-demo-entry",
  );
  assert.equal(
    entryPlugin.transformIndexHtml('<script src="/src/main.tsx"></script>'),
    '<script src="/src/main.tsx"></script>',
  );
  const browser = await chromium.launch();
  let cartJourneys = 0;
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      let joinProof = dining ? await dining.prepare() : null;
      const context = await browser.newContext({
        viewport,
        ignoreHTTPSErrors: true,
        isMobile: viewport.width === 390,
        hasTouch: viewport.width === 390,
      });
      try {
        const denied = await context.request.post(`${origin}/__local/customer-entry`);
        assert.equal(denied.status(), 404);
        for (const path of ["/__local/customer-entry", "/__local/stop", "/__local/unknown"]) {
          const wrongOrigin = await context.request.post(`${origin}${path}`, {
            headers: { origin: "https://wrong.invalid", "sec-fetch-site": "same-origin" },
          });
          assert.equal(wrongOrigin.status(), 404);
          assert.equal((await context.request.get(`${origin}${path}`)).status(), 404);
        }
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", () => errors.push("page_error"));
        const before = await sessionCount();
        const responses = [];
        page.on("response", (response) => {
          const p = new URL(response.url()).pathname;
          if (["/", "/__local/customer-entry", "/bff/customer/entry"].includes(p))
            responses.push([p, response.status()]);
        });
        await page.goto(origin);
        await page
          .getByRole("heading", { name: "Synthetic Store", exact: true })
          .waitFor({ timeout: 10_000 })
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                responses,
                errors,
                headings: await page.getByRole("heading").allTextContents(),
              }),
            );
          });
        assert.equal(await sessionCount(), before + 1);
        const cookie = (await context.cookies()).find((value) => value.name === "__Host-bop-guest");
        assert(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax");
        assert.equal(new URL(page.url()).hash, "");
        if (dining) {
          try {
            await page.getByLabel("Join code or invitation", { exact: true }).fill(joinProof);
          } catch {
            throw new Error("protected dining input unavailable");
          } finally {
            joinProof = null;
          }
          await page.getByRole("button", { name: "Join table", exact: true }).click();
          await page
            .getByRole("heading", { name: "You’ve joined this table", exact: true })
            .waitFor();
          assert.equal(
            await page.getByLabel("Join code or invitation", { exact: true }).count(),
            0,
          );
          const bound = (await context.cookies()).find(
            (value) => value.name === "__Host-bop-guest",
          );
          assert(bound?.secure && bound.httpOnly && bound.sameSite === "Lax");
          assert(bound.value !== cookie.value);
          assert.deepEqual(
            (await context.cookies()).map((value) => value.name),
            ["__Host-bop-guest"],
          );
          assert.equal(await sessionCount(), before + 2);
          await dining.verify();
        }
        await page.getByRole("button", { name: "Continue to menu", exact: true }).click();
        await page.getByText("Latte", { exact: true }).first().waitFor();
        await page
          .getByText("Price confirmed in your final quote", { exact: true })
          .first()
          .waitFor();
        assert.equal(new URL(page.url()).pathname, "/menu");
        if (cart) {
          await page.getByRole("link", { name: "View Latte", exact: true }).click();
          await page.getByRole("button", { name: "Add to cart", exact: true }).click();
          await page.getByLabel("Quantity", { exact: true }).fill("2");
          await page.getByRole("button", { name: "Add to cart", exact: true }).click();
          await page.getByRole("link", { name: "Review cart", exact: true }).click();
          await page.getByLabel("Latte quantity", { exact: true }).waitFor();
          assert.equal(await page.getByLabel("Latte quantity", { exact: true }).textContent(), "2");
          await page.getByRole("button", { name: "Increase Latte quantity", exact: true }).click();
          await page.waitForFunction(
            () =>
              globalThis.document.querySelector('[aria-label="Latte quantity"]')?.textContent ===
              "3",
          );
          await page.getByRole("button", { name: "Remove", exact: true }).click();
          await page.getByRole("heading", { name: "Your cart is empty", exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, "/cart");
          await cart.verify(++cartJourneys);
        }
        assert.equal((await page.request.get(`${origin}/ready`)).status(), 503);
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(
            () => globalThis.localStorage.length + globalThis.sessionStorage.length,
          ),
          0,
        );
        if (stopAfter && viewport.width === 390) {
          await page.getByRole("button", { name: "Stop local lab", exact: true }).click();
          await page.getByRole("button", { name: "Lab stopped", exact: true }).waitFor();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
