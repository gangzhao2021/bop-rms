import { request } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMerchantBffRouter,
  type MerchantBffRouterOptions,
  type MerchantBffService,
} from "./merchant-bff.js";
import { fullSignInMutationPaths } from "./merchant-staff-pin-http.js";
import { MerchantTaxClassificationError } from "./merchant-tax-classifications.js";

// Real localhost BFF transport with controlled port results (no IAM or database).
const cookie = Buffer.alloc(32, 3).toString("base64url"),
  csrf = Buffer.alloc(32, 4).toString("base64url");
const servers: ReturnType<express.Express["listen"]>[] = [];
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
async function serve(port: MerchantBffRouterOptions["taxClassifications"]) {
  const unused = async (): Promise<never> => {
    throw new Error("UNRELATED_TEST_PORT_UNAVAILABLE");
  };
  const service: MerchantBffService = {
    start: unused,
    callback: unused,
    bootstrap: unused,
    authorize: unused,
    logout: unused,
    switchStore: unused,
  };
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
      ...(port ? { taxClassifications: port } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
  return (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: unknown; cache: unknown }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/merchant" + path,
          method: "POST",
          headers: {
            host: "merchant.invalid",
            origin: "https://merchant.invalid",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
            cookie: "__Host-bop-merchant=" + cookie,
            "x-bop-csrf": csrf,
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              cache: response.headers["cache-control"],
            }),
          );
        },
      );
      req.once("error", reject);
      req.end(payload);
    });
}

it("WP-2423: a tax classification change on an unconfirmed PIN sign-in needs a full sign-in", () => {
  expect(fullSignInMutationPaths.has("/commerce/tax-classifications/command")).toBe(true);
  expect(fullSignInMutationPaths.has("/commerce/tax-classifications/query")).toBe(false);
});

it("WP-2423: reads and changes the Brand's tax classifications through closed routes", async () => {
  const view = { screenId: "CAT-TAX-CLASSIFICATION-LIST", classifications: [] };
  const port = {
    query: vi.fn(async () => view),
    command: vi.fn(async () => ({ status: "Applied", view })),
  };
  const post = await serve(port as never);
  expect(await post("/commerce/tax-classifications/query", {})).toEqual({
    status: 200,
    body: view,
    cache: "no-store",
  });
  expect(port.query).toHaveBeenCalledWith({ sessionCookie: cookie, csrf });
  const body = { action: "Add" };
  expect((await post("/commerce/tax-classifications/command", body)).status).toBe(200);
  expect(port.command).toHaveBeenCalledWith({ sessionCookie: cookie, csrf, body });
  // A query carries no fields; a missing CSRF header is refused before the port.
  expect((await post("/commerce/tax-classifications/query", { extra: 1 })).status).toBe(403);
  expect(
    (await post("/commerce/tax-classifications/command", body, { "x-bop-csrf": "" })).status,
  ).toBe(403);
  expect(port.command).toHaveBeenCalledTimes(1);
});

it("WP-2423: maps refusals to plain closed answers and hides other failures", async () => {
  const cases = [
    ["PermissionDenied", 403],
    ["Invalid", 400],
    ["NotFound", 404],
    ["NameTaken", 409],
    ["Retired", 409],
    ["Conflict", 409],
    ["Unavailable", 503],
  ] as const;
  for (const [code, status] of cases) {
    const post = await serve({
      query: vi.fn(async () => {
        throw new MerchantTaxClassificationError(code);
      }),
      command: vi.fn(),
    } as never);
    expect(await post("/commerce/tax-classifications/query", {})).toEqual({
      status,
      body: { error: code },
      cache: "no-store",
    });
  }
  const conflict = await serve({
    query: vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });
    }),
    command: vi.fn(),
  } as never);
  expect(await conflict("/commerce/tax-classifications/query", {})).toMatchObject({
    status: 503,
    body: { error: "retry_later" },
  });
  const secret = await serve({
    query: vi.fn(async () => {
      throw new Error("relation rms_catalog.secret does not exist");
    }),
    command: vi.fn(),
  } as never);
  expect(await secret("/commerce/tax-classifications/query", {})).toEqual({
    status: 503,
    body: { error: "Unavailable" },
    cache: "no-store",
  });
  const absent = await serve(undefined);
  expect((await absent("/commerce/tax-classifications/query", {})).status).toBe(503);
});
