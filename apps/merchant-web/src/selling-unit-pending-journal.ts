import {
  parseSellingUnitCursor,
  type SellingUnitCursor,
  type SellingUnitRecoveryScope,
} from "./selling-unit-recovery-client.js";
import { ProductSellingUnitsError } from "./product-selling-units-client.js";
export interface SellingUnitPendingJournal {
  load(): Promise<SellingUnitCursor | null>;
  reserve(cursor: SellingUnitCursor): Promise<void>;
  complete(cursor: SellingUnitCursor): Promise<void>;
}
/** Only exact-operation identity is durable. No credentials, form contents,
 * qualification, allergy/nutrition contents or immutable reports are cached. */
export function createSellingUnitPendingJournal(
  scope: SellingUnitRecoveryScope,
): SellingUnitPendingJournal {
  const selected = Object.freeze({ ...scope }),
    key = JSON.stringify([
      selected.tenantReference,
      selected.brandReference,
      selected.storeReference,
      selected.actorReference,
    ]);
  const same = (left: unknown, right: SellingUnitCursor) =>
    JSON.stringify(parseSellingUnitCursor(left, selected)) === JSON.stringify(right);
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
        if (failed) reject(new ProductSellingUnitsError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-selling-unit-registration-pending-v1", 1);
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
      return value === null ? null : parseSellingUnitCursor(value, selected);
    },
    async reserve(value: SellingUnitCursor) {
      const cursor = parseSellingUnitCursor(value, selected);
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
    async complete(value: SellingUnitCursor) {
      const cursor = parseSellingUnitCursor(value, selected);
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
