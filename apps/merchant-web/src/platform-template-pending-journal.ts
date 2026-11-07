import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  PlatformTemplateClientError,
  detachPlatformTemplateValue,
  parsePlatformTemplateScope,
  parsePlatformTemplatePendingOriginal,
  parsePlatformTemplateReceipt,
  parsePlatformTemplateQueryResult,
  type PlatformTemplateScope,
  type PlatformTemplatePendingOriginal,
  type PlatformTemplateReceipt,
  type PlatformTemplateList,
  type PlatformTemplateCurrent,
  type PlatformTemplateExact,
  type PlatformTemplateHistory,
  type PlatformTemplatePublicationCurrent,
  type PlatformTemplatePublicationExact,
  type PlatformTemplatePublicationHistory,
} from "./platform-template-client.js";
export interface PlatformTemplateRefresh {
  readonly list?: PlatformTemplateList;
  readonly current?: PlatformTemplateCurrent;
  readonly exact?: PlatformTemplateExact;
  readonly history?: PlatformTemplateHistory;
  readonly publicationCurrent?: PlatformTemplatePublicationCurrent;
  readonly publicationExact?: PlatformTemplatePublicationExact;
  readonly publicationHistory?: PlatformTemplatePublicationHistory;
}
export interface PlatformTemplatePendingJournal {
  load(): Promise<PlatformTemplatePendingOriginal | null>;
  reserve(original: PlatformTemplatePendingOriginal): Promise<void>;
  complete(
    original: PlatformTemplatePendingOriginal,
    receipt: PlatformTemplateReceipt,
    reobservedReceipt: PlatformTemplateReceipt,
    refresh: PlatformTemplateRefresh,
  ): Promise<void>;
}
export function createPlatformTemplatePendingJournal(
  value: PlatformTemplateScope,
): PlatformTemplatePendingJournal {
  const scope = parsePlatformTemplateScope(value),
    key = canonical(scope),
    now = () => new Date(Date.now()).toISOString();
  const fail = (): never => {
    throw new PlatformTemplateClientError("Conflict");
  };
  function parse(v: unknown) {
    const p = parsePlatformTemplatePendingOriginal(v);
    if (
      p.kind !== scope.kind ||
      p.actorReference !== scope.actorReference ||
      p.purposeCode !== scope.purposeCode
    )
      throw new PlatformTemplateClientError("ScopeChanged");
    return p;
  }
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  function transaction<T>(
    mode: IDBTransactionMode,
    work: (table: IDBObjectStore, set: (v: T) => void, fail: () => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let db: IDBDatabase | null = null,
        tx: IDBTransaction | null = null,
        done = false,
        result: T;
      const finish = (bad: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (bad) {
          try {
            tx?.abort();
          } catch {
            /* already terminal */
          }
        }
        db?.close();
        if (bad) reject(new PlatformTemplateClientError("Unavailable"));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        if (!globalThis.indexedDB) return finish(true);
        const open = indexedDB.open("bop-platform-template-pending-v1", 1);
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
              (v) => {
                result = v;
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
  async function validate(
    original: PlatformTemplatePendingOriginal,
    raw: PlatformTemplateReceipt,
    again: PlatformTemplateReceipt,
    refresh: PlatformTemplateRefresh,
  ) {
    const receipt = await parsePlatformTemplateReceipt(raw, original),
      reobserved = await parsePlatformTemplateReceipt(again, original);
    if (!same(receipt, reobserved)) return fail();
    const at = now();
    const newer = (observedAt: string) => {
      if (observedAt < receipt.occurredAt) throw new PlatformTemplateClientError("Stale");
    };
    if (original.owner === "Save") {
      if (receipt.profile !== "PlatformBrandTemplateOperationV1") return fail();
      const family = receipt.snapshot?.templateReference ?? original.templateReference;
      if (family === null) {
        if (receipt.outcome !== "Abandoned" || !refresh.list) return fail();
        const packet = await parsePlatformTemplateQueryResult(
          refresh.list,
          scope,
          { action: "List", after: refresh.list.after, limit: refresh.list.limit },
          at,
        );
        newer(packet.observedAt);
        return;
      }
      if (!refresh.current || !refresh.history) return fail();
      const current = await parsePlatformTemplateQueryResult(
          refresh.current,
          scope,
          { action: "Current", templateReference: family },
          at,
        ),
        history = await parsePlatformTemplateQueryResult(
          refresh.history,
          scope,
          {
            action: "History",
            templateReference: family,
            beforeRevision: refresh.history.beforeRevision,
          },
          at,
        );
      if (
        current.profile !== "PlatformBrandTemplateCurrentV1" ||
        history.profile !== "PlatformBrandTemplateHistoryV1"
      )
        return fail();
      newer(current.observedAt);
      newer(history.observedAt);
      if (
        current.current &&
        history.entries.some(
          (e) => e.revision === current.current?.revision && !same(e, current.current),
        )
      )
        return fail();
      if (receipt.outcome === "Committed") {
        const snapshot = receipt.snapshot;
        if (!snapshot || !refresh.exact) return fail();
        const exact = await parsePlatformTemplateQueryResult(
          refresh.exact,
          scope,
          { action: "Exact", templateVersionReference: snapshot.templateVersionReference },
          at,
        );
        if (
          exact.profile !== "PlatformBrandTemplateExactV1" ||
          !same(exact.snapshot, snapshot) ||
          !current.current ||
          current.current.revision < snapshot.revision ||
          (current.current.revision === snapshot.revision && !same(current.current, snapshot)) ||
          history.entries.some((e) => e.revision === snapshot.revision && !same(e, snapshot))
        )
          return fail();
        newer(exact.observedAt);
      }
      return;
    }
    if (
      receipt.profile !== "PlatformPublishingReceiptV1" ||
      original.templateReference === null ||
      !refresh.publicationCurrent ||
      !refresh.publicationHistory
    )
      return fail();
    const source = receipt.source,
      family = original.templateReference;
    const current = await parsePlatformTemplateQueryResult(
        refresh.publicationCurrent,
        scope,
        {
          action: "PublicationCurrent",
          templateReference: family,
          lifecycleReference: source?.command.next.lifecycleId ?? null,
        },
        at,
      ),
      history = await parsePlatformTemplateQueryResult(
        refresh.publicationHistory,
        scope,
        {
          action: "PublicationHistory",
          templateReference: family,
          beforeSequence: refresh.publicationHistory.beforeSequence,
        },
        at,
      );
    if (
      current.profile !== "PlatformPublishingCurrentV1" ||
      history.profile !== "PlatformPublishingHistoryV1"
    )
      return fail();
    newer(current.observedAt);
    newer(history.observedAt);
    for (const pointer of [current.current, current.currentRelease]) {
      if (
        pointer &&
        history.items.some((e) => e.sequence === pointer.sequence && !same(e, pointer))
      )
        return fail();
    }
    if (receipt.outcome === "Committed") {
      if (!source || !refresh.publicationExact) return fail();
      const exact = await parsePlatformTemplateQueryResult(
        refresh.publicationExact,
        scope,
        { action: "PublicationExact", templateReference: family, sequence: source.sequence },
        at,
      );
      if (
        exact.profile !== "PlatformPublishingExactV1" ||
        !same(exact.source, source) ||
        !current.current ||
        current.current.command.next.version < source.command.next.version ||
        (current.current.command.next.version === source.command.next.version &&
          !same(current.current, source)) ||
        history.items.some((e) => e.sequence === source.sequence && !same(e, source))
      )
        return fail();
      newer(exact.observedAt);
    }
  }
  return Object.freeze({
    async load() {
      const v = await transaction<unknown | null>("readonly", (table, set) => {
        const request = table.get(key);
        request.onsuccess = () => set(request.result === undefined ? null : request.result);
      });
      return v === null ? null : parse(v);
    },
    async reserve(value: PlatformTemplatePendingOriginal) {
      const p = parse(value);
      await transaction<undefined>("readwrite", (table, set, abort) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && !same(parse(request.result), p)) return abort();
            table.put(p, key);
            set(undefined);
          } catch {
            abort();
          }
        };
      });
    },
    async complete(
      value: PlatformTemplatePendingOriginal,
      receipt: PlatformTemplateReceipt,
      reobserved: PlatformTemplateReceipt,
      refresh: PlatformTemplateRefresh,
    ) {
      const p = parse(value),
        fresh = detachPlatformTemplateValue(refresh) as PlatformTemplateRefresh,
        first = detachPlatformTemplateValue(receipt) as PlatformTemplateReceipt,
        second = detachPlatformTemplateValue(reobserved) as PlatformTemplateReceipt;
      await validate(p, first, second, fresh);
      await transaction<undefined>("readwrite", (table, set, abort) => {
        const request = table.get(key);
        request.onsuccess = () => {
          try {
            if (request.result === undefined || !same(parse(request.result), p)) return abort();
            const packets = [
              fresh.list,
              fresh.current,
              fresh.exact,
              fresh.history,
              fresh.publicationCurrent,
              fresh.publicationExact,
              fresh.publicationHistory,
            ].filter((v) => v !== undefined);
            const at = now();
            for (const packet of packets) {
              if (
                !packet ||
                packet.observedAt > at ||
                at >= packet.validUntil ||
                Date.parse(packet.validUntil) > Date.parse(packet.observedAt) + 5000
              )
                return abort();
            }
            table.delete(key);
            set(undefined);
          } catch {
            abort();
          }
        };
      });
    },
  });
}
