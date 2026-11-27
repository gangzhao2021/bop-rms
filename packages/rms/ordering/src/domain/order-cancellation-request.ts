import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant, parseOrderingHash } from "./cart.js";
const fail = (): never => {
  throw new Error("ORDER_CANCELLATION_REQUEST_INVALID");
};
const fields = [
  "requestReference",
  "operationReference",
  "intentDigest",
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "version",
  "expectedOrderVersion",
  "requestedByActorReference",
  "requestedByActorType",
  "requestReasonCode",
  "requestedAt",
  "status",
  "decidedByActorReference",
  "decisionReasonCode",
  "executionReference",
  "occurredAt",
] as const;
const code = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) return fail();
  return value;
};
/** Owner fact, never a client-authorized command. Approval alone is not cancellation. */
export function parseOrderCancellationRequest(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
    const version = raw.version,
      expectedOrderVersion = raw.expectedOrderVersion;
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      (version as number) > 3 ||
      !Number.isSafeInteger(expectedOrderVersion) ||
      (expectedOrderVersion as number) < 1 ||
      (expectedOrderVersion as number) > 2147483647 ||
      (raw.requestedByActorType !== "GuestSession" && raw.requestedByActorType !== "User") ||
      !["Requested", "Approved", "Rejected", "Executed"].includes(String(raw.status))
    )
      return fail();
    const status = raw.status as "Requested" | "Approved" | "Rejected" | "Executed";
    const requestedAt = parseOrderingInstant(raw.requestedAt),
      occurredAt = parseOrderingInstant(raw.occurredAt);
    if (
      occurredAt < requestedAt ||
      (status === "Requested" &&
        (version !== 1 ||
          occurredAt !== requestedAt ||
          raw.decidedByActorReference !== null ||
          raw.decisionReasonCode !== null ||
          raw.executionReference !== null)) ||
      (status !== "Requested" &&
        (version === 1 ||
          raw.decidedByActorReference === null ||
          raw.decisionReasonCode === null)) ||
      (status === "Executed") !== (raw.executionReference !== null)
    )
      return fail();
    return Object.freeze({
      requestReference: parseOrderingReference(raw.requestReference),
      operationReference: parseOrderingReference(raw.operationReference),
      intentDigest: parseOrderingHash(raw.intentDigest),
      tenantReference: parseOrderingReference(raw.tenantReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      version: version as number,
      expectedOrderVersion: expectedOrderVersion as number,
      requestedByActorReference: parseOrderingReference(raw.requestedByActorReference),
      requestedByActorType: raw.requestedByActorType,
      requestReasonCode: code(raw.requestReasonCode),
      requestedAt,
      status,
      decidedByActorReference:
        raw.decidedByActorReference === null
          ? null
          : parseOrderingReference(raw.decidedByActorReference),
      decisionReasonCode: raw.decisionReasonCode === null ? null : code(raw.decisionReasonCode),
      executionReference:
        raw.executionReference === null ? null : parseOrderingReference(raw.executionReference),
      occurredAt,
    });
  } catch {
    return fail();
  }
}
export type OrderCancellationRequest = ReturnType<typeof parseOrderCancellationRequest>;
/** Full contiguous immutable history; missing or conflicting history is unavailable. */
export function resolveOrderCancellationRequestHistory(values: readonly unknown[]) {
  if (values.length === 0 || values.length > 3) return fail();
  const records = values.map(parseOrderCancellationRequest),
    first = records[0];
  if (!first || first.status !== "Requested") return fail();
  const stable = [
    "requestReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "requestedByActorReference",
    "requestedByActorType",
    "requestReasonCode",
    "requestedAt",
  ] as const;
  const operations = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const current = records[index];
    if (!current || current.version !== index + 1 || operations.has(current.operationReference))
      return fail();
    operations.add(current.operationReference);
    if (stable.some((key) => current[key] !== first[key])) return fail();
    const previous = records[index - 1];
    if (
      previous &&
      (current.occurredAt < previous.occurredAt ||
        current.expectedOrderVersion < previous.expectedOrderVersion ||
        !(
          (previous.status === "Requested" &&
            (current.status === "Approved" || current.status === "Rejected")) ||
          (previous.status === "Approved" && current.status === "Executed")
        ))
    )
      return fail();
  }
  const latest = records[records.length - 1];
  if (!latest) return fail();
  return Object.freeze({
    current: latest,
    pending: latest.status === "Requested" || latest.status === "Approved",
  });
}
