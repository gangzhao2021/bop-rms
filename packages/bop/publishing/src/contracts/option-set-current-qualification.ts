import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPublishingScope,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingVersion,
  parsePublishingCode,
  PublishingContractError,
} from "./publishing.js";
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
export const optionSetCurrentQualificationCheckCodes = Object.freeze([
  "CURRENT_REFERENCES",
  "PUBLISHING_POLICY",
  "RULE_SATISFIABILITY",
  "SCOPE_TOPOLOGY",
] as const);
/** A consumed server qualification, never proof of acquisition by parsing alone.
 * Original review/approval evidence remains immutable; this distinct lease binds
 * the current Publish operation and must be verified against owning history. */
export function parsePublishingOptionSetCurrentQualification(value: unknown) {
  const fields = [
    "profile",
    "tenantReference",
    "operationReference",
    "actorReference",
    "scope",
    "familyReference",
    "lifecycleReference",
    "expectedLifecycleVersion",
    "latestMutationOperationReference",
    "snapshotReference",
    "snapshotDigest",
    "reviewOperationReference",
    "validationEvidenceReference",
    "approvalOperationReference",
    "approvalEvidenceReference",
    "policyReference",
    "policyVersion",
    "policyContentDigest",
    "policyPublicationReference",
    "qualificationEvidenceReference",
    "qualificationReportDigest",
    "result",
    "originalObservedAt",
    "checkedAt",
    "validUntil",
    "checkCodes",
    "sourceAssessmentDigests",
  ];
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k)) ||
    fields.some((k) => !descriptors[k]?.enumerable || !("value" in descriptors[k]))
  )
    return fail();
  const r = Object.fromEntries(fields.map((k) => [k, descriptors[k]?.value]));
  if (r.profile !== "PublishingOptionSetCurrentQualificationV1" || r.result !== "Pass")
    return fail();
  const scope = createPublishingScope(r.scope),
    originalObservedAt = parsePublishingInstant(r.originalObservedAt),
    checkedAt = parsePublishingInstant(r.checkedAt),
    validUntil = parsePublishingInstant(r.validUntil);
  if (
    scope.kind !== "Brand" ||
    checkedAt < originalObservedAt ||
    validUntil <= checkedAt ||
    Date.parse(validUntil) - Date.parse(originalObservedAt) > 5000
  )
    return fail();
  const list = (input: unknown, parser: (value: unknown) => string, maximum: number) => {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > maximum ||
      Object.getOwnPropertySymbols(input).length
    )
      return fail();
    const values: string[] = [];
    for (let i = 0; i < input.length; i++) {
      const d = Object.getOwnPropertyDescriptor(input, String(i));
      if (!d || !("value" in d) || !d.enumerable) return fail();
      values.push(parser(d.value));
    }
    if (
      Reflect.ownKeys(input).length !== input.length + 1 ||
      new Set(values).size !== values.length
    )
      return fail();
    return Object.freeze(values.sort());
  };
  const checkCodes = list(r.checkCodes, parsePublishingCode, 4);
  if (
    canonicalizeRfc8785(checkCodes) !== canonicalizeRfc8785(optionSetCurrentQualificationCheckCodes)
  )
    return fail();
  const approvalOperationReference =
      r.approvalOperationReference === null
        ? null
        : parsePublishingReference(r.approvalOperationReference),
    approvalEvidenceReference =
      r.approvalEvidenceReference === null
        ? null
        : parsePublishingReference(r.approvalEvidenceReference);
  if ((approvalOperationReference === null) !== (approvalEvidenceReference === null)) return fail();
  return Object.freeze({
    profile: "PublishingOptionSetCurrentQualificationV1" as const,
    tenantReference: parsePublishingReference(r.tenantReference),
    operationReference: parsePublishingReference(r.operationReference),
    actorReference: parsePublishingReference(r.actorReference),
    scope,
    familyReference: parsePublishingReference(r.familyReference),
    lifecycleReference: parsePublishingReference(r.lifecycleReference),
    expectedLifecycleVersion: parsePublishingVersion(r.expectedLifecycleVersion),
    latestMutationOperationReference: parsePublishingReference(r.latestMutationOperationReference),
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    reviewOperationReference: parsePublishingReference(r.reviewOperationReference),
    validationEvidenceReference: parsePublishingReference(r.validationEvidenceReference),
    approvalOperationReference,
    approvalEvidenceReference,
    policyReference: parsePublishingReference(r.policyReference),
    policyVersion: parsePublishingVersion(r.policyVersion),
    policyContentDigest: parsePublishingDigest(r.policyContentDigest),
    policyPublicationReference: parsePublishingReference(r.policyPublicationReference),
    qualificationEvidenceReference: parsePublishingReference(r.qualificationEvidenceReference),
    qualificationReportDigest: parsePublishingDigest(r.qualificationReportDigest),
    result: "Pass" as const,
    originalObservedAt,
    checkedAt,
    validUntil,
    checkCodes,
    sourceAssessmentDigests: list(r.sourceAssessmentDigests, parsePublishingDigest, 32),
  });
}
export type PublishingOptionSetCurrentQualification = ReturnType<
  typeof parsePublishingOptionSetCurrentQualification
>;
export const publishingOptionSetCurrentQualificationDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionSetCurrentQualification(value)));
