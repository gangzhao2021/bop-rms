import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicationValueDigest as hash } from "./product-publication-command-client-v2.js";
import {
  createPlatformTemplateClient,
  parsePlatformTemplateReceipt,
  type PlatformTemplatePendingOriginal,
  type PlatformTemplateList,
  type PreparedPlatformTemplate,
} from "./platform-template-client.js";
import { createPlatformTemplatePendingJournal } from "./platform-template-pending-journal.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  scope = {
    kind: "Platform" as const,
    actorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE" as const,
  };
const content = {
  code: "BRAND_STANDARD",
  name: "Private operator text",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  overrideAllowedFieldCodes: ["CONTACT"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
};
const prepare = (operationReference = id(2)) =>
  createPlatformTemplateClient().prepareSave(scope, {
    operationReference,
    templateReference: null,
    expectedHead: null,
    content,
  });
const list: PlatformTemplateList = {
  profile: "PlatformBrandTemplateListV1",
  ...scope,
  after: null,
  limit: 20,
  items: [],
  hasMore: false,
  nextCursor: null,
  observedAt: at,
  validUntil: until,
  publication: "NotEvaluated",
};
async function abandoned(p: PreparedPlatformTemplate) {
  return parsePlatformTemplateReceipt(
    {
      profile: "PlatformBrandTemplateOperationV1",
      ...scope,
      operationReference: p.original.operationReference,
      intentDigest: p.original.intentDigest,
      originalCommand: null,
      outcome: "Abandoned",
      snapshot: null,
      auditReference: id(5),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    p.original,
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

it("atomically reserves one scalar original across tabs, survives same Actor rotation and isolates other Actors", async () => {
  const db = idb(),
    a = createPlatformTemplatePendingJournal(scope),
    b = createPlatformTemplatePendingJournal(scope),
    p = await prepare(),
    q = await prepare(id(9));
  expect(
    (await Promise.allSettled([a.reserve(p.original), b.reserve(q.original)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.original);
  expect(db.durability).toContainEqual({ durability: "strict" });
  const text = JSON.stringify([...db.data.values()]);
  for (const value of [
    "content",
    "csrf",
    "token",
    "Private operator text",
    "BRAND_STANDARD",
    "expectedHead",
  ])
    expect(text).not.toContain(value);
  expect(
    await createPlatformTemplatePendingJournal({ ...scope, actorReference: id(9) }).load(),
  ).toBeNull();
  expect(await createPlatformTemplatePendingJournal(scope).load()).toEqual(p.original);
});
it("clears first Save Abandoned only after matching original reobservation and genuine fresh List", async () => {
  idb();
  const p = await prepare(),
    j = createPlatformTemplatePendingJournal(scope),
    r = await abandoned(p);
  await j.reserve(p.original);
  await expect(j.complete(p.original, r, r, {})).rejects.toThrow();
  expect(await j.load()).toEqual(p.original);
  await expect(
    j.complete(p.original, r, { ...r, auditReference: id(8) }, { list }),
  ).rejects.toThrow();
  await j.complete(p.original, r, r, { list });
  expect(await j.load()).toBeNull();
});
it("retains the atomic barrier for expired, wrong Actor, or replaced original refresh", async () => {
  const db = idb(),
    p = await prepare(),
    q = await prepare(id(9)),
    j = createPlatformTemplatePendingJournal(scope),
    r = await abandoned(p);
  await j.reserve(p.original);
  await expect(
    j.complete(p.original, r, r, { list: { ...list, actorReference: id(9) } }),
  ).rejects.toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.original, r, r, { list })).rejects.toThrow();
  expect(await j.load()).toEqual(p.original);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  const key = [...db.data.keys()][0];
  if (!key) throw Error("missing original");
  db.data.set(key, q.original);
  await expect(j.complete(p.original, r, r, { list })).rejects.toThrow();
  expect(await j.load()).toEqual(q.original);
});
it("fails durable reservation on storage denial without overwriting the retained original", async () => {
  const db = idb(),
    p = await prepare(),
    j = createPlatformTemplatePendingJournal(scope);
  await j.reserve(p.original);
  db.refuseWrites();
  await expect(j.reserve(p.original)).rejects.toThrow();
  expect(await j.load()).toEqual(p.original);
  vi.stubGlobal("indexedDB", undefined);
  await expect(createPlatformTemplatePendingJournal(scope).reserve(p.original)).rejects.toThrow();
});
it("rejects business payload or Session identifier in the durable scalar shape", async () => {
  idb();
  const p = await prepare(),
    j = createPlatformTemplatePendingJournal(scope);
  await expect(
    j.reserve({ ...p.original, content } as PlatformTemplatePendingOriginal),
  ).rejects.toThrow();
  await expect(
    j.reserve({ ...p.original, sessionReference: id(8) } as PlatformTemplatePendingOriginal),
  ).rejects.toThrow();
  expect(await j.load()).toBeNull();
});
it("requires exact committed immutable version plus refreshed current and history before clear", async () => {
  idb();
  const p = await prepare();
  if (p.request.action !== "Save") throw Error("expected Save");
  const { action, ...request } = p.request;
  void action;
  const body = {
    profile: "PlatformBrandTemplateRevisionV1",
    templateReference: id(3),
    templateVersionReference: id(4),
    revision: 1,
    recordKind: "AuthoredContent",
    content: p.request.content,
    supersedesVersionReference: null,
    authoredByReference: scope.actorReference,
    operationReference: p.original.operationReference,
    auditReference: id(5),
    createdAt: at,
    recordedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const semantic = {
    profile: "PlatformBrandTemplateContentV1",
    templateReference: body.templateReference,
    templateVersionReference: body.templateVersionReference,
    revision: body.revision,
    content: body.content,
    supersedesVersionReference: null,
    authoredByReference: body.authoredByReference,
    createdAt: at,
    dataClassification: body.dataClassification,
  };
  const full = { ...body, contentDigest: await hash(semantic) },
    snapshot = { ...full, sourceDigest: await hash(full) };
  const r = await parsePlatformTemplateReceipt(
    {
      profile: "PlatformBrandTemplateOperationV1",
      ...scope,
      operationReference: p.original.operationReference,
      intentDigest: p.original.intentDigest,
      originalCommand: { profile: "PlatformBrandTemplateSaveV1", ...scope, ...request },
      outcome: "Committed",
      snapshot,
      auditReference: id(5),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    p.original,
  );
  if (r.profile !== "PlatformBrandTemplateOperationV1" || !r.snapshot)
    throw Error("missing snapshot");
  const current = {
      profile: "PlatformBrandTemplateCurrentV1" as const,
      ...scope,
      templateReference: id(3),
      current: r.snapshot,
      observedAt: at,
      validUntil: until,
      publication: "NotEvaluated" as const,
    },
    exact = {
      profile: "PlatformBrandTemplateExactV1" as const,
      ...scope,
      templateVersionReference: id(4),
      snapshot: r.snapshot,
      observedAt: at,
      validUntil: until,
      publication: "NotEvaluated" as const,
    },
    history = {
      profile: "PlatformBrandTemplateHistoryV1" as const,
      ...scope,
      templateReference: id(3),
      beforeRevision: null,
      entries: [r.snapshot],
      nextBeforeRevision: null,
      observedAt: at,
      validUntil: until,
      publication: "NotEvaluated" as const,
    };
  const j = createPlatformTemplatePendingJournal(scope);
  await j.reserve(p.original);
  await expect(j.complete(p.original, r, r, { current, history })).rejects.toThrow();
  await expect(
    j.complete(p.original, r, r, { current, exact: { ...exact, snapshot: null }, history }),
  ).rejects.toThrow();
  expect(await j.load()).toEqual(p.original);
  await j.complete(p.original, r, r, { current, exact, history });
  expect(await j.load()).toBeNull();
});
