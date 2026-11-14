// Controlled IndexedDB event model; real browser IndexedDB is verified separately by the coordinator.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTaxConfigAuthoringPendingJournal } from "./tax-config-authoring-pending-journal.js";
import {
  createTaxConfigAuthoringClient,
  parseTaxConfigAuthoringCurrent,
  validateTaxConfigAuthoringReceipt,
  type PreparedTaxConfigAuthoringCommand,
  type TaxConfigAuthoringReceipt,
} from "./tax-config-authoring-client.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  hash = `sha256:${"a".repeat(64)}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const period = {
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-10-05T04:00:00.000Z",
    localDateTime: "2026-10-05T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
};
const prepared = (op = id(5)) =>
  createTaxConfigAuthoringClient().prepare(scope, {
    action: "CreateDraft",
    operationReference: op,
    configurationReference: null,
    expectedAggregateVersion: null,
    content: { stableCode: "SYNTHETIC", effectivePeriod: period, rules: [] },
  });
async function snapshot(root = 1) {
  const base = {
    configurationReference: id(6),
    versionReference: id(6 + root),
    brandReference: id(2),
    storeReference: id(3),
    stableCode: "SYNTHETIC",
    aggregateVersion: root,
    versionNumber: root,
    lifecycle: "Draft",
    jurisdictionCode: "CA-ON",
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(20),
      metadataDigest: hash,
    },
    effectivePeriod: period,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: [],
    createdAt: at,
  };
  return { ...base, snapshotDigest: await digest(base) };
}
async function terminal(
  p: PreparedTaxConfigAuthoringCommand,
  abandoned = false,
): Promise<TaxConfigAuthoringReceipt> {
  return validateTaxConfigAuthoringReceipt(
    {
      profile: "TaxConfigAuthoringOperationV1",
      ...scope,
      action: p.command.action,
      operationReference: p.command.operationReference,
      configurationReference: null,
      expectedAggregateVersion: null,
      command: abandoned ? null : p.command,
      intentDigest: p.intentDigest,
      serviceIntentDigest: abandoned ? null : hash,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : await snapshot(),
      auditReference: id(9),
      eventReference: abandoned ? null : id(10),
      occurredAt: at,
    },
    p.cursor,
  );
}
async function current(root = 1, empty = false) {
  return parseTaxConfigAuthoringCurrent(
    {
      profile: "TaxConfigAuthoringCurrentV1",
      ...scope,
      configurationReference: empty ? null : id(6),
      state: empty
        ? null
        : {
            profile: "TaxConfigAuthoringStateV1",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            draftAuthorActorReference: id(11),
            snapshot: await snapshot(root),
          },
      observedAt: at,
      validUntil: until,
      referenceEligibility: "NotEvaluated",
    },
    scope,
    empty ? null : id(6),
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
it("serializes competing new Create reservations and admits identical same-original reserve", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12)),
    a = createTaxConfigAuthoringPendingJournal(scope),
    b = createTaxConfigAuthoringPendingJournal(scope);
  expect(
    (await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)])).map((r) => r.status),
  ).toEqual(["fulfilled", "rejected"]);
  await b.reserve(p.cursor);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("survives reload with exact payload-free original only", async () => {
  const db = idb(),
    p = await prepared();
  await createTaxConfigAuthoringPendingJournal(scope).reserve(p.cursor);
  expect(await createTaxConfigAuthoringPendingJournal(scope).load()).toEqual(p.cursor);
  const bytes = JSON.stringify([...db.data.values()]);
  for (const field of [
    "content",
    "currencyMetadata",
    "rules",
    "professionalEvidence",
    "registrationEvidence",
    "csrf",
    "createdAt",
    "snapshot",
  ])
    expect(bytes).not.toContain(field);
});
it("does not clear a Committed original before actual fresh current exists", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p);
  await expect(j.complete(p.cursor, r, await current(1, true))).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(await j.load()).toEqual(p.cursor);
  await j.complete(p.cursor, r, await current());
  expect(await j.load()).toBeNull();
});
it("accepts later Manager Draft successor without changing original cursor identity", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), await current(2));
  expect(await j.load()).toBeNull();
});
it("rejects changed same-root content and keeps exact marker", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const value = await current();
  if (!value.state) throw new Error("controlled Draft absent");
  const changed = { ...value.state.snapshot, versionReference: id(90) },
    body = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "snapshotDigest"));
  await expect(
    j.complete(p.cursor, await terminal(p), {
      ...value,
      state: { ...value.state, snapshot: { ...changed, snapshotDigest: await digest(body) } },
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(await j.load()).toEqual(p.cursor);
});
it("requires original terminal identity/hash and scope, refusing unknown or forged receipt", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p),
    v = await current();
  for (const change of [
    { intentDigest: hash },
    { operationReference: id(99) },
    { actorReference: id(99) },
  ])
    await expect(j.complete(p.cursor, { ...r, ...change }, v)).rejects.toMatchObject({
      code: "Invalid",
    });
  expect(await j.load()).toEqual(p.cursor);
});
it("stale fresh query cannot clear old terminal even if original receipt is valid", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p),
    v = await current();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(j.complete(p.cursor, r, v)).rejects.toMatchObject({ code: "Stale" });
  expect(await j.load()).toEqual(p.cursor);
});
it("permits actual Abandoned with authoritative empty current without fabricating result root", async () => {
  idb();
  const p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), await current(1, true));
  expect(await j.load()).toBeNull();
});
it("an old receipt cannot erase a different operation marker", async () => {
  const db = idb(),
    p = await prepared(),
    q = await prepared(id(12)),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const key = canonical({ scope });
  db.data.set(key, q.cursor);
  await expect(j.complete(p.cursor, await terminal(p), await current())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(q.cursor);
});
it("malformed persisted scope/body is refused rather than deleted or replaced", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  const key = canonical({ scope });
  db.data.set(key, { ...p.cursor, content: { rate: "0.13" } });
  await expect(j.load()).rejects.toMatchObject({ code: "Invalid" });
  expect(db.data.size).toBe(1);
  await expect(j.reserve(p.cursor)).rejects.toMatchObject({ code: "Unavailable" });
});
it("scope switch isolates actors while foreign cursor is rejected", async () => {
  idb();
  const p = await prepared();
  await createTaxConfigAuthoringPendingJournal(scope).reserve(p.cursor);
  const other = createTaxConfigAuthoringPendingJournal({ ...scope, actorReference: id(40) });
  expect(await other.load()).toBeNull();
  await expect(other.reserve(p.cursor)).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("missing IDB and quota failures fail closed without volatile fallback", async () => {
  const p = await prepared();
  vi.stubGlobal("indexedDB", undefined);
  await expect(
    createTaxConfigAuthoringPendingJournal(scope).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
  const db = idb();
  db.refuseWrites();
  await expect(
    createTaxConfigAuthoringPendingJournal(scope).reserve(p.cursor),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(db.data.size).toBe(0);
});
it("cleanup failure preserves durable barrier despite confirmed terminal and current refresh", async () => {
  const db = idb(),
    p = await prepared(),
    j = createTaxConfigAuthoringPendingJournal(scope);
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), await current())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
