import {
  parsePublicationPendingRecord,
  type PublicationPendingRecord,
  type PublicationPendingScope,
} from "./product-publication-pending-record.js";
export interface PublicationPendingJournal {
  load(): Promise<unknown | null>;
  reserve(record: PublicationPendingRecord): Promise<void>;
  complete(record: PublicationPendingRecord): Promise<void>;
}
export class PublicationPendingJournalError extends Error {
  constructor() {
    super("Original publication request storage is unavailable");
    this.name = "PublicationPendingJournalError";
  }
}
const database = "bop-publication-pending-v1",
  store = "originals";
/** This cursor stores no credentials or owning admission facts. Native permission still governs retry. */
export function createPublicationPendingJournal(
  scope: PublicationPendingScope,
): PublicationPendingJournal {
  const selected = Object.freeze({ ...scope });
  const key = JSON.stringify([
    selected.tenantReference,
    selected.brandReference,
    selected.storeReference,
    selected.productReference,
  ]);
  function transaction<T>(
    mode: IDBTransactionMode,
    work: (table: IDBObjectStore, set: (value: T) => void, reject: () => void) => void,
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
            /* already terminal */
          }
        }
        db?.close();
        if (failed) reject(new PublicationPendingJournalError());
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open(database, 1);
        open.onerror = () => finish(true);
        open.onblocked = () => finish(true);
        open.onupgradeneeded = () => {
          if (done) {
            open.transaction?.abort();
            return;
          }
          if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
        };
        open.onsuccess = () => {
          if (done) {
            open.result.close();
            return;
          }
          db = open.result;
          db.onversionchange = () => {
            db?.close();
            finish(true);
          };
          try {
            tx = db.transaction(store, mode, {
              durability: mode === "readwrite" ? "strict" : "default",
            });
            tx.oncomplete = () => finish(false);
            tx.onabort = tx.onerror = () => finish(true);
            work(
              tx.objectStore(store),
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
      if (value === null) return null;
      return (await parsePublicationPendingRecord(value, selected)).record;
    },
    async reserve(value: PublicationPendingRecord) {
      const { record } = await parsePublicationPendingRecord(value, selected);
      await transaction<undefined>("readwrite", (table, set, reject) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (
              request.result !== undefined &&
              JSON.stringify(request.result) !== JSON.stringify(record)
            )
              return reject();
            table.put(record, key);
            set(undefined);
          } catch {
            reject();
          }
        };
      });
    },
    async complete(value: PublicationPendingRecord) {
      const { record } = await parsePublicationPendingRecord(value, selected);
      await transaction<undefined>("readwrite", (table, set, reject) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (
              request.result === undefined ||
              JSON.stringify(request.result) !== JSON.stringify(record)
            )
              return reject();
            table.delete(key);
            set(undefined);
          } catch {
            reject();
          }
        };
      });
    },
  });
}
