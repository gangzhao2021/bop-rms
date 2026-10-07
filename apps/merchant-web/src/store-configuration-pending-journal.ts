import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseStoreConfigurationSnapshot,
  type StoreConfigurationSnapshot,
} from "./store-configuration-client.js";
import {
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";

export type StoreConfigurationOrdinaryAction =
  "Materialize" | "Validate" | "Submit" | "Approve" | "Publish";
export interface StoreConfigurationOrdinaryHead {
  readonly configurationReference: string | null;
  readonly configurationVersion: number;
  readonly contentDigest: string | null;
}
export interface StoreConfigurationSetupSelector {
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
}
type OriginalPins = StoreSetupScope & {
  readonly operationReference: string;
  readonly expectedHead: StoreConfigurationOrdinaryHead;
} & (
    | {
        readonly action: "Materialize";
        readonly setupSelector: StoreConfigurationSetupSelector;
        readonly reasonCode: string;
      }
    | { readonly action: Exclude<StoreConfigurationOrdinaryAction, "Materialize"> }
  );
export type StoreConfigurationOriginalCursor = Readonly<
  OriginalPins & {
    readonly profile: "StoreConfigurationOrdinaryResolveV1";
    readonly intentDigest: string;
  }
>;
export interface StoreConfigurationOriginalOperation {
  readonly command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly intentDigest: string;
  readonly resultingVersion: number;
  readonly configuration: StoreConfigurationSnapshot;
}
export type StoreConfigurationOrdinaryReceipt = Readonly<
  OriginalPins & {
    readonly profile: "StoreConfigurationOrdinaryReceiptV1";
    readonly intentDigest: string;
    readonly outcome: "Committed" | "Abandoned";
    readonly operation: StoreConfigurationOriginalOperation | null;
    readonly auditReference: string;
    readonly occurredAt: string;
    readonly dataClassification: "ConfigurationMetadata";
  }
>;
export interface StoreConfigurationOrdinaryWorkspace {
  readonly profile: "StoreConfigurationOrdinaryWorkspaceV1";
  readonly scope: StoreSetupScope;
  readonly latest: StoreConfigurationSnapshot | null;
  readonly current: StoreConfigurationSnapshot | null;
  readonly expectedHead: StoreConfigurationOrdinaryHead;
  readonly original: StoreConfigurationOrdinaryReceipt | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly businessReferenceValidation: "NotEvaluated";
}
const fail = (code: StoreSetupClientError["code"] = "Invalid"): never => {
  throw new StoreSetupClientError(code);
};
function copied(value: unknown, maximumBytes: number): unknown {
  let budget = 250000;
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 20) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 8192 ? v : fail();
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 10000 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return fail();
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 64)
        return fail();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((k) => {
            if (typeof k !== "string") return fail();
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!d?.enumerable || !("value" in d)) return fail();
            return [k, visit(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(canonical(result)).byteLength > maximumBytes) return fail();
  return result;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    return fail();
  return value as Record<string, unknown>;
}
const digest = (value: unknown) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail();
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fail();
function head(value: unknown): StoreConfigurationOrdinaryHead {
  const r = closed(value, ["configurationReference", "configurationVersion", "contentDigest"]),
    configurationVersion = integer(r.configurationVersion),
    configurationReference =
      r.configurationReference === null ? null : ref(r.configurationReference),
    contentDigest = r.contentDigest === null ? null : digest(r.contentDigest);
  if (
    (configurationVersion === 0) !== (configurationReference === null) ||
    (configurationVersion === 0) !== (contentDigest === null)
  )
    return fail();
  return Object.freeze({ configurationReference, configurationVersion, contentDigest });
}
const pinKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "action",
  "expectedHead",
] as const;
function pins(r: Record<string, unknown>): OriginalPins {
  const scope = parseStoreSetupScope(Object.fromEntries(pinKeys.slice(0, 4).map((k) => [k, r[k]]))),
    expectedHead = head(r.expectedHead),
    operationReference = ref(r.operationReference);
  if (r.action === "Materialize") {
    const s = closed(r.setupSelector, [
      "setupDraftReference",
      "sourceRevision",
      "sourceSnapshotDigest",
    ]);
    if (
      typeof r.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(r.reasonCode) ||
      expectedHead.configurationVersion === Number.MAX_SAFE_INTEGER
    )
      return fail();
    return Object.freeze({
      ...scope,
      operationReference,
      expectedHead,
      action: r.action,
      reasonCode: r.reasonCode,
      setupSelector: Object.freeze({
        setupDraftReference: ref(s.setupDraftReference),
        sourceRevision: integer(s.sourceRevision, 1, 2147483647),
        sourceSnapshotDigest: digest(s.sourceSnapshotDigest),
      }),
    });
  }
  if (
    !["Validate", "Submit", "Approve", "Publish"].includes(String(r.action)) ||
    expectedHead.configurationReference === null
  )
    return fail();
  return Object.freeze({
    ...scope,
    operationReference,
    expectedHead,
    action: r.action as Exclude<StoreConfigurationOrdinaryAction, "Materialize">,
  });
}
const additional = (value: unknown) =>
  value &&
  typeof value === "object" &&
  Object.getOwnPropertyDescriptor(value, "action")?.value === "Materialize"
    ? ["setupSelector", "reasonCode"]
    : [];
function cursorStructure(value: unknown): StoreConfigurationOriginalCursor {
  try {
    const v = copied(value, 8192),
      r = closed(v, ["profile", ...pinKeys, ...additional(v), "intentDigest"]);
    if (r.profile !== "StoreConfigurationOrdinaryResolveV1") return fail();
    return Object.freeze({ profile: r.profile, ...pins(r), intentDigest: digest(r.intentDigest) });
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
}
export async function validateStoreConfigurationOriginalCursor(
  value: unknown,
): Promise<StoreConfigurationOriginalCursor> {
  try {
    const cursor = cursorStructure(value),
      { intentDigest, ...resolve } = cursor;
    if (
      (await publicationValueDigest({
        ...resolve,
        profile: "StoreConfigurationOrdinaryCommandV1",
      })) !== intentDigest
    )
      return fail();
    return cursor;
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail("Unavailable");
  }
}
function scopedConfiguration(value: unknown, scope: StoreSetupScope): StoreConfigurationSnapshot {
  const parsed = parseStoreConfigurationSnapshot(value, scope.storeReference);
  if (
    parsed.brandReference !== scope.brandReference ||
    (parsed.setupBasis !== undefined && parsed.setupBasis.tenantReference !== scope.tenantReference)
  )
    return fail("ScopeChanged");
  return parsed;
}
function receiptStructure(value: unknown): StoreConfigurationOrdinaryReceipt {
  const v = copied(value, 4194304),
    r = closed(v, [
      "profile",
      ...pinKeys,
      ...additional(v),
      "intentDigest",
      "outcome",
      "operation",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ]);
  if (
    r.profile !== "StoreConfigurationOrdinaryReceiptV1" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return fail();
  const p = pins(r),
    scope = parseStoreSetupScope(Object.fromEntries(pinKeys.slice(0, 4).map((k) => [k, r[k]]))),
    occurredAt = instant(r.occurredAt);
  let operation: StoreConfigurationOriginalOperation | null = null;
  if (r.outcome === "Committed") {
    const o = closed(r.operation, [
        "command",
        "operationReference",
        "brandReference",
        "storeReference",
        "intentDigest",
        "resultingVersion",
        "configuration",
      ]),
      configuration = scopedConfiguration(o.configuration, scope),
      command = p.action === "Materialize" ? "SaveDraft" : p.action;
    if (
      o.command !== command ||
      o.operationReference !== p.operationReference ||
      o.brandReference !== p.brandReference ||
      o.storeReference !== p.storeReference ||
      o.resultingVersion !== configuration.configurationVersion ||
      configuration.configurationVersion !==
        p.expectedHead.configurationVersion + (p.action === "Materialize" ? 1 : 0)
    )
      return fail();
    if (p.action === "Materialize") {
      const basis = configuration.setupBasis;
      if (
        !basis ||
        basis.setupDraftReference !== p.setupSelector.setupDraftReference ||
        basis.sourceRevision !== p.setupSelector.sourceRevision ||
        basis.sourceSnapshotDigest !== p.setupSelector.sourceSnapshotDigest ||
        configuration.supersedesConfigurationReference !== p.expectedHead.configurationReference ||
        configuration.reasonCode !== p.reasonCode ||
        configuration.authoredByReference !== p.actorReference
      )
        return fail();
    } else if (configuration.configurationReference !== p.expectedHead.configurationReference)
      return fail();
    const states = {
      Materialize: "Draft",
      Validate: "Draft",
      Submit: "PendingApproval",
      Approve: "Approved",
      Publish: "Published",
    };
    if (configuration.lifecycle !== states[p.action] || configuration.updatedAt > occurredAt)
      return fail();
    // The legacy operation digest has its own server preimage. Its immutable
    // tuple is corroborated by the actual workspace original read, not recomputed here.
    operation = Object.freeze({
      command,
      operationReference: ref(o.operationReference),
      brandReference: ref(o.brandReference),
      storeReference: ref(o.storeReference),
      intentDigest: digest(o.intentDigest),
      resultingVersion: configuration.configurationVersion,
      configuration,
    });
  } else if (r.operation !== null) return fail();
  return Object.freeze({
    profile: r.profile,
    ...p,
    intentDigest: digest(r.intentDigest),
    outcome: r.outcome,
    operation,
    auditReference: ref(r.auditReference),
    occurredAt,
    dataClassification: r.dataClassification,
  });
}
export async function validateStoreConfigurationOrdinaryReceipt(
  value: unknown,
  cursor?: StoreConfigurationOriginalCursor,
): Promise<StoreConfigurationOrdinaryReceipt> {
  try {
    const receipt = receiptStructure(value);
    const originalCursor = await validateStoreConfigurationOriginalCursor({
      profile: "StoreConfigurationOrdinaryResolveV1",
      tenantReference: receipt.tenantReference,
      brandReference: receipt.brandReference,
      storeReference: receipt.storeReference,
      actorReference: receipt.actorReference,
      operationReference: receipt.operationReference,
      action: receipt.action,
      expectedHead: receipt.expectedHead,
      ...(receipt.action === "Materialize"
        ? { setupSelector: receipt.setupSelector, reasonCode: receipt.reasonCode }
        : {}),
      intentDigest: receipt.intentDigest,
    });
    if (
      cursor &&
      canonical(originalCursor) !==
        canonical(await validateStoreConfigurationOriginalCursor(cursor))
    )
      return fail("Conflict");
    return receipt;
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
}
export async function parseStoreConfigurationOrdinaryWorkspace(
  value: unknown,
  expectedScope: StoreSetupScope,
): Promise<StoreConfigurationOrdinaryWorkspace> {
  try {
    const r = closed(copied(value, 10485760), [
        "profile",
        "scope",
        "latest",
        "current",
        "expectedHead",
        "original",
        "observedAt",
        "validUntil",
        "businessReferenceValidation",
      ]),
      scope = parseStoreSetupScope(r.scope),
      selected = parseStoreSetupScope(expectedScope);
    if (
      r.profile !== "StoreConfigurationOrdinaryWorkspaceV1" ||
      r.businessReferenceValidation !== "NotEvaluated"
    )
      return fail();
    if (canonical(scope) !== canonical(selected)) return fail("ScopeChanged");
    const observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil),
      now = Date.now();
    if (
      observedAt >= validUntil ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      now < Date.parse(observedAt) ||
      now >= Date.parse(validUntil)
    )
      return fail("Stale");
    const latest = r.latest === null ? null : scopedConfiguration(r.latest, scope),
      current = r.current === null ? null : scopedConfiguration(r.current, scope),
      expectedHead = head(r.expectedHead),
      state = latest ?? current;
    if (current && current.lifecycle !== "Published") return fail();
    if (
      [latest, current].some(
        (v) => v !== null && (v.createdAt > observedAt || v.updatedAt > observedAt),
      )
    )
      return fail();
    if (state === null) {
      if (expectedHead.configurationReference !== null) return fail();
    } else if (
      expectedHead.configurationReference !== state.configurationReference ||
      expectedHead.configurationVersion !== state.configurationVersion ||
      expectedHead.contentDigest !== (await publicationValueDigest(state))
    )
      return fail();
    const original =
      r.original === null ? null : await validateStoreConfigurationOrdinaryReceipt(r.original);
    if (
      original &&
      (canonical(
        parseStoreSetupScope(Object.fromEntries(pinKeys.slice(0, 4).map((k) => [k, original[k]]))),
      ) !== canonical(scope) ||
        original.occurredAt > observedAt)
    )
      return fail("ScopeChanged");
    if (Date.now() >= Date.parse(validUntil)) return fail("Stale");
    return Object.freeze({
      profile: r.profile,
      scope,
      latest,
      current,
      expectedHead,
      original,
      observedAt,
      validUntil,
      businessReferenceValidation: r.businessReferenceValidation,
    });
  } catch (error) {
    if (error instanceof StoreSetupClientError) throw error;
    return fail();
  }
}
export interface StoreConfigurationPendingJournal {
  load(): Promise<StoreConfigurationOriginalCursor | null>;
  reserve(cursor: StoreConfigurationOriginalCursor): Promise<void>;
  complete(
    cursor: StoreConfigurationOriginalCursor,
    receipt: StoreConfigurationOrdinaryReceipt,
    workspace: StoreConfigurationOrdinaryWorkspace,
  ): Promise<void>;
}
/** Dedicated scope4 barrier. Only exact original command pins/hash are durable;
 * configuration content, business PII, approval and session data never enter IDB.
 * Cleanup requires the terminal freshly reread by the ordinary workspace owner. */
export function createStoreConfigurationPendingJournal(
  scope: StoreSetupScope,
): StoreConfigurationPendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical(selected);
  const parse = (value: unknown) => {
    const cursor = cursorStructure(value);
    if (
      canonical(
        parseStoreSetupScope(Object.fromEntries(pinKeys.slice(0, 4).map((k) => [k, cursor[k]]))),
      ) !== key
    )
      return fail("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: StoreConfigurationOriginalCursor) =>
    canonical(parse(left)) === canonical(right);
  function transaction<T>(
    mode: IDBTransactionMode,
    work: (table: IDBObjectStore, set: (value: T) => void, fail: () => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let db: IDBDatabase | null = null,
        tx: IDBTransaction | null = null,
        done = false,
        result: T;
      const finish = (failed: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failed) {
          try {
            tx?.abort();
          } catch {
            /* terminal */
          }
        }
        db?.close();
        if (failed) reject(new StoreSetupClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-store-configuration-pending-v1", 1);
        open.onerror = open.onblocked = () => finish(true);
        open.onupgradeneeded = () => {
          if (done) {
            open.transaction?.abort();
            return;
          }
          if (!open.result.objectStoreNames.contains("originals"))
            open.result.createObjectStore("originals");
        };
        open.onsuccess = () => {
          if (done) {
            open.result.close();
            return;
          }
          db = open.result;
          db.onversionchange = () => finish(true);
          try {
            tx = db.transaction("originals", mode, {
              durability: mode === "readwrite" ? "strict" : "default",
            });
            tx.oncomplete = () => finish(false);
            tx.onerror = tx.onabort = () => finish(true);
            work(
              tx.objectStore("originals"),
              (value) => {
                result = value;
              },
              () => finish(true),
            );
          } catch {
            finish(true);
          }
        };
      } catch {
        finish(true);
      }
    });
  }
  return Object.freeze({
    async load() {
      const value = await transaction<unknown | null>("readonly", (table, set) => {
        const request = table.get(key);
        request.onsuccess = () => set(request.result === undefined ? null : request.result);
      });
      return value === null ? null : validateStoreConfigurationOriginalCursor(parse(value));
    },
    async reserve(value: StoreConfigurationOriginalCursor) {
      const cursor = await validateStoreConfigurationOriginalCursor(parse(value));
      await transaction<undefined>("readwrite", (table, set, refuse) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && !same(request.result, cursor)) return refuse();
            table.put(cursor, key);
            set(undefined);
          } catch {
            refuse();
          }
        };
      });
    },
    async complete(
      value: StoreConfigurationOriginalCursor,
      actualReceipt: StoreConfigurationOrdinaryReceipt,
      freshWorkspace: StoreConfigurationOrdinaryWorkspace,
    ) {
      const cursor = await validateStoreConfigurationOriginalCursor(parse(value)),
        receipt = await validateStoreConfigurationOrdinaryReceipt(actualReceipt, cursor),
        workspace = await parseStoreConfigurationOrdinaryWorkspace(freshWorkspace, selected);
      if (
        workspace.observedAt < receipt.occurredAt ||
        Date.now() >= Date.parse(workspace.validUntil)
      )
        return fail("Stale");
      if (workspace.original === null || canonical(workspace.original) !== canonical(receipt))
        return fail("Conflict");
      await transaction<undefined>("readwrite", (table, set, refuse) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (
              Date.now() >= Date.parse(workspace.validUntil) ||
              request.result === undefined ||
              !same(request.result, cursor)
            )
              return refuse();
            table.delete(key);
            set(undefined);
          } catch {
            refuse();
          }
        };
      });
    },
  });
}
