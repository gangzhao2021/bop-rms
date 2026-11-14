import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";
import {
  TaxConfigAuthoringClientError,
  parseTaxConfigAuthoringCursor,
  validateTaxConfigAuthoringReceipt,
  parseTaxConfigAuthoringCurrent,
  validateTaxConfigDraftSnapshot,
  type TaxConfigAuthoringCursor,
  type TaxConfigAuthoringReceipt,
  type TaxConfigAuthoringCurrent,
} from "./tax-config-authoring-client.js";
export interface TaxConfigAuthoringPendingJournal {
  load(): Promise<TaxConfigAuthoringCursor | null>;
  reserve(cursor: TaxConfigAuthoringCursor): Promise<void>;
  complete(
    cursor: TaxConfigAuthoringCursor,
    receipt: TaxConfigAuthoringReceipt,
    current: TaxConfigAuthoringCurrent,
  ): Promise<void>;
}
/** One Store-scope barrier also protects unknown Create whose server root does not exist yet.
 * Only original identity and hash survive reload; no rates, currency, credentials or evidence.
 */
export function createTaxConfigAuthoringPendingJournal(
  scope: StoreSetupScope,
): TaxConfigAuthoringPendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical({ scope: selected });
  const parse = (value: unknown) => {
    const cursor = parseTaxConfigAuthoringCursor(value);
    if (canonical(cursor.scope) !== canonical(selected))
      throw new TaxConfigAuthoringClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: TaxConfigAuthoringCursor) =>
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
        if (failed) reject(new TaxConfigAuthoringClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-tax-config-authoring-pending-v1", 1);
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
        const r = table.get(key);
        r.onsuccess = () => set(r.result === undefined ? null : r.result);
      });
      return value === null ? null : parse(value);
    },
    async reserve(value: TaxConfigAuthoringCursor) {
      const cursor = parse(value);
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const r = table.get(key);
        r.onsuccess = () => {
          try {
            if (r.result !== undefined && !same(r.result, cursor)) return fail();
            table.put(cursor, key);
            set(undefined);
          } catch {
            fail();
          }
        };
      });
    },
    async complete(
      value: TaxConfigAuthoringCursor,
      rawReceipt: TaxConfigAuthoringReceipt,
      rawCurrent: TaxConfigAuthoringCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateTaxConfigAuthoringReceipt(rawReceipt, cursor),
        target = receipt.snapshot?.configurationReference ?? cursor.configurationReference,
        current = parseTaxConfigAuthoringCurrent(rawCurrent, selected, target);
      if (current.state) await validateTaxConfigDraftSnapshot(current.state.snapshot);
      const fresh = () => {
        if (
          Date.now() < Date.parse(current.observedAt) ||
          Date.now() >= Date.parse(current.validUntil) ||
          current.observedAt < receipt.occurredAt
        )
          throw new TaxConfigAuthoringClientError("Stale");
      };
      fresh();
      if (receipt.outcome === "Committed") {
        const original = receipt.snapshot,
          latest = current.state?.snapshot;
        if (
          !original ||
          !latest ||
          latest.aggregateVersion < original.aggregateVersion ||
          (latest.aggregateVersion === original.aggregateVersion &&
            canonical(latest) !== canonical(original))
        )
          throw new TaxConfigAuthoringClientError("Conflict");
      }
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const r = table.get(key);
        r.onsuccess = () => {
          try {
            fresh();
            if (r.result === undefined || !same(r.result, cursor)) return fail();
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
