import {
  parseOptionSetPublicationCursor,
  OptionSetPublicationClientError,
  type OptionSetPublicationCursor,
} from "./option-set-publication-client.js";
import {
  parseOptionSetAuthoringScope,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";
import { parseCatalogReference } from "./catalog-product-command-values.js";
export interface OptionSetPublicationJournalScope extends OptionSetAuthoringScope {
  readonly optionSetReference: string;
}
export interface OptionSetPublicationPendingJournal {
  load(): Promise<OptionSetPublicationCursor | null>;
  reserve(cursor: OptionSetPublicationCursor): Promise<void>;
  complete(cursor: OptionSetPublicationCursor): Promise<void>;
}
/** Only exact-operation identity is durable. No credentials, form contents,
 * qualification, allergy/nutrition contents or immutable reports are cached. */
export function createOptionSetPublicationPendingJournal(
  scope: OptionSetPublicationJournalScope,
): OptionSetPublicationPendingJournal {
  const selected = Object.freeze({
    ...parseOptionSetAuthoringScope({
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      actorReference: scope.actorReference,
    }),
    optionSetReference: parseCatalogReference(scope.optionSetReference),
  });
  const key = JSON.stringify([
    selected.tenantReference,
    selected.brandReference,
    selected.storeReference,
    selected.actorReference,
    selected.optionSetReference,
  ]);
  const parse = (value: unknown) => {
    const cursor = parseOptionSetPublicationCursor(value);
    if (
      cursor.command.optionSetReference !== selected.optionSetReference ||
      JSON.stringify(cursor.scope) !==
        JSON.stringify({
          tenantReference: selected.tenantReference,
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          actorReference: selected.actorReference,
        })
    )
      throw new OptionSetPublicationClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: OptionSetPublicationCursor) =>
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
        if (failed) reject(new OptionSetPublicationClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-option-set-publication-pending-v1", 1);
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
    async reserve(value: OptionSetPublicationCursor) {
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
    async complete(value: OptionSetPublicationCursor) {
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
