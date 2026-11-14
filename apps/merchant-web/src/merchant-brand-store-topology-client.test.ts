// Controlled HTTP; actual Session/IAM/PG acceptance is separate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandStoreTopologyClient,
  parseBrandTopologyWorkspace,
  validateBrandTopologyReceipt,
  parseBrandTopologyCursor,
} from "./merchant-brand-store-topology-client.js";
import { publicationValueDigest as digest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  csrf = "c".repeat(43),
  hash = `sha256:${"a".repeat(64)}`;
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const draft = () => ({
  profile: "BrandStoreTopologyDraftV1",
  tenantReference: id(1),
  brandReference: id(2),
  draftReference: id(4),
  selectors: [{ kind: "Region", reference: id(5), code: "NORTH", name: "North region" }],
  assignments: [{ storeReference: id(6), selectorReference: id(5) }],
});
const command = () => ({
  profile: "BrandStoreTopologySaveV1",
  ...scope,
  operationReference: id(7),
  expectedRevision: 0,
  content: draft(),
});
async function fixture(author = id(3)) {
  const content = draft(),
    body = {
      profile: "BrandStoreTopologyDraftRevisionV1",
      ...scope,
      actorReference: author,
      revision: 1,
      content,
      operationReference: id(7),
      auditReference: id(8),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    };
  const snapshot = { ...body, snapshotDigest: await digest(body) };
  return {
    profile: "BrandStoreTopologyWorkbenchV1",
    ...scope,
    current: {
      profile: "BrandStoreTopologyCurrentV1",
      ...scope,
      current: snapshot,
      observedAt: at,
      validUntil: until,
    },
    history: [snapshot],
    stores: {
      profile: "TenantStoreLabelReferenceV1",
      brandReference: id(2),
      brandLifecycle: "Active",
      brandVersion: "1",
      generation: "1",
      referenceCount: "1",
      originalIntentDigest: hash,
      observedAt: at,
      references: [
        {
          storeReference: id(6),
          lifecycle: "Suspended",
          version: "1",
          createdAt: at,
          updatedAt: at,
          code: "NORTH",
          displayName: "Synthetic North Store",
        },
      ],
    },
    observedAt: at,
    validUntil: until,
    status: "DraftOnly",
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses actual closed readonly POST and preserves reader separate from saved author", async () => {
  const f = await fixture(id(20)),
    fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url;
      void _init;
      return response(f);
    }),
    client = createMerchantBrandStoreTopologyClient(fetcher);
  const value = await client.workspace({ expectedBrandReference: id(2) }, { csrf });
  expect(value.current.current?.actorReference).toBe(id(20));
  expect(value.actorReference).toBe(id(3));
  expect(value.stores.references[0]?.lifecycle).toBe("Suspended");
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("Missing request");
  const init = call[1] as RequestInit;
  expect(call[0]).toBe("/merchant/organization/brands/topology/draft/workspace");
  expect(init).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(JSON.parse(String(init.body))).toEqual({ expectedBrandReference: id(2) });
  expect(init.headers).toMatchObject({ "X-BOP-CSRF": csrf });
});
it("verifies full canonical original and immutable snapshot and sends payload-free Resolve", async () => {
  const f = await fixture(),
    snapshot = f.current.current,
    p = await createMerchantBrandStoreTopologyClient().prepare(scope, command());
  const receipt = {
    profile: "BrandStoreTopologyOperationV1",
    ...scope,
    operationReference: id(7),
    expectedRevision: 0,
    intentDigest: p.cursor.intentDigest,
    outcome: "Committed",
    snapshot,
    auditReference: id(8),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const calls: unknown[] = [];
  const client = createMerchantBrandStoreTopologyClient(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return response(receipt);
  });
  expect(await client.execute(p, { csrf })).toEqual(await client.resolve(p.cursor, { csrf }));
  expect(calls[1]).toEqual({ expectedScope: scope, command: p.cursor });
  expect(JSON.stringify(calls[1])).not.toContain("North region");
  expect(Object.isFrozen(p.command.content.selectors[0])).toBe(true);
});
it("rejects foreign scope, stale observations, wrong latest/history and malformed label roster", async () => {
  const f = await fixture();
  for (const change of [
    { actorReference: id(50) },
    { validUntil: at },
    { history: [] },
    { stores: { ...f.stores, referenceCount: "2" } },
    { stores: { ...f.stores, references: [...f.stores.references, ...f.stores.references] } },
    { status: "Published" },
  ])
    await expect(
      parseBrandTopologyWorkspace({ ...f, ...change }, id(2), scope),
    ).rejects.toBeInstanceOf(Error);
});
it("refuses forged snapshot hash and command-body conflict despite matching operation metadata", async () => {
  const f = await fixture(),
    p = await createMerchantBrandStoreTopologyClient().prepare(scope, command());
  const body = {
    profile: "BrandStoreTopologyOperationV1",
    ...scope,
    operationReference: id(7),
    expectedRevision: 0,
    intentDigest: p.cursor.intentDigest,
    outcome: "Committed",
    snapshot: { ...f.current.current, snapshotDigest: hash },
    auditReference: id(8),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  await expect(validateBrandTopologyReceipt(body, p.cursor)).rejects.toBeInstanceOf(Error);
  const changed = { ...f.current.current, content: { ...draft(), assignments: [] } },
    { snapshotDigest: ignored, ...preimage } = changed;
  void ignored;
  await expect(
    validateBrandTopologyReceipt(
      { ...body, snapshot: { ...changed, snapshotDigest: await digest(preimage) } },
      p.cursor,
    ),
  ).rejects.toBeInstanceOf(Error);
});
it("rejects accessors and sparse membership arrays before network", async () => {
  let touched = false;
  const body = command();
  Object.defineProperty(body, "content", {
    enumerable: true,
    get() {
      touched = true;
      return draft();
    },
  });
  const fetcher = vi.fn();
  const client = createMerchantBrandStoreTopologyClient(fetcher);
  await expect(client.prepare(scope, body)).rejects.toBeInstanceOf(Error);
  expect(touched).toBe(false);
  await expect(
    client.prepare(scope, { ...command(), content: { ...draft(), assignments: new Array(1) } }),
  ).rejects.toBeInstanceOf(Error);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() =>
    parseBrandTopologyCursor({
      profile: "BrandStoreTopologyResolveV1",
      ...scope,
      operationReference: id(7),
      expectedRevision: 0,
      intentDigest: hash,
      content: draft(),
    }),
  ).toThrow();
});
it("maps denial/conflict exactly while unknown sent writes remain unresolved", async () => {
  const p = await createMerchantBrandStoreTopologyClient().prepare(scope, command());
  for (const [status, code] of [
    [403, "Denied"],
    [409, "Conflict"],
    [503, "OutcomeUnknown"],
  ] as const) {
    const client = createMerchantBrandStoreTopologyClient(async () =>
      response({ error: "unavailable" }, status),
    );
    await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code });
  }
  await expect(
    createMerchantBrandStoreTopologyClient(async () => response({}, 503)).workspace(
      { expectedBrandReference: id(2) },
      { csrf },
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("discards in-flight replies after invalidation without accepting changed Actor scope", async () => {
  let release: (value: Response) => void = () => undefined;
  const reply = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = createMerchantBrandStoreTopologyClient(async () => reply),
    pending = client.workspace({ expectedBrandReference: id(2) }, { csrf });
  client.invalidate();
  release(response(await fixture()));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("requires real scope and CSRF and aborts before a request", async () => {
  const fetcher = vi.fn(),
    client = createMerchantBrandStoreTopologyClient(fetcher),
    controller = new AbortController();
  controller.abort();
  await expect(
    client.workspace({ expectedBrandReference: id(2) }, { csrf, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    client.workspace({ expectedBrandReference: id(2) }, { csrf: "invalid" }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("maps actual 503 feature-disabled distinctly for readonly and original writes", async () => {
  const client = createMerchantBrandStoreTopologyClient(async () =>
    response({ error: "brand_store_topology_feature_disabled" }, 503),
  );
  await expect(client.workspace({ expectedBrandReference: id(2) }, { csrf })).rejects.toMatchObject(
    { code: "FeatureDisabled" },
  );
  await expect(
    client.execute(await client.prepare(scope, command()), { csrf }),
  ).rejects.toMatchObject({ code: "FeatureDisabled" });
});
