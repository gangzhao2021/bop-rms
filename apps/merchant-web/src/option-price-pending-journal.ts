import {
  createOptionPriceAuthoringClient,
  OptionPriceAuthoringClientError,
  type OptionPriceAuthoringScope,
} from "./option-price-authoring-client.js";
import { createOptionPriceReviewClient } from "./option-price-review-client.js";
import {
  productCommandRecord as record,
  parseCatalogReference as ref,
} from "./catalog-product-command-values.js";
import { parseOptionSetAuthoringScope } from "./option-set-authoring-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
type PreparedAuthoring = ReturnType<ReturnType<typeof createOptionPriceAuthoringClient>["prepare"]>;
type PreparedReview = ReturnType<ReturnType<typeof createOptionPriceReviewClient>["prepare"]>;
export type OptionPricePendingOriginal =
  | Readonly<{
      profile: "OptionPricePendingOriginalV1";
      kind: "Authoring";
      scope: OptionPriceAuthoringScope;
      command: PreparedAuthoring["command"];
      context: PreparedAuthoring["context"];
    }>
  | Readonly<{
      profile: "OptionPricePendingOriginalV1";
      kind: "Review";
      scope: OptionPriceAuthoringScope;
      command: PreparedReview["command"];
      context: PreparedReview["context"];
    }>;
export interface OptionPriceJournalScope extends OptionPriceAuthoringScope {
  readonly productReference: string;
  readonly bindingReference: string;
  readonly optionReference: string;
}
export interface OptionPricePendingJournal {
  load(): Promise<OptionPricePendingOriginal | null>;
  reserve(cursor: OptionPricePendingOriginal): Promise<void>;
  complete(cursor: OptionPricePendingOriginal): Promise<void>;
}
/** Exact immutable operation intent only. Money/period are necessary because
 * owning Resolve requires the original closed command; no form/report cache. */
export function parseOptionPricePendingOriginal(value: unknown): OptionPricePendingOriginal {
  try {
    const r = record(value, ["profile", "kind", "scope", "command", "context"]);
    if (
      r.profile !== "OptionPricePendingOriginalV1" ||
      (r.kind !== "Authoring" && r.kind !== "Review")
    )
      throw new OptionPriceAuthoringClientError("Invalid");
    // prepare performs only detached closed parsing here, never execute/resolve.
    const noTransport: typeof fetch = async () => {
      throw new OptionPriceAuthoringClientError("Unavailable");
    };
    if (r.kind === "Authoring") {
      const prepared = createOptionPriceAuthoringClient(noTransport).prepare({
        command: r.command,
        context: r.context,
        expectedScope: r.scope,
      });
      return Object.freeze({
        profile: "OptionPricePendingOriginalV1" as const,
        kind: "Authoring" as const,
        scope: prepared.scope,
        command: prepared.command,
        context: prepared.context,
      });
    }
    const prepared = createOptionPriceReviewClient(noTransport).prepare({
      command: r.command,
      context: r.context,
      expectedScope: r.scope,
    });
    return Object.freeze({
      profile: "OptionPricePendingOriginalV1" as const,
      kind: "Review" as const,
      scope: prepared.scope,
      command: prepared.command,
      context: prepared.context,
    });
  } catch (error) {
    if (error instanceof OptionPriceAuthoringClientError) throw error;
    throw new OptionPriceAuthoringClientError("Invalid");
  }
}
function journalTransaction<T>(
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
      if (failed) reject(new OptionPriceAuthoringClientError("Unavailable"));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 5000);
    try {
      if (!globalThis.indexedDB) return finish(true);
      const open = indexedDB.open("bop-option-price-pending-v1", 1);
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

export function createOptionPricePendingJournal(
  value: OptionPriceJournalScope,
): OptionPricePendingJournal {
  const input = record(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "productReference",
    "bindingReference",
    "optionReference",
  ]);
  const selected = Object.freeze({
    ...parseOptionSetAuthoringScope({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      actorReference: input.actorReference,
    }),
    productReference: ref(input.productReference),
    bindingReference: ref(input.bindingReference),
    optionReference: ref(input.optionReference),
  });
  const selectedScope = Object.freeze({
    tenantReference: selected.tenantReference,
    brandReference: selected.brandReference,
    storeReference: selected.storeReference,
    actorReference: selected.actorReference,
  });
  const key = JSON.stringify([
    selected.tenantReference,
    selected.brandReference,
    selected.storeReference,
    selected.actorReference,
    selected.productReference,
    selected.bindingReference,
    selected.optionReference,
  ]);
  const parse = (raw: unknown) => {
    const cursor = parseOptionPricePendingOriginal(raw);
    if (
      canonical(cursor.scope) !== canonical(selectedScope) ||
      cursor.context.productReference !== selected.productReference ||
      (cursor.kind === "Review"
        ? cursor.context.bindingReference !== selected.bindingReference ||
          cursor.context.optionReference !== selected.optionReference
        : cursor.command.action === "CreateDraft" &&
          (cursor.command.bindingReference !== selected.bindingReference ||
            cursor.command.optionReference !== selected.optionReference))
    )
      throw new OptionPriceAuthoringClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: OptionPricePendingOriginal) =>
    canonical(parse(left)) === canonical(right);
  return Object.freeze({
    async load() {
      const value = await journalTransaction<unknown | null>("readonly", (table, set) => {
        const request = table.get(key);
        request.onsuccess = () => set(request.result === undefined ? null : request.result);
      });
      return value === null ? null : parse(value);
    },
    async reserve(value: OptionPricePendingOriginal) {
      const cursor = parse(value);
      await journalTransaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && !same(request.result, cursor)) return fail();
            table.put(cursor, key);
            set(undefined);
          } catch {
            fail();
          }
        };
      });
    },
    async complete(value: OptionPricePendingOriginal) {
      const cursor = parse(value);
      await journalTransaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result === undefined || !same(request.result, cursor)) return fail();
            table.delete(key);
            set(undefined);
          } catch {
            fail();
          }
        };
      });
    },
  });
}

export interface OptionPriceDiscoveredOriginal {
  /** Recovery locators only, never current Binding/Choice eligibility. */
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly original: OptionPricePendingOriginal;
}
/** Call only after the actual current server scope read. Stored Actor/Store values
 * are never used to choose a scope or infer permission. No business-source read is
 * necessary to discover an immutable original whose Binding was later removed. */
export function createOptionPricePendingDiscovery(
  value: OptionPriceAuthoringScope & { readonly productReference: string },
) {
  const input = record(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "productReference",
  ]);
  const actualScope = parseOptionSetAuthoringScope({
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    actorReference: input.actorReference,
  });
  const productReference = ref(input.productReference);
  const prefixValues = [
    actualScope.tenantReference,
    actualScope.brandReference,
    actualScope.storeReference,
    actualScope.actorReference,
    productReference,
  ];
  // Existing string keys group by all five actual identities; range iteration does
  // not read another Actor/Store/Product's business intent. No IDB schema change.
  const prefix = JSON.stringify(prefixValues).slice(0, -1) + ",";
  return Object.freeze({
    async load(): Promise<readonly OptionPriceDiscoveredOriginal[]> {
      return journalTransaction<readonly OptionPriceDiscoveredOriginal[]>(
        "readonly",
        (table, set, fail) => {
          const results: OptionPriceDiscoveredOriginal[] = [],
            operations = new Set<string>();
          const request = table.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
          request.onsuccess = () => {
            try {
              const row = request.result;
              if (row === null) {
                set(Object.freeze(results));
                return;
              }
              if (results.length >= 1000 || typeof row.key !== "string" || row.key.length > 300)
                return fail();
              const raw: unknown = JSON.parse(row.key);
              if (!Array.isArray(raw) || raw.length !== 7) return fail();
              const keys = raw.map(ref);
              if (JSON.stringify(keys) !== row.key || prefixValues.some((id, i) => keys[i] !== id))
                return fail();
              const bindingReference = keys[5],
                optionReference = keys[6];
              if (bindingReference === undefined || optionReference === undefined) return fail();
              const original = parseOptionPricePendingOriginal(row.value);
              if (
                canonical(original.scope) !== canonical(actualScope) ||
                original.context.productReference !== productReference ||
                (original.kind === "Review"
                  ? original.context.bindingReference !== bindingReference ||
                    original.context.optionReference !== optionReference
                  : original.command.action === "CreateDraft" &&
                    (original.command.bindingReference !== bindingReference ||
                      original.command.optionReference !== optionReference)) ||
                operations.has(original.command.operationReference)
              )
                return fail();
              operations.add(original.command.operationReference);
              results.push(Object.freeze({ bindingReference, optionReference, original }));
              row.continue();
            } catch {
              fail();
            }
          };
          request.onerror = () => fail();
        },
      );
    },
  });
}
