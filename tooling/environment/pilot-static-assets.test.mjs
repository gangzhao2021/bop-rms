import { afterAll, beforeAll, expect, test } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  createPilotStaticAssets,
  createResponseCompressor,
  encodedHeaders,
  IMMUTABLE_CACHE,
  missingPilotAsset,
  preferredEncoding,
  publicApiEncoding,
} from "./pilot-static-assets.mjs";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const express = require("express");

let directory, server, port;
const script = "export const page = '" + "x".repeat(40_000) + "';\n";
const html = "<!doctype html><title>Store</title>" + "<p>staff</p>".repeat(200);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bop-static-assets-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets", "PickupPages-Bk_XwfZm.js"), script);
  await writeFile(join(directory, "assets", "logo-3TeSG_8z.png"), Buffer.alloc(4096, 1));
  await writeFile(join(directory, "index.html"), html);
  await writeFile(join(directory, "service-worker.js"), script);
  await writeFile(join(directory, ".env"), "SECRET=1");
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(createPilotStaticAssets(directory));
  app.use("/assets", missingPilotAsset);
  app.use((_req, res) => res.status(200).set("Cache-Control", "no-store").send("app page"));
  server = await new Promise((done) => {
    const listening = app.listen(0, "127.0.0.1", () => done(listening));
  });
  port = server.address().port;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
});

const get = (path, headers = {}, method = "GET") =>
  new Promise((done, fail) => {
    const call = request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        done({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    call.on("error", fail);
    call.end();
  });

test("hashed build files are cached for a year and sent brotli compressed", async () => {
  const response = await get("/assets/PickupPages-Bk_XwfZm.js", {
    "accept-encoding": "gzip, deflate, br, zstd",
  });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe(IMMUTABLE_CACHE);
  expect(response.headers["content-encoding"]).toBe("br");
  expect(response.headers["vary"]).toBe("Accept-Encoding");
  expect(response.headers["content-type"]).toMatch(/javascript/u);
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(Number(response.headers["content-length"])).toBe(response.body.length);
  expect(response.body.length).toBeLessThan(script.length / 10);
  expect(brotliDecompressSync(response.body).toString()).toBe(script);
});

test("gzip when brotli is not accepted, plain when nothing is", async () => {
  const gzip = await get("/assets/PickupPages-Bk_XwfZm.js", { "accept-encoding": "gzip, br;q=0" });
  expect(gzip.headers["content-encoding"]).toBe("gzip");
  expect(gunzipSync(gzip.body).toString()).toBe(script);
  const plain = await get("/assets/PickupPages-Bk_XwfZm.js");
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.body.toString()).toBe(script);
  const head = await get("/assets/PickupPages-Bk_XwfZm.js", { "accept-encoding": "br" }, "HEAD");
  expect(head.headers["content-encoding"]).toBe("br");
  expect(head.body.length).toBe(0);
});

test("binary hashed files are cached but not recompressed", async () => {
  const response = await get("/assets/logo-3TeSG_8z.png", { "accept-encoding": "br" });
  expect(response.headers["cache-control"]).toBe(IMMUTABLE_CACHE);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.body.length).toBe(4096);
});

test("unhashed files are revalidated on each use so a deploy is picked up", async () => {
  for (const path of ["/index.html", "/service-worker.js"]) {
    const response = await get(path, { "accept-encoding": "gzip" });
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-encoding"]).toBe("gzip");
    const again = await get(path, {
      "accept-encoding": "gzip",
      "if-none-match": response.headers["etag"],
    });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  }
});

test("a missing build file is a 404, never the app page", async () => {
  const response = await get("/assets/PickupPages-OldDeploy.js");
  expect(response.status).toBe(404);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body.length).toBe(0);
});

test("hidden files and paths outside the build are not served", async () => {
  for (const path of ["/.env", "/assets/../.env", "/%2e%2e/%2e%2e/etc/passwd", "/%00"]) {
    const response = await get(path);
    expect(response.body.toString()).not.toContain("SECRET");
    expect(response.headers["cache-control"]).toBe("no-store");
  }
});

test("encoding preference honours refusals", () => {
  expect(preferredEncoding("gzip, deflate, br")).toBe("br");
  expect(preferredEncoding("br;q=0, gzip")).toBe("gzip");
  expect(preferredEncoding("*")).toBe("br");
  expect(preferredEncoding("identity")).toBeNull();
  expect(preferredEncoding(undefined)).toBeNull();
});

test("WP-2423 Q30: only large public JSON reads are compressed on the way to the guest", () => {
  const json = (length, extra = {}) => ({
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(length),
      ...extra,
    },
  });
  const menu = "/api/v1/public/stores/0190/menu";
  expect(publicApiEncoding(menu, "GET", json(98_648), "gzip, br")).toBe("br");
  expect(publicApiEncoding(menu, "GET", json(98_648), "gzip")).toBe("gzip");
  expect(publicApiEncoding(menu, "GET", json(98_648), undefined)).toBeNull();
  // Small, already encoded, not JSON, not 200, not GET, or not public: passed through unchanged.
  expect(publicApiEncoding(menu, "GET", json(300), "br")).toBeNull();
  expect(
    publicApiEncoding(menu, "GET", json(98_648, { "content-encoding": "br" }), "br"),
  ).toBeNull();
  expect(
    publicApiEncoding(
      menu,
      "GET",
      { statusCode: 200, headers: { "content-type": "text/event-stream" } },
      "br",
    ),
  ).toBeNull();
  expect(publicApiEncoding(menu, "GET", { ...json(98_648), statusCode: 404 }, "br")).toBeNull();
  expect(publicApiEncoding(menu, "POST", json(98_648), "br")).toBeNull();
  expect(publicApiEncoding("/api/v1/customer/session/csrf", "GET", json(98_648), "br")).toBeNull();
  expect(publicApiEncoding("/bff/customer/cart", "GET", json(98_648), "br")).toBeNull();
  // Unknown length (chunked) is compressed.
  expect(
    publicApiEncoding(
      menu,
      "GET",
      { statusCode: 200, headers: { "content-type": "application/json" } },
      "br",
    ),
  ).toBe("br");
});

test("WP-2423 Q30: a compressed answer drops its length and varies by encoding", async () => {
  const headers = encodedHeaders(
    { "content-type": "application/json", "content-length": "98648", vary: "Origin" },
    "br",
  );
  expect(headers).toEqual({
    "content-type": "application/json",
    "content-encoding": "br",
    vary: "Origin, Accept-Encoding",
  });
  expect(encodedHeaders({ vary: "accept-encoding" }, "gzip").vary).toBe("accept-encoding");
  const body = JSON.stringify({
    items: Array.from({ length: 400 }, (_, i) => ({ name: "Latte " + i })),
  });
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ]) {
    const compressor = createResponseCompressor(encoding);
    const chunks = [];
    compressor.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve) => compressor.on("end", resolve));
    compressor.end(body);
    await done;
    const sent = Buffer.concat(chunks);
    expect(decode(sent).toString()).toBe(body);
    expect(sent.length).toBeLessThan(body.length / 5);
  }
});
