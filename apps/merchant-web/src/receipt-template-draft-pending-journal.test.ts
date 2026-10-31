// Controlled IDB event model; actual IndexedDB is verified by root rendered browser acceptance.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReceiptTemplateDraftPendingJournal } from "./receipt-template-draft-pending-journal.js";
import {
  createReceiptTemplateDraftClient,
  parseReceiptTemplateDraftCurrent,
  validateReceiptTemplateDraftReceipt,
  type PreparedReceiptTemplateDraft,
} from "./receipt-template-draft-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const fields = {
  locale: "en-CA",
  layoutDefinitionReference: id(5),
  complianceRuleReference: id(6),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
};
const prepared = (op = id(7), templateReference: string | null = null) =>
  createReceiptTemplateDraftClient().prepare({
    expectedScope: scope,
    operationReference: op,
    templateReference,
    expectedVersionReference: templateReference === null ? null : id(9),
    expectedRevision: templateReference === null ? 0 : 1,
    fields,
  });
async function snapshot(revision = 1) {
  const content = {
    profile: "DigitalReceiptTemplateContentV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(8),
    versionReference: revision === 1 ? id(9) : id(13),
    versionNumber: 1,
    versionCode: "RECEIPT_1",
    ...fields,
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    requiredFields: [...receiptTemplateArtifactRequiredFields],
    dataClassification: "Internal",
  };
  return {
    profile: "DigitalReceiptTemplateDraftV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    familyReference: id(10),
    revision,
    authoredByReference: id(4),
    previousVersionReference: revision === 1 ? null : id(9),
    content,
    contentDigest: await publicationValueDigest(content),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
async function terminal(p: PreparedReceiptTemplateDraft, abandoned = false) {
  return validateReceiptTemplateDraftReceipt(
    {
      profile: "DigitalReceiptTemplateDraftReceiptV1",
      ...scope,
      operationReference: p.cursor.operationReference,
      templateReference: p.cursor.templateReference,
      expectedVersionReference: p.cursor.expectedVersionReference,
      expectedRevision: p.cursor.expectedRevision,
      intentDigest: p.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : await snapshot(),
      auditReference: id(11),
      occurredAt: at,
    },
    p.cursor,
  );
}
async function current(revision = 1) {
  return parseReceiptTemplateDraftCurrent(
    {
      profile: "DigitalReceiptTemplateDraftCurrentV1",
      ...scope,
      templateReference: revision ? id(8) : null,
      snapshot: revision ? await snapshot(revision) : null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    },
    id(3),
    revision ? id(8) : null,
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
it("atomic first reservation refuses a different original across concurrent tabs", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12)),
    a = createReceiptTemplateDraftPendingJournal(scope, null),
    b = createReceiptTemplateDraftPendingJournal(scope, null);
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((v) => v.status),
  ).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload retains only identity pins/hash and separate template subjects coexist", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12), id(8));
  await createReceiptTemplateDraftPendingJournal(scope, null).reserve(p.cursor);
  await createReceiptTemplateDraftPendingJournal(scope, id(8)).reserve(q.cursor);
  expect(await createReceiptTemplateDraftPendingJournal(scope, null).load()).toEqual(p.cursor);
  expect(await createReceiptTemplateDraftPendingJournal(scope, id(8)).load()).toEqual(q.cursor);
  expect(db.data.size).toBe(2);
  for (const key of [
    "fields",
    "locale",
    "activation",
    "layoutDefinitionReference",
    "content",
    "csrf",
    "snapshot",
  ])
    expect(JSON.stringify([...db.data.values()])).not.toContain(key);
});
it("Committed initial receipt requires actual generated-template fresh current before exact cleanup", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  await expect(j.complete(p.cursor, await terminal(p), await current(0))).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
  await j.complete(p.cursor, await terminal(p), await current());
  expect(await j.load()).toBeNull();
});
it("later immutable successor still permits original cleanup but wrong family and older root do not", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  const next = await current(2);
  if (!next.snapshot) throw new Error("fixture current missing");
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...next,
      snapshot: { ...next.snapshot, familyReference: id(99) },
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
  await j.complete(p.cursor, await terminal(p), next);
  expect(await j.load()).toBeNull();
});
it("permanent Abandoned clears only with a fresh truthful current; no payload is needed", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), await current(0));
  expect(await j.load()).toBeNull();
});
it("403/409/Unknown keep original marker and never automatically dispatch replacement", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  for (const status of [403, 409, 503]) {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status }));
    await expect(
      createReceiptTemplateDraftClient(f).resolve(p.cursor, { csrf: "A".repeat(43) }),
    ).rejects.toThrow();
    expect(await j.load()).toEqual(p.cursor);
    expect(f).toHaveBeenCalledTimes(1);
  }
});
it("Actor/Store/subject isolation denies foreign cursor and does not release old actor original", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  expect(
    await createReceiptTemplateDraftPendingJournal(
      { ...scope, actorReference: id(12) },
      null,
    ).load(),
  ).toBeNull();
  await expect(
    createReceiptTemplateDraftPendingJournal(scope, id(8)).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(await j.load()).toEqual(p.cursor);
});
it("missing IndexedDB/quota/cleanup failure has no volatile fallback", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const p = await prepared();
  await expect(
    createReceiptTemplateDraftPendingJournal(scope, null).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
  const db = idb(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), await current())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("stale current and replacement CAS cannot erase newer pending original", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12)),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  const r = await terminal(p),
    fresh = await current();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, r, fresh)).rejects.toMatchObject({ code: "Stale" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture journal missing");
  db.data.set(key, q.cursor);
  await expect(j.complete(p.cursor, r, fresh)).rejects.toMatchObject({ code: "Unavailable" });
  expect(await j.load()).toEqual(q.cursor);
});
it("malformed persisted payload/profiles remain locked rather than being cleared", async () => {
  const db = idb(),
    p = await prepared(),
    j = createReceiptTemplateDraftPendingJournal(scope, null);
  await j.reserve(p.cursor);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture journal missing");
  db.data.set(key, { ...p.cursor, fields: { locale: "en-CA" } });
  await expect(j.load()).rejects.toMatchObject({ code: "Invalid" });
  expect(db.data.size).toBe(1);
});
