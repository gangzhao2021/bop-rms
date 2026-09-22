import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant } from "./cart.js";

export class OrderRevisionChainError extends Error {
  readonly code = "ORDER_REVISION_CHAIN_INVALID";
  constructor() {
    super("order revision chain is unavailable");
    this.name = "OrderRevisionChainError";
  }
}
const invalid = (): never => {
  throw new OrderRevisionChainError();
};
function version(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
export function parseOrderRevision(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "brandReference",
      "storeReference",
      "orderReference",
      "revisionReference",
      "previousRevisionReference",
      "expectedVersion",
      "version",
      "occurredAt",
      "kind",
    ]);
    const expectedVersion = version(raw.expectedVersion),
      next = version(raw.version);
    if (
      next !== expectedVersion + 1 ||
      typeof raw.kind !== "string" ||
      ![
        "AdditionalBatch",
        "Acceptance",
        "Termination",
        "Fulfillment",
        "BatchCancellation",
      ].includes(raw.kind)
    )
      return invalid();
    const revisionReference = parseOrderingReference(raw.revisionReference);
    const previousRevisionReference = parseOrderingReference(raw.previousRevisionReference);
    if (revisionReference === previousRevisionReference) return invalid();
    return Object.freeze({
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      revisionReference,
      previousRevisionReference,
      expectedVersion,
      version: next,
      occurredAt: parseOrderingInstant(raw.occurredAt),
      kind: raw.kind as
        "AdditionalBatch" | "Acceptance" | "Termination" | "Fulfillment" | "BatchCancellation",
    });
  } catch {
    return invalid();
  }
}
/** Checks complete ordered owner revision evidence, not action/phase eligibility.
 * Each revision must additionally bind to its owning persisted operation. A writer
 * must serialize append and enforce unique Order/version; this pure fold is no lock.
 */
export function resolveOrderRevisionChain(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "brandReference",
      "storeReference",
      "orderReference",
      "initialSubmissionReference",
      "createdAt",
      "revisions",
    ]);
    const scope = {
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
    };
    let checkpoint = parseOrderingReference(raw.initialSubmissionReference);
    let occurredAt = parseOrderingInstant(raw.createdAt),
      currentVersion = 1;
    if (
      !Array.isArray(raw.revisions) ||
      Object.getPrototypeOf(raw.revisions) !== Array.prototype ||
      raw.revisions.length > 10000 ||
      Reflect.ownKeys(raw.revisions).length !== raw.revisions.length + 1
    )
      return invalid();
    const seen = new Set([checkpoint]);
    for (let index = 0; index < raw.revisions.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw.revisions, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      const revision = parseOrderRevision(descriptor.value);
      if (
        revision.brandReference !== scope.brandReference ||
        revision.storeReference !== scope.storeReference ||
        revision.orderReference !== scope.orderReference ||
        revision.expectedVersion !== currentVersion ||
        revision.previousRevisionReference !== checkpoint ||
        revision.occurredAt < occurredAt ||
        seen.has(revision.revisionReference)
      )
        return invalid();
      seen.add(revision.revisionReference);
      currentVersion = revision.version;
      checkpoint = revision.revisionReference;
      occurredAt = revision.occurredAt;
    }
    return Object.freeze({ ...scope, version: currentVersion, checkpoint, occurredAt });
  } catch {
    return invalid();
  }
}
