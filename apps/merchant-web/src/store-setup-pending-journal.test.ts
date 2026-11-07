// Controlled real transaction event semantics; actual browser IDB is a separate gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStoreSetupPendingJournal } from "./store-setup-pending-journal.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  parseStoreSetupReceipt,
  parseStoreSetupWorkspace,
  type StoreSetupCursor,
} from "./store-setup-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function original(op = id(5)) {
  return (
    await createStoreSetupClient().prepare({
      expectedScope: scope,
      operationReference: op,
      expectedSetupReference: null,
      expectedRevision: 0,
      content: createUnconfiguredStoreSetupContent(),
    })
  ).cursor;
}
function snapshot(revision = 1) {
  return {
    profile: "StoreSetupDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(6),
    revision,
    authoredByReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: createUnconfiguredStoreSetupContent(),
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  };
}
function terminal(cursor: StoreSetupCursor, abandoned = false) {
  return parseStoreSetupReceipt(
    {
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: cursor.operationReference,
      expectedSetupReference: null,
      expectedRevision: 0,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: cursor.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : snapshot(),
      auditReference: id(7),
      occurredAt: at,
    },
    cursor,
  );
}
function current(revision = 1) {
  return parseStoreSetupWorkspace(
    {
      profile: "StoreSetupWorkspaceV1",
      scope,
      store: {
        storeReference: id(3),
        code: "SYNTH",
        displayName: "Synthetic store",
        locale: "en-CA",
        currencyCode: "CAD",
        timeZone: "America/Toronto",
        version: 1,
      },
      setup: {
        profile: "StoreSetupCurrentV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        readerActorReference: id(4),
        snapshot: revision === 0 ? null : snapshot(revision),
        observedAt: at,
        validUntil: until,
        businessReferenceValidation: "NotEvaluated",
      },
    },
    id(3),
    scope,
  );
}
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
it("atomic reservation prevents another tab from overwriting pending intent", async () => {
  const db = idb(),
    a = createStoreSetupPendingJournal(scope),
    b = createStoreSetupPendingJournal(scope),
    first = await original(),
    second = await original(id(8));
  expect(await a.load()).toBeNull();
  const outcomes = await Promise.allSettled([a.reserve(first), b.reserve(second)]);
  expect(outcomes.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(first);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload stores only scope and original identity, never form facts, credentials or metadata", async () => {
  const db = idb(),
    cursor = await original();
  await createStoreSetupPendingJournal(scope).reserve(cursor);
  expect(await createStoreSetupPendingJournal(scope).load()).toEqual(cursor);
  const encoded = JSON.stringify([...db.data.values()][0]);
  for (const field of [
    "content",
    "addressReference",
    "contactReference",
    "csrf",
    "defaultLocale",
    "timeZone",
    "snapshot",
    "displayName",
  ])
    expect(encoded).not.toContain(field);
});
it("exact immutable terminal and successful current read permit cleanup, including later revisions", async () => {
  const db = idb(),
    journal = createStoreSetupPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  await journal.complete(cursor, terminal(cursor), current(2));
  expect(await journal.load()).toBeNull();
  expect(db.data.size).toBe(0);
});
it("an Abandoned original permits cleanup without claiming current root equality", async () => {
  idb();
  const journal = createStoreSetupPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  await journal.complete(cursor, terminal(cursor, true), current(0));
  expect(await journal.load()).toBeNull();
});
it("wrong original, stale observation and missing committed current root retain pending", async () => {
  idb();
  const journal = createStoreSetupPendingJournal(scope),
    cursor = await original(),
    other = await original(id(8));
  await journal.reserve(cursor);
  await expect(journal.complete(other, terminal(other), current())).rejects.toThrow();
  await expect(journal.complete(cursor, terminal(cursor), current(0))).rejects.toHaveProperty(
    "code",
    "Conflict",
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(journal.complete(cursor, terminal(cursor), current())).rejects.toHaveProperty(
    "code",
    "Stale",
  );
  expect(await journal.load()).toEqual(cursor);
});
it("current Actor gets a separate journal and cannot clear prior Actor cursor", async () => {
  idb();
  const cursor = await original(),
    journal = createStoreSetupPendingJournal(scope);
  await journal.reserve(cursor);
  const other = createStoreSetupPendingJournal({ ...scope, actorReference: id(8) });
  expect(await other.load()).toBeNull();
  await expect(other.reserve(cursor)).rejects.toHaveProperty("code", "ScopeChanged");
  expect(await journal.load()).toEqual(cursor);
});
it("storage cleanup failure does not remove the original, and invalid receipt cannot touch storage", async () => {
  const db = idb(),
    cursor = await original(),
    journal = createStoreSetupPendingJournal(scope);
  await journal.reserve(cursor);
  const count = db.factory.open.mock.calls.length;
  await expect(
    journal.complete(
      cursor,
      { ...terminal(cursor), intentDigest: `sha256:${"a".repeat(64)}` },
      current(),
    ),
  ).rejects.toThrow();
  expect(db.factory.open.mock.calls).toHaveLength(count);
  db.refuseWrites();
  await expect(journal.complete(cursor, terminal(cursor), current())).rejects.toHaveProperty(
    "code",
    "Unavailable",
  );
  expect(await journal.load()).toEqual(cursor);
});
it("refuses cached business content or malformed scope before IDB access", async () => {
  const db = idb(),
    journal = createStoreSetupPendingJournal(scope),
    cursor = await original();
  const malformed = { ...cursor, content: createUnconfiguredStoreSetupContent() };
  await expect(journal.reserve(malformed)).rejects.toThrow();
  expect(db.factory.open).not.toHaveBeenCalled();
  expect(() => createStoreSetupPendingJournal({ ...scope, actorReference: "invalid" })).toThrow();
});
