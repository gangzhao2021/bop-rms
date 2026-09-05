import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { chromium } from "@playwright/test";

const entryPath = "/bff/customer/entry";
const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function browserCheck(condition, code) {
  if (!/^WP2215_[A-Z_]+$/u.test(code)) throw new Error("WP2215_INVALID_ASSERTION_CODE");
  if (!condition) throw new Error(code);
}

async function createTls(directory) {
  const keyFile = path.join(directory, "key.pem");
  const certFile = path.join(directory, "cert.pem");
  const configFile = path.join(directory, "openssl.cnf");
  await writeFile(keyFile, "", { mode: 0o600 });
  await writeFile(certFile, "", { mode: 0o600 });
  await writeFile(
    configFile,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=local\n[dn]\nCN=127.0.0.1\n[local]\nsubjectAltName=IP:127.0.0.1\n",
    { mode: 0o600 },
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "1",
        "-config",
        configFile,
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("WP2215_OPENSSL_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("WP2215_LOCAL_TLS_GENERATION_FAILED"));
    });
  });
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}

async function loadAssets() {
  const root = path.resolve(import.meta.dirname, "../../../apps/customer-pwa/dist");
  const assets = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      browserCheck(!entry.isSymbolicLink(), "WP2215_ASSET_LINK_DENIED");
      if (entry.isDirectory()) await visit(file);
      else {
        browserCheck(!entry.name.includes("customer-demo"), "WP2215_DEMO_ASSET_DENIED");
        assets.set(`/${path.relative(root, file).split(path.sep).join("/")}`, {
          bytes: await readFile(file),
          contentType: mimeTypes[path.extname(file)] ?? "application/octet-stream",
        });
      }
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (/^WP2215_[A-Z_]+$/u.test(error?.message ?? "")) throw error;
    browserCheck(false, "WP2215_CUSTOMER_BUILD_REQUIRED");
  }
  browserCheck(assets.has("/index.html"), "WP2215_CUSTOMER_BUILD_REQUIRED");
  return assets;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WP2215_HTTPS_CLEANUP_FAILED")), 5_000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(new Error("WP2215_HTTPS_CLEANUP_FAILED"));
      else resolve();
    });
  });
}

// All assets and requests stay within this test-owned origin. Application transport is unchanged.
export async function withCustomerEntryBrowser(startApi, body) {
  const assets = await loadAssets();
  const directory = await mkdtemp(path.join(tmpdir(), "bop-wp2215-entry-"));
  let server;
  let runtime;
  let browser;
  const contexts = [];
  const violations = [];
  let bodyError;
  let result;
  try {
    const tls = await createTls(directory);
    server = createHttpsServer(tls, (request, response) => {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      if (url.pathname === entryPath && url.search === "" && runtime !== undefined) {
        const address = runtime.server.address();
        const upstream = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: entryPath,
            method: request.method,
            headers: request.headers,
            agent: false,
            timeout: 10_000,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 503, incoming.headers);
            incoming.pipe(response);
          },
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(503, { "Cache-Control": "no-store" });
          response.end();
        });
        request.on("aborted", () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      const asset = assets.get(url.pathname === "/" ? "/index.html" : url.pathname);
      const publicPrecacheRevision =
        url.searchParams.size === 1 &&
        /^[a-f0-9]{32}$/u.test(url.searchParams.get("__WB_REVISION__") ?? "");
      if (
        request.method !== "GET" ||
        (url.search !== "" && !publicPrecacheRevision) ||
        asset === undefined
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "no-store" });
      response.end(asset.bytes);
    });
    tls.key.fill(0);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new Error("WP2215_HTTPS_START_FAILED")));
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `https://127.0.0.1:${server.address().port}`;
    runtime = await startApi(origin);
    await runtime.listen();
    const spki = new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" });
    const certificatePin = createHash("sha256").update(spki).digest("base64");
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 20_000,
        args: [`--ignore-certificate-errors-spki-list=${certificatePin}`],
      });
    } catch {
      throw new Error("WP2215_CHROMIUM_START_FAILED");
    }
    result = await body({
      origin,
      violations,
      entryStatus(token, headers) {
        return new Promise((resolve, reject) => {
          const request = httpsRequest(
            `${origin}${entryPath}`,
            {
              method: "POST",
              ca: tls.cert,
              agent: false,
              timeout: 10_000,
              headers: { "content-type": "application/json", ...headers },
            },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode));
            },
          );
          request.on("timeout", () => request.destroy());
          request.on("error", () => reject(new Error("WP2215_GUARD_REQUEST_FAILED")));
          request.end(JSON.stringify({ qrToken: token }));
        });
      },
      async newContext() {
        // The browser process permits only the disposable TLS public-key pin, never host trust.
        // No recordVideo, tracing, screenshots, HAR, or persistent browser profile is enabled.
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
        });
        contexts.push(context);
        context.setDefaultTimeout(10_000);
        context.setDefaultNavigationTimeout(15_000);
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin !== origin) {
            violations.push("EXTERNAL_REQUEST");
            return route.abort();
          }
          return route.continue();
        });
        context.on("request", (request) => {
          if (new URL(request.url()).origin !== origin) violations.push("EXTERNAL_REQUEST");
        });
        context.on("page", (page) => {
          page.on("pageerror", () => violations.push("PAGE_ERROR"));
        });
        return context;
      },
    });
  } catch (error) {
    // Browser navigation errors may embed a QR fragment. Never preserve them or their causes.
    bodyError = new Error(
      /^WP2215_[A-Z_]+$/u.test(error?.message ?? "")
        ? error.message
        : "WP2215_BROWSER_EXECUTION_FAILED",
    );
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      ...contexts.map((context) => () => context.close()),
      () => browser?.close(),
      () => runtime?.shutdown("SIGTERM"),
      () => closeServer(server),
      () => rm(directory, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch {
        cleanupErrors.push("CLEANUP_FAILED");
      }
    }
    if (cleanupErrors.length > 0) bodyError = new Error("WP2215_BROWSER_CLEANUP_FAILED");
  }
  if (bodyError) throw bodyError;
  return result;
}
