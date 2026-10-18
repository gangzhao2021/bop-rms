import type { CommitPublishingMutationInput } from "../application/ports/publishing-ports.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
  type PublishingApprovalEvidence,
  type PublishingDigest,
  type PublishingLifecycleRecord,
  type PublishingReference,
  type PublishingReleaseRecord,
  type PublishingValidationEvidence,
} from "./publishing.js";

export const optionPricePolicyConfigurationType = "OPTION_PRICE_PUBLICATION_POLICY" as const;
export const optionPriceRuleConfigurationType = "OPTION_PRICE_RULE" as const;
export const optionPriceRulePublicationPurpose = "OPTION_PRICE_RULE_PUBLICATION" as const;

/** The policy is governance content, not a Pricing rule or an approval grant. */
export function parsePublishingOptionPricePublicationPolicy(value: unknown) {
  try {
    const fields = [
      "profile",
      "tenantReference",
      "brandReference",
      "familyReference",
      "policyReference",
      "policyVersion",
      "approvalPolicy",
      "effectiveFrom",
      "effectiveUntil",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !fields.includes(key) ||
          !descriptors[key]?.enumerable ||
          !("value" in descriptors[key]),
      )
    )
      throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
    const r: Record<string, unknown> = Object.fromEntries(
      fields.map((key) => [key, descriptors[key]?.value]),
    );
    if (
      r.profile !== "PublishingOptionPricePublicationPolicyV1" ||
      (r.approvalPolicy !== "Required" && r.approvalPolicy !== "NotRequired")
    )
      throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
    const effectiveFrom = parsePublishingInstant(r.effectiveFrom);
    const effectiveUntil =
      r.effectiveUntil === null ? null : parsePublishingInstant(r.effectiveUntil);
    if (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
      throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
    return Object.freeze({
      profile: "PublishingOptionPricePublicationPolicyV1" as const,
      tenantReference: parsePublishingReference(r.tenantReference),
      brandReference: parsePublishingReference(r.brandReference),
      familyReference: parsePublishingReference(r.familyReference),
      policyReference: parsePublishingReference(r.policyReference),
      policyVersion: parsePublishingVersion(r.policyVersion),
      approvalPolicy: r.approvalPolicy,
      effectiveFrom,
      effectiveUntil,
    });
  } catch {
    throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
  }
}
export type PublishingOptionPricePublicationPolicy = ReturnType<
  typeof parsePublishingOptionPricePublicationPolicy
>;
export const publishingOptionPricePublicationPolicyDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionPricePublicationPolicy(value)));

/** Actual current governance release and immutable body. The consumer must hold
 * current permissions and the natural policy deadline in the same outer UoW. */
export interface CurrentOptionPricePublicationPolicy {
  readonly content: PublishingOptionPricePublicationPolicy;
  readonly current: Readonly<{
    release: PublishingReleaseRecord;
    lifecycle: PublishingLifecycleRecord;
    validationEvidence: PublishingValidationEvidence;
    approvalEvidence: PublishingApprovalEvidence;
    auditReference: PublishingReference;
    observedAt: ReturnType<typeof parsePublishingInstant>;
  }>;
  readonly observedAt: ReturnType<typeof parsePublishingInstant>;
}

export type OptionPriceRuleReviewSourceResult =
  | Readonly<{
      outcome: "Absent";
      familyReference: PublishingReference;
      snapshotReference: PublishingReference;
      snapshotDigest: PublishingDigest;
      observedAt: ReturnType<typeof parsePublishingInstant>;
    }>
  | Readonly<{
      outcome: "Recorded";
      familyReference: PublishingReference;
      snapshotReference: PublishingReference;
      snapshotDigest: PublishingDigest;
      draft: CommitPublishingMutationInput;
      review: CommitPublishingMutationInput | null;
      approval: CommitPublishingMutationInput | null;
      latest: CommitPublishingMutationInput;
      observedAt: ReturnType<typeof parsePublishingInstant>;
    }>;
export interface OptionPriceRuleReviewHeldSource {
  readForDraft(
    value: Readonly<{ snapshotReference: string; snapshotDigest: string; observedAt: string }>,
  ): Promise<OptionPriceRuleReviewSourceResult>;
}
