import { parseCatalogReference as ref } from "./catalog-product-command-values.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseReceiptTemplateDraftCursor,
  validateReceiptTemplateDraftReceipt,
  parseReceiptTemplateDraftCurrent,
  type ReceiptTemplateDraftCursor,
  type ReceiptTemplateDraftReceipt,
  type ReceiptTemplateDraftCurrent,
  validateReceiptTemplateDraftContentDigest,
} from "./receipt-template-draft-client.js";
export interface ReceiptTemplateDraftPendingJournal {
  load(): Promise<ReceiptTemplateDraftCursor | null>;
  reserve(cursor: ReceiptTemplateDraftCursor): Promise<void>;
  complete(
    cursor: ReceiptTemplateDraftCursor,
    receipt: ReceiptTemplateDraftReceipt,
    workspace: ReceiptTemplateDraftCurrent,
  ): Promise<void>;
}
/** Payload-free original identity only, isolated by fresh actual scope4. This
 * journal is not permission, a setup snapshot, or business reference evidence. */
export function createReceiptTemplateDraftPendingJournal(
  scope: StoreSetupScope,
  templateReference: string | null,
): ReceiptTemplateDraftPendingJournal {
  const selected = parseStoreSetupScope(scope),
    subject = (() => {
      try {
        return templateReference === null ? null : ref(templateReference);
      } catch {
        throw new StoreSetupClientError("Invalid");
      }
    })(),
    key = canonical({ scope: selected, templateReference: subject });
  const parse = (value: unknown) => {
    const cursor = parseReceiptTemplateDraftCursor(value);
    if (canonical(cursor.scope) !== canonical(selected) || cursor.templateReference !== subject)
      throw new StoreSetupClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: ReceiptTemplateDraftCursor) =>
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
        const open = indexedDB.open("bop-receipt-template-draft-pending-v1", 1);
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
    async reserve(value: ReceiptTemplateDraftCursor) {
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
      value: ReceiptTemplateDraftCursor,
      actualReceipt: ReceiptTemplateDraftReceipt,
      freshWorkspace: ReceiptTemplateDraftCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateReceiptTemplateDraftReceipt(actualReceipt, cursor),
        workspace = parseReceiptTemplateDraftCurrent(
          freshWorkspace,
          selected.storeReference,
          receipt.snapshot?.content.templateReference ?? cursor.templateReference,
          selected,
        );
      if (
        Date.now() < Date.parse(workspace.observedAt) ||
        Date.now() >= Date.parse(workspace.validUntil) ||
        workspace.observedAt < receipt.occurredAt
      )
        throw new StoreSetupClientError("Stale");
      await validateReceiptTemplateDraftContentDigest(workspace.snapshot);
      const current = workspace.snapshot;
      if (
        receipt.outcome === "Committed" &&
        (!receipt.snapshot ||
          !current ||
          current.familyReference !== receipt.snapshot.familyReference ||
          current.revision < receipt.snapshot.revision ||
          (current.revision === receipt.snapshot.revision &&
            (current.content.versionReference !== receipt.snapshot.content.versionReference ||
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
