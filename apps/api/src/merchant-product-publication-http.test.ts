import express from "express";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { buildCatalogProductEditorSnapshot, CatalogError } from "@rms/catalog";
import { createMerchantBffRouter, type MerchantBffRouterOptions } from "./merchant-bff.js";
const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});
const id = "01900000-0000-7000-8000-000000000001",
  cookie = "A".repeat(43),
  csrf = "A".repeat(43);
const expectedScope = { brandReference: id, storeReference: id };
const headers = {
  host: "merchant.invalid",
  origin: "https://merchant.invalid",
  "sec-fetch-site": "same-origin",
  cookie: "__Host-bop-merchant=" + cookie,
  "x-bop-csrf": csrf,
  "x-bop-catalog-scope": Buffer.from(JSON.stringify(expectedScope)).toString("base64url"),
  "content-type": "application/json",
};
async function serve(
  productPublication?: MerchantBffRouterOptions["productPublication"],
  signals: Pick<
    MerchantBffRouterOptions,
    "storeCapability" | "productPublicationQuery" | "productScopeJournals" | "productEditor"
  > = {},
) {
  const unavailable = async (): Promise<never> => {
    throw Error("unconfigured");
  };
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service: {
        start: unavailable,
        callback: unavailable,
        bootstrap: unavailable,
        authorize: unavailable,
        logout: unavailable,
        switchStore: unavailable,
      },
      ...signals,
      ...(productPublication ? { productPublication } : {}),
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  return `http://127.0.0.1:${address.port}/merchant/catalog/products/publication`;
}
async function submit(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
) {
  return new Promise<{
    status: number;
    headers: Headers;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: options.method, headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8"),
            responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
            const name = incoming.rawHeaders[i],
              value = incoming.rawHeaders[i + 1];
            if (name === undefined || value === undefined) throw Error("invalid fixture response");
            responseHeaders.append(name, value);
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers: responseHeaders,
            json: async () => JSON.parse(body) as unknown,
            text: async () => body,
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}
it("forwards same-origin private intent and exact scope, returning no-store owning result", async () => {
  const result = {
    status: "Applied",
    operationReference: id,
    productReference: id,
    versionReference: id,
    aggregateVersion: 2,
    publicationVersion: 1,
    state: "Draft",
    scheduleVersion: 0,
    effectiveFrom: "2026-09-29T12:00:00.000Z",
    successorDraftVersionReference: null,
  };
  const command = { action: "Validate", operationReference: id };
  const execute = vi.fn(async () => result);
  const root = await serve(execute as never);
  const response = await submit(root, { method: "POST", headers, body: JSON.stringify(command) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result);
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    command,
    expectedScope,
  });
});
it("refuses unconfigured publication without implying a commit", async () => {
  const root = await serve();
  const response = await submit(root, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "product_publication_unavailable" });
});
it.each([
  "CATALOG_INPUT_INVALID",
  "CATALOG_PERMISSION_DENIED",
  "CATALOG_VERSION_CONFLICT",
  "CATALOG_DEPENDENCY_UNAVAILABLE",
] as const)("sanitizes %s", async (code) => {
  const root = await serve(async () => {
    throw new CatalogError(code);
  });
  const response = await submit(root, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(
    code === "CATALOG_INPUT_INVALID"
      ? 400
      : code === "CATALOG_VERSION_CONFLICT"
        ? 409
        : code === "CATALOG_DEPENDENCY_UNAVAILABLE"
          ? 503
          : 403,
  );
  expect(await response.text()).not.toContain(code);
});
it.each([
  { "x-bop-csrf": "" },
  { origin: "https://foreign.invalid" },
  { "x-bop-catalog-scope": "bad" },
  { cookie: "" },
])("denies malformed transport before owning command", async (override) => {
  const execute = vi.fn(async () => ({}));
  const root = await serve(execute as never);
  const response = await submit(root, {
    method: "POST",
    headers: { ...headers, ...override },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
});

it("forwards Product current/future query with exact scope and keeps unconfigured current source unavailable", async () => {
  const query = {
      productReference: id,
      expectedAggregateVersion: 7,
      channelCode: "WEB",
      orderTypeCode: "PICKUP",
    },
    view = {
      productReference: id,
      aggregateVersion: 7,
      observedAt: "2026-09-29T12:00:00.000Z",
      current: { outcome: "Unavailable", reason: "NO_EFFECTIVE_PRODUCT_VERSION" },
      future: [],
    };
  const read = vi.fn(async () => view);
  const root = (await serve(undefined, { productPublicationQuery: read as never })) + "/query";
  const response = await submit(root, { method: "POST", headers, body: JSON.stringify(query) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(view);
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    query,
    expectedScope,
  });
  const unavailable = (await serve()) + "/query";
  expect((await submit(unavailable, { method: "POST", headers, body: "{}" })).status).toBe(503);
});
it("returns one owning Store decision and sanitizes unavailable sources", async () => {
  const query = { capabilityKey: "dining.din_table_list" },
    decision = {
      capabilityKey: query.capabilityKey,
      controlKey: "dining.table.capability",
      brandReference: id,
      storeReference: id,
      backendExecution: "Deny",
      frontendVisibility: "Hide",
      reason: "Disabled",
      source: "StoreOverride",
      controlReference: id,
      controlVersion: 2,
      observedAt: "2026-09-29T12:00:00.000Z",
    };
  const observe = vi.fn(async () => decision);
  const root = (await serve(undefined, { storeCapability: observe as never })).replace(
    "/catalog/products/publication",
    "/store-capability",
  );
  const response = await submit(root, { method: "POST", headers, body: JSON.stringify(query) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(decision);
  expect(observe).toHaveBeenCalledExactlyOnceWith({ sessionCookie: cookie, csrf, query });
  const bad = (
    await serve(undefined, {
      storeCapability: async () => {
        throw Error("private trigger details");
      },
    })
  ).replace("/catalog/products/publication", "/store-capability");
  const refused = await submit(bad, { method: "POST", headers, body: "{}" });
  expect(refused.status).toBe(503);
  expect(await refused.text()).not.toContain("private");
});

it("forwards private scope-journal query and exact navigation scope with no-store", async () => {
  const query = { productReference: id, expectedAggregateVersion: 7 },
    view = {
      profile: "CatalogProductScopeJournalManagementV1",
      recordStatus: "NotRecorded",
      currentDisposition: "NotEvaluated",
      eligibility: "NotEvaluated",
    },
    read = vi.fn(async () => view),
    url = (await serve(undefined, { productScopeJournals: read as never })) + "/scope-journals";
  const response = await submit(url, { method: "POST", headers, body: JSON.stringify(query) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(view);
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    query,
    expectedScope,
  });
});
it("keeps unconfigured owning scope-journal source unavailable", async () => {
  const response = await submit((await serve()) + "/scope-journals", {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "product_scope_journals_unavailable" });
});
it.each([
  ["CATALOG_INPUT_INVALID", 400],
  ["CATALOG_PERMISSION_DENIED", 403],
  ["CATALOG_DEPENDENCY_UNAVAILABLE", 503],
  ["raw", 503],
] as const)("sanitizes scope-journal read %s", async (code, status) => {
  const url =
    (await serve(undefined, {
      productScopeJournals: async () => {
        if (code === "raw") throw Error("private source body and internal stack");
        throw new CatalogError(code);
      },
    })) + "/scope-journals";
  const response = await submit(url, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(status);
  expect(await response.text()).not.toMatch(/CATALOG_|private|stack/u);
});
it.each([
  { "x-bop-csrf": "" },
  { origin: "https://foreign.invalid" },
  { "x-bop-catalog-scope": "bad" },
  { cookie: "" },
])("refuses malformed scope-journal transport before source %#", async (override) => {
  const read = vi.fn(async () => ({})),
    url = (await serve(undefined, { productScopeJournals: read as never })) + "/scope-journals";
  const response = await submit(url, {
    method: "POST",
    headers: { ...headers, ...override },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});
it("refuses query-string identifiers and GET journal reads", async () => {
  const read = vi.fn(async () => ({})),
    url = (await serve(undefined, { productScopeJournals: read as never })) + "/scope-journals";
  const query = await submit(url + "?productReference=" + id, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(query.status).toBe(403);
  const get = await submit(url, { method: "GET", headers, body: "" });
  expect(get.status).toBe(404);
  expect(read).not.toHaveBeenCalled();
});

// Explicit synthetic transport fixtures; actual session/permission/SQL is separately accepted.
function fullEditorView() {
  const at = "2026-09-30T22:00:00.000Z";
  return buildCatalogProductEditorSnapshot(
    {
      productReference: id,
      brandReference: id,
      internalCode: "SYNTHETIC_EDITOR",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id,
      updatedAt: at,
      draft: {
        versionReference: id,
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic editor" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: { "en-CA": "Synthetic full content" },
          preparationNotes: {},
          tagReferences: [],
          attributeValues: [],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    },
    { tenantReference: id, brandReference: id },
    { productReference: id, expectedAggregateVersion: 1 },
    at,
  );
}
const editorRequest = { productReference: id, expectedAggregateVersion: 1 };
it("returns closed complete owning editor content with exact private scope and no-store", async () => {
  const view = fullEditorView(),
    read = vi.fn(async () => view),
    url = (await serve(undefined, { productEditor: read })).replace(/publication$/, "editor"),
    response = await submit(url, { method: "POST", headers, body: JSON.stringify(editorRequest) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual(view);
  expect(read).toHaveBeenCalledWith({
    sessionCookie: cookie,
    csrf,
    query: editorRequest,
    expectedScope,
  });
});
it("refuses missing editor source without an empty editable fallback", async () => {
  const url = (await serve()).replace(/publication$/, "editor"),
    response = await submit(url, { method: "POST", headers, body: JSON.stringify(editorRequest) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "product_editor_unavailable" });
});
it.each([
  { ...editorRequest, clientReady: true },
  {},
  { ...editorRequest, expectedAggregateVersion: 0 },
])("refuses closed editor request before configured source %#", async (query) => {
  const read = vi.fn(async () => fullEditorView()),
    url = (await serve(undefined, { productEditor: read })).replace(/publication$/, "editor"),
    response = await submit(url, { method: "POST", headers, body: JSON.stringify(query) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "product_editor_invalid" });
  expect(read).not.toHaveBeenCalled();
});
it.each(["extra", "digest", "qualification", "root", "product", "brand"])(
  "rejects malformed or rebound editor source %s without payload echo",
  async (mode) => {
    const view = fullEditorView();
    let value: unknown = view;
    if (mode === "extra") value = { ...view, privateSource: "Synthetic private marker" };
    if (mode === "digest") value = { ...view, digest: "sha256:" + "0".repeat(64) };
    if (mode === "qualification") value = { ...view, eligibility: "Eligible" };
    if (["root", "product", "brand"].includes(mode)) {
      const aggregate = structuredClone(view.aggregate);
      const other = "01900000-0000-7000-8000-000000000002";
      Object.assign(
        aggregate,
        mode === "root"
          ? { aggregateVersion: 2 }
          : mode === "product"
            ? { productReference: other }
            : { brandReference: other },
      );
      value = buildCatalogProductEditorSnapshot(
        aggregate,
        { tenantReference: id, brandReference: aggregate.brandReference },
        {
          productReference: aggregate.productReference,
          expectedAggregateVersion: aggregate.aggregateVersion,
        },
        view.observedAt,
      );
    }
    const url = (await serve(undefined, { productEditor: (async () => value) as never })).replace(
        /publication$/,
        "editor",
      ),
      response = await submit(url, {
        method: "POST",
        headers,
        body: JSON.stringify(editorRequest),
      });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "product_editor_unavailable" });
  },
);
it.each([
  ["CATALOG_PERMISSION_DENIED", 403, "request_denied"],
  ["CATALOG_DEPENDENCY_UNAVAILABLE", 503, "product_editor_unavailable"],
] as const)("redacts editor %s failure", async (code, status, error) => {
  const url = (
      await serve(undefined, {
        productEditor: async () => {
          throw new CatalogError(code);
        },
      })
    ).replace(/publication$/, "editor"),
    response = await submit(url, { method: "POST", headers, body: JSON.stringify(editorRequest) });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
});
it.each(["origin", "csrf", "scope", "query", "get"])(
  "blocks editor transport %s before source",
  async (mode) => {
    const read = vi.fn(async () => fullEditorView()),
      url = (await serve(undefined, { productEditor: read })).replace(/publication$/, "editor"),
      h = { ...headers };
    if (mode === "origin") h.origin = "https://foreign.invalid";
    if (mode === "csrf") delete (h as Partial<typeof h>)["x-bop-csrf"];
    if (mode === "scope") delete (h as Partial<typeof h>)["x-bop-catalog-scope"];
    const response = await submit(url + (mode === "query" ? "?productReference=" + id : ""), {
      method: mode === "get" ? "GET" : "POST",
      headers: h,
      body: JSON.stringify(editorRequest),
    });
    expect(response.status).not.toBe(200);
    expect(read).not.toHaveBeenCalled();
  },
);
