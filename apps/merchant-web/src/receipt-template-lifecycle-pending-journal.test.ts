// Controlled IndexedDB event model, not native/browser acceptance evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReceiptTemplateLifecyclePendingJournal } from "./receipt-template-lifecycle-pending-journal.js";
import {
  createReceiptTemplateLifecycleClient,
  validateReceiptTemplateLifecycleReceipt,
  type PreparedReceiptTemplateLifecycle,
} from "./receipt-template-lifecycle-client.js";
import { parseReceiptTemplateReviewCurrent } from "./receipt-template-submit-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
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
const prepared = (action: "Approve" | "Publish" = "Approve", op = id(20)) =>
  createReceiptTemplateLifecycleClient().prepare({
    expectedScope: scope,
    action,
    operationReference: op,
    templateReference: id(8),
    expectedVersionReference: id(9),
    expectedRevision: 2,
    reviewLifecycleReference: id(11),
    expectedReviewVersion: action === "Approve" ? 2 : 3,
    expectedReviewOperationReference: action === "Approve" ? id(7) : id(21),
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
  submittedByReference: id(6),
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
const published = () => ({
  templateReference: id(8),
  versionReference: id(9),
  versionNumber: 1,
  versionCode: "RECEIPT_1",
  brandReference: id(2),
  storeReference: id(3),
  locale: "en",
  dataContractVersion: 1,
  renderEngineVersion: 1,
  outputProfile: "AccessibleDigitalReceipt",
  layoutDefinitionReference: id(30),
  complianceRuleReference: id(31),
  requiredFields: receiptTemplateArtifactRequiredFields,
  publicationReference: id(32),
  publishedAt: at,
  effectiveFrom: at,
  effectiveUntil: null,
});
async function receipt(p: PreparedReceiptTemplateLifecycle, abandoned = false) {
  const c = p.cursor;
  return validateReceiptTemplateLifecycleReceipt(
    {
      profile: "DigitalReceiptTemplateLifecycleReceiptV1",
      ...scope,
      action: c.action,
      operationReference: c.operationReference,
      templateReference: c.templateReference,
      expectedVersionReference: c.expectedVersionReference,
      expectedRevision: c.expectedRevision,
      reviewLifecycleReference: c.reviewLifecycleReference,
      expectedReviewVersion: c.expectedReviewVersion,
      expectedReviewOperationReference: c.expectedReviewOperationReference,
      intentDigest: p.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      result: abandoned
        ? null
        : {
            lifecycleReference: id(11),
            lifecycleVersion: c.expectedReviewVersion + 1,
            state: c.action === "Approve" ? "Approved" : "Published",
            mutationOperationReference: c.operationReference,
            changedAt: at,
            approvalEvidenceReference: id(15),
            approvedByReference: c.action === "Approve" ? scope.actorReference : id(14),
            approvedAt: at,
            approvalValidUntil: "2026-10-06T10:00:00.000Z",
            publishedVersion: c.action === "Publish" ? published() : null,
          },
      auditReference: id(16),
      occurredAt: at,
    },
    c,
  );
}
function current(p: PreparedReceiptTemplateLifecycle, newDraft = false) {
  return parseReceiptTemplateReviewCurrent(
    {
      profile: "DigitalReceiptTemplateReviewCurrentV1",
      ...scope,
      templateReference: id(8),
      currentDraft: {
        versionReference: newDraft ? id(90) : id(9),
        revision: newDraft ? 3 : 2,
        contentDigest: digest,
      },
      submission: newDraft ? null : submission(),
      lifecycle: newDraft
        ? null
        : {
            lifecycleReference: id(11),
            version: p.cursor.expectedReviewVersion + 1,
            state: p.cursor.action === "Approve" ? "Approved" : "Published",
            latestMutationOperationReference: p.cursor.operationReference,
            changedAt: at,
            validationEvidenceReference: id(12),
            approvalEvidenceReference: id(15),
          },
      observedAt: at,
      validUntil: until,
      sourceQualification: "NotEvaluated",
    },
    scope.storeReference,
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

it("atomic first-or-identical reservations fence Approve and Publish for one template", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared("Publish", id(40)),
    a = createReceiptTemplateLifecyclePendingJournal(scope, id(8)),
    b = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload persists only exact pins and digest, never content, evidence, credentials or review text", async () => {
  const db = idb(),
    p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  expect(await createReceiptTemplateLifecyclePendingJournal(scope, id(8)).load()).toEqual(p.cursor);
  for (const name of [
    "content",
    "submission",
    "approvalEvidenceReference",
    "validationEvidenceReference",
    "approvedAt",
    "csrf",
    "locale",
    "fields",
  ])
    expect(JSON.stringify([...db.data.values()])).not.toContain(name);
});
it("confirmed Approved refresh clears the exact original", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  expect(await j.complete(p.cursor, await receipt(p), current(p), null)).toEqual({
    historical: false,
  });
  expect(await j.load()).toBeNull();
});
it("historical terminal recovery survives business approval expiry and a newer immutable Draft", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  const future = "2026-10-07T10:00:00.000Z",
    view = current(p, true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(future));
  const fresh = { ...view, observedAt: future, validUntil: "2026-10-07T10:00:05.000Z" };
  expect(await j.complete(p.cursor, await receipt(p), fresh, null)).toEqual({ historical: true });
  expect(await j.load()).toBeNull();
});
it("Publish clears from actual terminal and fresh head; optional version metadata must match immutable original", async () => {
  idb();
  const p = await prepared("Publish"),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8)),
    r = await receipt(p),
    view = current(p);
  await j.reserve(p.cursor);
  if (!r.result?.publishedVersion) throw new Error("fixture publication required");
  await expect(
    j.complete(p.cursor, r, view, { ...r.result.publishedVersion, locale: "fr" }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
  expect(await j.complete(p.cursor, r, view, null)).toEqual({ historical: false });
  expect(await j.load()).toBeNull();
});
it("an authoritative newer Published source clears old Publish as historical without pretending old envelope is current", async () => {
  idb();
  const p = await prepared("Publish"),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8)),
    view = current(p),
    r = await receipt(p);
  await j.reserve(p.cursor);
  if (!view.submission || !view.lifecycle || !r.result?.publishedVersion)
    throw new Error("fixture source required");
  const newer = {
    ...r.result.publishedVersion,
    versionReference: id(90),
    versionNumber: 2,
    versionCode: "RECEIPT_2",
    publicationReference: id(91),
  };
  const fresh = {
    ...view,
    currentDraft: { ...view.currentDraft, versionReference: id(90), revision: 3 },
    submission: {
      ...view.submission,
      versionReference: id(90),
      draftRevision: 3,
      operationReference: id(92),
      reviewLifecycleReference: id(93),
    },
    lifecycle: {
      ...view.lifecycle,
      lifecycleReference: id(93),
      latestMutationOperationReference: id(94),
    },
  };
  expect(await j.complete(p.cursor, r, fresh, newer)).toEqual({ historical: true });
  expect(await j.load()).toBeNull();
});
it("Abandoned needs fresh same-template scope, never invents current lifecycle or publication", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  expect(await j.complete(p.cursor, await receipt(p, true), current(p, true), null)).toEqual({
    historical: false,
  });
  expect(await j.load()).toBeNull();
});
it("old terminal cannot erase a different reserved original, cleanup failure keeps exact cursor", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared("Approve", id(40)),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture key missing");
  db.data.set(key, q.cursor);
  await expect(j.complete(p.cursor, await receipt(p), current(p), null)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(q.cursor);
  db.data.set(key, p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await receipt(p), current(p), null)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("Unknown, Denied and conflict retain durable original and never generate automatic requests", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  for (const status of [403, 409, 503]) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("{}", { status }));
    await expect(
      createReceiptTemplateLifecycleClient(fetcher).resolve(p.cursor, { csrf: "A".repeat(43) }),
    ).rejects.toThrow();
    expect(await j.load()).toEqual(p.cursor);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it("wrong Actor or subject and malformed stored records never clear another scope", async () => {
  const db = idb(),
    p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  expect(
    await createReceiptTemplateLifecyclePendingJournal(
      { ...scope, actorReference: id(90) },
      id(8),
    ).load(),
  ).toBeNull();
  await expect(
    createReceiptTemplateLifecyclePendingJournal(scope, id(90)).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("fixture key missing");
  db.data.set(key, { ...p.cursor, approvalEvidenceReference: id(15) });
  await expect(j.load()).rejects.toMatchObject({ code: "Invalid" });
  expect(db.data.size).toBe(1);
});
it("missing IDB and expired actual current observations fail closed without volatile fallback", async () => {
  const p = await prepared();
  vi.stubGlobal("indexedDB", undefined);
  await expect(
    createReceiptTemplateLifecyclePendingJournal(scope, id(8)).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
  idb();
  const j = createReceiptTemplateLifecyclePendingJournal(scope, id(8));
  await j.reserve(p.cursor);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, await receipt(p), current(p), null)).rejects.toMatchObject({
    code: "Stale",
  });
  expect(await j.load()).toEqual(p.cursor);
});

it("Approve can recover after the same lifecycle publishes, without renewing historical approval", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8)),
    view = current(p);
  await j.reserve(p.cursor);
  if (!view.lifecycle) throw new Error("fixture lifecycle missing");
  const fresh: ReturnType<typeof current> = {
    ...view,
    lifecycle: {
      ...view.lifecycle,
      state: "Published",
      version: 4,
      latestMutationOperationReference: id(41),
    },
  };
  expect(await j.complete(p.cursor, await receipt(p), fresh, null)).toEqual({ historical: true });
  expect(await j.load()).toBeNull();
});
it("lower current head or a foreign current scope cannot corroborate a committed terminal", async () => {
  idb();
  const p = await prepared(),
    j = createReceiptTemplateLifecyclePendingJournal(scope, id(8)),
    view = current(p);
  await j.reserve(p.cursor);
  if (!view.lifecycle) throw new Error("fixture lifecycle missing");
  const r = await receipt(p);
  await expect(
    j.complete(
      p.cursor,
      r,
      {
        ...view,
        lifecycle: {
          ...view.lifecycle,
          state: "InReview",
          version: 2,
          latestMutationOperationReference: id(7),
          approvalEvidenceReference: null,
        },
      },
      null,
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  await expect(
    j.complete(p.cursor, r, { ...view, actorReference: id(90) }, null),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(await j.load()).toEqual(p.cursor);
});
