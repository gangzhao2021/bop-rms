import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createSellingUnitRecoveryClient,
  parseSellingUnitCursor,
} from "./selling-unit-recovery-client.js";
const id = (n: number) => "019a2421-0018-7000-8000-" + n.toString(16).padStart(12, "0"),
  csrf = "c".repeat(43),
  at = "2026-10-04T12:00:00.000Z",
  hash = "sha256:" + "1".repeat(64),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(5),
  };
const cursor = () =>
  parseSellingUnitCursor(
    {
      profile: "CatalogSellingUnitRegistrationCursorV1",
      scope,
      action: "Create",
      operationReference: id(8),
      expectedRegistryVersion: 0,
    },
    scope,
  );
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function terminal(outcome: "Committed" | "Abandoned") {
  const body = {
    profile: "CatalogSellingUnitRegistrationResolutionV1",
    outcome,
    command: {
      profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: scope.actorReference,
      action: "Create",
      operationReference: id(8),
      expectedRegistryVersion: 0,
    },
    registryReference: outcome === "Committed" ? id(9) : null,
    versionReference: outcome === "Committed" ? id(10) : null,
    registryVersion: outcome === "Committed" ? 1 : null,
    originalIntentDigest: outcome === "Committed" ? hash : null,
    snapshotDigest: outcome === "Committed" ? hash : null,
    recordedAt: at,
  };
  return {
    profile: "CatalogSellingUnitRegistrationResolutionResultV1",
    storeReference: scope.storeReference,
    resolution: {
      ...body,
      digest: "sha256:" + createHash("sha256").update(canonical(body)).digest("hex"),
    },
  };
}
it("context uses fixed action, same-origin scoped POST and actual current Actor", async () => {
  const transport = vi.fn(
      async (_url: RequestInfo | URL) => (
        void _url,
        response({
          profile: "CatalogSellingUnitRegistrationContextV1",
          ...scope,
          action: "Create",
          observedAt: at,
          validUntil: "2026-10-04T12:00:05.000Z",
        })
      ),
    ),
    client = createSellingUnitRecoveryClient(transport, () => Date.parse(at));
  await expect(
    client.context("Create", scope, csrf, new AbortController().signal),
  ).resolves.toMatchObject(scope);
  expect(transport.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/selling-units/context");
});
for (const outcome of ["Committed", "Abandoned"] as const)
  it(`resolution verifies exact ${outcome} original identity and immutable digest`, async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        profile: "CatalogSellingUnitRegistrationResolutionRequestV1",
        tenantReference: scope.tenantReference,
        actorReference: scope.actorReference,
        action: "Create",
        operationReference: id(8),
        expectedRegistryVersion: 0,
      });
      return response(terminal(outcome));
    });
    await expect(
      createSellingUnitRecoveryClient(transport).resolve(
        cursor(),
        csrf,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome, registryVersion: outcome === "Committed" ? 1 : null });
  });
for (const corruption of ["Actor", "Operation", "Digest", "Terminal"] as const)
  it(`rejects ${corruption} rebinding without accepting a terminal receipt`, async () => {
    const value = terminal("Committed");
    if (corruption === "Actor") value.resolution.command.actorReference = id(99);
    if (corruption === "Operation") value.resolution.command.operationReference = id(99);
    if (corruption === "Digest") value.resolution.digest = hash;
    if (corruption === "Terminal") value.resolution.registryVersion = null;
    await expect(
      createSellingUnitRecoveryClient(async () => response(value)).resolve(
        cursor(),
        csrf,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
it("cursor rejects payload expansion and another Actor, and context rejects expiry or denied access", async () => {
  expect(() => parseSellingUnitCursor({ ...cursor(), units: [] }, scope)).toThrow();
  expect(() => parseSellingUnitCursor(cursor(), { ...scope, actorReference: id(99) })).toThrow();
  await expect(
    createSellingUnitRecoveryClient(async () => response({ error: "request_denied" }, 403)).context(
      "Create",
      scope,
      csrf,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "Denied" });
  await expect(
    createSellingUnitRecoveryClient(
      async () =>
        response({
          profile: "CatalogSellingUnitRegistrationContextV1",
          ...scope,
          action: "Create",
          observedAt: at,
          validUntil: "2026-10-04T12:00:05.000Z",
        }),
      () => Date.parse(at) + 5000,
    ).context("Create", scope, csrf, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Stale" });
});
