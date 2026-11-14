// Real browser protocol under controlled HTTP/atomic journal ports, not live IAM.
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrandStoreTopologyDraftPanel,
  prepareBrandTopologyOriginal,
  finishBrandTopologyOriginal,
} from "./BrandStoreTopologyDraftPanel.js";
import {
  createMerchantBrandStoreTopologyClient,
  parseBrandTopologyWorkspace,
  type BrandTopologyCursor,
} from "./merchant-brand-store-topology-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  csrf = "c".repeat(43),
  hash = `sha256:${"a".repeat(64)}`;
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) },
  draft = {
    profile: "BrandStoreTopologyDraftV1" as const,
    tenantReference: id(1),
    brandReference: id(2),
    draftReference: id(4),
    selectors: [],
    assignments: [],
  };
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const stores = {
  profile: "TenantStoreLabelReferenceV1",
  brandReference: id(2),
  brandLifecycle: "Active",
  brandVersion: "1",
  generation: "0",
  referenceCount: "0",
  originalIntentDigest: hash,
  observedAt: at,
  references: [],
};
function workspace(snapshot: unknown = null) {
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
    history: snapshot ? [snapshot] : [],
    stores,
    observedAt: at,
    validUntil: until,
    status: "DraftOnly",
  };
}
function journal() {
  let cursor: BrandTopologyCursor | null = null;
  const log: string[] = [];
  return {
    log,
    get cursor() {
      return cursor;
    },
    port: {
      load: async () => cursor,
      reserve: vi.fn(async (value: BrandTopologyCursor) => {
        log.push("reserve");
        if (cursor && canonical(cursor) !== canonical(value)) throw new Error("Competing original");
        cursor = value;
      }),
      complete: vi.fn(async () => {
        log.push("complete");
        cursor = null;
      }),
    },
  };
}
async function ledger() {
  let current = workspace(),
    receipt: unknown;
  const requests: string[] = [];
  let lose = false;
  const client = createMerchantBrandStoreTopologyClient(async (url, init) => {
    const path = String(url).split("/").pop();
    if (!path) throw new Error("Missing path");
    requests.push(path);
    const input = JSON.parse(String(init?.body));
    if (path === "workspace") return response(current);
    if (path === "save") {
      const command = input.command,
        body = {
          profile: "BrandStoreTopologyDraftRevisionV1",
          ...scope,
          revision: 1,
          content: command.content,
          operationReference: command.operationReference,
          auditReference: id(8),
          createdAt: at,
          updatedAt: at,
          dataClassification: "ConfigurationMetadata",
        },
        snapshot = { ...body, snapshotDigest: await digest(body) };
      receipt = {
        profile: "BrandStoreTopologyOperationV1",
        ...scope,
        operationReference: command.operationReference,
        expectedRevision: command.expectedRevision,
        intentDigest: await digest(command),
        outcome: "Committed",
        snapshot,
        auditReference: id(8),
        occurredAt: at,
        dataClassification: "ConfigurationMetadata",
      };
      current = workspace(snapshot);
      if (lose) throw new Error("Controlled lost response");
      return response(receipt);
    }
    if (path === "resolve") return response(receipt);
    throw new Error("Unexpected controlled route");
  });
  return {
    client,
    requests,
    setLose: () => {
      lose = true;
    },
    setCurrent: (value: ReturnType<typeof workspace>) => {
      current = value;
    },
    baseline: await parseBrandTopologyWorkspace(current, id(2), scope),
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("renders the real ordinary Draft-only region and excludes unsupported approval controls", () => {
  const html = renderToStaticMarkup(
    <BrandStoreTopologyDraftPanel expectedBrandReference={id(2)} csrf={csrf} />,
  );
  expect(html).toContain('aria-label="Brand Store topology draft"');
  expect(html).toContain("not effective membership");
  expect(html).toContain("Loading topology draft");
  expect(html).not.toContain("Publish topology");
});
it("fresh source check precedes reservation; original receipt and postwrite workspace precede cleanup", async () => {
  const l = await ledger(),
    j = journal(),
    controller = new AbortController();
  const result = await prepareBrandTopologyOriginal({
    client: l.client,
    journal: j.port,
    workspace: l.baseline,
    content: draft,
    csrf,
    signal: controller.signal,
    isCurrent: () => true,
    onReserved: vi.fn(),
  });
  expect(l.requests).toEqual(["workspace", "save", "workspace"]);
  expect(j.log).toEqual(["reserve", "complete"]);
  expect(result.current.current?.revision).toBe(1);
  expect(j.cursor).toBeNull();
});
it("lost reply retains original and reload resolves before reading today's source", async () => {
  const l = await ledger(),
    j = journal(),
    controller = new AbortController();
  l.setLose();
  await expect(
    prepareBrandTopologyOriginal({
      client: l.client,
      journal: j.port,
      workspace: l.baseline,
      content: draft,
      csrf,
      signal: controller.signal,
      isCurrent: () => true,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = j.cursor;
  if (!cursor) throw new Error("Missing durable original");
  expect(j.port.complete).not.toHaveBeenCalled();
  l.requests.length = 0;
  const result = await finishBrandTopologyOriginal({
    client: l.client,
    journal: j.port,
    scope,
    cursor,
    csrf,
    signal: controller.signal,
    isCurrent: () => true,
  });
  expect(l.requests).toEqual(["resolve", "workspace"]);
  expect(result.current.current?.revision).toBe(1);
  expect(j.cursor).toBeNull();
});
it("changed current head prevents a new operation and journal reservation", async () => {
  const l = await ledger(),
    j = journal(),
    body = {
      profile: "BrandStoreTopologyDraftRevisionV1",
      ...scope,
      revision: 1,
      content: draft,
      operationReference: id(20),
      auditReference: id(21),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    };
  l.setCurrent(workspace({ ...body, snapshotDigest: await digest(body) }));
  await expect(
    prepareBrandTopologyOriginal({
      client: l.client,
      journal: j.port,
      workspace: l.baseline,
      content: draft,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => true,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(j.port.reserve).not.toHaveBeenCalled();
  expect(l.requests).toEqual(["workspace"]);
});
it("scope invalidation after reserve preserves original without dispatch or cleanup", async () => {
  const l = await ledger(),
    j = journal();
  let current = true;
  await expect(
    prepareBrandTopologyOriginal({
      client: l.client,
      journal: j.port,
      workspace: l.baseline,
      content: draft,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => current,
      onReserved: () => {
        current = false;
      },
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(j.cursor).not.toBeNull();
  expect(j.port.complete).not.toHaveBeenCalled();
  expect(l.requests).toEqual(["workspace"]);
});
