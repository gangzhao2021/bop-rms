// Controlled atomic IDB event model; browser acceptance uses actual IndexedDB.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createBrandStoreTopologyJournal } from "./brand-store-topology-journal.js";
import {
  createMerchantBrandStoreTopologyClient,
  parseBrandTopologyWorkspace,
  validateBrandTopologyReceipt,
} from "./merchant-brand-store-topology-client.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  hash = `sha256:${"a".repeat(64)}`;
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const draft = () => ({
  profile: "BrandStoreTopologyDraftV1",
  tenantReference: id(1),
  brandReference: id(2),
  draftReference: id(4),
  selectors: [],
  assignments: [],
});
const prepared = (op = id(7)) =>
  createMerchantBrandStoreTopologyClient().prepare(scope, {
    profile: "BrandStoreTopologySaveV1",
    ...scope,
    operationReference: op,
    expectedRevision: 0,
    content: draft(),
  });
async function fixture(op = id(7), abandoned = false) {
  const p = await prepared(op),
    body = {
      profile: "BrandStoreTopologyDraftRevisionV1",
      ...scope,
      revision: 1,
      content: p.command.content,
      operationReference: op,
      auditReference: id(8),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    snapshot = { ...body, snapshotDigest: await digest(body) };
  const receipt = await validateBrandTopologyReceipt(
    {
      profile: "BrandStoreTopologyOperationV1",
      ...scope,
      operationReference: op,
      expectedRevision: 0,
      intentDigest: p.cursor.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : snapshot,
      auditReference: id(8),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    p.cursor,
  );
  const workspace = await parseBrandTopologyWorkspace(
    {
      profile: "BrandStoreTopologyWorkbenchV1",
      ...scope,
      current: {
        profile: "BrandStoreTopologyCurrentV1",
        ...scope,
        current: abandoned ? null : snapshot,
        observedAt: at,
        validUntil: until,
      },
      history: abandoned ? [] : [snapshot],
      stores: {
        profile: "TenantStoreLabelReferenceV1",
        brandReference: id(2),
        brandLifecycle: "Active",
        brandVersion: "1",
        generation: "0",
        referenceCount: "0",
        originalIntentDigest: hash,
        observedAt: at,
        references: [],
      },
      observedAt: at,
      validUntil: until,
      status: "DraftOnly",
    },
    id(2),
    scope,
  );
  return { p, receipt, workspace };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function idb() {
  const data = new Map<string, unknown>(),
    durability: unknown[] = [];
  let tail = Promise.resolve(),
    quota = false;
  const factory = {
    open: vi.fn(() => {
      const open: {
        result: unknown;
        onsuccess: null | (() => void);
        onerror: null | (() => void);
        onblocked: null | (() => void);
        onupgradeneeded: null | (() => void);
      } = { result: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      const db = {
        close: vi.fn(),
        onversionchange: null,
        objectStoreNames: { contains: () => true },
        transaction(_store: unknown, _mode: unknown, options: unknown) {
          durability.push(options);
          let failed = false;
          const reads: {
              key: string;
              request: { result: unknown; onsuccess: null | (() => void) };
            }[] = [],
            changes = new Map<string, unknown>();
          const tx: {
            oncomplete: null | (() => void);
            onabort: null | (() => void);
            onerror: null | (() => void);
            abort: () => void;
            objectStore: () => unknown;
          } = {
            oncomplete: null,
            onabort: null,
            onerror: null,
            abort() {
              failed = true;
              tx.onabort?.();
            },
            objectStore: () => table,
          };
          const table = {
            get(key: string) {
              const request = {
                result: undefined as unknown,
                onsuccess: null as null | (() => void),
              };
              reads.push({ key, request });
              return request;
            },
            put(value: unknown, key: string) {
              if (quota) throw new Error("controlled quota");
              changes.set(key, value);
            },
            delete(key: string) {
              if (quota) throw new Error("controlled quota");
              changes.set(key, undefined);
            },
          };
          tail = tail.then(() => {
            for (const { key, request } of reads) {
              request.result = data.get(key);
              request.onsuccess?.();
            }
            if (failed) return;
            for (const [key, value] of changes) {
              if (value === undefined) data.delete(key);
              else data.set(key, structuredClone(value));
            }
            tx.oncomplete?.();
          });
          return tx;
        },
      };
      open.result = db;
      queueMicrotask(() => open.onsuccess?.());
      return open;
    }),
  };
  vi.stubGlobal("indexedDB", factory);
  return {
    data,
    durability,
    factory,
    refuseWrites: () => {
      quota = true;
    },
  };
}

it("atomic reserve admits only first or identical original and persists no Draft body", async () => {
  const db = idb(),
    a = createBrandStoreTopologyJournal(scope),
    b = createBrandStoreTopologyJournal(scope),
    p = await prepared(),
    q = await prepared(id(20));
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
  const saved = [...db.data.values()][0];
  expect(canonical(saved)).not.toContain("content");
  expect(Object.keys(saved as object)).toHaveLength(7);
});
it("retains exact cursor until terminal and fresh original history corroboration, then clears", async () => {
  idb();
  const { p, receipt, workspace } = await fixture(),
    journal = createBrandStoreTopologyJournal(scope);
  await journal.reserve(p.cursor);
  await expect(
    journal.complete(p.cursor, receipt, { ...workspace, history: [] }),
  ).rejects.toBeInstanceOf(Error);
  expect(await journal.load()).toEqual(p.cursor);
  await journal.complete(p.cursor, receipt, workspace);
  expect(await journal.load()).toBeNull();
});
it("durable Abandoned can clear after genuine empty current without inventing a revision", async () => {
  idb();
  const { p, receipt, workspace } = await fixture(id(7), true),
    journal = createBrandStoreTopologyJournal(scope);
  await journal.reserve(p.cursor);
  await journal.complete(p.cursor, receipt, workspace);
  expect(await journal.load()).toBeNull();
});
it("old completion cannot erase a newer reserved original", async () => {
  idb();
  const { p, receipt, workspace } = await fixture(),
    journal = createBrandStoreTopologyJournal(scope);
  await journal.reserve(p.cursor);
  await journal.complete(p.cursor, receipt, workspace);
  const q = await prepared(id(20));
  await journal.reserve(q.cursor);
  await expect(journal.complete(p.cursor, receipt, workspace)).rejects.toBeInstanceOf(Error);
  expect(await journal.load()).toEqual(q.cursor);
});
it("isolate Actor and Brand, refuse corrupt or expired records and fail closed on quota", async () => {
  const db = idb(),
    { p, receipt, workspace } = await fixture(),
    journal = createBrandStoreTopologyJournal(scope);
  await journal.reserve(p.cursor);
  expect(
    await createBrandStoreTopologyJournal({ ...scope, actorReference: id(30) }).load(),
  ).toBeNull();
  await expect(
    createBrandStoreTopologyJournal({ ...scope, brandReference: id(31) }).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(journal.complete(p.cursor, receipt, workspace)).rejects.toMatchObject({
    code: "Stale",
  });
  expect(await journal.load()).toEqual(p.cursor);
  db.refuseWrites();
  await expect(journal.reserve(p.cursor)).rejects.toMatchObject({ code: "Unavailable" });
});
it("no IndexedDB never degrades to volatile memory", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(
    createBrandStoreTopologyJournal(scope).reserve((await prepared()).cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
