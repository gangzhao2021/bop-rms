import express from "express";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
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
const id = "01902452-0000-7000-8000-000000000001",
  cookie = "A".repeat(43),
  csrf = "B".repeat(43),
  expectedScope = { brandReference: id, storeReference: id },
  headers = {
    host: "merchant.invalid",
    origin: "https://merchant.invalid",
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-merchant=" + cookie,
    "x-bop-csrf": csrf,
    "x-bop-catalog-scope": Buffer.from(JSON.stringify(expectedScope)).toString("base64url"),
    "content-type": "application/json",
  };
async function serve(
  ports: Pick<
    MerchantBffRouterOptions,
    | "productPublicationV2"
    | "productPublicationManagementV2"
    | "productPublication"
    | "productPublicationManagement"
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
  if (!address || typeof address === "string") throw Error();
  return `http://127.0.0.1:${address.port}/merchant/catalog/products/publication`;
}
async function submit(url: string, value: unknown = {}, override: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Headers; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: "POST", headers: { ...headers, ...override } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const received = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index],
              value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) received.append(name, value);
          }
          resolve({
            status: incoming.statusCode ?? 0,
            headers: received,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(value));
  });
}
it.each(["command", "management"] as const)(
  "forwards only explicit %s V2 port with private scope and no-store",
  async (kind) => {
    const result = {
        profile:
          kind === "command"
            ? "CatalogProductPublicationCommandResultV2"
            : "CatalogProductPublicationManagementV2",
        replacementIntentDigest: "sha256:" + "a".repeat(64),
      },
      value = { profile: "CatalogProductPublicationCommandV2", productReference: id },
      port = vi.fn(async () => result),
      legacy = vi.fn();
    const url = await serve({
      productPublicationV2: port as never,
      productPublicationManagementV2: port as never,
      productPublication: legacy,
      productPublicationManagement: legacy,
    });
    const response = await submit(url + (kind === "command" ? "/v2" : "/management/v2"), value);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual(result);
    expect(port).toHaveBeenCalledExactlyOnceWith({
      sessionCookie: cookie,
      csrf,
      expectedScope,
      [kind === "command" ? "command" : "query"]: value,
    });
    expect(legacy).not.toHaveBeenCalled();
  },
);
it.each(["/v2", "/management/v2"])(
  "refuses absent %s configuration without falling back to V1",
  async (path) => {
    const legacy = vi.fn(),
      url = await serve({ productPublication: legacy, productPublicationManagement: legacy });
    const response = await submit(url + path);
    expect(response.status).toBe(503);
    expect(response.body).toContain("unavailable");
    expect(legacy).not.toHaveBeenCalled();
  },
);
it.each(["/v2", "/management/v2"])(
  "rejects cross-origin/session/CSRF/scope defects before %s dispatch",
  async (path) => {
    const port = vi.fn(),
      url = await serve({ productPublicationV2: port, productPublicationManagementV2: port });
    for (const override of [
      { origin: "https://foreign.invalid" },
      { "sec-fetch-site": "cross-site" },
      { cookie: "" },
      { "x-bop-csrf": "" },
      { "x-bop-csrf": "bad" },
      { "x-bop-catalog-scope": "bad" },
    ]) {
      const response = await submit(url + path, {}, override);
      expect(response.status).toBe(403);
    }
    expect((await submit(url + path + "?productReference=" + id)).status).toBe(403);
    expect(port).not.toHaveBeenCalled();
  },
);
it.each([
  "CATALOG_INPUT_INVALID",
  "CATALOG_PERMISSION_DENIED",
  "CATALOG_VERSION_CONFLICT",
  "CATALOG_IDEMPOTENCY_CONFLICT",
  "CATALOG_LIFECYCLE_CONFLICT",
  "CATALOG_DEPENDENCY_UNAVAILABLE",
] as const)(
  "sanitizes V2 command %s without publication or private diagnostic fields",
  async (code) => {
    const port = async (): Promise<never> => {
      throw new CatalogError(code);
    };
    const url = await serve({ productPublicationV2: port });
    const response = await submit(url + "/v2");
    expect(response.status).toBe(
      code === "CATALOG_INPUT_INVALID"
        ? 400
        : code === "CATALOG_PERMISSION_DENIED"
          ? 403
          : code === "CATALOG_DEPENDENCY_UNAVAILABLE"
            ? 503
            : 409,
    );
    expect(Object.keys(JSON.parse(response.body))).toEqual(["error"]);
    expect(response.body).not.toContain(code);
  },
);
it("sanitizes opaque management errors and keeps V1 separate", async () => {
  const legacy = vi.fn(),
    url = await serve({
      productPublicationManagementV2: async () => {
        throw Error("SYNTHETIC_PRIVATE");
      },
      productPublicationManagement: legacy,
    });
  const response = await submit(url + "/management/v2");
  expect(response.status).toBe(503);
  expect(response.body).not.toContain("SYNTHETIC_PRIVATE");
  expect(legacy).not.toHaveBeenCalled();
});
