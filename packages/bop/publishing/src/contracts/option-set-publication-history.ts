import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingInstant,
} from "./publishing.js";

const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
export function readOptionSetHistoryRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !descriptors[k]?.enumerable || !("value" in descriptors[k]))
  )
    return fail();
  return Object.freeze(
    Object.fromEntries(
      keys.map((k) => {
        const descriptor = descriptors[k];
        if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
        return [k, descriptor.value];
      }),
    ),
  );
}
export function parseOptionSetPublicationHistoryBefore(value: unknown) {
  const r = readOptionSetHistoryRecord(value, ["occurredAt", "operationReference"]);
  return Object.freeze({
    occurredAt: parsePublishingInstant(r.occurredAt),
    operationReference: parsePublishingReference(r.operationReference),
  });
}
/** Each page is a fresh owning read, not a durable multi-request snapshot. */
export function parseOptionSetPublicationHistoryRequest(value: unknown) {
  const r = readOptionSetHistoryRecord(value, ["familyReference", "before", "limit"]);
  if (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > 50)
    return fail();
  return Object.freeze({
    familyReference: parsePublishingReference(r.familyReference),
    before: r.before === null ? null : parseOptionSetPublicationHistoryBefore(r.before),
    limit: r.limit,
  });
}
export const optionSetPublicationHistoryFields = Object.freeze([
  "operationReference",
  "lifecycleReference",
  "lifecycleVersion",
  "operation",
  "actorKind",
  "actorReference",
  "occurredAt",
  "recordedAt",
  "reasonCode",
  "fromState",
  "toState",
  "snapshotReference",
  "snapshotDigest",
  "releaseReference",
  "releaseSequence",
  "supersededReleaseReference",
  "rollbackTargetReleaseReference",
] as const);
export type OptionSetPublicationHistoryRequest = ReturnType<
  typeof parseOptionSetPublicationHistoryRequest
>;
