import { afterEach, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { BrandStoreTopologyError } from "@bop/tenant";
import { MerchantBrandStoreTopologyFeatureDisabled } from "./merchant-brand-store-topology-capability.js";
import { createApp } from "./app.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { createMerchantBrandStoreTopologyDraft } from "./merchant-brand-store-topology-draft.js";
// Actual HTTP transport with controlled services; no current Session/IAM or persisted workflow claim.
const id = (n: number) => `01902421-1510-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
function workspace() {
  return {
    profile: "BrandStoreTopologyWorkbenchV1" as const,
    ...scope,
    current: {
      profile: "BrandStoreTopologyCurrentV1" as const,
      ...scope,
      current: null,
      observedAt: at,
      validUntil: until,
    },
    history: [],
    stores: {
      profile: "TenantStoreLabelReferenceV1" as const,
      brandReference: scope.brandReference,
      brandLifecycle: "Active" as const,
      brandVersion: "1",
      generation: "0",
      referenceCount: "0",
      originalIntentDigest: "sha256:" + "a".repeat(64),
      observedAt: at,
      references: [],
    },
    observedAt: at,
    validUntil: until,
    status: "DraftOnly" as const,
  };
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});
async function fixture(
  port?: ReturnType<typeof createMerchantBrandStoreTopologyDraft>,
  now = () => at,
) {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const service: MerchantBffService = {
    start: unused,
    callback: unused,
    logout: unused,
    bootstrap: unused,
    authorize: unused,
    switchStore: unused,
  };
  const app = createApp({
    merchantBff: {
      service,
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      ...(port ? { brandStoreTopologyDraft: port, brandStoreTopologyClock: { now } } : {}),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  return address.port;
}
function send(
  port: number,
  path = "workspace",
  body: unknown = { expectedBrandReference: scope.brandReference },
  overrides: Record<string, string> = {},
) {
  return new Promise<{ status: number; cache: string | undefined; body: unknown }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/merchant/organization/brands/topology/draft/" + path,
          method: "POST",
          headers: {
            Host: "merchant.invalid",
            Origin: "https://merchant.invalid",
            "Sec-Fetch-Site": "same-origin",
            Cookie: "__Host-bop-merchant=" + Buffer.alloc(32, 2).toString("base64url"),
            "X-BOP-CSRF": Buffer.alloc(32, 1).toString("base64url"),
            "Content-Type": "application/json",
            ...overrides,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.once("error", reject);
          res.once("end", () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                cache: res.headers["cache-control"],
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}
function controlled() {
  const read = vi.fn(async () => workspace());
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return { read, port: { workspace: read, save: unused, resolve: unused } };
}
it("returns a closed complete current workspace and forwards actual credential and route pin", async () => {
  const f = controlled(),
    r = await send(await fixture(f.port));
  expect(r).toEqual({ status: 200, cache: "no-store", body: workspace() });
  expect(f.read).toHaveBeenCalledWith({
    sessionCookie: Buffer.alloc(32, 2).toString("base64url"),
    csrf: Buffer.alloc(32, 1).toString("base64url"),
    expectedBrandReference: scope.brandReference,
  });
});
it.each([
  { Origin: "https://foreign.invalid" },
  { Host: "foreign.invalid" },
  { "X-BOP-CSRF": "bad" },
  { "Sec-Fetch-Site": "cross-site" },
])("refuses untrusted transport without calling business source %j", async (headers) => {
  const f = controlled();
  expect((await send(await fixture(f.port), "workspace", undefined, headers)).status).toBe(403);
  expect(f.read).not.toHaveBeenCalled();
});
it.each([
  { expectedBrandReference: scope.brandReference, extra: true },
  { expectedBrandReference: "invalid" },
  {
    expectedBrandReference: scope.brandReference,
    expectedScope: { ...scope, brandReference: id(9) },
  },
])("refuses open or conflicting request fields %j", async (body) => {
  const f = controlled();
  expect((await send(await fixture(f.port), "workspace", body)).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("rejects a valid foreign Brand workspace instead of leaking its output", async () => {
  const f = controlled();
  expect(
    (await send(await fixture(f.port), "workspace", { expectedBrandReference: id(9) })).body,
  ).toEqual({ error: "brand_store_topology_unavailable" });
});
it("fails closed for absent composition", async () =>
  expect((await send(await fixture())).body).toEqual({
    error: "brand_store_topology_unavailable",
  }));
it.each([
  [new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED"), 403, "request_denied"],
  [
    new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT"),
    409,
    "brand_store_topology_conflict",
  ],
  [new MerchantBrandStoreTopologyFeatureDisabled(), 503, "brand_store_topology_feature_disabled"],
  [new Error("private synthetic detail"), 503, "brand_store_topology_unavailable"],
] as const)("preserves finite owning failure %s", async (error, status, message) => {
  const f = controlled();
  f.read.mockRejectedValue(error);
  expect(await send(await fixture(f.port))).toEqual({
    status,
    cache: "no-store",
    body: { error: message },
  });
});

it("refuses an expired source envelope against the trusted server clock", async () => {
  const f = controlled();
  expect((await send(await fixture(f.port, () => "2026-10-06T12:00:06.000Z"))).body).toEqual({
    error: "brand_store_topology_unavailable",
  });
});
