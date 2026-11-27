import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandCatalogSourceClient,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceReceipt,
  type PreparedBrandCatalogSource,
} from "./merchant-brand-catalog-source-client.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const prepare = (operationReference = id(4)) =>
  createMerchantBrandCatalogSourceClient().prepare(scope, {
    operationReference,
    code: " menu ",
    label: " Catalogue ",
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
import { createBrandCatalogSourcePendingJournal } from "./brand-catalog-source-pending-journal.js";
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
it("atomically reserves one original across tabs with strict durable writes and reload", async () => {
  const db = idb(),
    a = createBrandCatalogSourcePendingJournal(scope),
    b = createBrandCatalogSourcePendingJournal(scope),
    p = await prepare(),
    q = await prepare(id(9));
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((v) => v.status),
  ).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
  const text = JSON.stringify([...db.data.values()]);
  for (const field of ["code", "label", "command", "source", "csrf", "Catalogue"])
    expect(text).not.toContain(field);
  expect(
    await createBrandCatalogSourcePendingJournal({ ...scope, actorReference: id(9) }).load(),
  ).toBeNull();
  expect(await a.load()).toEqual(p.cursor);
});
it("requires actual matching receipt plus fresh coherent current and exact before compare-and-clear", async () => {
  idb();
  const p = await prepare(),
    j = createBrandCatalogSourcePendingJournal(scope);
  await j.reserve(p.cursor);
  const receipt = await parseBrandCatalogSourceReceipt(terminal(p), p.cursor),
    current = parseBrandCatalogSourceCurrent(packet(source(p)), scope, at),
    exact = parseBrandCatalogSourceExact(
      {
        ...packet(source(p)),
        profile: "BrandCatalogSourceExactV1",
        requestedSourceReference: id(5),
      },
      scope,
      id(5),
      at,
    );
  await expect(j.complete(p.cursor, receipt, current, null)).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
  await expect(
    j.complete(p.cursor, receipt, { ...current, source: null }, exact),
  ).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
  await j.complete(p.cursor, receipt, current, exact);
  expect(await j.load()).toBeNull();
});
it("clears Abandoned only after fresh current and preserves replaced or expired original barriers", async () => {
  const db = idb(),
    p = await prepare(),
    q = await prepare(id(9)),
    j = createBrandCatalogSourcePendingJournal(scope),
    receipt = await parseBrandCatalogSourceReceipt(terminal(p, true), p.cursor),
    current = parseBrandCatalogSourceCurrent(packet(), scope, at);
  await j.reserve(p.cursor);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("missing original");
  db.data.set(key, q.cursor);
  await expect(j.complete(p.cursor, receipt, current, null)).rejects.toThrow();
  expect(await j.load()).toEqual(q.cursor);
  db.data.set(key, p.cursor);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, receipt, current, null)).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  await j.complete(p.cursor, receipt, current, null);
  expect(await j.load()).toBeNull();
});
it("fails durable reserve on unavailable storage without losing an existing original", async () => {
  const db = idb(),
    p = await prepare(),
    j = createBrandCatalogSourcePendingJournal(scope);
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.reserve(p.cursor)).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
});
