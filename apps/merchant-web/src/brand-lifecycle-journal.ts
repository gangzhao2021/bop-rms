import {
  parseBrandLifecycleOriginal,
  parseBrandLifecycleReceipt,
  parseBrandLifecycleScope,
  BrandLifecycleClientError,
  type BrandLifecycleOriginal,
  type BrandLifecycleReceipt,
} from "./merchant-brand-lifecycle-client.js";
import type { MerchantBrandScope } from "./merchant-brand-workspace.js";
export interface BrandLifecycleJournal {
  load(): Promise<BrandLifecycleOriginal | null>;
  reserve(value: BrandLifecycleOriginal): Promise<void>;
  complete(
    value: BrandLifecycleOriginal,
    receipt: BrandLifecycleReceipt,
    canClear?: () => boolean,
  ): Promise<void>;
  releaseConflict(
    value: BrandLifecycleOriginal,
    refusal: BrandLifecycleClientError,
    canClear: () => boolean,
  ): Promise<void>;
}
/** Only the scalar original is durable; credentials and labels remain in memory. */
export function createBrandLifecycleJournal(scope: MerchantBrandScope): BrandLifecycleJournal {
  const selected = parseBrandLifecycleScope(scope),
    key = JSON.stringify(selected);
  const parse = (value: unknown) => {
    const original = parseBrandLifecycleOriginal(value);
    if (
      original.actorReference !== selected.actorReference ||
      original.brandReference !== selected.brandReference
    )
      throw new BrandLifecycleClientError("ScopeChanged");
    return original;
  };
  const same = (left: unknown, right: BrandLifecycleOriginal) =>
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
        if (failed) reject(new BrandLifecycleClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-brand-lifecycle-pending-v1", 1);
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
    async reserve(value: BrandLifecycleOriginal) {
      const original = parse(value);
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && !same(request.result, original)) return fail();
            table.put(original, key);
            set(undefined);
          } catch {
            fail();
          }
        };
      });
    },
    async complete(
      value: BrandLifecycleOriginal,
      actualReceipt: BrandLifecycleReceipt,
      canClear: () => boolean = () => true,
    ) {
      const original = parse(value),
        receipt = parseBrandLifecycleReceipt(actualReceipt, original);
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            parseBrandLifecycleReceipt(receipt, original);
            if (!canClear()) return fail();
            if (request.result === undefined || !same(request.result, original)) return fail();
            table.delete(key);
            set(undefined);
          } catch {
            fail();
          }
        };
      });
    },
    async releaseConflict(
      value: BrandLifecycleOriginal,
      refusal: BrandLifecycleClientError,
      canClear: () => boolean,
    ) {
      const original = parse(value);
      if (
        refusal.code !== "RequestConflict" ||
        !refusal.original ||
        !same(refusal.original, original)
      )
        throw new BrandLifecycleClientError("Conflict");
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (!canClear() || request.result === undefined || !same(request.result, original))
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
