// Controlled IDB event evidence; no browser persistence claim.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrandConfigurationPendingJournal } from "./brand-configuration-pending-journal.js";
import {
  createMerchantBrandConfigurationClient,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  validateBrandConfigurationReceipt,
} from "./merchant-brand-configuration-client.js";
import { publicationValueDigest as hash } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) };
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function materials(operationReference = id(3)) {
  const client = createMerchantBrandConfigurationClient(),
    prepared = await client.prepare({
      profile: "TenantBrandConfigurationCommandV1",
      ...scope,
      command: "SaveConfigurationDraft",
      operationReference,
      expectedBrandVersion: 1,
      expectedHead: null,
      purposeCode: "BRAND_CONFIGURATION",
      configuration: {
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA"],
        mediaThemeReference: null,
        catalogSourceReference: id(4),
        platformTemplateReference: id(5),
        overrideAllowedFieldCodes: [],
        hardRequirementFieldCodes: ["CURRENCY"],
        effectiveFrom: at,
        effectiveUntil: null,
        reasonCode: "AUTHOR_EDIT",
      },
      reviewValidUntil: null,
    });
  const { profile, ...pins } = prepared.original;
  void profile;
  const receipt = await validateBrandConfigurationReceipt(
    {
      profile: "TenantBrandConfigurationOperationV1",
      ...pins,
      originalCommand: null,
      outcome: "Abandoned",
      snapshot: null,
      auditReference: id(6),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    prepared.original,
  );
  const base = { ...scope, observedAt: at, validUntil: until, currentPublication: "NotEvaluated" };
  const current = await parseBrandConfigurationCurrent(
    { profile: "TenantBrandConfigurationCurrentV1", ...base, current: null, recordedReview: null },
    scope,
  );
  const history = await parseBrandConfigurationHistory(
    {
      profile: "TenantBrandConfigurationHistoryV1",
      ...base,
      beforeRevision: null,
      entries: [],
      nextBeforeRevision: null,
    },
    scope,
    null,
  );
  return { prepared, original: prepared.original, receipt, current, history };
}
function idb() {
  const data = new Map<string, unknown>(),
    durability: unknown[] = [];
  let tail = Promise.resolve(),
    quota = false;
  let beforeRead: (() => void) | null = null;
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
            const action = beforeRead;
            beforeRead = null;
            action?.();
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
    onNextRead(action: () => void) {
      beforeRead = action;
    },
    refuseWrites: () => {
      quota = true;
    },
  };
}

it("fails closed when durable IDB is unavailable", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const journal = createBrandConfigurationPendingJournal(scope);
  await expect(journal.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it("durably reserves only the scalar immutable original and refuses competing replacement", async () => {
  const db = idb(),
    journal = createBrandConfigurationPendingJournal(scope),
    a = await materials(),
    b = await materials(id(7));
  await journal.reserve(a.original);
  expect(await journal.load()).toEqual(a.original);
  expect([...db.data.values()][0]).not.toHaveProperty("configuration");
  expect([...db.data.values()][0]).not.toHaveProperty("reviewValidUntil");
  await journal.reserve(a.original);
  await expect(journal.reserve(b.original)).rejects.toThrow();
  expect(await journal.load()).toEqual(a.original);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("rejects wrong Actor scope before storage", async () => {
  const db = idb(),
    journal = createBrandConfigurationPendingJournal(scope),
    a = await materials();
  await expect(journal.reserve({ ...a.original, actorReference: id(8) })).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  expect(db.data.size).toBe(0);
});
it("compares fresh owner reobservation before deleting the identical original", async () => {
  idb();
  const journal = createBrandConfigurationPendingJournal(scope),
    a = await materials();
  await journal.reserve(a.original);
  await expect(
    journal.complete(
      a.original,
      a.receipt,
      { ...a.receipt, auditReference: id(9) },
      a.current,
      a.history,
    ),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(a.original);
  await journal.complete(a.original, a.receipt, a.receipt, a.current, a.history);
  expect(await journal.load()).toBeNull();
});
it("preserves another tab original changed during the atomic compare-delete", async () => {
  const db = idb(),
    journal = createBrandConfigurationPendingJournal(scope),
    a = await materials(),
    b = await materials(id(7));
  await journal.reserve(a.original);
  db.onNextRead(() => {
    for (const key of db.data.keys()) db.data.set(key, b.original);
  });
  await expect(
    journal.complete(a.original, a.receipt, a.receipt, a.current, a.history),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(b.original);
});
it("rechecks the original observation lease inside the IDB transaction", async () => {
  const db = idb(),
    journal = createBrandConfigurationPendingJournal(scope),
    a = await materials();
  await journal.reserve(a.original);
  db.onNextRead(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(until)));
  await expect(
    journal.complete(a.original, a.receipt, a.receipt, a.current, a.history),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(a.original);
});
it("retains the original on quota failure", async () => {
  const db = idb(),
    journal = createBrandConfigurationPendingJournal(scope),
    a = await materials();
  db.refuseWrites();
  await expect(journal.reserve(a.original)).rejects.toThrow();
  expect(db.data.size).toBe(0);
});

it("refuses two independently valid records that disagree for the same immutable revision", async () => {
  idb();
  const journal = createBrandConfigurationPendingJournal(scope),
    a = await materials();
  await journal.reserve(a.original);
  const editable = a.prepared.command.configuration;
  if (!editable) throw new Error("fixture configuration");
  const semantic = {
    profile: "TenantBrandConfigurationContentV1",
    ...editable,
    configurationVersionReference: id(11),
    brandReference: id(1),
    configurationVersion: 1,
    supersedesVersionReference: null,
    authoredByReference: id(2),
    createdAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const { profile, ...content } = semantic;
  void profile;
  const configuration = {
    ...content,
    lifecycle: "Draft",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    updatedAt: at,
  };
  const body = {
    profile: "TenantBrandConfigurationRevisionV1",
    ...scope,
    revision: 1,
    brandVersion: 1,
    command: "SaveConfigurationDraft",
    operationReference: a.original.operationReference,
    configuration,
    submittedByReference: null,
    publishing: null,
    contentDigest: await hash(semantic),
    auditReference: id(6),
    createdAt: at,
    recordedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const snapshot = { ...body, sourceDigest: await hash(body) },
    alternateBody = { ...body, auditReference: id(12) },
    alternate = { ...alternateBody, sourceDigest: await hash(alternateBody) };
  const receipt = await validateBrandConfigurationReceipt(
    { ...a.receipt, originalCommand: a.prepared.command, outcome: "Committed", snapshot },
    a.original,
  );
  const current = await parseBrandConfigurationCurrent({ ...a.current, current: alternate }, scope);
  await expect(
    journal.complete(a.original, receipt, receipt, current, a.history),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await journal.load()).toEqual(a.original);
  const genuine = await parseBrandConfigurationCurrent({ ...a.current, current: snapshot }, scope),
    history = await parseBrandConfigurationHistory(
      { ...a.history, entries: [alternate] },
      scope,
      null,
    );
  await expect(
    journal.complete(a.original, receipt, receipt, genuine, history),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await journal.load()).toEqual(a.original);
});
