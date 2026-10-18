import {
  parsePublicationPendingRecord,
  type PublicationPendingRecord,
  type PublicationPendingScope,
} from "./product-publication-pending-record.js";
import {
  parsePublicationPendingRecordV2,
  type PublicationPendingRecordV2,
} from "./product-publication-pending-record-v2.js";
import { copyProductCommandValue } from "./catalog-product-command-values.js";
import {
  parseProductPublicationWarningAcknowledgementPendingRecord,
  type ProductPublicationWarningAcknowledgementPendingRecord,
} from "./product-publication-warning-acknowledgement-pending-record.js";
type AnyPublicationPendingRecord =
  | PublicationPendingRecord
  | PublicationPendingRecordV2
  | ProductPublicationWarningAcknowledgementPendingRecord;
export async function parseAnyPublicationPendingRecord(
  value: unknown,
  scope: PublicationPendingScope,
) {
  const safe = copyProductCommandValue(value);
  if (
    safe !== null &&
    typeof safe === "object" &&
    "profile" in safe &&
    safe.profile === "CatalogProductPublicationWarningAcknowledgementPendingV1"
  )
    return parseProductPublicationWarningAcknowledgementPendingRecord(safe, scope);
  if (
    safe !== null &&
    typeof safe === "object" &&
    "profile" in safe &&
    safe.profile === "CatalogProductPublicationPendingV2"
  )
    return parsePublicationPendingRecordV2(safe, scope);
  return parsePublicationPendingRecord(safe, scope);
}
export interface PublicationPendingJournalV2 {
  load(): Promise<unknown | null>;
  reserve(record: AnyPublicationPendingRecord): Promise<void>;
  complete(record: AnyPublicationPendingRecord): Promise<void>;
}
export class PublicationPendingJournalV2Error extends Error {
  constructor() {
    super("Original publication request storage is unavailable");
    this.name = "PublicationPendingJournalV2Error";
  }
}
const database = "bop-publication-pending-v1",
  store = "originals";
/** This cursor stores no credentials or owning admission facts. Native permission still governs retry. */
export function createPublicationPendingJournalV2(
  scope: PublicationPendingScope,
): PublicationPendingJournalV2 {
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
        if (failed) reject(new PublicationPendingJournalV2Error());
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
      return (await parseAnyPublicationPendingRecord(value, selected)).record;
    },
    async reserve(value: AnyPublicationPendingRecord) {
      const { record } = await parseAnyPublicationPendingRecord(value, selected);
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
    async complete(value: AnyPublicationPendingRecord) {
      const { record } = await parseAnyPublicationPendingRecord(value, selected);
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
