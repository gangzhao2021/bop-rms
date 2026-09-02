export type CustomerMergeReviewClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class CustomerMergeReviewClientError extends Error {
  constructor(readonly code: CustomerMergeReviewClientErrorCode) {
    super("Customer merge review unavailable");
    this.name = "CustomerMergeReviewClientError";
  }
}
export interface CustomerMergeReviewView {
  readonly projectionName: "customer_merge_review_v1";
  readonly projectionVersion: 1;
  readonly screenId: "CRM-MERGE-REVIEW";
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayViewEvidence: boolean;
    readonly mayReview: boolean;
    readonly mayApprove: boolean;
  };
  readonly review: null | {
    readonly reviewReference: string;
    readonly aggregateVersion: number;
    readonly status: "PendingApproval" | "Approved" | "Rejected";
    readonly canonicalProfileReference: string;
    readonly candidateProfileReference: string;
    readonly canonicalProfileVersion: number;
    readonly candidateProfileVersion: number;
    readonly evidence:
      | readonly {
          readonly evidenceReference: string;
          readonly kind:
            "VerifiedContact" | "VerifiedUser" | "AuthorizedTransaction" | "StaffInvestigation";
          readonly verifiedAt: string;
        }[]
      | null;
    readonly conflicts: readonly {
      readonly fieldCode:
        "DISPLAY_NAME" | "LOCALE" | "USER_LINK" | "CONTACT" | "CONSENT" | "LOYALTY_ACCOUNT";
      readonly resolution:
        "KeepCanonical" | "KeepCandidate" | "KeepBothReferences" | "RequiresFollowUp";
    }[];
    readonly linkedAccountReferences: readonly string[];
    readonly linkedTransactionReferences: readonly string[];
    readonly consentEvidenceReferences: readonly string[] | null;
    readonly impactReference: string;
    readonly rollbackReference: string;
    readonly requestedBy: string;
    readonly decidedBy: string | null;
    readonly decisionEvidenceReference: string | null;
  };
}
export interface CustomerMergeReviewClient {
  load(reviewReference?: string): Promise<unknown>;
}
const fail = (): never => {
  throw new CustomerMergeReviewClientError("Unavailable");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u.test(value)
    ? value
    : fail();
const refs = (value: unknown) =>
  !Array.isArray(value) || value.length > 200 ? fail() : Object.freeze(value.map(ref));
export function parseCustomerMergeReviewView(value: unknown): CustomerMergeReviewView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "review",
  ]);
  if (
    raw.projectionName !== "customer_merge_review_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "CRM-MERGE-REVIEW" ||
    typeof raw.partial !== "boolean"
  )
    fail();
  const p = object(raw.permissions, ["mayViewEvidence", "mayReview", "mayApprove"]);
  if (Object.values(p).some((entry) => typeof entry !== "boolean")) fail();
  const permissions = p as unknown as CustomerMergeReviewView["permissions"];
  let review: CustomerMergeReviewView["review"] = null;
  if (raw.review !== null) {
    const item = object(raw.review, [
      "reviewReference",
      "aggregateVersion",
      "status",
      "canonicalProfileReference",
      "candidateProfileReference",
      "canonicalProfileVersion",
      "candidateProfileVersion",
      "evidence",
      "conflicts",
      "linkedAccountReferences",
      "linkedTransactionReferences",
      "consentEvidenceReferences",
      "impactReference",
      "rollbackReference",
      "requestedBy",
      "decidedBy",
      "decisionEvidenceReference",
    ]);
    if (
      !permissions.mayViewEvidence &&
      (item.evidence !== null || item.consentEvidenceReferences !== null)
    )
      fail();
    if (
      !Number.isSafeInteger(item.aggregateVersion) ||
      (item.aggregateVersion as number) < 1 ||
      !Number.isSafeInteger(item.canonicalProfileVersion) ||
      (item.canonicalProfileVersion as number) < 1 ||
      !Number.isSafeInteger(item.candidateProfileVersion) ||
      (item.candidateProfileVersion as number) < 1 ||
      !["PendingApproval", "Approved", "Rejected"].includes(item.status as string) ||
      !Array.isArray(item.conflicts) ||
      item.conflicts.length > 30 ||
      (item.evidence !== null && (!Array.isArray(item.evidence) || item.evidence.length > 20))
    )
      fail();
    const evidence =
      item.evidence === null
        ? null
        : Object.freeze(
            (item.evidence as unknown[]).map((entry) => {
              const evidenceItem = object(entry, ["evidenceReference", "kind", "verifiedAt"]);
              if (
                ![
                  "VerifiedContact",
                  "VerifiedUser",
                  "AuthorizedTransaction",
                  "StaffInvestigation",
                ].includes(evidenceItem.kind as string)
              )
                fail();
              return Object.freeze({
                evidenceReference: ref(evidenceItem.evidenceReference),
                kind: evidenceItem.kind as NonNullable<
                  CustomerMergeReviewView["review"]
                >["evidence"] extends readonly (infer E)[] | null
                  ? E extends { kind: infer K }
                    ? K
                    : never
                  : never,
                verifiedAt: instant(evidenceItem.verifiedAt),
              });
            }),
          );
    const conflicts = Object.freeze(
      (item.conflicts as unknown[]).map((entry) => {
        const conflict = object(entry, ["fieldCode", "resolution"]);
        if (
          ![
            "DISPLAY_NAME",
            "LOCALE",
            "USER_LINK",
            "CONTACT",
            "CONSENT",
            "LOYALTY_ACCOUNT",
          ].includes(conflict.fieldCode as string) ||
          !["KeepCanonical", "KeepCandidate", "KeepBothReferences", "RequiresFollowUp"].includes(
            conflict.resolution as string,
          )
        )
          fail();
        return Object.freeze(conflict) as unknown as NonNullable<
          CustomerMergeReviewView["review"]
        >["conflicts"][number];
      }),
    );
    review = Object.freeze({
      reviewReference: ref(item.reviewReference),
      aggregateVersion: item.aggregateVersion as number,
      status: item.status as NonNullable<CustomerMergeReviewView["review"]>["status"],
      canonicalProfileReference: ref(item.canonicalProfileReference),
      candidateProfileReference: ref(item.candidateProfileReference),
      canonicalProfileVersion: item.canonicalProfileVersion as number,
      candidateProfileVersion: item.candidateProfileVersion as number,
      evidence,
      conflicts,
      linkedAccountReferences: refs(item.linkedAccountReferences),
      linkedTransactionReferences: refs(item.linkedTransactionReferences),
      consentEvidenceReferences:
        item.consentEvidenceReferences === null ? null : refs(item.consentEvidenceReferences),
      impactReference: ref(item.impactReference),
      rollbackReference: ref(item.rollbackReference),
      requestedBy: ref(item.requestedBy),
      decidedBy: item.decidedBy === null ? null : ref(item.decidedBy),
      decisionEvidenceReference:
        item.decisionEvidenceReference === null ? null : ref(item.decisionEvidenceReference),
    });
  }
  return Object.freeze({
    projectionName: "customer_merge_review_v1",
    projectionVersion: 1,
    screenId: "CRM-MERGE-REVIEW",
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: ["Current", "Stale", "Rebuilding"].includes(raw.freshness as string)
      ? (raw.freshness as CustomerMergeReviewView["freshness"])
      : fail(),
    partial: raw.partial as boolean,
    permissions,
    review,
  });
}
export const unavailableCustomerMergeReviewClient: CustomerMergeReviewClient = {
  load: async () => {
    throw new CustomerMergeReviewClientError("FeatureDisabled");
  },
};
