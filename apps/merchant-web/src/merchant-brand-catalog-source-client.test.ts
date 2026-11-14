import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandCatalogSourceClient,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceRegister,
  brandCatalogSourceIntentDigest,
  type PreparedBrandCatalogSource,
} from "./merchant-brand-catalog-source-client.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  csrf = "c".repeat(43);
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const prepare = (operationReference = id(4)) =>
  createMerchantBrandCatalogSourceClient().prepare(scope, {
    operationReference,
    code: " menu ",
    label: " Catalogue ",
  });
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function source(p: PreparedBrandCatalogSource) {
  return {
    profile: "BrandCatalogSourceRegisteredIdentityV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    sourceReference: id(5),
    code: p.command.code,
    label: p.command.label,
    registeredByReference: scope.actorReference,
    operationReference: p.command.operationReference,
    auditReference: id(6),
    registeredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
function packet(value: unknown = null, reader = scope) {
  return {
    profile: "BrandCatalogSourceCurrentV1",
    ...reader,
    source: value,
    observedAt: at,
    validUntil: until,
    publicationStatus: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
  };
}
function terminal(p: PreparedBrandCatalogSource, abandoned = false) {
  return {
    profile: "BrandCatalogSourceReceiptV1",
    ...scope,
    operationReference: p.cursor.operationReference,
    intentDigest: p.cursor.intentDigest,
    outcome: abandoned ? "Abandoned" : "Committed",
    originalCommand: abandoned ? null : p.command,
    source: abandoned ? null : source(p),
    auditReference: id(6),
    occurredAt: at,
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("matches the full owning Register digest after normalization and keeps scalar Resolve only", async () => {
  const p = await prepare();
  expect(p.command.code).toBe("MENU");
  expect(p.command.label).toBe("Catalogue");
  expect(p.cursor.intentDigest).toBe(
    "sha256:a67c2c22c564abf5fd340f8a1a744ca4dffe50fd94004c1e7dafa35aa45a73c8",
  );
  expect(p.cursor.intentDigest).toBe(await brandCatalogSourceIntentDigest(p.command));
  expect(Object.keys(p.cursor).sort()).toEqual(
    [
      "profile",
      "tenantReference",
      "brandReference",
      "actorReference",
      "operationReference",
      "intentDigest",
    ].sort(),
  );
  const getter = vi.fn(() => "Catalogue");
  expect(() =>
    parseBrandCatalogSourceRegister(
      Object.defineProperty({ ...p.command }, "label", { enumerable: true, get: getter }),
    ),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseBrandCatalogSourceRegister({ ...p.command, label: "😀".repeat(101) }),
  ).toThrow();
  expect(() => parseBrandCatalogSourceRegister({ ...p.command, label: "bad\u0001" })).toThrow();
});
it("reads with the actual current Actor while retaining the historical registrant and rejects stale or qualified packets", async () => {
  const p = await prepare(),
    reader = { ...scope, actorReference: id(9) };
  expect(
    parseBrandCatalogSourceCurrent(packet(source(p), reader), reader, at).source
      ?.registeredByReference,
  ).toBe(scope.actorReference);
  for (const change of [
    { validUntil: at },
    { observedAt: until },
    { validUntil: "2026-10-06T10:00:06.000Z" },
    { publicationStatus: "Published" },
    { referenceEligibility: "Eligible" },
  ])
    expect(() => parseBrandCatalogSourceCurrent({ ...packet(), ...change }, scope, at)).toThrow();
  expect(() => parseBrandCatalogSourceCurrent(packet(), reader, at)).toThrow();
  expect(() =>
    parseBrandCatalogSourceExact(
      {
        ...packet(source(p)),
        profile: "BrandCatalogSourceExactV1",
        requestedSourceReference: id(8),
      },
      scope,
      id(8),
      at,
    ),
  ).toThrow();
});
it("validates original/source/Audit reciprocity and never reconstructs Abandoned bodies", async () => {
  const p = await prepare();
  expect((await parseBrandCatalogSourceReceipt(terminal(p), p.cursor)).outcome).toBe("Committed");
  for (const change of [
    { intentDigest: "sha256:" + "a".repeat(64) },
    { source: { ...source(p), registeredByReference: id(9) } },
    { auditReference: id(9) },
    { originalCommand: { ...p.command, label: "Changed" } },
  ])
    await expect(
      parseBrandCatalogSourceReceipt({ ...terminal(p), ...change }, p.cursor),
    ).rejects.toThrow();
  const abandoned = await parseBrandCatalogSourceReceipt(terminal(p, true), p.cursor);
  expect(abandoned.originalCommand).toBeNull();
  expect(abandoned.source).toBeNull();
  await expect(
    parseBrandCatalogSourceReceipt({ ...terminal(p, true), originalCommand: p.command }, p.cursor),
  ).rejects.toThrow();
});
it("uses the actual fixed HTTP routes with same-origin CSRF and no browser authority fields", async () => {
  const p = await prepare(),
    fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(url).split("/").pop();
      if (path === "current") return response(packet(source(p)));
      if (path === "exact")
        return response({
          ...packet(source(p)),
          profile: "BrandCatalogSourceExactV1",
          requestedSourceReference: id(5),
        });
      return response(terminal(p));
    });
  const client = createMerchantBrandCatalogSourceClient(fetcher);
  await client.current(scope, { csrf });
  await client.exact(scope, id(5), { csrf });
  await client.execute(p, { csrf });
  await client.resolve(p.cursor, { csrf });
  expect(fetcher.mock.calls.map(([url]) => String(url).split("/").pop())).toEqual([
    "current",
    "exact",
    "register",
    "resolve",
  ]);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[2]).toEqual({
    brandReference: scope.brandReference,
    command: { operationReference: id(4), code: "MENU", label: "Catalogue" },
  });
  expect(bodies[3]).toEqual({
    brandReference: scope.brandReference,
    original: { operationReference: id(4), intentDigest: p.cursor.intentDigest },
  });
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      method: "POST",
    });
    expect(init?.headers).toMatchObject({ "X-BOP-CSRF": csrf });
  }
});
it("keeps lost or malformed write responses unknown, maps actual denial and refuses changed intent before dispatch", async () => {
  const p = await prepare(),
    lost = vi.fn(async () => {
      throw new Error("controlled loss");
    });
  await expect(
    createMerchantBrandCatalogSourceClient(lost).execute(p, { csrf }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(
    createMerchantBrandCatalogSourceClient(async () => response({}, 403)).current(scope, { csrf }),
  ).rejects.toMatchObject({ code: "Denied" });
  await expect(
    createMerchantBrandCatalogSourceClient(lost).execute(
      { ...p, command: { ...p.command, label: "Changed" } },
      { csrf },
    ),
  ).rejects.toThrow();
  expect(lost).toHaveBeenCalledTimes(1);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    createMerchantBrandCatalogSourceClient(lost).current(scope, { csrf, signal: aborted.signal }),
  ).rejects.toThrow();
  expect(lost).toHaveBeenCalledTimes(1);
});
it("invalidates an in-flight observation on a scope change", async () => {
  let release: (value: Response) => void = () => undefined;
  const client = createMerchantBrandCatalogSourceClient(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const promise = client.current(scope, { csrf });
  client.invalidate();
  release(response(packet()));
  await expect(promise).rejects.toMatchObject({ code: "ScopeChanged" });
});
