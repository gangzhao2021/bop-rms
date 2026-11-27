// Controlled IDB event/transaction fixture; production-browser native IDB remains root acceptance.
import { afterEach, expect, it, vi } from "vitest";
import { createOptionSetPublicationPendingJournal } from "./option-set-publication-pending-journal.js";
import { parseOptionSetPublicationCursor } from "./option-set-publication-client.js";
const id = (n: number) => "01902421-7c00-7000-8000-" + n.toString(16).padStart(12, "0"),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    optionSetReference: id(6),
  },
  hash = "sha256:" + "a".repeat(64);
const cursor = (op = id(50)) =>
  parseOptionSetPublicationCursor({
    profile: "CatalogOptionSetPublicationCursorV1",
    scope: {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      actorReference: scope.actorReference,
    },
    command: {
      profile: "CatalogOptionSetPublicationCommandRequestV1",
      action: "SubmitReview",
      operationReference: op,
      optionSetReference: scope.optionSetReference,
      versionReference: id(8),
      expectedAggregateVersion: 1,
      sourceDigest: hash,
      contentDigest: hash,
      configurationDigest: hash,
      expectedReview: null,
      expectedLifecycle: null,
    },
  });
afterEach(() => vi.unstubAllGlobals());
function idb() {
  const data = new Map<string, unknown>();
  let tail = Promise.resolve();
  const factory = {
    open: vi.fn(() => {
      const open: {
        result: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      const db = {
        close: vi.fn(),
        onversionchange: null,
        objectStoreNames: { contains: () => true },
        transaction() {
          const tx: {
            oncomplete: (() => void) | null;
            onabort: (() => void) | null;
            onerror: (() => void) | null;
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
          let failed = false;
          const reads: {
              key: string;
              request: { result: unknown; onsuccess: (() => void) | null };
            }[] = [],
            changes = new Map<string, unknown>();
          const table = {
            get(key: string) {
              const request = {
                result: undefined as unknown,
                onsuccess: null as (() => void) | null,
              };
              reads.push({ key, request });
              return request;
            },
            put(value: unknown, key: string) {
              changes.set(key, value);
            },
            delete(key: string) {
              changes.set(key, undefined);
            },
          };
          tail = tail.then(() => {
            for (const { key, request } of reads) {
              request.result = data.get(key);
              request.onsuccess?.();
            }
            if (failed) return;
            for (const [key, v] of changes)
              if (v === undefined) data.delete(key);
              else data.set(key, globalThis.structuredClone(v));
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
  return { data, factory };
}
it("atomically reserves exact original across instances, rejects replacement, then exact CAS clears", async () => {
  const h = idb(),
    a = createOptionSetPublicationPendingJournal(scope),
    b = createOptionSetPublicationPendingJournal(scope);
  expect(await a.load()).toBeNull();
  const results = await Promise.allSettled([a.reserve(cursor()), b.reserve(cursor(id(51)))]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(cursor());
  await expect(b.complete(cursor(id(51)))).rejects.toThrow();
  expect(h.data.size).toBe(1);
  await b.complete(cursor());
  expect(await a.load()).toBeNull();
});
it("stores only closed identity, isolates actor/set, rejects content/credentials", async () => {
  const h = idb(),
    journal = createOptionSetPublicationPendingJournal(scope);
  await journal.reserve(cursor());
  const stored = JSON.stringify([...h.data.values()]);
  for (const excluded of [
    "csrf",
    "editorContent",
    "policy",
    "localizedNames",
    "validation",
    "approvalEvidence",
  ])
    expect(stored).not.toContain(excluded);
  expect(
    await createOptionSetPublicationPendingJournal({ ...scope, actorReference: id(99) }).load(),
  ).toBeNull();
  expect(
    await createOptionSetPublicationPendingJournal({ ...scope, optionSetReference: id(98) }).load(),
  ).toBeNull();
  expect(() => parseOptionSetPublicationCursor({ ...cursor(), csrf: "secret" })).toThrow();
});
it("unavailable IDB never dispatches a false successful reservation", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const journal = createOptionSetPublicationPendingJournal(scope);
  await expect(journal.load()).rejects.toThrow();
  await expect(journal.reserve(cursor())).rejects.toThrow();
});
