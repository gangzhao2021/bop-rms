import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
} from "./publishing.js";
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
/** Expected pins only. No caller evidence/Approved/Pass/current source is accepted. */
export function parseIndependentPublishingApprovalRequest(value: unknown) {
  const fields = [
    "familyReference",
    "lifecycleReference",
    "configurationType",
    "purposeCode",
    "snapshotReference",
    "snapshotDigest",
    "requiredCheckCodes",
    "observedAt",
  ];
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !fields.includes(k) ||
        !descriptors[k]?.enumerable ||
        !("value" in descriptors[k]),
    )
  )
    return fail();
  const r = Object.fromEntries(fields.map((k) => [k, descriptors[k]?.value]));
  const v: unknown = r.requiredCheckCodes;
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length < 1 ||
    v.length > 32
  )
    return fail();
  const d = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== v.length + 1) return fail();
  const codes = Array.from({ length: v.length }, (_, i) => {
    const x = d[String(i)];
    if (!x || !("value" in x) || !x.enumerable) return fail();
    return parsePublishingCode(x.value);
  }).sort();
  if (new Set(codes).size !== codes.length) return fail();
  return Object.freeze({
    familyReference: parsePublishingReference(r.familyReference),
    lifecycleReference: parsePublishingReference(r.lifecycleReference),
    configurationType: parsePublishingCode(r.configurationType),
    purposeCode: parsePublishingCode(r.purposeCode),
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    requiredCheckCodes: Object.freeze(codes),
    observedAt: parsePublishingInstant(r.observedAt),
  });
}
