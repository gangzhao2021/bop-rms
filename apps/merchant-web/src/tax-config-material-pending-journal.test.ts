// Controlled IndexedDB scheduling; production-browser IndexedDB is a separate coordinator gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTaxConfigMaterialPendingJournal } from "./tax-config-material-pending-journal.js";
import {
  createTaxConfigMaterialClient,
  parseTaxConfigMaterialCurrent,
  validateTaxConfigMaterialReceipt,
  type PreparedTaxConfigMaterialCommand,
} from "./tax-config-material-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = {
  operatingEntityProfileVersionReference: id(10),
  operatingEntityTaxReference: null,
  jurisdictionCode: "CA-ON",
  applicability: "NotApplicable",
  sourceIssuedAt: at,
  effectiveFrom: at,
  effectiveUntil: null,
  declaredSourceDigest: null,
};
const prepared = (op = id(5)) =>
  createTaxConfigMaterialClient().prepare(scope, {
    action: "CreateMaterial",
    operationReference: op,
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content,
  });
async function version(revision = 1) {
  return {
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    materialReference: id(6),
    versionReference: id(6 + revision),
    revision,
    previousVersionReference: revision === 1 ? null : id(5 + revision),
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: await digest(content),
    recordedByActorReference: revision === 1 ? id(4) : id(13),
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  };
}
async function terminal(p: PreparedTaxConfigMaterialCommand, abandoned = false) {
  return validateTaxConfigMaterialReceipt(
    {
      profile: "TaxConfigMaterialOperationV1",
      ...scope,
      action: p.command.action,
      operationReference: p.command.operationReference,
      materialReference: p.command.materialReference,
      expectedRevision: p.command.expectedRevision,
      materialKind: p.command.materialKind,
      command: abandoned ? null : p.command,
      intentDigest: p.intentDigest,
      outcome: abandoned ? "Abandoned" : "Committed",
      version: abandoned ? null : await version(),
      auditReference: id(8),
      eventReference: abandoned ? null : id(9),
      occurredAt: at,
    },
    p.cursor,
  );
}
async function current(revision = 1, empty = false) {
  return parseTaxConfigMaterialCurrent(
    {
      profile: "TaxConfigMaterialCurrentV1",
      ...scope,
      materialReference: empty ? null : id(6),
      materialKind: "RegistrationApplicability",
      version: empty ? null : await version(revision),
      observedAt: at,
      validUntil: until,
      qualification: "NotEvaluated",
    },
    scope,
    { materialKind: "RegistrationApplicability", materialReference: empty ? null : id(6) },
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
it("serializes two tabs and admits identical original reservation", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12)),
    a = createTaxConfigMaterialPendingJournal(scope),
    b = createTaxConfigMaterialPendingJournal(scope);
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await a.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("stores only original pins and hash, never material body or issuer details", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  expect(db.data.size).toBe(1);
  expect(JSON.stringify([...db.data.values()])).not.toMatch(
    /operatingEntity|declaredIssuer|sourceIssuedAt|NotApplicable/u,
  );
  expect([...db.data.values()]).toEqual([p.cursor]);
});
it("restores a lost original in a new journal before any material-source read", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const restarted = createTaxConfigMaterialPendingJournal(scope);
  expect(await restarted.load()).toEqual(p.cursor);
});
it("isolates actual Actor and Store scope and refuses cached foreign identity", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  expect(
    await createTaxConfigMaterialPendingJournal({ ...scope, actorReference: id(14) }).load(),
  ).toBeNull();
  expect(
    await createTaxConfigMaterialPendingJournal({ ...scope, storeReference: id(15) }).load(),
  ).toBeNull();
  await expect(
    j.reserve({ ...p.cursor, scope: { ...scope, actorReference: id(14) } }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(await j.load()).toEqual(p.cursor);
});
it("uses one whole-scope original barrier across material kinds", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const pin = { versionReference: id(7), contentDigest: `sha256:${"a".repeat(64)}` },
    other = await createTaxConfigMaterialClient().prepare(scope, {
      action: "CreateMaterial",
      operationReference: id(12),
      materialReference: null,
      expectedRevision: null,
      materialKind: "ProfessionalReport",
      content: {
        targetPublicationCandidate: pin,
        registrationMaterial: pin,
        fixtureSuiteMaterial: pin,
        declaredIssuer: {
          displayName: "Declared issuer",
          organizationName: null,
          credentialIdentifier: null,
        },
        reviewedAt: at,
        validUntil: until,
        declaredConclusion: "Pass",
        declaredSourceDigest: null,
      },
    });
  await expect(j.reserve(other.cursor)).rejects.toMatchObject({ code: "Unavailable" });
  expect(await j.load()).toEqual(p.cursor);
});
it("clears only after actual committed receipt and freshly hashed current version", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), await current());
  expect(await j.load()).toBeNull();
  expect(db.data.size).toBe(0);
});
it("allows legitimately newer authorized Manager revisions after the original commit", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), await current(2));
  expect(await j.load()).toBeNull();
});
it("clears durable Abandoned only with fresh same-kind scope and original hash", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), await current(1, true));
  expect(await j.load()).toBeNull();
});
it("keeps cursor when fresh current root, original action or hash differs", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const receipt = await terminal(p),
    view = await current();
  await expect(
    j.complete(p.cursor, receipt, { ...view, materialReference: id(20) }),
  ).rejects.toThrow();
  await expect(
    j.complete(p.cursor, { ...receipt, intentDigest: `sha256:${"a".repeat(64)}` }, view),
  ).rejects.toThrow();
  await expect(
    j.complete(p.cursor, { ...receipt, operationReference: id(20) }, view),
  ).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
});
it("keeps cursor when current content hash or equal-revision identity is counterfeit", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p),
    v = await current();
  if (!v.version) throw new Error("controlled version missing");
  await expect(
    j.complete(p.cursor, r, {
      ...v,
      version: { ...v.version, contentDigest: `sha256:${"a".repeat(64)}` },
    }),
  ).rejects.toThrow();
  await expect(
    j.complete(p.cursor, r, { ...v, version: { ...v.version, versionReference: id(21) } }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});
it("keeps cursor when lease expires and when cleanup storage fails", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p),
    v = await current();
  vi.mocked(Date.now).mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, r, v)).rejects.toMatchObject({ code: "Stale" });
  vi.mocked(Date.now).mockReturnValue(Date.parse(at));
  db.refuseWrites();
  await expect(j.complete(p.cursor, r, v)).rejects.toMatchObject({ code: "Unavailable" });
  expect(await j.load()).toEqual(p.cursor);
});
it("does not accept no terminal boolean or delete another tab's original", async () => {
  idb();
  const p = await prepared(),
    q = await prepared(id(12)),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  await expect(j.complete(q.cursor, await terminal(q), await current())).rejects.toMatchObject({
    code: "Unavailable",
  });
  await expect(
    j.complete(p.cursor, { ...(await terminal(p)), outcome: "Pending" } as never, await current()),
  ).rejects.toThrow();
  expect(await j.load()).toEqual(p.cursor);
});
it("fails closed on malformed durable payload, unavailable IDB and save quota", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigMaterialPendingJournal(scope);
  await j.reserve(p.cursor);
  const key = canonical({ scope });
  db.data.set(key, { ...p.cursor, content });
  await expect(j.load()).rejects.toThrow();
  db.data.delete(key);
  db.refuseWrites();
  await expect(j.reserve(p.cursor)).rejects.toMatchObject({ code: "Unavailable" });
  vi.stubGlobal("indexedDB", undefined);
  await expect(j.load()).rejects.toMatchObject({ code: "Unavailable" });
});
