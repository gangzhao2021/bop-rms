// Controlled IDB event model; actual IndexedDB belongs to later rendered browser acceptance.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReceiptTemplateSubmitPendingJournal } from "./receipt-template-submit-pending-journal.js";
import {
  createReceiptTemplateSubmitClient,
  parseReceiptTemplateReviewCurrent,
  validateReceiptTemplateSubmitReceipt,
  type PreparedReceiptTemplateSubmit,
} from "./receipt-template-submit-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  digest = `sha256:${"a".repeat(64)}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const prepared = (op = id(7), template = id(8)) =>
  createReceiptTemplateSubmitClient().prepare({
    expectedScope: scope,
    operationReference: op,
    templateReference: template,
    expectedVersionReference: id(9),
    expectedRevision: 2,
  });
const submission = () => ({
  profile: "DigitalReceiptTemplateSubmissionV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  templateReference: id(8),
  familyReference: id(10),
  versionReference: id(9),
  draftRevision: 2,
  contentDigest: digest,
  authoredByReference: id(5),
  submittedByReference: id(4),
  operationReference: id(7),
  reviewLifecycleReference: id(11),
  reviewVersion: 2,
  validationEvidenceReference: id(12),
  checkedAt: at,
  validationValidUntil: "2026-10-08T10:00:00.000Z",
  submittedAt: at,
  auditReference: id(13),
  dataClassification: "Internal",
});
const terminal = (p: PreparedReceiptTemplateSubmit, abandoned = false) =>
  validateReceiptTemplateSubmitReceipt(
    {
      profile: "DigitalReceiptTemplateSubmitReceiptV1",
      ...scope,
      operationReference: p.cursor.operationReference,
      templateReference: p.cursor.templateReference,
      expectedVersionReference: id(9),
      expectedRevision: 2,
      intentDigest: p.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      submission: abandoned ? null : submission(),
      auditReference: id(13),
      occurredAt: at,
    },
    p.cursor,
  );
function current(recorded = true, revision = 2) {
  return parseReceiptTemplateReviewCurrent(
    {
      profile: "DigitalReceiptTemplateReviewCurrentV1",
      ...scope,
      templateReference: id(8),
      currentDraft: {
        versionReference: revision === 2 ? id(9) : id(90),
        revision,
        contentDigest: digest,
      },
      submission: recorded ? submission() : null,
      lifecycle: recorded
        ? {
            lifecycleReference: id(11),
            version: 2,
            state: "InReview",
            latestMutationOperationReference: id(7),
            changedAt: at,
            validationEvidenceReference: id(12),
            approvalEvidenceReference: null,
          }
        : null,
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    },
    id(3),
    id(8),
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
it("atomic competing reservations admit only first original, identical reservation remains safe", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(20)),
    a = createReceiptTemplateSubmitPendingJournal(scope, id(8)),
    b = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload stores exact payload-free original only, subjects remain independent", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(20), id(21));
  await createReceiptTemplateSubmitPendingJournal(scope, id(8)).reserve(p.cursor);
  await createReceiptTemplateSubmitPendingJournal(scope, id(21)).reserve(q.cursor);
  expect(await createReceiptTemplateSubmitPendingJournal(scope, id(8)).load()).toEqual(p.cursor);
  expect(db.data.size).toBe(2);
  for (const name of [
    "content",
    "submission",
    "validationEvidenceReference",
    "reviewLifecycleReference",
    "csrf",
    "locale",
    "fields",
    "validationValidUntil",
  ])
    expect(JSON.stringify([...db.data.values()])).not.toContain(name);
});
it("Committed requires a fresh real recorded review before clearing and accepts later Draft successor", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  const r = await terminal(p);
  await expect(j.complete(p.cursor, r, current(false))).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
  await j.complete(p.cursor, r, current(true, 3));
  expect(await j.load()).toBeNull();
});
it("a different recorded family or altered same original record cannot release the marker", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8)),
    r = await terminal(p),
    fresh = current();
  await j.reserve(p.cursor);
  if (!fresh.submission) throw new Error("fixture submission missing");
  for (const changed of [
    { ...fresh.submission, familyReference: id(90) },
    { ...fresh.submission, authoredByReference: id(90) },
  ])
    await expect(j.complete(p.cursor, r, { ...fresh, submission: changed })).rejects.toMatchObject({
      code: "Conflict",
    });
  expect(await j.load()).toEqual(p.cursor);
});
it("permanent Abandoned also needs authoritative fresh review, but does not invent a submission", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), current(false));
  expect(await j.load()).toBeNull();
});
it("403,409,Unknown retain original and never dispatch an automatic replacement", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  for (const status of [403, 409, 503]) {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status }));
    await expect(
      createReceiptTemplateSubmitClient(f).resolve(p.cursor, { csrf: "A".repeat(43) }),
    ).rejects.toThrow();
    expect(await j.load()).toEqual(p.cursor);
    expect(f).toHaveBeenCalledTimes(1);
  }
});
it("scope and Actor isolation keeps old manager originals, foreign subject cursor cannot reserve", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  expect(
    await createReceiptTemplateSubmitPendingJournal(
      { ...scope, actorReference: id(90) },
      id(8),
    ).load(),
  ).toBeNull();
  await expect(
    createReceiptTemplateSubmitPendingJournal(scope, id(90)).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(await j.load()).toEqual(p.cursor);
});
it("missing IndexedDB or quota/cleanup refusal never falls back to memory", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const p = await prepared();
  await expect(
    createReceiptTemplateSubmitPendingJournal(scope, id(8)).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
  const db = idb(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), current())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("expired read and obsolete original completion cannot erase another request", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(20)),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  const r = await terminal(p),
    fresh = current();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, r, fresh)).rejects.toMatchObject({ code: "Stale" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture original missing");
  db.data.set(key, q.cursor);
  await expect(j.complete(p.cursor, r, fresh)).rejects.toMatchObject({ code: "Unavailable" });
  expect(await j.load()).toEqual(q.cursor);
});
it("malformed persisted payload remains refused and retained instead of cleared", async () => {
  const db = idb(),
    p = await prepared(),
    j = createReceiptTemplateSubmitPendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture key missing");
  db.data.set(key, { ...p.cursor, submission: submission() });
  await expect(j.load()).rejects.toMatchObject({ code: "Invalid" });
  expect(db.data.size).toBe(1);
});
