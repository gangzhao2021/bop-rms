// Controlled IDB transaction events; real IndexedDB remains a rendered browser gate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorePaymentConfigurationPendingJournal } from "./store-payment-configuration-pending-journal.js";
import {
  createStorePaymentConfigurationClient,
  parseStorePaymentConfigurationCurrent,
  validateStorePaymentConfigurationReceipt,
  type PreparedStorePaymentConfiguration,
} from "./store-payment-configuration-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = {
  customerOnlineCardEnabled: false,
  staffTerminalCardPresentEnabled: true,
  staffTerminalInteracEnabled: true,
};
const prepared = (operationReference = id(5)) =>
  createStorePaymentConfigurationClient().prepare({
    expectedScope: scope,
    operationReference,
    expectedConfigurationReference: null,
    expectedRevision: 0,
    content,
  });
function snapshot(p: PreparedStorePaymentConfiguration, revision = 1) {
  return {
    profile: "StorePaymentConfigurationV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: revision === 1 ? id(6) : id(8),
    revision,
    authoredByReference: id(4),
    previousConfigurationReference: revision === 1 ? null : id(6),
    content: p.command.content,
    currencyCode: "CAD",
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
const terminal = (p: PreparedStorePaymentConfiguration, abandoned = false) =>
  validateStorePaymentConfigurationReceipt(
    {
      profile: "StorePaymentConfigurationReceiptV1",
      ...scope,
      operationReference: p.cursor.operationReference,
      intentDigest: p.intentDigest,
      expectedConfigurationReference: null,
      expectedRevision: 0,
      outcome: abandoned ? "Abandoned" : "Committed",
      snapshot: abandoned ? null : snapshot(p),
      auditReference: id(7),
      occurredAt: at,
    },
    p.cursor,
  );
const current = (p: PreparedStorePaymentConfiguration, revision = 1) =>
  parseStorePaymentConfigurationCurrent(
    {
      profile: "StorePaymentConfigurationCurrentV1",
      ...scope,
      snapshot: revision ? snapshot(p, revision) : null,
      observedAt: at,
      validUntil: until,
      providerReadiness: "NotEvaluated",
    },
    id(3),
    scope,
  );
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

it("two actual tabs atomically reserve only one original and strict durable writes", async () => {
  const db = idb(),
    a = createStorePaymentConfigurationPendingJournal(scope),
    b = createStorePaymentConfigurationPendingJournal(scope),
    p = await prepared(),
    q = await prepared(id(9));
  const outcomes = await Promise.allSettled([a.reserve(p.cursor), b.reserve(q.cursor)]);
  expect(outcomes.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(p.cursor);
  expect(db.durability).toContainEqual({ durability: "strict" });
  await a.reserve(p.cursor);
  expect(db.data.size).toBe(1);
});
it("reload preserves original pins/hash only, never payment rules or credentials", async () => {
  const db = idb(),
    p = await prepared();
  await createStorePaymentConfigurationPendingJournal(scope).reserve(p.cursor);
  expect(await createStorePaymentConfigurationPendingJournal(scope).load()).toEqual(p.cursor);
  const text = JSON.stringify([...db.data.values()]);
  for (const field of [
    "content",
    "csrf",
    "snapshot",
    "customerOnlineCardEnabled",
    "staffTerminalCardPresentEnabled",
    "staffTerminalInteracEnabled",
    "providerReadiness",
  ])
    expect(text).not.toContain(field);
});
it("scope4 separates current Actor and Store without erasing their old original", async () => {
  const db = idb(),
    p = await prepared();
  await createStorePaymentConfigurationPendingJournal(scope).reserve(p.cursor);
  for (const selected of [
    { ...scope, actorReference: id(9) },
    { ...scope, storeReference: id(9) },
  ])
    expect(await createStorePaymentConfigurationPendingJournal(selected).load()).toBeNull();
  expect(db.data.size).toBe(1);
  expect(await createStorePaymentConfigurationPendingJournal(scope).load()).toEqual(p.cursor);
});
it("actual matching terminal plus fresh current permits cleanup, including legitimate successor", async () => {
  idb();
  const p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), current(p, 2));
  expect(await j.load()).toBeNull();
});
it("permanent Abandoned needs no invented saved configuration", async () => {
  idb();
  const p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p, true), current(p, 0));
  expect(await j.load()).toBeNull();
});
it("missing actual current and stale current retain the original barrier", async () => {
  idb();
  const p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
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
it.each(["identity", "content"])(
  "same current revision with altered %s cannot clear",
  async (kind) => {
    idb();
    const p = await prepared(),
      j = createStorePaymentConfigurationPendingJournal(scope);
    await j.reserve(p.cursor);
    const view = current(p);
    if (!view.snapshot) throw new Error("snapshot missing");
    const changed =
      kind === "identity"
        ? { ...view.snapshot, configurationReference: id(9) }
        : { ...view.snapshot, content: { ...content, customerOnlineCardEnabled: true } };
    await expect(
      j.complete(p.cursor, await terminal(p), { ...view, snapshot: changed }),
    ).rejects.toMatchObject({ code: "Conflict" });
    expect(await j.load()).toEqual(p.cursor);
  },
);
it("wrong terminal, foreign fresh reader and tampered content cannot unlock", async () => {
  idb();
  const p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await j.reserve(p.cursor);
  const r = await terminal(p);
  await expect(
    j.complete(p.cursor, { ...r, operationReference: id(9) }, current(p)),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    j.complete(p.cursor, r, { ...current(p), actorReference: id(9) }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  await expect(
    j.complete(
      p.cursor,
      {
        ...r,
        snapshot: r.snapshot
          ? { ...r.snapshot, content: { ...content, customerOnlineCardEnabled: true } }
          : null,
      },
      current(p),
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(await j.load()).toEqual(p.cursor);
});
it("quota failure during cleanup retains exact durable pending identity", async () => {
  const db = idb(),
    p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await j.reserve(p.cursor);
  db.refuseWrites();
  await expect(j.complete(p.cursor, await terminal(p), current(p))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(p.cursor);
});
it("malformed/foreign cursor refused before opening a journal", async () => {
  const db = idb(),
    p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await expect(
    j.reserve({ ...p.cursor, scope: { ...scope, actorReference: id(9) } }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  const malformed = { ...p.cursor, content };
  await expect(j.reserve(malformed)).rejects.toMatchObject({ code: "Invalid" });
  expect(db.factory.open).not.toHaveBeenCalled();
});
it("receipt for old operation cannot erase a newer reservation", async () => {
  idb();
  const p = await prepared(),
    q = await prepared(id(9)),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await j.reserve(p.cursor);
  await j.complete(p.cursor, await terminal(p), current(p));
  await j.reserve(q.cursor);
  await expect(j.complete(p.cursor, await terminal(p), current(p))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(await j.load()).toEqual(q.cursor);
});
it("missing IndexedDB is fail closed without volatile reservation", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const p = await prepared(),
    j = createStorePaymentConfigurationPendingJournal(scope);
  await expect(j.reserve(p.cursor)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(j.load()).rejects.toMatchObject({ code: "Unavailable" });
});
