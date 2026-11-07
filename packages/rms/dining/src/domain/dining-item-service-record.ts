import { parseDiningReference, parseDiningInstant, parseDiningHash } from "./dining-session.js";

export class DiningItemServiceError extends Error {
  readonly code = "DINING_ITEM_SERVICE_INVALID";
  constructor() {
    super("dining item service record is invalid");
    this.name = "DiningItemServiceError";
  }
}
const refs = [
  "serviceReference",
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "tableReference",
  "orderReference",
  "orderBatchReference",
  "orderItemReference",
  "actorReference",
  "sourceCheckpoint",
  "auditReference",
] as const;
const versions = [
  "sessionVersion",
  "tableAssignmentVersion",
  "expectedOrderVersion",
  "expectedItemServiceVersion",
] as const;
/** Immutable service fact candidate. Current access, readiness, remaining quantity,
 * session/table version, idempotency and Audit must be proved by the transactional writer.
 */
export function parseDiningItemServiceRecord(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      ...refs,
      ...versions,
      "itemServiceVersion",
      "quantity",
      "purposeCode",
      "permissionCode",
      "servedAt",
      "recordedAt",
      "sourceDigest",
    ]);
    const reference = Object.fromEntries(
      refs.map((key) => [key, parseDiningReference(raw[key])]),
    ) as Readonly<Record<(typeof refs)[number], ReturnType<typeof parseDiningReference>>>;
    for (const key of versions) {
      if (
        typeof raw[key] !== "number" ||
        !Number.isSafeInteger(raw[key]) ||
        raw[key] < (key === "expectedItemServiceVersion" ? 0 : 1) ||
        raw[key] >= 2147483647
      )
        throw new DiningItemServiceError();
    }
    const expectedItemServiceVersion = raw.expectedItemServiceVersion as number;
    if (
      raw.itemServiceVersion !== expectedItemServiceVersion + 1 ||
      typeof raw.quantity !== "number" ||
      !Number.isSafeInteger(raw.quantity) ||
      raw.quantity < 1 ||
      raw.quantity > 999 ||
      raw.purposeCode !== "ServeDiningOrderItem" ||
      raw.permissionCode !== "dining.item.serve"
    )
      throw new DiningItemServiceError();
    const servedAt = parseDiningInstant(raw.servedAt);
    const recordedAt = parseDiningInstant(raw.recordedAt);
    if (servedAt > recordedAt) throw new DiningItemServiceError();
    return Object.freeze({
      ...reference,
      sessionVersion: raw.sessionVersion as number,
      tableAssignmentVersion: raw.tableAssignmentVersion as number,
      expectedOrderVersion: raw.expectedOrderVersion as number,
      expectedItemServiceVersion,
      itemServiceVersion: expectedItemServiceVersion + 1,
      quantity: raw.quantity,
      purposeCode: "ServeDiningOrderItem" as const,
      permissionCode: "dining.item.serve" as const,
      servedAt,
      recordedAt,
      sourceDigest: parseDiningHash(raw.sourceDigest),
    });
  } catch {
    throw new DiningItemServiceError();
  }
}
export type DiningItemServiceRecord = ReturnType<typeof parseDiningItemServiceRecord>;

function readClosedRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new DiningItemServiceError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new DiningItemServiceError();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new DiningItemServiceError();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

/** Validate a new append against complete locked item history and owner quantities.
 * Replay must be resolved before this check; quantities are cumulative, never deltas.
 */
export function validateDiningItemServiceAppend(input: {
  record: unknown;
  history: readonly unknown[];
  orderedQuantity: number;
  readyQuantity: number;
}) {
  const record = parseDiningItemServiceRecord(input.record);
  const fail = (): never => {
    throw new DiningItemServiceError();
  };
  if (
    !Array.isArray(input.history) ||
    input.history.length > 999 ||
    !Number.isSafeInteger(input.orderedQuantity) ||
    input.orderedQuantity < 1 ||
    input.orderedQuantity > 999 ||
    !Number.isSafeInteger(input.readyQuantity) ||
    input.readyQuantity < 0 ||
    input.readyQuantity > input.orderedQuantity
  )
    return fail();
  const scope = [
    "tenantReference",
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
  ] as const;
  const identities = new Set<string>();
  let servedQuantity = 0;
  let version = 0;
  let previous: DiningItemServiceRecord | undefined;
  for (const value of input.history) {
    const fact = parseDiningItemServiceRecord(value);
    if (
      scope.some((key) => fact[key] !== record[key]) ||
      fact.expectedItemServiceVersion !== version ||
      fact.expectedOrderVersion > record.expectedOrderVersion ||
      fact.servedAt > record.servedAt ||
      fact.recordedAt > record.recordedAt ||
      (previous && (fact.servedAt < previous.servedAt || fact.recordedAt < previous.recordedAt))
    )
      return fail();
    for (const reference of [fact.serviceReference, fact.operationReference, fact.auditReference]) {
      if (identities.has(reference)) return fail();
      identities.add(reference);
    }
    servedQuantity += fact.quantity;
    version = fact.itemServiceVersion;
    previous = fact;
  }
  if (
    record.expectedItemServiceVersion !== version ||
    [record.serviceReference, record.operationReference, record.auditReference].some((ref) =>
      identities.has(ref),
    ) ||
    new Set([record.serviceReference, record.operationReference, record.auditReference]).size !==
      3 ||
    servedQuantity + record.quantity > input.readyQuantity ||
    servedQuantity + record.quantity > input.orderedQuantity
  )
    return fail();
  return Object.freeze({
    record,
    servedQuantity: servedQuantity + record.quantity,
    remainingQuantity: input.orderedQuantity - servedQuantity - record.quantity,
  });
}
