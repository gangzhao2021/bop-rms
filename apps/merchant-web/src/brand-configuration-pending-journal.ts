import {
  BrandConfigurationClientError,
  parseBrandConfigurationScope,
  parseBrandConfigurationOriginal,
  validateBrandConfigurationReceipt,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  type BrandConfigurationScope,
  type BrandConfigurationOriginal,
  type BrandConfigurationReceipt,
  type BrandConfigurationCurrent,
  type BrandConfigurationHistory,
} from "./merchant-brand-configuration-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
export interface BrandConfigurationPendingJournal {
  load(): Promise<BrandConfigurationOriginal | null>;
  reserve(original: BrandConfigurationOriginal): Promise<void>;
  complete(
    original: BrandConfigurationOriginal,
    receipt: BrandConfigurationReceipt,
    reobserved: BrandConfigurationReceipt,
    current: BrandConfigurationCurrent,
    history: BrandConfigurationHistory,
  ): Promise<void>;
}
const fail = (code: BrandConfigurationClientError["code"] = "Conflict"): never => {
  throw new BrandConfigurationClientError(code);
};
/** Only scalar immutable original identity is durable. Never retain editable
 * business payloads, credentials, qualification or approval claims. Atomic IDB
 * comparison preserves a cross-tab replacement and every unconfirmed original. */
export function createBrandConfigurationPendingJournal(
  value: BrandConfigurationScope,
): BrandConfigurationPendingJournal {
  const scope = parseBrandConfigurationScope(value),
    key = canonical(scope);
  const parse = (raw: unknown) => {
    const original = parseBrandConfigurationOriginal(raw);
    if (
      canonical({
        tenantReference: original.tenantReference,
        brandReference: original.brandReference,
        actorReference: original.actorReference,
      }) !== key
    )
      return fail("ScopeChanged");
    return original;
  };
  const same = (raw: unknown, original: BrandConfigurationOriginal) =>
    canonical(parse(raw)) === canonical(original);
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
        if (failed) reject(new BrandConfigurationClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-brand-configuration-pending-v1", 1);
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
    async reserve(value: BrandConfigurationOriginal) {
      const original = parse(value);
      await transaction<undefined>("readwrite", (table, set, refuse) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && !same(request.result, original)) return refuse();
            table.put(original, key);
            set(undefined);
          } catch {
            refuse();
          }
        };
      });
    },
    async complete(
      value: BrandConfigurationOriginal,
      terminal: BrandConfigurationReceipt,
      actualOriginal: BrandConfigurationReceipt,
      actualCurrent: BrandConfigurationCurrent,
      actualHistory: BrandConfigurationHistory,
    ) {
      const original = parse(value),
        receipt = await validateBrandConfigurationReceipt(terminal, original),
        reobserved = await validateBrandConfigurationReceipt(actualOriginal, original),
        current = await parseBrandConfigurationCurrent(actualCurrent, scope),
        history = await parseBrandConfigurationHistory(
          actualHistory,
          scope,
          actualHistory.beforeRevision,
        );
      if (
        canonical(receipt) !== canonical(reobserved) ||
        current.observedAt < receipt.occurredAt ||
        history.observedAt < receipt.occurredAt ||
        (receipt.snapshot &&
          (current.current === null || current.current.revision < receipt.snapshot.revision))
      )
        return fail();
      // A revision identifies one immutable record, even when recovery observes
      // a later head. Older originals need not appear in the latest two rows.
      const snapshot = receipt.snapshot;
      if (
        snapshot &&
        current.current?.revision === snapshot.revision &&
        canonical(current.current) !== canonical(snapshot)
      )
        return fail();
      for (const entry of history.entries) {
        if (
          snapshot &&
          entry.revision === snapshot.revision &&
          canonical(entry) !== canonical(snapshot)
        )
          return fail();
        if (
          current.current &&
          entry.revision === current.current.revision &&
          canonical(entry) !== canonical(current.current)
        )
          return fail();
      }
      const check = () => {
        const now = Date.now();
        if (
          now < Date.parse(current.observedAt) ||
          now < Date.parse(history.observedAt) ||
          now >= Date.parse(current.validUntil) ||
          now >= Date.parse(history.validUntil)
        )
          return fail("Stale");
      };
      check();
      await transaction<undefined>("readwrite", (table, set, refuse) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            check();
            if (request.result === undefined || !same(request.result, original)) return refuse();
            table.delete(key);
            set(undefined);
          } catch {
            refuse();
          }
        };
      });
    },
  });
}
