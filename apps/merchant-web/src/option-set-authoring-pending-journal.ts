import {
  parseOptionSetAuthoringCursor,
  parseOptionSetAuthoringScope,
  OptionSetAuthoringClientError,
  type OptionSetAuthoringCursor,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";
import { parseCatalogReference } from "./catalog-product-command-values.js";
export interface OptionSetAuthoringJournalScope extends OptionSetAuthoringScope {
  readonly action: "Create" | "Edit";
  readonly optionSetReference: string | null;
}
export interface OptionSetAuthoringPendingJournal {
  load(): Promise<OptionSetAuthoringCursor | null>;
  reserve(cursor: OptionSetAuthoringCursor): Promise<void>;
  complete(cursor: OptionSetAuthoringCursor): Promise<void>;
}
/** Only exact-operation identity is durable. No credentials, form contents,
 * qualification, allergy/nutrition contents or immutable reports are cached. */
export function createOptionSetAuthoringPendingJournal(
  scope: OptionSetAuthoringJournalScope,
): OptionSetAuthoringPendingJournal {
  const selected = Object.freeze({
    ...parseOptionSetAuthoringScope({
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      actorReference: scope.actorReference,
    }),
    action: scope.action,
    optionSetReference:
      scope.optionSetReference === null ? null : parseCatalogReference(scope.optionSetReference),
  });
  if (
    (selected.action !== "Create" && selected.action !== "Edit") ||
    (selected.action === "Create" && selected.optionSetReference !== null) ||
    (selected.action === "Edit" && selected.optionSetReference === null)
  )
    throw new OptionSetAuthoringClientError("Invalid");
  const key = JSON.stringify([
    selected.tenantReference,
    selected.brandReference,
    selected.storeReference,
    selected.actorReference,
    selected.action,
    selected.optionSetReference,
  ]);
  const parse = (value: unknown) => {
    const cursor = parseOptionSetAuthoringCursor(value);
    if (
      cursor.action !== selected.action ||
      cursor.optionSetReference !== selected.optionSetReference ||
      JSON.stringify(cursor.scope) !==
        JSON.stringify({
          tenantReference: selected.tenantReference,
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          actorReference: selected.actorReference,
        })
    )
      throw new OptionSetAuthoringClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: OptionSetAuthoringCursor) =>
    JSON.stringify(parse(left)) === JSON.stringify(right);
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
        if (failed) reject(new OptionSetAuthoringClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-option-set-authoring-pending-v1", 1);
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
      return value === null ? null : parse(value);
    },
    async reserve(value: OptionSetAuthoringCursor) {
      const cursor = parse(value);
      await transaction<undefined>("readwrite", (table, set, fail) => {
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
    async complete(value: OptionSetAuthoringCursor) {
      const cursor = parse(value);
      await transaction<undefined>("readwrite", (table, set, fail) => {
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
