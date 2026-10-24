// Controlled IDB transaction events; actual browser IDB is a separate acceptance gate.
import { afterEach, expect, it, vi } from "vitest";
import {
  createOptionPricePendingJournal,
  createOptionPricePendingDiscovery,
  parseOptionPricePendingOriginal,
} from "./option-price-pending-journal.js";
const id = (n: number) => "01902421-7c00-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  productReference: id(5),
  bindingReference: id(6),
  optionReference: id(7),
};
const scope4 = {
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  actorReference: scope.actorReference,
};
const content = {
  skuReference: null,
  scopeKind: "Brand",
  scopeReference: null,
  channelCode: null,
  orderType: null,
  unitAmountMinor: "125",
  includedQuantity: 1,
  effectivePeriod: {
    timeZone: "UTC",
    effectiveFrom: {
      instant: "2026-09-11T12:00:00.000Z",
      localDateTime: "2026-09-11T12:00:00.000",
      utcOffsetMinutes: 0,
    },
    effectiveUntil: null,
  },
};
const cursor = (op = id(50)) =>
  parseOptionPricePendingOriginal({
    profile: "OptionPricePendingOriginalV1",
    kind: "Authoring",
    scope: scope4,
    command: {
      action: "CreateDraft",
      operationReference: op,
      ruleReference: id(8),
      expectedAggregateVersion: null,
      bindingReference: scope.bindingReference,
      optionReference: scope.optionReference,
      content,
    },
    context: { productReference: scope.productReference, expectedProductAggregateVersion: 1 },
  });
const review = (op = id(60)) =>
  parseOptionPricePendingOriginal({
    profile: "OptionPricePendingOriginalV1",
    kind: "Review",
    scope: scope4,
    command: {
      action: "SubmitReview",
      operationReference: op,
      ruleReference: id(8),
      draftVersionReference: id(9),
      draftSnapshotDigest: "sha256:" + "a".repeat(64),
      expectedAggregateVersion: 1,
      validationValidUntil: "2026-09-12T12:00:00.000Z",
      approvalValidUntil: null,
      expectedLifecycle: null,
    },
    context: {
      productReference: scope.productReference,
      expectedProductAggregateVersion: 1,
      bindingReference: scope.bindingReference,
      optionReference: scope.optionReference,
    },
  });
afterEach(() => vi.unstubAllGlobals());
function idb() {
  const data = new Map<string, unknown>(),
    durability: unknown[] = [];
  let tail = Promise.resolve(),
    quota = false,
    cursorFailed = false;
  const factory = {
    open: vi.fn(() => {
      const open: {
        result: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      const db = {
        close: vi.fn(),
        onversionchange: null,
        objectStoreNames: { contains: () => true },
        transaction(_store: unknown, _mode: unknown, options: unknown) {
          durability.push(options);
          const tx: {
            oncomplete: (() => void) | null;
            onabort: (() => void) | null;
            onerror: (() => void) | null;
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
          let failed = false;
          const reads: {
              key: string;
              request: { result: unknown; onsuccess: (() => void) | null };
            }[] = [],
            changes = new Map<string, unknown>();
          const cursorReads: {
            range: { lower: string; upper: string };
            request: {
              result: null | { key: string; value: unknown; continue: () => void };
              onsuccess: null | (() => void);
              onerror: null | (() => void);
            };
          }[] = [];
          const table = {
            openCursor(range: { lower: string; upper: string }) {
              const request: {
                result: null | { key: string; value: unknown; continue: () => void };
                onsuccess: null | (() => void);
                onerror: null | (() => void);
              } = { result: null, onsuccess: null, onerror: null };
              cursorReads.push({ range, request });
              return request;
            },
            get(key: string) {
              const request = {
                result: undefined as unknown,
                onsuccess: null as (() => void) | null,
              };
              reads.push({ key, request });
              return request;
            },
            put(value: unknown, key: string) {
              if (quota) throw Error("Synthetic storage quota");
              changes.set(key, value);
            },
            delete(key: string) {
              if (quota) throw Error("Synthetic storage quota");
              changes.set(key, undefined);
            },
          };
          tail = tail.then(() => {
            for (const { key, request } of reads) {
              request.result = data.get(key);
              request.onsuccess?.();
            }
            for (const { range, request } of cursorReads) {
              if (cursorFailed) {
                request.onerror?.();
                break;
              }
              const keys = [...data.keys()]
                .filter((key) => key >= range.lower && key <= range.upper)
                .sort();
              for (const key of keys) {
                let continued = false;
                request.result = {
                  key,
                  value: data.get(key),
                  continue: () => {
                    continued = true;
                  },
                };
                request.onsuccess?.();
                if (failed || !continued) break;
              }
              if (!failed) {
                request.result = null;
                request.onsuccess?.();
              }
            }
            if (failed) return;
            for (const [key, v] of changes)
              if (v === undefined) data.delete(key);
              else data.set(key, globalThis.structuredClone(v));
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
  vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
  return {
    data,
    factory,
    durability,
    refuseCursorReads: () => {
      cursorFailed = true;
    },
    refuseWrites: () => {
      quota = true;
    },
  };
}

it("atomic original across authoring/review reserves rejects replacement and exact original CAS survives reload", async () => {
  const h = idb(),
    a = createOptionPricePendingJournal(scope),
    b = createOptionPricePendingJournal(scope);
  expect(await a.load()).toBeNull();
  const results = await Promise.allSettled([a.reserve(cursor()), b.reserve(review())]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(cursor());
  await b.reserve(cursor());
  await expect(b.complete(review())).rejects.toThrow();
  expect(h.data.size).toBe(1);
  await a.complete(cursor());
  await b.reserve(review());
  await expect(a.complete(cursor())).rejects.toThrow();
  expect(await createOptionPricePendingJournal(scope).load()).toEqual(review());
  await b.complete(review());
  expect(await a.load()).toBeNull();
  expect(h.durability).toContainEqual({ durability: "strict" });
});
it("persists only exact owning business intent and context, never credentials/policy/report/cache", async () => {
  const h = idb(),
    journal = createOptionPricePendingJournal(scope);
  await journal.reserve(cursor());
  const original = [...h.data.values()][0];
  expect(original).toEqual(cursor());
  const stored = JSON.stringify(original);
  expect(stored).toContain('"unitAmountMinor":"125"');
  for (const forbidden of [
    "csrf",
    "policy",
    "editorContent",
    "localizedNames",
    "currencyMetadata",
    "approvalEvidence",
    "report",
    "health",
  ])
    expect(stored).not.toContain(forbidden);
  expect(() => parseOptionPricePendingOriginal({ ...cursor(), csrf: "credential" })).toThrow();
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "productReference",
  "bindingReference",
  "optionReference",
] as const)("selected %s key isolates the existing pending operation", async (field) => {
  idb();
  const journal = createOptionPricePendingJournal(scope);
  await journal.reserve(cursor());
  expect(await createOptionPricePendingJournal({ ...scope, [field]: id(99) }).load()).toBeNull();
  expect(await journal.load()).toEqual(cursor());
});
it("foreign Product/Create BindingChoice/Review anchor and mismatched scope refuse dispatch reservation", async () => {
  idb();
  const journal = createOptionPricePendingJournal(scope);
  const c = cursor();
  await expect(
    journal.reserve(
      parseOptionPricePendingOriginal({
        ...c,
        context: { ...c.context, productReference: id(99) },
      }),
    ),
  ).rejects.toThrow();
  if (c.kind !== "Authoring") throw Error("Authoring fixture");
  await expect(
    journal.reserve(
      parseOptionPricePendingOriginal({
        ...c,
        command: { ...c.command, bindingReference: id(99) },
      }),
    ),
  ).rejects.toThrow();
  const r = review();
  if (r.kind !== "Review") throw Error("Review fixture");
  await expect(
    journal.reserve(
      parseOptionPricePendingOriginal({ ...r, context: { ...r.context, optionReference: id(99) } }),
    ),
  ).rejects.toThrow();
  expect(await journal.load()).toBeNull();
});
it("existing null BindingChoice command retains independently selected key and original expiry never deletes Unknown", async () => {
  idb();
  const journal = createOptionPricePendingJournal(scope),
    c = cursor();
  const replaced = parseOptionPricePendingOriginal({
    ...c,
    command: {
      action: "ReplaceDraft",
      operationReference: id(51),
      ruleReference: id(8),
      expectedAggregateVersion: 2,
      bindingReference: null,
      optionReference: null,
      content,
    },
  });
  await journal.reserve(replaced);
  expect(await createOptionPricePendingJournal(scope).load()).toEqual(replaced);
  await journal.complete(replaced);
  await journal.reserve(review());
  expect(await journal.load()).toEqual(review());
});
it("malformed stored original remains locked and cannot be cleared by another operation", async () => {
  const h = idb(),
    journal = createOptionPricePendingJournal(scope);
  await journal.reserve(cursor());
  const key = [...h.data.keys()][0];
  if (!key) throw Error("Expected original key");
  h.data.set(key, {
    ...cursor(),
    context: { productReference: id(99), expectedProductAggregateVersion: 1 },
  });
  await expect(journal.load()).rejects.toThrow();
  await expect(journal.reserve(cursor())).rejects.toThrow();
  await expect(journal.complete(cursor())).rejects.toThrow();
  expect(h.data.size).toBe(1);
});
it("missing/blocked/quota IDB has no successful volatile fallback", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const journal = createOptionPricePendingJournal(scope);
  await expect(journal.load()).rejects.toThrow();
  await expect(journal.reserve(cursor())).rejects.toThrow();
  vi.stubGlobal("indexedDB", {
    open: () => {
      throw Error("Synthetic quota refusal");
    },
  });
  await expect(journal.reserve(cursor())).rejects.toThrow();
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: { onblocked: (() => void) | null } = { onblocked: null };
      queueMicrotask(() => request.onblocked?.());
      return request;
    },
  });
  await expect(journal.load()).rejects.toThrow();
});
it("payload descriptor accessors are never read", () => {
  const getter = vi.fn(() => cursor().command),
    value = { ...cursor() };
  Object.defineProperty(value, "command", { enumerable: true, get: getter });
  expect(() => parseOptionPricePendingOriginal(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("failed persistent CAS cleanup keeps the original marker instead of unlocking", async () => {
  const h = idb(),
    journal = createOptionPricePendingJournal(scope);
  await journal.reserve(cursor());
  h.refuseWrites();
  await expect(journal.complete(cursor())).rejects.toThrow();
  expect(await journal.load()).toEqual(cursor());
  expect(h.data.size).toBe(1);
  await expect(journal.reserve(review())).rejects.toThrow();
});

const discoveryScope = { ...scope4, productReference: scope.productReference };
const storedKey = (
  bindingReference = scope.bindingReference,
  optionReference = scope.optionReference,
) =>
  JSON.stringify([
    ...Object.values(scope4),
    scope.productReference,
    bindingReference,
    optionReference,
  ]);
it("discovers original authoring and review intents without today's saved Binding or policy", async () => {
  idb();
  await createOptionPricePendingJournal(scope).reserve(cursor());
  const otherBinding = id(80),
    otherScope = { ...scope, bindingReference: otherBinding };
  const otherReview = parseOptionPricePendingOriginal({
    ...review(),
    context: { ...review().context, bindingReference: otherBinding },
  });
  await createOptionPricePendingJournal(otherScope).reserve(otherReview);
  const result = await createOptionPricePendingDiscovery(discoveryScope).load();
  expect(result).toEqual([
    {
      bindingReference: scope.bindingReference,
      optionReference: scope.optionReference,
      original: cursor(),
    },
    {
      bindingReference: otherBinding,
      optionReference: scope.optionReference,
      original: otherReview,
    },
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
  await createOptionPricePendingJournal({
    ...discoveryScope,
    bindingReference: scope.bindingReference,
    optionReference: scope.optionReference,
  }).complete(cursor());
  expect(await createOptionPricePendingDiscovery(discoveryScope).load()).toHaveLength(1);
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "productReference",
] as const)(
  "discovery isolates actual current %s rather than trusting a stored identity",
  async (field) => {
    const h = idb();
    await createOptionPricePendingJournal(scope).reserve(cursor());
    expect(
      await createOptionPricePendingDiscovery({ ...discoveryScope, [field]: id(90) }).load(),
    ).toEqual([]);
    expect(h.data.size).toBe(1);
  },
);
it("does not parse another scope's potentially malformed business intent", async () => {
  const h = idb();
  await createOptionPricePendingJournal(scope).reserve(cursor());
  const foreign = [...Object.values(scope4)];
  foreign[3] = id(90);
  h.data.set(
    JSON.stringify([
      ...foreign,
      scope.productReference,
      scope.bindingReference,
      scope.optionReference,
    ]),
    { notAnOriginal: true },
  );
  expect(await createOptionPricePendingDiscovery(discoveryScope).load()).toHaveLength(1);
});
it.each([
  (v: ReturnType<typeof cursor>) => ({ ...v, scope: { ...scope4, actorReference: id(90) } }),
  (v: ReturnType<typeof cursor>) => ({ ...v, context: { ...v.context, productReference: id(90) } }),
  (v: ReturnType<typeof cursor>) => ({ ...v, command: { ...v.command, bindingReference: id(90) } }),
  (v: ReturnType<typeof cursor>) => ({ ...v, command: { ...v.command, optionReference: id(90) } }),
])(
  "refuses corrupted scope/product/locator coherence rather than silently omitting an original %#",
  async (change) => {
    const h = idb();
    h.data.set(storedKey(), change(cursor()));
    await expect(createOptionPricePendingDiscovery(discoveryScope).load()).rejects.toMatchObject({
      code: "Unavailable",
    });
    expect(h.data.size).toBe(1);
  },
);
it("rejects noncanonical keys and duplicate original operation locators", async () => {
  const h = idb();
  h.data.set(storedKey().replace("]", " ]"), cursor());
  await expect(createOptionPricePendingDiscovery(discoveryScope).load()).rejects.toMatchObject({
    code: "Unavailable",
  });
  h.data.clear();
  h.data.set(storedKey(), cursor());
  const extraBinding = id(91);
  h.data.set(storedKey(extraBinding), {
    ...cursor(),
    command: { ...cursor().command, bindingReference: extraBinding },
  });
  await expect(createOptionPricePendingDiscovery(discoveryScope).load()).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("returns bounded complete discovery and refuses overflow without truncation or deletion", async () => {
  const h = idb();
  for (let i = 0; i < 1001; i++) {
    const bindingReference = id(100 + i);
    h.data.set(storedKey(bindingReference), {
      ...cursor(id(2000 + i)),
      command: { ...cursor(id(2000 + i)).command, bindingReference },
    });
  }
  await expect(createOptionPricePendingDiscovery(discoveryScope).load()).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(h.data.size).toBe(1001);
  h.data.delete(storedKey(id(1100)));
  expect(await createOptionPricePendingDiscovery(discoveryScope).load()).toHaveLength(1000);
});
it("cursor failure remains an unavailable recovery read, never an empty absence", async () => {
  const h = idb();
  await createOptionPricePendingJournal(scope).reserve(cursor());
  h.refuseCursorReads();
  await expect(createOptionPricePendingDiscovery(discoveryScope).load()).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(h.data.size).toBe(1);
});
it("discovery requires closed current full scope and never infers missing Actor from storage", () => {
  const h = idb();
  expect(() =>
    createOptionPricePendingDiscovery({ ...discoveryScope, actorReference: "" }),
  ).toThrow();
  expect(() =>
    createOptionPricePendingDiscovery({ ...discoveryScope, productReference: "" }),
  ).toThrow();
  const extraInput = { ...discoveryScope, extra: true };
  expect(() => createOptionPricePendingDiscovery(extraInput)).toThrow();
  expect(h.factory.open).not.toHaveBeenCalled();
});
