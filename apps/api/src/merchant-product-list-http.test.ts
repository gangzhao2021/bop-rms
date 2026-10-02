import { request as httpRequest } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogProductListError, parseCatalogProductListView } from "@rms/catalog";
import {
  createMerchantBffRouter,
  type MerchantBffRouterOptions,
  type MerchantBffService,
} from "./merchant-bff.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const servers: import("node:http").Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function read(url: string, options: { headers: Record<string, string> }) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        resolve(
          new Response(Buffer.concat(chunks).toString("utf8"), {
            status: response.statusCode ?? 500,
            headers,
          }),
        );
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const filters = {
  search: null,
  lifecycle: null,
  productType: null,
  limit: 50,
  cursor: null,
  includeArchived: false,
  hasActiveSku: null,
  missingTranslationLocale: null,
  updatedFrom: null,
  updatedUntil: null,
  createdFrom: null,
  createdUntil: null,
  sort: "updatedAt",
  direction: "DESC",
};
const view = () =>
  parseCatalogProductListView({
    projection: {
      name: "catalog_product_search_v1",
      version: 1,
      asOfUtc: "2026-09-28T12:00:00.000Z",
      stale: false,
      partial: true,
    },
    scope: { brandReference: id(2), storeReference: id(3) },
    locale: "en-CA",
    items: [],
    nextCursor: null,
    hasMore: false,
  });
async function setup(productList?: MerchantBffRouterOptions["productList"]) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {} as MerchantBffService,
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
      ...(productList ? { productList } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("isolated listener missing");
  const headers = {
    Host: "merchant.invalid",
    Origin: "https://merchant.invalid",
    "Sec-Fetch-Site": "same-origin",
    Cookie: "__Host-bop-merchant=" + Buffer.alloc(32, 18).toString("base64url"),
    "x-bop-product-list": Buffer.from(JSON.stringify(filters)).toString("base64url"),
  };
  const url = "http://127.0.0.1:" + address.port + "/merchant/catalog/products";
  return { headers, url };
}
it("returns a closed no-store actual read envelope", async () => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(view());
  expect(operation).toHaveBeenCalledWith({ sessionCookie: expect.any(String), filters });
});
it("leaves unconfigured runtime unavailable", async () => {
  const f = await setup();
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "product_list_unavailable" });
});
it.each([
  ["Denied", 403, "denied"],
  ["FeatureDisabled", 409, "feature_disabled"],
  ["Stale", 409, "stale"],
  ["Invalid", 400, "invalid"],
  ["Unavailable", 503, "unavailable"],
] as const)("bounds %s errors", async (code, status, error) => {
  const f = await setup(async () => {
    throw new CatalogProductListError(code);
  });
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "product_list_" + error });
});
it("never echoes an unknown error message or extra response fields", async () => {
  const f = await setup(async () => ({ ...view(), hidden: "synthetic-private-source" }));
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "product_list_unavailable" });
  const g = await setup(async () => {
    throw new Error("synthetic-secret-SQL");
  });
  const failed = await read(g.url, { headers: g.headers });
  expect(await failed.text()).not.toContain("secret");
});
it.each(["cross-site", "same-site"])("rejects %s reads before query", async (site) => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  const response = await read(f.url, { headers: { ...f.headers, "Sec-Fetch-Site": site } });
  expect(response.status).toBe(403);
  expect(operation).not.toHaveBeenCalled();
});
it("rejects query strings and missing filter headers/cookies before query", async () => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  expect((await read(f.url + "?store=" + id(99), { headers: f.headers })).status).toBe(403);
  const withoutCookie: Record<string, string> = { ...f.headers };
  delete withoutCookie.Cookie;
  expect((await read(f.url, { headers: withoutCookie })).status).toBe(403);
  const withoutFilter: Record<string, string> = { ...f.headers };
  delete withoutFilter["x-bop-product-list"];
  expect((await read(f.url, { headers: withoutFilter })).status).toBe(403);
  expect(operation).not.toHaveBeenCalled();
});
it("rejects malformed/oversized header JSON", async () => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  expect(
    (
      await read(f.url, {
        headers: { ...f.headers, "x-bop-product-list": Buffer.from("{").toString("base64url") },
      })
    ).status,
  ).toBe(400);
  expect(
    (await read(f.url, { headers: { ...f.headers, "x-bop-product-list": "a".repeat(5463) } }))
      .status,
  ).toBe(403);
  expect(operation).not.toHaveBeenCalled();
});

it("transports Unicode names losslessly outside the URL", async () => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  const localized = { ...filters, search: "茶 ☕" };
  const response = await read(f.url, {
    headers: {
      ...f.headers,
      "x-bop-product-list": Buffer.from(JSON.stringify(localized)).toString("base64url"),
    },
  });
  expect(response.status).toBe(200);
  expect(operation).toHaveBeenCalledWith({ sessionCookie: expect.any(String), filters: localized });
});
