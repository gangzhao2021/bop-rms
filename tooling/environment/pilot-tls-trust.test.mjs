import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pilotCertificatePublicKeyPin, pilotChromiumTrustArguments } from "./pilot-tls-trust.mjs";

const run = promisify(execFile);
const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const webRequire = createRequire(new URL("../../apps/merchant-web/package.json", import.meta.url));
let directory, certificate, server, proxy, origin;

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-pilot-tls-trust-")));
  await chmod(directory, 0o700);
  // Same shape as the pilot certificate: self-signed, 127.0.0.1 only.
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=BOP-RMS Local DEMO",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
  ]);
  certificate = await readFile(join(directory, "cert.pem"), "utf8");
  // A page shaped like the merchant build: a large entry module, modulepreloads, then the
  // stylesheet last, all requested at once.
  const preloads = Array.from({ length: 9 }, (_, i) => `/assets/m${i}.js`);
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html><head><script type="module" crossorigin src="/assets/index.js"></script>` +
      preloads.map((s) => `<link rel="modulepreload" crossorigin href="${s}">`).join("") +
      `<link rel="stylesheet" crossorigin href="/assets/index.css">` +
      `</head><body><button id="key">1</button></body></html>`,
  );
  const express = apiRequire("express");
  const app = express();
  app.get("/assets/index.css", (_req, res) =>
    res
      .set("Cache-Control", "no-cache")
      .type("text/css")
      .send("#key{display:block;width:185px;height:72px}" + "/*pad*/".repeat(20000)),
  );
  app.get("/assets/:name", (req, res) =>
    res
      .set("Cache-Control", "no-cache")
      .type("text/javascript")
      .send("export {};" + (req.params.name === "index.js" ? "//".repeat(350000) : "")),
  );
  app.get("/", (_req, res) =>
    res.set("Cache-Control", "no-store").sendFile(join(directory, "index.html")),
  );
  server = createServer(
    { key: await readFile(join(directory, "key.pem")), cert: certificate },
    app,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Like the pilot's port forward (Docker Desktop + socat): each new connection is relayed with
  // a little latency, so a page's parallel handshakes are still in flight together.
  proxy = createTcpServer((client) => {
    client.pause();
    setTimeout(() => {
      const upstream = connect(server.address().port, "127.0.0.1", () => {
        client.pipe(upstream).pipe(client);
        client.resume();
      });
      const end = () => (client.destroy(), upstream.destroy());
      client.on("error", end).on("close", end);
      upstream.on("error", end).on("close", end);
    }, 25);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  origin = "https://127.0.0.1:" + proxy.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve()));
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

it("pins exactly the certificate's public key (same value as OpenSSL's SPKI digest)", async () => {
  const { stdout } = await run("sh", [
    "-c",
    `openssl x509 -in "${join(directory, "cert.pem")}" -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`,
  ]);
  expect(pilotCertificatePublicKeyPin(certificate)).toBe(stdout.trim());
  expect(pilotChromiumTrustArguments(certificate)).toEqual([
    "--ignore-certificate-errors-spki-list=" + stdout.trim(),
  ]);
  expect(() => pilotCertificatePublicKeyPin("not a certificate")).toThrow(
    "PILOT_TLS_CERTIFICATE_INVALID",
  );
});

it("loads the stylesheet on every fresh browser connection when the certificate is trusted", async (context) => {
  let chromium;
  try {
    ({ chromium } = webRequire("@playwright/test"));
  } catch {
    context.skip();
  }
  let browser;
  try {
    browser = await chromium.launch({ args: pilotChromiumTrustArguments(certificate) });
  } catch {
    // The Linux pilot image has no browser; the macOS/CI host runs this check.
    context.skip();
  }
  try {
    for (let load = 0; load < 6; load += 1) {
      // A fresh context has no idle connection: every asset needs a new TLS handshake.
      const page = await (await browser.newContext()).newPage();
      const failed = [];
      page.on("requestfailed", (request) => failed.push(request.failure()?.errorText));
      await page.goto(origin + "/", { waitUntil: "load" });
      expect(failed).toEqual([]);
      expect(
        await page.locator("#key").evaluate((key) => {
          const box = key.getBoundingClientRect();
          return [Math.round(box.width), Math.round(box.height)];
        }),
      ).toEqual([185, 72]);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
}, 60000);
