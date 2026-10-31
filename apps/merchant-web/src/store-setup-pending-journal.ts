import {
  parseStoreSetupScope,
  parseStoreSetupCursor,
  validateStoreSetupReceipt,
  parseStoreSetupWorkspace,
  StoreSetupClientError,
  type StoreSetupScope,
  type StoreSetupCursor,
  type StoreSetupReceipt,
  type StoreSetupWorkspace,
} from "./store-setup-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
export interface StoreSetupPendingJournal {
  load(): Promise<StoreSetupCursor | null>;
  reserve(cursor: StoreSetupCursor): Promise<void>;
  complete(
    cursor: StoreSetupCursor,
    receipt: StoreSetupReceipt,
    workspace: StoreSetupWorkspace,
  ): Promise<void>;
}
/** Payload-free original identity only, isolated by fresh actual scope4. This
 * journal is not permission, a setup snapshot, or business reference evidence. */
export function createStoreSetupPendingJournal(scope: StoreSetupScope): StoreSetupPendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical(selected);
  const parse = (value: unknown) => {
    const cursor = parseStoreSetupCursor(value);
    if (canonical(cursor.scope) !== key) throw new StoreSetupClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: StoreSetupCursor) =>
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
        const open = indexedDB.open("bop-store-setup-pending-v1", 1);
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
    async reserve(value: StoreSetupCursor) {
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
    async complete(
      value: StoreSetupCursor,
      actualReceipt: StoreSetupReceipt,
      freshWorkspace: StoreSetupWorkspace,
    ) {
      const cursor = parse(value),
        receipt = await validateStoreSetupReceipt(actualReceipt, cursor),
        workspace = parseStoreSetupWorkspace(freshWorkspace, selected.storeReference, selected);
      if (
        Date.now() >= Date.parse(workspace.setup.validUntil) ||
        workspace.setup.observedAt < receipt.occurredAt
      )
        throw new StoreSetupClientError("Stale");
      if (
        receipt.outcome === "Committed" &&
        (!receipt.snapshot ||
          !workspace.setup.snapshot ||
          workspace.setup.snapshot.setupDraftReference !== receipt.snapshot.setupDraftReference ||
          workspace.setup.snapshot.revision < receipt.snapshot.revision)
      )
        throw new StoreSetupClientError("Conflict");
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (
              Date.now() >= Date.parse(workspace.setup.validUntil) ||
              request.result === undefined ||
              !same(request.result, cursor)
            )
              return fail();
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
