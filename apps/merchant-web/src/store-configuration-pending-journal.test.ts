// Controlled atomic IDB event semantics; ordinary browser and Session/IAM are separate gates.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createStoreConfigurationPendingJournal,
  validateStoreConfigurationOriginalCursor,
  validateStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationOriginalCursor,
} from "./store-configuration-pending-journal.js";
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
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(20),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "SETUP_MATERIALIZATION",
  authoredByReference: id(4),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

const setupSelector = {
  setupDraftReference: id(30),
  sourceRevision: 1,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
};
const basis = {
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(1),
  ...setupSelector,
  feeContexts: [
    { chargeType: "ServiceCharge", state: "Disabled" },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
};
async function original(
  operationReference = id(90),
  action: "Materialize" | "Validate" | "Submit" | "Approve" | "Publish" = "Materialize",
) {
  const command = {
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope,
    operationReference,
    action,
    expectedHead:
      action === "Materialize"
        ? { configurationReference: null, configurationVersion: 0, contentDigest: null }
        : {
            configurationReference: id(20),
            configurationVersion: 1,
            contentDigest: await publicationValueDigest(configuration("Draft")),
          },
    ...(action === "Materialize" ? { setupSelector, reasonCode: "SETUP_MATERIALIZATION" } : {}),
  };
  return validateStoreConfigurationOriginalCursor({
    ...command,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: await publicationValueDigest(command),
  });
}
async function terminal(cursor: StoreConfigurationOriginalCursor, abandoned = false) {
  const snapshot = {
    ...configuration(
      cursor.action === "Submit"
        ? "PendingApproval"
        : cursor.action === "Approve"
          ? "Approved"
          : cursor.action === "Publish"
            ? "Published"
            : "Draft",
    ),
    ...(cursor.action === "Materialize" ? { setupBasis: basis } : {}),
  };
  return validateStoreConfigurationOrdinaryReceipt(
    {
      ...cursor,
      profile: "StoreConfigurationOrdinaryReceiptV1",
      outcome: abandoned ? "Abandoned" : "Committed",
      operation: abandoned
        ? null
        : {
            command: cursor.action === "Materialize" ? "SaveDraft" : cursor.action,
            operationReference: cursor.operationReference,
            brandReference: id(2),
            storeReference: id(3),
            intentDigest: "sha256:" + "b".repeat(64),
            resultingVersion: 1,
            configuration: snapshot,
          },
      auditReference: id(91),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    cursor,
  );
}
async function workspace(
  cursor: StoreConfigurationOriginalCursor,
  abandoned = false,
  successor = false,
) {
  const receipt = await terminal(cursor, abandoned);
  const latest = successor
    ? {
        ...configuration("Draft"),
        configurationReference: id(21),
        configurationVersion: 2,
        authoredByReference: id(22),
        supersedesConfigurationReference: id(20),
      }
    : (receipt.operation?.configuration ?? null);
  return parseStoreConfigurationOrdinaryWorkspace(
    {
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest,
      current: null,
      expectedHead: latest
        ? {
            configurationReference: latest.configurationReference,
            configurationVersion: latest.configurationVersion,
            contentDigest: await publicationValueDigest(latest),
          }
        : { configurationReference: null, configurationVersion: 0, contentDigest: null },
      original: receipt,
      observedAt: at,
      validUntil: until,
      businessReferenceValidation: "NotEvaluated",
    },
    scope,
  );
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

it("atomically reserves only one exact original across tabs with strict durability", async () => {
  const db = idb(),
    a = createStoreConfigurationPendingJournal(scope),
    b = createStoreConfigurationPendingJournal(scope),
    first = await original(),
    second = await original(id(92));
  expect(await a.load()).toBeNull();
  const results = await Promise.allSettled([a.reserve(first), b.reserve(second)]);
  expect(results.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(await b.load()).toEqual(first);
  await b.reserve(first);
  expect(await a.load()).toEqual(first);
  expect(db.durability).toContainEqual({ durability: "strict" });
});
it("reload preserves exact canonical command pins and hash without configuration or credentials", async () => {
  const db = idb(),
    cursor = await original();
  await createStoreConfigurationPendingJournal(scope).reserve(cursor);
  expect(await createStoreConfigurationPendingJournal(scope).load()).toEqual(cursor);
  const encoded = JSON.stringify([...db.data.values()][0]);
  for (const field of [
    "weeklySchedule",
    "addressReference",
    "contactReference",
    '"configuration":',
    "csrf",
    "defaultLocale",
    "timeZone",
    "snapshot",
    "authoredByReference",
    "approvalEvidenceReference",
  ])
    expect(encoded).not.toContain(field);
  expect(db.factory.open).toHaveBeenCalledWith("bop-store-configuration-pending-v1", 1);
});
it("refresh of the exact immutable original clears even after another manager advances current head", async () => {
  idb();
  const journal = createStoreConfigurationPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  const current = await workspace(cursor, false, true);
  expect(current.latest?.authoredByReference).toBe(id(22));
  await journal.complete(cursor, await terminal(cursor), current);
  expect(await journal.load()).toBeNull();
});
it("requires fresh owner-reread Abandoned before clearing without fabricating a configuration", async () => {
  idb();
  const journal = createStoreConfigurationPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  const current = await workspace(cursor, true);
  expect(current.latest).toBeNull();
  await journal.complete(cursor, await terminal(cursor, true), current);
  expect(await journal.load()).toBeNull();
});
it("unknown, denied or failed refresh cannot clear the durable original", async () => {
  idb();
  const journal = createStoreConfigurationPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  const current = await workspace(cursor);
  await expect(
    journal.complete(cursor, await terminal(cursor), { ...current, original: null }),
  ).rejects.toHaveProperty("code", "Conflict");
  await expect(
    journal.complete(cursor, await terminal(cursor), {
      ...current,
      original: await terminal(cursor, true),
    }),
  ).rejects.toThrow();
  await expect(
    journal.complete(cursor, await terminal(cursor), { ...current, validUntil: at }),
  ).rejects.toHaveProperty("code", "Stale");
  expect(await journal.load()).toEqual(cursor);
});
it("immutable receipt tampering, foreign actor and wrong full head hash retain the original", async () => {
  idb();
  const journal = createStoreConfigurationPendingJournal(scope),
    cursor = await original();
  await journal.reserve(cursor);
  const receipt = await terminal(cursor),
    current = await workspace(cursor);
  await expect(
    journal.complete(cursor, { ...receipt, auditReference: id(98) }, current),
  ).rejects.toHaveProperty("code", "Conflict");
  await expect(
    journal.complete(cursor, receipt, { ...current, scope: { ...scope, actorReference: id(99) } }),
  ).rejects.toHaveProperty("code", "ScopeChanged");
  await expect(
    journal.complete(cursor, receipt, {
      ...current,
      expectedHead: { ...current.expectedHead, contentDigest: "sha256:" + "f".repeat(64) },
    }),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(cursor);
});
it("old receipt cannot erase a newer reserved operation", async () => {
  idb();
  const journal = createStoreConfigurationPendingJournal(scope),
    first = await original(),
    second = await original(id(92));
  await journal.reserve(first);
  await journal.complete(first, await terminal(first), await workspace(first));
  await journal.reserve(second);
  await expect(
    journal.complete(first, await terminal(first), await workspace(first)),
  ).rejects.toThrow();
  expect(await journal.load()).toEqual(second);
});
it("Actor and Store changes isolate keys and cannot adopt a foreign original", async () => {
  idb();
  const cursor = await original(),
    journal = createStoreConfigurationPendingJournal(scope);
  await journal.reserve(cursor);
  for (const next of [
    { ...scope, actorReference: id(99) },
    { ...scope, storeReference: id(99) },
  ]) {
    const other = createStoreConfigurationPendingJournal(next);
    expect(await other.load()).toBeNull();
    await expect(other.reserve(cursor)).rejects.toHaveProperty("code", "ScopeChanged");
  }
  expect(await journal.load()).toEqual(cursor);
});
it("refuses malformed, getter or altered intent before storage access and invalid stored bytes on reload", async () => {
  const db = idb(),
    cursor = await original(),
    journal = createStoreConfigurationPendingJournal(scope),
    getter = vi.fn(() => cursor.expectedHead),
    bad = { ...cursor };
  Object.defineProperty(bad, "expectedHead", { get: getter, enumerable: true });
  await expect(journal.reserve(bad)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const poisoned = { ...cursor, businessContent: { address: "not persisted" } };
  await expect(journal.reserve(poisoned)).rejects.toThrow();
  await expect(
    journal.reserve({ ...cursor, intentDigest: "sha256:" + "f".repeat(64) }),
  ).rejects.toThrow();
  expect(db.factory.open).not.toHaveBeenCalled();
  await journal.reserve(cursor);
  const key = [...db.data.keys()][0];
  if (!key) throw new Error("missing controlled key");
  db.data.set(key, { ...cursor, intentDigest: "sha256:" + "f".repeat(64) });
  await expect(journal.load()).rejects.toThrow();
  expect(db.data.has(key)).toBe(true);
});
it("quota and missing IDB fail closed; cleanup failure keeps the original", async () => {
  const db = idb(),
    cursor = await original(),
    journal = createStoreConfigurationPendingJournal(scope);
  await journal.reserve(cursor);
  db.refuseWrites();
  await expect(
    journal.complete(cursor, await terminal(cursor), await workspace(cursor)),
  ).rejects.toHaveProperty("code", "Unavailable");
  expect(await journal.load()).toEqual(cursor);
  vi.stubGlobal("indexedDB", undefined);
  await expect(journal.reserve(cursor)).rejects.toHaveProperty("code", "Unavailable");
});
it("accepts pinned non-Materialize originals while rejecting empty heads and overlong observations", async () => {
  for (const action of ["Validate", "Submit", "Approve", "Publish"] as const) {
    const cursor = await original(id(94), action);
    expect(cursor.action).toBe(action);
    expect(cursor).not.toHaveProperty("setupSelector");
  }
  const cursor = await original();
  await expect(
    validateStoreConfigurationOriginalCursor({
      ...cursor,
      expectedHead: { configurationReference: null, configurationVersion: 1, contentDigest: null },
    }),
  ).rejects.toThrow();
  const current = await workspace(cursor);
  await expect(
    parseStoreConfigurationOrdinaryWorkspace(
      { ...current, validUntil: "2026-10-05T10:00:05.001Z" },
      scope,
    ),
  ).rejects.toHaveProperty("code", "Stale");
});

it("expiry after valid refresh but before the atomic delete retains the original", async () => {
  const db = idb(),
    cursor = await original(),
    journal = createStoreConfigurationPendingJournal(scope);
  await journal.reserve(cursor);
  const receipt = await terminal(cursor),
    current = await workspace(cursor);
  db.onNextRead(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(until)));
  await expect(journal.complete(cursor, receipt, current)).rejects.toHaveProperty(
    "code",
    "Unavailable",
  );
  expect(await journal.load()).toEqual(cursor);
});
