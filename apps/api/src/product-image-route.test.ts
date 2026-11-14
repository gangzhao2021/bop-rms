import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createProductImageFileHandler } from "./product-image-route.js";

const name = "a".repeat(64) + ".webp";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});
async function listen(read: (name: string) => Promise<unknown>) {
  const app = express();
  app.get(
    "/media/images/:name",
    createProductImageFileHandler({ read } as Parameters<typeof createProductImageFileHandler>[0]),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/media/images/`;
}

describe("WP-2423 product photo files", () => {
  it("serves a stored size with year-long immutable caching and no script context", async () => {
    const asked: string[] = [];
    const base = await listen(async (requested) => {
      asked.push(requested);
      return { contentType: "image/webp", bytes: new Uint8Array([1, 2, 3]) };
    });
    const response = await fetch(base + name);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    const etag = response.headers.get("etag") ?? "";
    const revalidated = await fetch(base + name, { headers: { "if-none-match": etag } });
    expect(revalidated.status).toBe(304);
    expect(asked).toEqual([name, name]);
  });
  it.each([
    ["an unknown file", name, null],
    ["a name that is not a content hash", "photo.jpg", { contentType: "image/jpeg" }],
    ["an upper-case hash", "A".repeat(64) + ".jpg", { contentType: "image/jpeg" }],
    ["another extension", "a".repeat(64) + ".png", { contentType: "image/png" }],
    ["a query string", name + "?v=1", { contentType: "image/webp" }],
  ])("answers 404 without caching for %s", async (_label, path, stored) => {
    const base = await listen(async () =>
      stored === null ? null : { ...stored, bytes: new Uint8Array([1]) },
    );
    const response = await fetch(base + path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("answers 503 when the storage cannot be read", async () => {
    const base = await listen(async () => {
      throw new Error("EIO /private/path");
    });
    const response = await fetch(base + name);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
});
