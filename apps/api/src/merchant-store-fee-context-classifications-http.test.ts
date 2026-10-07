import { request } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { StoreSetupOperationError } from "@rms/store";
import {
  createMerchantBffRouter,
  type MerchantBffRouterOptions,
  type MerchantBffService,
} from "./merchant-bff.js";
const id = (n: number) => `01902421-100b-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T14:00:00.000Z",
  until = "2026-10-06T14:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const encoded = Buffer.from(JSON.stringify(scope)).toString("base64url"),
  cookie = Buffer.alloc(32, 2).toString("base64url");
const route = "/merchant/store-setup/fee-context-classifications?storeReference=" + id(3);
function choices() {
  return {
    profile: "TaxConfigClassificationChoicesV1" as const,
    ...scope,
    registryReference: id(5),
    versionReference: id(6),
    registryVersion: 1,
    snapshotDigest: "sha256:" + "a".repeat(64),
    defaultLocale: "en-CA",
    choices: [
      {
        classificationReference: id(7),
        code: "SYNTHETIC_MEAL",
        localizedNames: { "en-CA": "Synthetic registered classification" },
        lifecycle: "Active" as const,
      },
    ],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated" as const,
  };
}
// Real localhost BFF transport with explicit controlled public service results.
// This does not prove actual IAM, Catalog eligibility or database persistence.
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
async function serve(
  port: NonNullable<MerchantBffRouterOptions["storeSetup"]>,
  clock?: MerchantBffRouterOptions["storeSetupClock"],
) {
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
      storeSetup: port,
      ...(clock ? { storeSetupClock: clock } : {}),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
  return (path = route, headers: Record<string, string | readonly string[] | undefined> = {}) =>
    new Promise<{ status: number; body: unknown; cache: unknown }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: "GET",
          headers: Object.fromEntries(
            Object.entries({
              host: "merchant.invalid",
              origin: "https://merchant.invalid",
              "sec-fetch-site": "same-origin",
              cookie: "__Host-bop-merchant=" + cookie,
              "x-bop-store-setup-scope": encoded,
              ...headers,
            }).filter(([, value]) => value !== undefined),
          ),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                cache: response.headers["cache-control"],
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.end();
    });
}
function port(
  classifications:
    | ((input: { sessionCookie: unknown; expectedStoreReference: unknown }) => Promise<unknown>)
    | undefined,
): NonNullable<MerchantBffRouterOptions["storeSetup"]> {
  const unused = async (): Promise<never> => {
    throw Error("UNRELATED_TEST_PORT_UNAVAILABLE");
  };
  // Deliberately malformed producer outputs exercise the runtime boundary parser.
  const source = classifications as NonNullable<
    MerchantBffRouterOptions["storeSetup"]
  >["classifications"];
  return { read: unused, write: unused, ...(source ? { classifications: source } : {}) };
}
it("returns exact current registered fee choices pinned to current request scope without claiming qualification", async () => {
  const read = vi.fn(async () => choices()),
    send = await serve(port(read), { now: () => at });
  expect(await send()).toEqual({ status: 200, body: choices(), cache: "no-store" });
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: cookie,
    expectedStoreReference: id(3),
  });
});
it("requires a single scope header, exact Store query and safe read context before source acquisition", async () => {
  const read = vi.fn(async () => choices()),
    send = await serve(port(read), { now: () => at });
  for (const [path, headers] of [
    [route, { "x-bop-store-setup-scope": undefined }],
    [route, { "x-bop-store-setup-scope": [encoded, encoded] }],
    [route + "&extra=x", {}],
    [route, { "sec-fetch-site": "cross-site" }],
    [route, { "x-bop-store-setup-scope": "invalid" }],
  ] as const) {
    const value = await send(path, headers);
    expect([400, 403]).toContain(value.status);
    expect(value.cache).toBe("no-store");
  }
  const other = Buffer.from(JSON.stringify({ ...scope, storeReference: id(8) })).toString(
    "base64url",
  );
  expect((await send(route, { "x-bop-store-setup-scope": other })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it("refuses stale or future choices and all foreign scope fields against the trusted clock", async () => {
  let value: unknown = choices();
  const read = vi.fn(async () => value),
    send = await serve(port(read), { now: () => at });
  for (const change of [
    { observedAt: until, validUntil: "2026-10-06T14:00:10.000Z" },
    { observedAt: "2026-10-06T13:59:55.000Z", validUntil: at },
    ...Object.keys(scope).map((key) => ({ [key]: id(99) })),
    { extra: true },
  ]) {
    value = { ...choices(), ...change };
    expect(await send()).toEqual({
      status: 503,
      body: { error: "store_setup_unavailable" },
      cache: "no-store",
    });
  }
});
it("never evaluates an untrusted output getter", async () => {
  const read = vi.fn(() => choices().choices);
  const value = { ...choices() };
  Object.defineProperty(value, "choices", { enumerable: true, get: read });
  const send = await serve(
    port(async () => value),
    { now: () => at },
  );
  expect((await send()).status).toBe(503);
  expect(read).not.toHaveBeenCalled();
});
it("cannot validate choices using their own lease when the trusted clock or producer is absent", async () => {
  const read = vi.fn(async () => choices());
  expect((await (await serve(port(read)))()).status).toBe(503);
  expect(read).not.toHaveBeenCalled();
  expect((await (await serve(port(undefined), { now: () => at }))()).status).toBe(503);
});
it.each([
  ["STORE_SETUP_OPERATION_PERMISSION_DENIED", 403, "request_denied"],
  ["STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE", 503, "store_setup_unavailable"],
] as const)("keeps %s finite", async (code, status, error) => {
  const send = await serve(
    port(async () => {
      throw new StoreSetupOperationError(code);
    }),
    { now: () => at },
  );
  expect(await send()).toEqual({ status, body: { error }, cache: "no-store" });
});
