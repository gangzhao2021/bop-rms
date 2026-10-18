import { parseCatalogReference as ref } from "./catalog-product-command-values.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseReceiptTemplateSubmitCursor,
  validateReceiptTemplateSubmitReceipt,
  parseReceiptTemplateReviewCurrent,
  type ReceiptTemplateSubmitCursor,
  type ReceiptTemplateSubmitReceipt,
  type ReceiptTemplateReviewCurrent,
} from "./receipt-template-submit-client.js";
export interface ReceiptTemplateSubmitPendingJournal {
  load(): Promise<ReceiptTemplateSubmitCursor | null>;
  reserve(cursor: ReceiptTemplateSubmitCursor): Promise<void>;
  complete(
    cursor: ReceiptTemplateSubmitCursor,
    receipt: ReceiptTemplateSubmitReceipt,
    workspace: ReceiptTemplateReviewCurrent,
  ): Promise<void>;
}
/** Payload-free original identity only, isolated by fresh actual scope4. This
 * journal is not permission, a setup snapshot, or business reference evidence. */
export function createReceiptTemplateSubmitPendingJournal(
  scope: StoreSetupScope,
  templateReference: string,
): ReceiptTemplateSubmitPendingJournal {
  const selected = parseStoreSetupScope(scope),
    subject = (() => {
      try {
        return ref(templateReference);
      } catch {
        throw new StoreSetupClientError("Invalid");
      }
    })(),
    key = canonical({ scope: selected, templateReference: subject });
  const parse = (value: unknown) => {
    const cursor = parseReceiptTemplateSubmitCursor(value);
    if (canonical(cursor.scope) !== canonical(selected) || cursor.templateReference !== subject)
      throw new StoreSetupClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: ReceiptTemplateSubmitCursor) =>
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
        const open = indexedDB.open("bop-receipt-template-submit-pending-v1", 1);
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
    async reserve(value: ReceiptTemplateSubmitCursor) {
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
      value: ReceiptTemplateSubmitCursor,
      actualReceipt: ReceiptTemplateSubmitReceipt,
      freshWorkspace: ReceiptTemplateReviewCurrent,
    ) {
      const cursor = parse(value),
        receipt = await validateReceiptTemplateSubmitReceipt(actualReceipt, cursor),
        workspace = parseReceiptTemplateReviewCurrent(
          freshWorkspace,
          selected.storeReference,
          cursor.templateReference,
          selected,
        );
      if (
        Date.now() < Date.parse(workspace.observedAt) ||
        Date.now() >= Date.parse(workspace.validUntil) ||
        workspace.observedAt < receipt.occurredAt
      )
        throw new StoreSetupClientError("Stale");
      const original = receipt.submission,
        current = workspace.submission;
      if (
        receipt.outcome === "Committed" &&
        (!original ||
          !current ||
          current.familyReference !== original.familyReference ||
          current.draftRevision < original.draftRevision ||
          (current.draftRevision === original.draftRevision &&
            canonical(current) !== canonical(original)) ||
          workspace.currentDraft.revision < original.draftRevision ||
          (workspace.currentDraft.revision === original.draftRevision &&
            (workspace.currentDraft.versionReference !== original.versionReference ||
              workspace.currentDraft.contentDigest !== original.contentDigest)))
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
