import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  BrandCatalogSourceClientError,
  parseBrandCatalogSourceScope,
  parseBrandCatalogSourceResolve,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  type BrandCatalogSourceScope,
  type BrandCatalogSourceResolve,
  type BrandCatalogSourceReceipt,
  type BrandCatalogSourceCurrent,
  type BrandCatalogSourceExact,
} from "./merchant-brand-catalog-source-client.js";
export interface BrandCatalogSourcePendingJournal {
  load(): Promise<BrandCatalogSourceResolve | null>;
  reserve(cursor: BrandCatalogSourceResolve): Promise<void>;
  complete(
    cursor: BrandCatalogSourceResolve,
    receipt: BrandCatalogSourceReceipt,
    current: BrandCatalogSourceCurrent,
    exact: BrandCatalogSourceExact | null,
  ): Promise<void>;
}
/** Only the immutable scalar original is durable. Business text and CSRF stay in memory. */
export function createBrandCatalogSourcePendingJournal(
  scope: BrandCatalogSourceScope,
): BrandCatalogSourcePendingJournal {
  const selected = parseBrandCatalogSourceScope(scope),
    key = canonical(selected);
  const parse = (value: unknown) => {
    const cursor = parseBrandCatalogSourceResolve(value);
    if (
      cursor.tenantReference !== selected.tenantReference ||
      cursor.brandReference !== selected.brandReference ||
      cursor.actorReference !== selected.actorReference
    )
      throw new BrandCatalogSourceClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: BrandCatalogSourceResolve) =>
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
        if (failed) reject(new BrandCatalogSourceClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-brand-catalog-source-pending-v1", 1);
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
    async reserve(value: BrandCatalogSourceResolve) {
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
      value: BrandCatalogSourceResolve,
      actualReceipt: BrandCatalogSourceReceipt,
      freshCurrent: BrandCatalogSourceCurrent,
      freshExact: BrandCatalogSourceExact | null,
    ) {
      const cursor = parse(value),
        receipt = await parseBrandCatalogSourceReceipt(actualReceipt, cursor);
      const now = () => new Date(Date.now()).toISOString();
      const current = parseBrandCatalogSourceCurrent(freshCurrent, selected, now());
      if (current.observedAt < receipt.occurredAt) throw new BrandCatalogSourceClientError("Stale");
      let exact: BrandCatalogSourceExact | null = null;
      if (receipt.outcome === "Committed") {
        if (!receipt.source || !freshExact) throw new BrandCatalogSourceClientError("Conflict");
        exact = parseBrandCatalogSourceExact(
          freshExact,
          selected,
          receipt.source.sourceReference,
          now(),
        );
        if (
          exact.observedAt < receipt.occurredAt ||
          canonical(current.source) !== canonical(receipt.source) ||
          canonical(exact.source) !== canonical(receipt.source)
        )
          throw new BrandCatalogSourceClientError("Conflict");
      } else if (freshExact !== null) throw new BrandCatalogSourceClientError("Invalid");
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            parseBrandCatalogSourceCurrent(current, selected, now());
            if (exact && receipt.source)
              parseBrandCatalogSourceExact(exact, selected, receipt.source.sourceReference, now());
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
