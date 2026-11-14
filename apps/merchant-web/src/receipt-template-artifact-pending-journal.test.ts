// Controlled IDB transaction event model; actual IndexedDB interaction is a browser gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReceiptTemplateArtifactPendingJournal } from "./receipt-template-artifact-pending-journal.js";
import {
  createReceiptTemplateArtifactClient,
  parseReceiptTemplateArtifactsCurrent,
  validateReceiptTemplateArtifactReceipt,
  type PreparedReceiptTemplateArtifact,
  receiptTemplateArtifactRequiredFields,
  type ReceiptTemplateArtifactKind,
} from "./receipt-template-artifact-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const layout = () => ({
  profile: "AccessibleDigitalReceiptLayoutV1",
  dataContractVersion: 1,
  renderEngineVersion: 1,
  outputProfile: "AccessibleDigitalReceipt",
  requiredFields: [...receiptTemplateArtifactRequiredFields],
});
const compliance = () => ({
  profile: "DigitalReceiptRequiredFieldRuleV1",
  dataContractVersion: 1,
  requiredFields: [...receiptTemplateArtifactRequiredFields],
  professionalReviewStatus: "NotEvaluated",
  legalConclusion: "NotEvaluated",
});
async function prepared(kind: ReceiptTemplateArtifactKind = "Layout", operationReference = id(5)) {
  return createReceiptTemplateArtifactClient().prepare({
    expectedScope: scope,
    artifactKind: kind,
    operationReference,
    expectedArtifactReference: null,
    expectedRevision: 0,
    content: kind === "Layout" ? layout() : compliance(),
  });
}
function snapshot(p: PreparedReceiptTemplateArtifact, revision = 1) {
  return {
    profile: "DigitalReceiptTemplateArtifactV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    artifactKind: p.cursor.artifactKind,
    artifactReference: revision === 1 ? id(6) : id(8),
    revision,
    authoredByReference: id(4),
    previousArtifactReference: revision === 1 ? null : id(6),
    content: p.command.content,
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
async function terminal(p: PreparedReceiptTemplateArtifact, abandoned = false) {
  return validateReceiptTemplateArtifactReceipt(
    {
      profile: "DigitalReceiptTemplateArtifactReceiptV1",
      ...scope,
      artifactKind: p.cursor.artifactKind,
      operationReference: p.cursor.operationReference,
      intentDigest: p.intentDigest,
      expectedArtifactReference: null,
      expectedRevision: 0,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : snapshot(p),
      auditReference: id(7),
      occurredAt: at,
    },
    p.cursor,
  );
}
function current(p: PreparedReceiptTemplateArtifact, revision = 1) {
  return parseReceiptTemplateArtifactsCurrent(
    {
      profile: "DigitalReceiptTemplateArtifactsCurrentV1",
      ...scope,
      layout: p.cursor.artifactKind === "Layout" && revision ? snapshot(p, revision) : null,
      compliance: p.cursor.artifactKind === "Compliance" && revision ? snapshot(p, revision) : null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
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
    a = createReceiptTemplateArtifactPendingJournal(scope, "Layout"),
    b = createReceiptTemplateArtifactPendingJournal(scope, "Layout"),
    p = await prepared(),
    q = await prepared("Layout", id(9));
  const outcomes = await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)]);
  expect(outcomes.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload stores only scope/kind/original pins; Layout and Compliance never overwrite each other", async () => {
  const db = idb(),
    a = await prepared(),
    c = await prepared("Compliance", id(9));
  await createReceiptTemplateArtifactPendingJournal(scope, "Layout").reserve(a.cursor);
  await createReceiptTemplateArtifactPendingJournal(scope, "Compliance").reserve(c.cursor);
  expect(await createReceiptTemplateArtifactPendingJournal(scope, "Layout").load()).toEqual(
    a.cursor,
  );
  expect(await createReceiptTemplateArtifactPendingJournal(scope, "Compliance").load()).toEqual(
    c.cursor,
  );
  expect(db.data.size).toBe(2);
  const encoded = JSON.stringify([...db.data.values()]);
  for (const key of [
    "requiredFields",
    "professionalReviewStatus",
    "legalConclusion",
    "csrf",
    "snapshot",
    "content",
  ])
    expect(encoded).not.toContain(key);
});
it("another actual Actor or Store sees no old Actor cursor", async () => {
  idb();
  const p = await prepared();
  await createReceiptTemplateArtifactPendingJournal(scope, "Layout").reserve(p.cursor);
  expect(
    await createReceiptTemplateArtifactPendingJournal(
      { ...scope, actorReference: id(9) },
      "Layout",
    ).load(),
  ).toBeNull();
  expect(
    await createReceiptTemplateArtifactPendingJournal(
      { ...scope, storeReference: id(9) },
      "Layout",
    ).load(),
  ).toBeNull();
});
it("exact terminal plus samekind fresh current clears, including legitimate newer revisions", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), current(p, 2));
  expect(await j.load()).toBeNull();
});
it("Abandoned terminal permits cleanup without inventing a saved reference", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), current(p, 0));
  expect(await j.load()).toBeNull();
});
it("missing current/expired current/foreign current refuse cleanup and retain exact original", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
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
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  const view = current(p);
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...view,
      layout: view.layout ? { ...view.layout, artifactReference: id(9) } : null,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});
it("wrong receipt identity or tampered content cannot clear pending", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  const r = await terminal(p);
  await expect(
    j.complete(p.cursor, { ...r, operationReference: id(9) }, current(p)),
  ).rejects.toMatchObject({ code: "Invalid" });
  const damaged = { ...r, snapshot: r.snapshot ? { ...r.snapshot } : null };
  if (damaged.snapshot)
    Object.defineProperty(damaged.snapshot, "content", {
      value: { ...layout(), outputProfile: "Changed" },
      enumerable: true,
    });
  await expect(j.complete(p.cursor, damaged, current(p))).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("quota/cleanup failure never discards original", async () => {
  const db = idb(),
    p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), current(p))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("wrongkind reserve is refused before opening IndexedDB", async () => {
  const db = idb(),
    p = await prepared("Compliance");
  await expect(
    createReceiptTemplateArtifactPendingJournal(scope, "Layout").reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(db.factory.open).not.toHaveBeenCalled();
});
it("same immutable reference cannot clear using altered original author", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await j.reserve(p.cursor);
  const v = current(p);
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...v,
      layout: v.layout ? { ...v.layout, authoredByReference: id(9) } : null,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});

it("missing IndexedDB has no volatile fallback", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const p = await prepared(),
    j = createReceiptTemplateArtifactPendingJournal(scope, "Layout");
  await expect(j.reserve(p.cursor)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(j.load()).rejects.toMatchObject({ code: "Unavailable" });
});
