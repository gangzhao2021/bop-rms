import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";
import {
  TaxConfigMaterialClientError,
  parseTaxConfigMaterialCursor,
  validateTaxConfigMaterialReceipt,
  parseTaxConfigMaterialCurrent,
  validateTaxConfigMaterialVersion,
  type TaxConfigMaterialCursor,
  type TaxConfigMaterialReceipt,
  type TaxConfigMaterialCurrent,
} from "./tax-config-material-client.js";
export interface TaxConfigMaterialPendingJournal {
  load(): Promise<TaxConfigMaterialCursor | null>;
  reserve(cursor: TaxConfigMaterialCursor): Promise<void>;
  complete(
    cursor: TaxConfigMaterialCursor,
    receipt: TaxConfigMaterialReceipt,
    current: TaxConfigMaterialCurrent,
  ): Promise<void>;
}
/** One Store-scope barrier also protects unknown Create whose server root does not exist yet.
 * Only original identity and hash survive reload; no material content, issuer identities, tax references or professional declarations.
 */
export function createTaxConfigMaterialPendingJournal(
  scope: StoreSetupScope,
): TaxConfigMaterialPendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical({ scope: selected });
  const parse = (value: unknown) => {
    const cursor = parseTaxConfigMaterialCursor(value);
    if (canonical(cursor.scope) !== canonical(selected))
      throw new TaxConfigMaterialClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: TaxConfigMaterialCursor) =>
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
        if (failed) reject(new TaxConfigMaterialClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-tax-config-material-pending-v1", 1);
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
    async reserve(value: TaxConfigMaterialCursor) {
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
      value: TaxConfigMaterialCursor,
      rawReceipt: TaxConfigMaterialReceipt,
      rawCurrent: TaxConfigMaterialCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateTaxConfigMaterialReceipt(rawReceipt, cursor),
        target = receipt.version?.materialReference ?? cursor.materialReference,
        current = parseTaxConfigMaterialCurrent(rawCurrent, selected, {
          materialKind: cursor.materialKind,
          materialReference: target,
        });
      if (current.version) await validateTaxConfigMaterialVersion(current.version);
      const fresh = () => {
        if (
          Date.now() < Date.parse(current.observedAt) ||
          Date.now() >= Date.parse(current.validUntil) ||
          current.observedAt < receipt.occurredAt
        )
          throw new TaxConfigMaterialClientError("Stale");
      };
      fresh();
      if (receipt.outcome === "Committed") {
        const original = receipt.version,
          latest = current.version;
        if (
          !original ||
          !latest ||
          latest.revision < original.revision ||
          (latest.revision === original.revision && canonical(latest) !== canonical(original))
        )
          throw new TaxConfigMaterialClientError("Conflict");
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
