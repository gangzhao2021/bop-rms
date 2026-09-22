import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant, parseOrderingHash } from "./cart.js";
const fail = (): never => {
  throw new Error("ORDER_CLOSURE_RECORD_INVALID");
};
const fields = [
  "closureReference",
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "closureVersion",
  "orderVersion",
  "previousClosureReference",
  "status",
  "actorType",
  "actorReference",
  "reasonCode",
  "financialFinalityReference",
  "evidenceDigest",
  "occurredAt",
] as const;
export function parseOrderClosureRecord(value: unknown) {
  try {
    const raw = readClosedRecord(value, fields),
      closureVersion = raw.closureVersion,
      orderVersion = raw.orderVersion;
    if (
      !Number.isSafeInteger(closureVersion) ||
      (closureVersion as number) < 1 ||
      (closureVersion as number) > 2147483647 ||
      !Number.isSafeInteger(orderVersion) ||
      (orderVersion as number) < 1 ||
      (orderVersion as number) > 2147483647 ||
      (raw.status !== "Open" && raw.status !== "Closed") ||
      (raw.actorType !== "User" && raw.actorType !== "System") ||
      (raw.actorType === "System") !== (raw.actorReference === null) ||
      (raw.status === "Open" && raw.actorType !== "User") ||
      (raw.status === "Closed") !== (raw.financialFinalityReference !== null) ||
      (closureVersion === 1) !== (raw.previousClosureReference === null) ||
      typeof raw.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode)
    )
      return fail();
    return Object.freeze({
      closureReference: parseOrderingReference(raw.closureReference),
      operationReference: parseOrderingReference(raw.operationReference),
      tenantReference: parseOrderingReference(raw.tenantReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      closureVersion: closureVersion as number,
      orderVersion: orderVersion as number,
      previousClosureReference:
        raw.previousClosureReference === null
          ? null
          : parseOrderingReference(raw.previousClosureReference),
      status: raw.status,
      actorType: raw.actorType,
      actorReference:
        raw.actorReference === null ? null : parseOrderingReference(raw.actorReference),
      reasonCode: raw.reasonCode,
      financialFinalityReference:
        raw.financialFinalityReference === null
          ? null
          : parseOrderingReference(raw.financialFinalityReference),
      evidenceDigest: parseOrderingHash(raw.evidenceDigest),
      occurredAt: parseOrderingInstant(raw.occurredAt),
    });
  } catch {
    return fail();
  }
}
export type OrderClosureRecord = ReturnType<typeof parseOrderClosureRecord>;
/** Full owner history. An empty history is interpreted only by a reader that proved Order existence. */
export function resolveOrderClosureHistory(values: readonly unknown[]) {
  if (values.length < 1 || values.length > 1000) return fail();
  const records = values.map(parseOrderClosureRecord),
    first = records[0];
  if (!first || first.status !== "Closed") return fail();
  const references = new Set<string>(),
    operations = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const row = records[index];
    if (
      !row ||
      row.closureVersion !== index + 1 ||
      references.has(row.closureReference) ||
      operations.has(row.operationReference) ||
      row.tenantReference !== first.tenantReference ||
      row.brandReference !== first.brandReference ||
      row.storeReference !== first.storeReference ||
      row.orderReference !== first.orderReference
    )
      return fail();
    references.add(row.closureReference);
    operations.add(row.operationReference);
    const prior = records[index - 1];
    if (
      prior &&
      (row.previousClosureReference !== prior.closureReference ||
        row.status === prior.status ||
        row.occurredAt < prior.occurredAt ||
        row.orderVersion < prior.orderVersion)
    )
      return fail();
  }
  const current = records[records.length - 1];
  if (!current) return fail();
  return current;
}
