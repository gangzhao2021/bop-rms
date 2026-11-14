import { parseCatalogReference as ref } from "./catalog-product-command-values.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  parseStoreSetupScope,
  StoreSetupClientError,
  type StoreSetupScope,
} from "./store-setup-client.js";
import {
  parseReceiptTemplateLifecycleCursor,
  parseReceiptTemplatePublishedVersion,
  validateReceiptTemplateLifecycleReceipt,
  type ReceiptTemplateLifecycleCursor,
  type ReceiptTemplateLifecycleReceipt,
  type ReceiptTemplatePublishedVersion,
} from "./receipt-template-lifecycle-client.js";
import {
  parseReceiptTemplateReviewCurrent,
  type ReceiptTemplateReviewCurrent,
} from "./receipt-template-submit-client.js";
export interface ReceiptTemplateLifecyclePendingJournal {
  load(): Promise<ReceiptTemplateLifecycleCursor | null>;
  reserve(cursor: ReceiptTemplateLifecycleCursor): Promise<void>;
  complete(
    cursor: ReceiptTemplateLifecycleCursor,
    receipt: ReceiptTemplateLifecycleReceipt,
    workspace: ReceiptTemplateReviewCurrent,
    publishedVersion: ReceiptTemplatePublishedVersion | null,
  ): Promise<Readonly<{ historical: boolean }>>;
}
/** Payload-free original identity only, isolated by fresh actual scope4.
 * A durable terminal plus the fresh Review observation releases the original.
 * Optional immutable publication metadata is validated but does not prove current
 * effectiveness or eligibility, including scheduled publication. This
 * journal is not permission, a setup snapshot, or business reference evidence. */
export function createReceiptTemplateLifecyclePendingJournal(
  scope: StoreSetupScope,
  templateReference: string,
): ReceiptTemplateLifecyclePendingJournal {
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
    const cursor = parseReceiptTemplateLifecycleCursor(value);
    if (canonical(cursor.scope) !== canonical(selected) || cursor.templateReference !== subject)
      throw new StoreSetupClientError("ScopeChanged");
    return cursor;
  };
  const same = (left: unknown, right: ReceiptTemplateLifecycleCursor) =>
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
        const open = indexedDB.open("bop-receipt-template-lifecycle-pending-v1", 1);
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
    async reserve(value: ReceiptTemplateLifecycleCursor) {
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
      value: ReceiptTemplateLifecycleCursor,
      actualReceipt: ReceiptTemplateLifecycleReceipt,
      freshWorkspace: ReceiptTemplateReviewCurrent,
      publishedVersion: ReceiptTemplatePublishedVersion | null,
    ) {
      const cursor = parse(value),
        receipt = await validateReceiptTemplateLifecycleReceipt(actualReceipt, cursor),
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
      let historical = false;
      const published =
        publishedVersion === null ? null : parseReceiptTemplatePublishedVersion(publishedVersion);
      if (
        published &&
        (published.brandReference !== selected.brandReference ||
          published.storeReference !== selected.storeReference ||
          published.templateReference !== subject ||
          published.publishedAt > workspace.observedAt)
      )
        throw new StoreSetupClientError("Conflict");
      if (
        workspace.lifecycle?.state === "Published" &&
        published &&
        (!workspace.submission ||
          published.versionReference !== workspace.submission.versionReference ||
          published.publishedAt !== workspace.lifecycle.changedAt)
      )
        throw new StoreSetupClientError("Conflict");
      if (receipt.outcome === "Committed") {
        const result = receipt.result;
        if (!result) throw new StoreSetupClientError("Conflict");
        const lifecycle = workspace.lifecycle,
          submission = workspace.submission;
        historical =
          workspace.currentDraft.versionReference !== cursor.expectedVersionReference ||
          workspace.currentDraft.revision !== cursor.expectedRevision ||
          !lifecycle ||
          lifecycle.lifecycleReference !== result.lifecycleReference ||
          lifecycle.version !== result.lifecycleVersion ||
          lifecycle.latestMutationOperationReference !== cursor.operationReference;
        if (
          workspace.currentDraft.revision < cursor.expectedRevision ||
          (workspace.currentDraft.revision === cursor.expectedRevision &&
            workspace.currentDraft.versionReference !== cursor.expectedVersionReference)
        )
          throw new StoreSetupClientError("Conflict");
        if (
          lifecycle?.lifecycleReference === result.lifecycleReference &&
          (lifecycle.version < result.lifecycleVersion ||
            (lifecycle.version === result.lifecycleVersion &&
              (lifecycle.latestMutationOperationReference !== cursor.operationReference ||
                lifecycle.state !== result.state ||
                lifecycle.changedAt !== result.changedAt ||
                lifecycle.approvalEvidenceReference !== result.approvalEvidenceReference)))
        )
          throw new StoreSetupClientError("Conflict");
        if (
          submission?.reviewLifecycleReference === result.lifecycleReference &&
          (submission.versionReference !== cursor.expectedVersionReference ||
            submission.draftRevision !== cursor.expectedRevision)
        )
          throw new StoreSetupClientError("Conflict");
        if (cursor.action === "Publish") {
          const original = result.publishedVersion;
          if (!original) throw new StoreSetupClientError("Conflict");
          if (
            published &&
            (published.versionNumber < original.versionNumber ||
              (published.versionReference === original.versionReference &&
                canonical(published) !== canonical(original)) ||
              (published.versionNumber === original.versionNumber &&
                published.versionReference !== original.versionReference))
          )
            throw new StoreSetupClientError("Conflict");
          if (published && published.versionReference !== original.versionReference)
            historical = true;
        }
      }
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
      return Object.freeze({ historical });
    },
  });
}
