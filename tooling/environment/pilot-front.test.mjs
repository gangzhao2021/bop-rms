import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { renderUnavailable, startPilotFront } from "./pilot-front.mjs";
import { parsePilotHosting } from "./pilot-hosting.mjs";
import { startPlannedMaintenance } from "./pilot-ops-maintenance.mjs";
import { createTestCertificates } from "./pilot-test-certificates.mjs";

const run = promisify(execFile);
const host = "order.store-pilot.ca";
const internal = { env: { NODE_ENV: "development" } };
let directory, runtime, certificates, loopback;
const open = [];
beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pilot-front-")));
  runtime = path.join(directory, "runtime");
  await fs.mkdir(runtime, { mode: 0o700 });
  certificates = await createTestCertificates(directory, { hostname: host });
  // The local entry's own self-signed loopback certificate (as pilot-provision-tls makes it).
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "30",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      path.join(directory, "loopback.key"),
      "-out",
      path.join(directory, "loopback.pem"),
    ],
    { timeout: 30_000 },
  );
  loopback = {
    cert: await fs.readFile(path.join(directory, "loopback.pem")),
    key: await fs.readFile(path.join(directory, "loopback.key")),
  };
}, 60_000);
afterEach(async () => {
  while (open.length > 0) await new Promise((resolve) => open.pop().close(resolve));
  await fs.rm(path.join(runtime, "ops"), { recursive: true, force: true });
});
afterAll(() => fs.rm(directory, { recursive: true, force: true }));

const listen = (server) =>
  new Promise((resolve) => {
    open.push(server);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
const upstream = (pair) =>
  https.createServer(pair, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream ${req.headers.host} ${req.url}`);
  });
const get = (port, url, { ca, servername, headers = {} }) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      // A new connection per request, as a browser makes after the old one was closed.
      {
        host: "127.0.0.1",
        port,
        path: url,
        ca,
        servername,
        agent: false,
        headers: { host, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
const front = async (options) => {
  const server = await startPilotFront({
    runtimeDirectory: runtime,
    listenHost: "127.0.0.1",
    listenPort: 0,
    log: () => undefined,
    ...options,
  });
  open.push(server);
  return server.address().port;
};

it("DEC-PILOT-MAINTENANCE-PAGE: relays the entry unchanged and answers with the update page while it is down", async () => {
  // Relay mode serves the runtime's own certificate pair, exactly like the local entry.
  await fs.copyFile(certificates.certificateFile, path.join(runtime, "customer-tls-cert.pem"));
  await fs.copyFile(certificates.keyFile, path.join(runtime, "customer-tls-key.pem"));
  const entry = upstream({
    cert: await fs.readFile(certificates.certificateFile),
    key: await fs.readFile(certificates.keyFile),
  });
  const upstreamPort = await listen(entry);
  const port = await front({ hosting: parsePilotHosting(null, internal), upstreamPort });
  const tls = { ca: certificates.root, servername: host };
  expect(await get(port, "/menu", tls)).toMatchObject({
    status: 200,
    body: `upstream ${host} /menu`,
  });
  await new Promise((resolve) => entry.close(resolve));
  open.splice(open.indexOf(entry), 1);
  const page = await get(port, "/menu", { ...tls, headers: { accept: "text/html" } });
  expect(page.status).toBe(503);
  expect(page.headers["retry-after"]).toBe("30");
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.body).toContain("Ordering is paused for a moment");
  expect(page.body).toContain("A staff member can take your order");
  const api = await get(port, "/api/v1/checkout-sessions/x", {
    ...tls,
    headers: { accept: "application/json" },
  });
  expect(api.status).toBe(503);
  expect(JSON.parse(api.body)).toEqual({ code: "SERVICE_UNAVAILABLE", retryable: true });
  // During a planned update the page says so; staff pages carry the counter/paper instruction.
  await startPlannedMaintenance(runtime, { reason: "deploy synthetic", minutes: 5 });
  const staff = await get(port, "/app/operations/orders", {
    ...tls,
    headers: { accept: "text/html" },
  });
  expect(staff.status).toBe(503);
  expect(staff.body).toContain("We're updating");
  expect(staff.body).toContain("counter or on paper");
  const french = await get(port, "/", { ...tls, headers: { "accept-language": "fr-CA,fr;q=0.9" } });
  expect(french.body).toContain("Mise à jour en cours");
  // The entry is back: relayed again on the next connection.
  const back = upstream({
    cert: await fs.readFile(certificates.certificateFile),
    key: await fs.readFile(certificates.keyFile),
  });
  await new Promise((resolve) => {
    open.push(back);
    back.listen(upstreamPort, "127.0.0.1", resolve);
  });
  expect((await get(port, "/", tls)).status).toBe(200);
});

it("DEC-PILOT-MAINTENANCE-PAGE: with the hosting's certificate the front terminates TLS and re-encrypts to the local entry", async () => {
  await fs.writeFile(path.join(runtime, "customer-tls-cert.pem"), loopback.cert);
  const upstreamPort = await listen(upstream(loopback));
  const hosting = parsePilotHosting(
    {
      schemaVersion: 1,
      environment: "Pilot",
      customerOrigin: `https://${host}`,
      secretsDirectory: "/run/secrets/bop-rms",
      tls: {
        mode: "front",
        certificateFile: certificates.certificateFile,
        keyFile: certificates.keyFile,
      },
    },
    { env: { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" } },
  );
  const port = await front({ hosting, upstreamPort });
  const tls = { ca: certificates.root, servername: host };
  expect(await get(port, "/app", tls)).toMatchObject({
    status: 200,
    body: `upstream ${host} /app`,
  });
  // Phones see the public certificate, never the loopback one.
  await expect(get(port, "/", { ca: loopback.cert, servername: host })).rejects.toThrow();
  const down = await front({ hosting, upstreamPort: 1 });
  expect((await get(down, "/", { ...tls, headers: { accept: "text/html" } })).status).toBe(503);
});

it("DEC-PILOT-MAINTENANCE-PAGE: the page has no internal terms, no scripts and answers HEAD without a body", () => {
  const html = renderUnavailable(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), {
    updating: true,
  }).toString("utf8");
  expect(html).toMatch(/^HTTP\/1\.1 503 /u);
  const body = html.slice(html.indexOf("<!doctype"));
  expect(body).not.toMatch(/<script|pilot|InternalTest|supervisor|container|503|error/iu);
  expect(html).toContain("default-src 'none'");
  const head = renderUnavailable(Buffer.from("HEAD / HTTP/1.1\r\nHost: x\r\n\r\n"), {
    updating: false,
  }).toString("utf8");
  expect(head.endsWith("\r\n\r\n")).toBe(true);
  expect(
    renderUnavailable(Buffer.from("\x16\x03\x01garbage\r\n\r\n"), { updating: false }),
  ).toBeNull();
});
