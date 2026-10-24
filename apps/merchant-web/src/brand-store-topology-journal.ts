import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  BrandStoreTopologyClientError,
  parseBrandTopologyScope,
  parseBrandTopologyCursor,
  validateBrandTopologyReceipt,
  parseBrandTopologyWorkspace,
  type BrandTopologyScope,
  type BrandTopologyCursor,
  type BrandTopologyReceipt,
  type BrandTopologyWorkspace,
} from "./merchant-brand-store-topology-client.js";
export interface BrandStoreTopologyJournal {
  load(): Promise<BrandTopologyCursor | null>;
  reserve(cursor: BrandTopologyCursor): Promise<void>;
  complete(
    cursor: BrandTopologyCursor,
    receipt: BrandTopologyReceipt,
    workspace: BrandTopologyWorkspace,
  ): Promise<void>;
}
/** Durable payload-free original identity; not topology or permission evidence. */
export function createBrandStoreTopologyJournal(
  scope: BrandTopologyScope,
): BrandStoreTopologyJournal {
  const selected = parseBrandTopologyScope(scope),
    key = canonical(selected);
  const parse = (value: unknown) => parseBrandTopologyCursor(value, selected);
  const same = (value: unknown, cursor: BrandTopologyCursor) =>
    canonical(parse(value)) === canonical(cursor);
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
        if (failed) reject(new BrandStoreTopologyClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-brand-store-topology-pending-v1", 1);
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
    async reserve(value: BrandTopologyCursor) {
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
      value: BrandTopologyCursor,
      original: BrandTopologyReceipt,
      current: BrandTopologyWorkspace,
    ) {
      const cursor = parse(value),
        receipt = await validateBrandTopologyReceipt(original, cursor),
        workspace = await parseBrandTopologyWorkspace(current, selected.brandReference, selected);
      if (workspace.observedAt < receipt.occurredAt)
        throw new BrandStoreTopologyClientError("Stale");
      if (receipt.snapshot) {
        const recorded = workspace.history.find((r) => r.revision === receipt.snapshot?.revision);
        if (!recorded || canonical(recorded) !== canonical(receipt.snapshot))
          throw new BrandStoreTopologyClientError("Conflict");
      }
      await transaction<undefined>("readwrite", (table, set, fail) => {
        const r = table.get(key);
        r.onsuccess = () => {
          try {
            if (
              Date.now() < Date.parse(workspace.observedAt) ||
              Date.now() >= Date.parse(workspace.validUntil) ||
              r.result === undefined ||
              !same(r.result, cursor)
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
