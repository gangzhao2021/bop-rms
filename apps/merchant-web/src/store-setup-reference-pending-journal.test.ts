// Controlled IDB transaction event model; actual IndexedDB interaction is a browser gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStoreSetupReferencePendingJournal } from "./store-setup-reference-pending-journal.js";
import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferencesCurrent,
  validateStoreSetupReferenceReceipt,
  type PreparedStoreSetupReference,
  type StoreSetupReferenceKind,
} from "./store-setup-reference-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const address = () => ({
  countryCode: "CA",
  regionCode: "ON",
  locality: "Toronto",
  postalCode: "M5V 1A1",
  addressLines: ["100 Synthetic Street"],
});
async function prepared(kind: StoreSetupReferenceKind = "Address", operationReference = id(5)) {
  return createStoreSetupReferenceClient().prepare({
    expectedScope: scope,
    kind,
    operationReference,
    expectedReference: null,
    expectedRevision: 0,
    content:
      kind === "Address"
        ? address()
        : { contactName: "Synthetic Contact", businessPhone: "+14165550100", website: null },
  });
}
function snapshot(p: PreparedStoreSetupReference, revision = 1) {
  return {
    profile: "StoreSetupReferenceVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    kind: p.cursor.kind,
    reference: revision === 1 ? id(6) : id(8),
    revision,
    authoredByReference: id(4),
    previousReference: revision === 1 ? null : id(6),
    content: p.command.content,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
async function terminal(p: PreparedStoreSetupReference, abandoned = false) {
  return validateStoreSetupReferenceReceipt(
    {
      profile: "StoreSetupReferenceReceiptV1",
      ...scope,
      kind: p.cursor.kind,
      operationReference: p.cursor.operationReference,
      intentDigest: p.intentDigest,
      expectedReference: null,
      expectedRevision: 0,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : snapshot(p),
      auditReference: id(7),
      occurredAt: at,
    },
    p.cursor,
  );
}
function current(p: PreparedStoreSetupReference, revision = 1) {
  return parseStoreSetupReferencesCurrent(
    {
      profile: "StoreSetupReferencesCurrentV1",
      ...scope,
      address: p.cursor.kind === "Address" && revision ? snapshot(p, revision) : null,
      contact: p.cursor.kind === "Contact" && revision ? snapshot(p, revision) : null,
      observedAt: at,
      validUntil: until,
      businessReferenceValidation: "NotEvaluated",
    },
    id(3),
    scope,
  );
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
it("atomic reservation refuses a second tab's different original", async () => {
  const db = idb(),
    a = createStoreSetupReferencePendingJournal(scope, "Address"),
    b = createStoreSetupReferencePendingJournal(scope, "Address"),
    p = await prepared(),
    q = await prepared("Address", id(9));
  const outcomes = await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)]);
  expect(outcomes.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload stores only scope/kind/original pins; Address and Contact never overwrite each other", async () => {
  const db = idb(),
    a = await prepared(),
    c = await prepared("Contact", id(9));
  await createStoreSetupReferencePendingJournal(scope, "Address").reserve(a.cursor);
  await createStoreSetupReferencePendingJournal(scope, "Contact").reserve(c.cursor);
  expect(await createStoreSetupReferencePendingJournal(scope, "Address").load()).toEqual(a.cursor);
  expect(await createStoreSetupReferencePendingJournal(scope, "Contact").load()).toEqual(c.cursor);
  expect(db.data.size).toBe(2);
  const encoded = JSON.stringify([...db.data.values()]);
  for (const key of ["contactName", "businessPhone", "addressLines", "csrf", "snapshot", "content"])
    expect(encoded).not.toContain(key);
});
it("another actual Actor or Store sees no old Actor cursor", async () => {
  idb();
  const p = await prepared();
  await createStoreSetupReferencePendingJournal(scope, "Address").reserve(p.cursor);
  expect(
    await createStoreSetupReferencePendingJournal(
      { ...scope, actorReference: id(9) },
      "Address",
    ).load(),
  ).toBeNull();
  expect(
    await createStoreSetupReferencePendingJournal(
      { ...scope, storeReference: id(9) },
      "Address",
    ).load(),
  ).toBeNull();
});
it("exact terminal plus samekind fresh current clears, including legitimate newer revisions", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), current(p, 2));
  expect(await j.load()).toBeNull();
});
it("Abandoned terminal permits cleanup without inventing a saved reference", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), current(p, 0));
  expect(await j.load()).toBeNull();
});
it("missing current/expired current/foreign current refuse cleanup and retain exact original", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  await expect(j.complete(p.cursor, await terminal(p), current(p, 0))).rejects.toMatchObject({
    code: "Conflict",
  });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, await terminal(p), current(p))).rejects.toMatchObject({
    code: "Stale",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("same revision with a different reference cannot clear pending identity", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  const view = current(p);
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...view,
      address: view.address ? { ...view.address, reference: id(9) } : null,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});
it("wrong receipt identity or tampered content cannot clear pending", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  const r = await terminal(p);
  await expect(
    j.complete(p.cursor, { ...r, operationReference: id(9) }, current(p)),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    j.complete(
      p.cursor,
      {
        ...r,
        snapshot: r.snapshot
          ? { ...r.snapshot, content: { ...address(), locality: "Changed" } }
          : null,
      },
      current(p),
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(await j.load()).toEqual(p.cursor);
});
it("quota/cleanup failure never discards original", async () => {
  const db = idb(),
    p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), current(p))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("wrongkind reserve is refused before opening IndexedDB", async () => {
  const db = idb(),
    p = await prepared("Contact");
  await expect(
    createStoreSetupReferencePendingJournal(scope, "Address").reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(db.factory.open).not.toHaveBeenCalled();
});
it("same immutable reference cannot clear using altered current business content", async () => {
  idb();
  const p = await prepared(),
    j = createStoreSetupReferencePendingJournal(scope, "Address");
  await j.reserve(p.cursor);
  const v = current(p);
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...v,
      address: v.address ? { ...v.address, content: { ...address(), locality: "Changed" } } : null,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});
