import { request as httpRequest } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import {
  MerchantCategoryTreeError,
  parseMerchantCategoryTreeResult,
} from "./merchant-category-tree-query.js";
import {
  createMerchantBffRouter,
  type MerchantBffRouterOptions,
  type MerchantBffService,
} from "./merchant-bff.js";
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
  productUsage: null,
  includeArchivedProducts: false,
};
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
function view() {
  return parseMerchantCategoryTreeResult({
    scope: { brandReference: id(2), storeReference: id(3) },
    query: {
      filters,
      matchedCategoryReferences: [id(300)],
      tree: {
        projection: {
          name: "catalog_category_tree_v1",
          version: 1,
          asOfUtc: at,
          stale: false,
          partial: true,
        },
        brandReference: id(2),
        locale: "en-CA",
        configuration: "Draft",
        classificationCoverage: "Known",
        source: {
          category: { revision: "1", digest: "sha256:" + "1".repeat(64), asOfUtc: at },
          products: {
            generationReference: id(600),
            revision: "0",
            digest: "sha256:" + "2".repeat(64),
            asOfUtc: at,
          },
        },
        items: [
          {
            categoryReference: id(300),
            internalCode: "CATEGORY_1",
            name: "Synthetic Category",
            nameLocale: "en-CA",
            localeFallback: false,
            lifecycle: "Draft",
            parentCategoryReference: null,
            level: 1,
            sortOrder: 0,
            aggregateVersion: "1",
            productCount: { status: "Known", includingArchived: 0, excludingArchived: 0 },
            menuUse: { status: "Unavailable" },
          },
        ],
      },
    },
  });
}
async function setup(categoryTree?: MerchantBffRouterOptions["categoryTree"]) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {} as MerchantBffService,
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
      ...(categoryTree ? { categoryTree } : {}),
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
    "x-bop-category-tree": Buffer.from(JSON.stringify(filters)).toString("base64url"),
  };
  const url = "http://127.0.0.1:" + address.port + "/merchant/catalog/categories";
  return { headers, url };
}
it("returns a closed no-store Category read envelope", async () => {
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
  expect(await response.json()).toEqual({ error: "category_tree_unavailable" });
});
it.each([
  ["Denied", 403, "denied"],
  ["FeatureDisabled", 409, "feature_disabled"],
  ["Stale", 409, "stale"],
  ["Invalid", 400, "invalid"],
  ["Unavailable", 503, "unavailable"],
] as const)("bounds %s errors", async (code, status, error) => {
  const f = await setup(async () => {
    throw new MerchantCategoryTreeError(code);
  });
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "category_tree_" + error });
});
it("never echoes an unknown error message or extra response fields", async () => {
  const f = await setup(async () => ({ ...view(), hidden: "synthetic-private-source" }));
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "category_tree_unavailable" });
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
  delete withoutFilter["x-bop-category-tree"];
  expect((await read(f.url, { headers: withoutFilter })).status).toBe(403);
  expect(operation).not.toHaveBeenCalled();
});
it("rejects malformed/oversized header JSON", async () => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  expect(
    (
      await read(f.url, {
        headers: { ...f.headers, "x-bop-category-tree": Buffer.from("{").toString("base64url") },
      })
    ).status,
  ).toBe(400);
  expect(
    (await read(f.url, { headers: { ...f.headers, "x-bop-category-tree": "a".repeat(5463) } }))
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
      "x-bop-category-tree": Buffer.from(JSON.stringify(localized)).toString("base64url"),
    },
  });
  expect(response.status).toBe(200);
  expect(operation).toHaveBeenCalledWith({ sessionCookie: expect.any(String), filters: localized });
});

it.each([
  { usage: "Empty" },
  { actorReference: id(7) },
  { search: "x".repeat(101) },
  { productUsage: "Maybe" },
])("rejects malformed/unsupported filter before source query %j", async (change) => {
  const operation = vi.fn(async () => view()),
    f = await setup(operation);
  const response = await read(f.url, {
    headers: {
      ...f.headers,
      "x-bop-category-tree": Buffer.from(JSON.stringify({ ...filters, ...change })).toString(
        "base64url",
      ),
    },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "category_tree_invalid" });
  expect(operation).not.toHaveBeenCalled();
});
it("rejects a rebound tree Brand after the configured handler", async () => {
  const f = await setup(async () => ({
    ...view(),
    scope: { brandReference: id(9), storeReference: id(3) },
  }));
  const response = await read(f.url, { headers: f.headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "category_tree_unavailable" });
});
