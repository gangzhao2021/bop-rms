/**
 * DEC-PAPER-SEND-IDEMPOTENT: a counter send that got no answer (or was still being sent) may have
 * placed the order and, on paper, recorded its sale. Its order operation, and the payment
 * operation sent with a paper order, are kept in this browser for the Store until the send is
 * answered, so a page reloaded after a wifi blip sends the same order again (the server returns
 * or names it) instead of placing and recording it a second time.
 *
 * Only operation references, when it was sent and whether it was a paper order are kept; the
 * paper payment's details are kept as a digest, never the slip itself. Nothing depends on it:
 * when it can't be read or written the page behaves as before (Orders shows what was placed).
 */
const keyFor = (storeReference: string) => `bop.counter.unansweredSend.v1.${storeReference}`;
/** A paper order is entered within 3 days of being paid; an older unanswered send is dropped. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface UnansweredCounterSend {
  readonly operationReference: string;
  /** When it was sent (an instant), shown to staff after a reload. */
  readonly sentAt: string;
  readonly recordedAfterOutage: boolean;
  /** The payment operation sent with a paper order, and a digest of its details as sent. */
  readonly paperPayment: { readonly digest: string; readonly reference: string } | null;
}

/** A short digest of the paper payment as entered (FNV-1a), to tell whether it was changed. */
export function paperPaymentDigest(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "fnv1a:" + hash.toString(16).padStart(8, "0");
}

export function loadUnansweredCounterSend(
  storeReference: string,
  nowMs: number = Date.now(),
): UnansweredCounterSend | null {
  try {
    const raw = localStorage.getItem(keyFor(storeReference));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<UnansweredCounterSend> | null;
    const sentAt = typeof value?.sentAt === "string" ? Date.parse(value.sentAt) : Number.NaN;
    const paper = value?.paperPayment;
    if (
      value === null ||
      typeof value.operationReference !== "string" ||
      !uuid.test(value.operationReference) ||
      !Number.isFinite(sentAt) ||
      nowMs - sentAt > KEEP_MS ||
      typeof value.recordedAfterOutage !== "boolean" ||
      (paper !== null &&
        (typeof paper !== "object" ||
          typeof paper.digest !== "string" ||
          typeof paper.reference !== "string" ||
          !uuid.test(paper.reference)))
    ) {
      clearUnansweredCounterSend(storeReference);
      return null;
    }
    return Object.freeze({
      operationReference: value.operationReference,
      sentAt: value.sentAt as string,
      recordedAfterOutage: value.recordedAfterOutage,
      paperPayment:
        paper === null || paper === undefined
          ? null
          : Object.freeze({ digest: paper.digest, reference: paper.reference }),
    });
  } catch {
    return null;
  }
}

export function keepUnansweredCounterSend(storeReference: string, send: UnansweredCounterSend) {
  try {
    localStorage.setItem(keyFor(storeReference), JSON.stringify(send));
  } catch {
    // Private browsing or a full store: only this page remembers the send.
  }
}

export function clearUnansweredCounterSend(storeReference: string) {
  try {
    localStorage.removeItem(keyFor(storeReference));
  } catch {
    // Nothing kept, or it can't be reached: nothing to clear.
  }
}
