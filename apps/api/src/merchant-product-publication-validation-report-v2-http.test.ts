import express from "express";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogProductPublicationValidationReportView } from "@rms/catalog";
import { createMerchantBffRouter, type MerchantBffRouterOptions } from "./merchant-bff.js";

const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
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
const id = (n: number) => "01902496-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  cookie = "A".repeat(43),
  csrf = "B".repeat(43),
  scope = { brandReference: id(2), storeReference: id(3) },
  query = {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 7,
    expectedPublicationVersion: 0,
  },
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  headers = {
    host: "merchant.invalid",
    origin: "https://merchant.invalid",
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-merchant=" + cookie,
    "x-bop-csrf": csrf,
    "x-bop-catalog-scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
    "content-type": "application/json",
  };
function view() {
  const body = {
    profile: "CatalogProductPublicationValidationReportViewV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 7,
    publicationVersion: 0,
    selectedPublicationOperationReference: null,
    selectedPublicationDigest: null,
    currentDraft: {
      versionReference: id(6),
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      contentStatus: "Present",
    },
    status: "NotValidated",
    applicability: "NotValidated",
    report: null,
    observedAt: "2026-10-03T12:00:00.000Z",
    validUntil: "2026-10-03T12:00:05.000Z",
    eligibility: "NotEvaluated",
  };
  return parseCatalogProductPublicationValidationReportView({ ...body, digest: hash(body) });
}
async function serve(
  ports: Pick<
    MerchantBffRouterOptions,
    | "productPublicationValidationReportV2"
    | "productPublicationManagementV2"
    | "productPublicationV2"
    | "productPublicationManagement"
    | "productPublication"
  > = {},
) {
  const unavailable = async (): Promise<never> => {
      throw Error("unconfigured");
    },
    app = express();
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
      ...ports,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing HTTP fixture port");
  return `http://127.0.0.1:${address.port}/merchant/catalog/products/publication/validation-report/v2`;
}
async function submit(
  url: string,
  value: unknown = query,
  override: Record<string, string | string[]> = {},
) {
  return new Promise<{ status: number; headers: Headers; body: string }>((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "POST", headers: { ...headers, ...override } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          const received = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const key = response.rawHeaders[i],
              value = response.rawHeaders[i + 1];
            if (key !== undefined && value !== undefined) received.append(key, value);
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: received,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(value));
  });
}

it("forwards the independent private report query with exact scope and no-store", async () => {
  const result = view(),
    port = vi.fn(async () => result),
    other = vi.fn(async (): Promise<never> => {
      throw Error("Must not dispatch");
    }),
    url = await serve({
      productPublicationValidationReportV2: port,
      productPublicationManagementV2: other,
      productPublicationV2: other,
      productPublicationManagement: other,
      productPublication: other,
    }),
    response = await submit(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.parse(response.body)).toEqual(result);
  expect(port).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    csrf,
    query,
    expectedScope: scope,
  });
  expect(other).not.toHaveBeenCalled();
});
it("returns unavailable for missing optional configuration without falling back to management or commands", async () => {
  const other = vi.fn(async (): Promise<never> => {
      throw Error("Must not dispatch");
    }),
    url = await serve({
      productPublicationManagementV2: other,
      productPublicationV2: other,
      productPublicationManagement: other,
      productPublication: other,
    }),
    response = await submit(url);
  expect(response.status).toBe(503);
  expect(JSON.parse(response.body)).toEqual({
    error: "product_publication_validation_report_unavailable",
  });
  expect(other).not.toHaveBeenCalled();
});
it("rejects origin, session, CSRF, scope and URL query defects before dispatch", async () => {
  const port = vi.fn(async () => view()),
    url = await serve({ productPublicationValidationReportV2: port });
  const invalidHeaders: readonly Record<string, string | string[]>[] = [
    { origin: "https://foreign.invalid" },
    { "sec-fetch-site": "cross-site" },
    { cookie: "" },
    { "x-bop-csrf": "" },
    { "x-bop-csrf": "bad" },
    { "x-bop-catalog-scope": "" },
    { "x-bop-catalog-scope": "bad" },
    { "x-bop-csrf": [csrf, csrf] },
    { "x-bop-catalog-scope": [headers["x-bop-catalog-scope"], headers["x-bop-catalog-scope"]] },
  ];
  for (const override of invalidHeaders)
    expect((await submit(url, query, override)).status).toBe(403);
  expect((await submit(url + "?productReference=" + id(5))).status).toBe(403);
  expect(port).not.toHaveBeenCalled();
});
it.each([
  ["CATALOG_INPUT_INVALID", 400, "product_publication_validation_report_invalid"],
  ["CATALOG_PERMISSION_DENIED", 403, "request_denied"],
  ["CATALOG_VERSION_CONFLICT", 503, "product_publication_validation_report_unavailable"],
  ["CATALOG_DEPENDENCY_UNAVAILABLE", 503, "product_publication_validation_report_unavailable"],
] as const)(
  "sanitizes %s without report or private diagnostic fields",
  async (code, status, error) => {
    const port = async (): Promise<never> => {
        throw new CatalogError(code);
      },
      url = await serve({ productPublicationValidationReportV2: port }),
      response = await submit(url);
    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toEqual({ error });
    expect(response.body).not.toContain(code);
  },
);
it("sanitizes opaque report failures", async () => {
  const url = await serve({
      productPublicationValidationReportV2: async () => {
        throw Error("SYNTHETIC_PRIVATE_REPORT");
      },
    }),
    response = await submit(url);
  expect(response.status).toBe(503);
  expect(response.body).not.toContain("SYNTHETIC_PRIVATE_REPORT");
  expect(JSON.parse(response.body)).toEqual({
    error: "product_publication_validation_report_unavailable",
  });
});
