// Controlled atomic IndexedDB transport; actual browser durability is a separate gate.
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createTaxConfigCandidatePendingJournal } from "./tax-config-candidate-pending-journal.js";
import {
  createTaxConfigCandidateClient,
  parseTaxConfigCandidateCurrent,
  validateTaxConfigCandidateReceipt,
} from "./tax-config-candidate-client.js";
import { publicationValueDigest as digest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902602-0017-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  hash = "sha256:" + "a".repeat(64),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const command = {
  action: "PrepareCandidate",
  operationReference: id(5),
  configurationReference: id(6),
  expectedDraft: {
    versionReference: id(7),
    snapshotDigest: hash,
    aggregateVersion: 1,
    versionNumber: 1,
  },
  registrationMaterial: { materialReference: id(8), versionReference: id(9), contentDigest: hash },
};
async function record() {
  const content = {
    profile: "TaxPublicationCandidateContentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(6),
    baseDraft: command.expectedDraft,
    targetVersionReference: id(10),
    targetAggregateVersion: 2,
    targetVersionNumber: 2,
    stableCode: "SYNTHETIC",
    jurisdictionCode: "CA-ON",
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(11),
      metadataDigest: hash,
    },
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-10-01T04:00:00.000Z",
        localDateTime: "2026-10-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    rules: [],
    sourceRuleBindings: [],
    registrationMaterial: command.registrationMaterial,
  };
  return {
    profile: "TaxConfigCandidateRecordV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    preparedByActorReference: id(4),
    operationReference: id(5),
    candidate: {
      profile: "TaxPublicationCandidateV1",
      content,
      contentDigest: await digest(content),
    },
    auditReference: id(12),
    eventReference: id(13),
    preparedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  };
}
async function receipt(abandoned = false) {
  return {
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command: abandoned ? null : command,
    intentDigest: await digest({ scope, command }),
    outcome: abandoned ? "Abandoned" : "Committed",
    result: abandoned ? null : await record(),
    auditReference: id(12),
    eventReference: abandoned ? null : id(13),
    occurredAt: at,
  };
}
async function current() {
  return {
    profile: "TaxConfigCandidateCurrentV1",
    ...scope,
    configurationReference: id(6),
    targetVersionReference: id(10),
    record: await record(),
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  };
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

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const prepared = (op = id(5)) =>
  createTaxConfigCandidateClient().prepare(scope, { ...command, operationReference: op });
it("atomically arbitrates two candidate requests and admits only identical retry", async () => {
  const db = idb(),
    a = createTaxConfigCandidatePendingJournal(scope),
    b = createTaxConfigCandidatePendingJournal(scope),
    p = await prepared(),
    q = await prepared(id(30));
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await a.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
  expect(JSON.stringify([...db.data.values()])).not.toMatch(
    /rules|currencyMetadata|rate|csrf|content"/u,
  );
});
it("restores exact payload-free original after reload and isolates changed Actor/Store", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigCandidatePendingJournal(scope);
  await j.reserve(p.cursor);
  expect(await createTaxConfigCandidatePendingJournal(scope).load()).toEqual(p.cursor);
  expect(
    await createTaxConfigCandidatePendingJournal({ ...scope, actorReference: id(30) }).load(),
  ).toBeNull();
  await expect(
    j.reserve({ ...p.cursor, scope: { ...scope, storeReference: id(31) } }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(await j.load()).toEqual(p.cursor);
});
it("requires exact immutable original explicit current and fresh lease before deleting", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigCandidatePendingJournal(scope),
    r = await validateTaxConfigCandidateReceipt(await receipt(), p.cursor);
  await j.reserve(p.cursor);
  const fresh = parseTaxConfigCandidateCurrent(await current(), scope, {
    configurationReference: id(6),
    targetVersionReference: id(10),
  });
  vi.mocked(Date.now).mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, r, fresh)).rejects.toMatchObject({ code: "Stale" });
  expect(await j.load()).toEqual(p.cursor);
  vi.mocked(Date.now).mockReturnValue(Date.parse(at));
  await j.complete(p.cursor, r, fresh);
  expect(await j.load()).toBeNull();
});
it("old receipt cannot erase a newer original and cleanup failure keeps exact cursor", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(30)),
    j = createTaxConfigCandidatePendingJournal(scope),
    r = await validateTaxConfigCandidateReceipt(await receipt(), p.cursor),
    fresh = parseTaxConfigCandidateCurrent(await current(), scope, {
      configurationReference: id(6),
      targetVersionReference: id(10),
    });
  await j.reserve(q.cursor);
  await expect(j.complete(p.cursor, r, fresh)).rejects.toThrow();
  expect(await j.load()).toEqual(q.cursor);
  db.refuseWrites();
  await expect(j.reserve(q.cursor)).rejects.toThrow();
  expect(await j.load()).toEqual(q.cursor);
});
it("authoritative Abandoned plus actual current refresh clears without fabricated candidate", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigCandidatePendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await validateTaxConfigCandidateReceipt(await receipt(true), p.cursor),
    fresh = parseTaxConfigCandidateCurrent(
      {
        profile: "TaxConfigCandidateCurrentV1",
        ...scope,
        configurationReference: id(6),
        targetVersionReference: null,
        record: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      },
      scope,
      { configurationReference: id(6), targetVersionReference: null },
    );
  await j.complete(p.cursor, r, fresh);
  expect(await j.load()).toBeNull();
});
it("missing IndexedDB never substitutes volatile success", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(
    createTaxConfigCandidatePendingJournal(scope).reserve((await prepared()).cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
