import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";
import {
  TaxConfigCandidateClientError,
  parseTaxConfigCandidateCursor,
  validateTaxConfigCandidateReceipt,
  parseTaxConfigCandidateCurrent,
  validateTaxConfigCandidateRecord,
  type TaxConfigCandidateCursor,
  type TaxConfigCandidateReceipt,
  type TaxConfigCandidateCurrent,
} from "./tax-config-candidate-client.js";
export interface TaxConfigCandidatePendingJournal {
  load(): Promise<TaxConfigCandidateCursor | null>;
  reserve(cursor: TaxConfigCandidateCursor): Promise<void>;
  complete(
    cursor: TaxConfigCandidateCursor,
    receipt: TaxConfigCandidateReceipt,
    current: TaxConfigCandidateCurrent,
  ): Promise<void>;
}
/** One Store-scope barrier also protects unknown Create whose server root does not exist yet.
 * Only original scope and pinned source identities/hash survive reload; no rules, rates, material content or credentials.
 */
export function createTaxConfigCandidatePendingJournal(
  scope: StoreSetupScope,
): TaxConfigCandidatePendingJournal {
  const selected = parseStoreSetupScope(scope),
    key = canonical({ scope: selected });
  const parse = (value: unknown) => {
    const cursor = parseTaxConfigCandidateCursor(value);
    if (canonical(cursor.scope) !== canonical(selected))
      throw new TaxConfigCandidateClientError("ScopeChanged");
    return cursor;
  };
  const validated = async (value: unknown) => {
    const cursor = parse(value),
      command = {
        action: cursor.action,
        operationReference: cursor.operationReference,
        configurationReference: cursor.configurationReference,
        expectedDraft: cursor.expectedDraft,
        registrationMaterial: cursor.registrationMaterial,
      };
    if ((await digest({ scope: cursor.scope, command })) !== cursor.intentDigest)
      throw new TaxConfigCandidateClientError("Invalid");
    return cursor;
  };
  const same = (left: unknown, right: TaxConfigCandidateCursor) =>
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
        if (failed) reject(new TaxConfigCandidateClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-tax-config-candidate-pending-v1", 1);
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
      return value === null ? null : validated(value);
    },
    async reserve(value: TaxConfigCandidateCursor) {
      const cursor = await validated(value);
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
      value: TaxConfigCandidateCursor,
      rawReceipt: TaxConfigCandidateReceipt,
      rawCurrent: TaxConfigCandidateCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateTaxConfigCandidateReceipt(rawReceipt, cursor),
        current = parseTaxConfigCandidateCurrent(rawCurrent, selected, {
          configurationReference: cursor.configurationReference,
          targetVersionReference: receipt.result?.candidate.content.targetVersionReference ?? null,
        });
      if (current.record) await validateTaxConfigCandidateRecord(current.record);
      const fresh = () => {
        if (
          Date.now() < Date.parse(current.observedAt) ||
          Date.now() >= Date.parse(current.validUntil) ||
          current.observedAt < receipt.occurredAt
        )
          throw new TaxConfigCandidateClientError("Stale");
      };
      fresh();
      if (
        receipt.outcome === "Committed" &&
        (!receipt.result ||
          !current.record ||
          canonical(current.record) !== canonical(receipt.result))
      )
        throw new TaxConfigCandidateClientError("Conflict");
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
