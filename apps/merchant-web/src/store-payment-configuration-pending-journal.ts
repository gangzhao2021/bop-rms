import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseStorePaymentConfigurationCursor,
  validateStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationCurrent,
  type StorePaymentConfigurationCursor,
  type StorePaymentConfigurationReceipt,
  type StorePaymentConfigurationCurrent,
} from "./store-payment-configuration-client.js";
export interface StorePaymentConfigurationPendingJournal {
  load(): Promise<StorePaymentConfigurationCursor | null>;
  reserve(cursor: StorePaymentConfigurationCursor): Promise<void>;
  complete(
    cursor: StorePaymentConfigurationCursor,
    receipt: StorePaymentConfigurationReceipt,
    workspace: StorePaymentConfigurationCurrent,
  ): Promise<void>;
}
/** Payload-free original identity only, isolated by fresh actual scope4. This
 * journal is not permission, a setup snapshot, or business reference evidence. */
export function createStorePaymentConfigurationPendingJournal(
  scope: StoreSetupScope,
): StorePaymentConfigurationPendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical({ scope: selected });
  const parse = (value: unknown) => {
    const cursor = parseStorePaymentConfigurationCursor(value);
    if (canonical(cursor.scope) !== canonical(selected))
      throw new StoreSetupClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: StorePaymentConfigurationCursor) =>
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
        const open = indexedDB.open("bop-store-payment-configuration-pending-v1", 1);
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
    async reserve(value: StorePaymentConfigurationCursor) {
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
      value: StorePaymentConfigurationCursor,
      actualReceipt: StorePaymentConfigurationReceipt,
      freshWorkspace: StorePaymentConfigurationCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateStorePaymentConfigurationReceipt(actualReceipt, cursor),
        workspace = parseStorePaymentConfigurationCurrent(
          freshWorkspace,
          selected.storeReference,
          selected,
        );
      if (
        Date.now() < Date.parse(workspace.observedAt) ||
        Date.now() >= Date.parse(workspace.validUntil) ||
        workspace.observedAt < receipt.occurredAt
      )
        throw new StoreSetupClientError("Stale");
      const current = workspace.snapshot;
      if (
        receipt.outcome === "Committed" &&
        (!receipt.snapshot ||
          !current ||
          current.revision < receipt.snapshot.revision ||
          (current.revision === receipt.snapshot.revision &&
            (current.configurationReference !== receipt.snapshot.configurationReference ||
              canonical(current) !== canonical(receipt.snapshot))))
      )
        throw new StoreSetupClientError("Conflict");
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (
              Date.now() < Date.parse(workspace.observedAt) ||
              Date.now() >= Date.parse(workspace.validUntil) ||
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
