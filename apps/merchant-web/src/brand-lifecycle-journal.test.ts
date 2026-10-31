// Reuses the existing controlled atomic IDB event model; browser cases use actual IndexedDB.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createBrandLifecycleJournal } from "./brand-lifecycle-journal.js";
import {
  createMerchantBrandLifecycleClient,
  BrandLifecycleClientError,
} from "./merchant-brand-lifecycle-client.js";
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) },
  client = createMerchantBrandLifecycleClient(),
  original = client.prepare(scope, "ActivateBrand", 1, id(3));
const receipt = {
  profile: "MerchantBrandLifecycleReceiptV1" as const,
  actorReference: id(2),
  brandReference: id(1),
  action: "ActivateBrand" as const,
  operationReference: id(3),
  expectedBrandVersion: 1,
  status: "Applied" as const,
  lifecycle: "Active" as const,
  version: 2,
  occurredAt: "2026-10-06T12:00:00.000Z",
};
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(receipt.occurredAt)));
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
it("serializes one durable scalar original across tabs and reload without CSRF or label", async () => {
  const db = idb(),
    a = createBrandLifecycleJournal(scope),
    b = createBrandLifecycleJournal(scope),
    other = client.prepare(scope, "ArchiveBrand", 1, id(4));
  expect(
    (await Promise.allSettled([a.reserve(original), b.reserve(other)])).map(
      (value) => value.status,
    ),
  ).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(original);
  expect(db.durability).toContainEqual({ durability: "strict" });
  const durable = JSON.stringify([...db.data.values()]);
  for (const field of ["csrf", "label", "cookie", "token", "proof"])
    expect(durable).not.toContain(field);
  expect(await createBrandLifecycleJournal({ ...scope, actorReference: id(9) }).load()).toBeNull();
});
it("requires exact immutable original receipt and same-phase guard before compare-and-clear", async () => {
  idb();
  const journal = createBrandLifecycleJournal(scope);
  await journal.reserve(original);
  await expect(
    journal.complete(original, { ...receipt, operationReference: id(9) }),
  ).rejects.toThrow();
  await expect(journal.complete(original, receipt, () => false)).rejects.toThrow();
  expect(await journal.load()).toEqual(original);
  await journal.complete(original, receipt, () => true);
  expect(await journal.load()).toBeNull();
});
it("releases only request-bound authoritative conflict, never generic unavailable or another original", async () => {
  idb();
  const journal = createBrandLifecycleJournal(scope);
  await journal.reserve(original);
  await expect(
    journal.releaseConflict(
      original,
      new BrandLifecycleClientError("Conflict", original),
      () => true,
    ),
  ).rejects.toThrow();
  const other = client.prepare(scope, "ArchiveBrand", 1, id(4));
  await expect(
    journal.releaseConflict(
      original,
      new BrandLifecycleClientError("RequestConflict", other),
      () => true,
    ),
  ).rejects.toThrow();
  await expect(
    journal.releaseConflict(
      original,
      new BrandLifecycleClientError("RequestConflict", original),
      () => false,
    ),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(original);
  await journal.releaseConflict(
    original,
    new BrandLifecycleClientError("RequestConflict", original),
    () => true,
  );
  expect(await journal.load()).toBeNull();
});
it("preserves replaced barriers and quota-failed reserves", async () => {
  const db = idb(),
    journal = createBrandLifecycleJournal(scope);
  await journal.reserve(original);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("missing scalar");
  const other = client.prepare(scope, "ArchiveBrand", 2, id(4));
  db.data.set(key, other);
  await expect(journal.complete(original, receipt)).rejects.toThrow();
  expect(await journal.load()).toEqual(other);
  db.refuseWrites();
  await expect(journal.reserve(other)).rejects.toThrow();
  expect(await journal.load()).toEqual(other);
});
