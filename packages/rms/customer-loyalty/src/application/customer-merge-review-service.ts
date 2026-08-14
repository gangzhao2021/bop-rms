import {
  customerInstant,
  customerReference,
  CustomerProfileError,
} from "../domain/customer-profile.js";
import {
  customerProfilesMergedFact,
  decideCustomerMergeReview,
  startCustomerMergeReview,
} from "../domain/customer-merge-review.js";
import type {
  CustomerMergeReviewCommand,
  CustomerMergeReviewQuery,
} from "../contracts/customer-merge-review.js";
import type { CustomerMergeReviewPorts } from "./ports/customer-merge-review-ports.js";

const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
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
const version = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail();
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : fail();
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
function parse(value: unknown): CustomerMergeReviewCommand {
  const raw = object(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (
    raw.purpose !== "CustomerDuplicateResolution" ||
    !["StartReview", "Approve", "Reject"].includes(raw.action as string)
  )
    fail();
  const action = raw.action as CustomerMergeReviewCommand["action"];
  if (
    raw.permission !==
    (action === "StartReview" ? "customer.merge.review" : "customer.merge.approve")
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const fields =
    action === "StartReview"
      ? [
          "reviewReference",
          "canonicalProfileReference",
          "candidateProfileReference",
          "canonicalProfileVersion",
          "candidateProfileVersion",
          "evidenceReferences",
        ]
      : ["reviewReference", "expectedVersion", "reasonCode"];
  const payload = Object.freeze(object(raw.payload, fields));
  customerReference(payload.reviewReference);
  if (action === "StartReview") {
    customerReference(payload.canonicalProfileReference);
    customerReference(payload.candidateProfileReference);
    version(payload.canonicalProfileVersion);
    version(payload.candidateProfileVersion);
    const evidenceReferences = payload.evidenceReferences;
    if (!Array.isArray(evidenceReferences)) return fail();
    if (evidenceReferences.length === 0 || evidenceReferences.length > 20) fail();
    evidenceReferences.forEach(customerReference);
  } else {
    version(payload.expectedVersion);
    code(payload.reasonCode);
  }
  return Object.freeze({
    tenantReference: customerReference(raw.tenantReference),
    brandReference: customerReference(raw.brandReference),
    actorReference: customerReference(raw.actorReference),
    purpose: "CustomerDuplicateResolution",
    permission: raw.permission as CustomerMergeReviewCommand["permission"],
    operationReference: customerReference(raw.operationReference),
    occurredAt: customerInstant(raw.occurredAt),
    action,
    payload,
  });
}
export async function executeCustomerMergeReview(value: unknown, ports: CustomerMergeReviewPorts) {
  const command = parse(value);
  const access = await ports.authorization.authorize(command);
  if (
    !access?.authorized ||
    !access.mayReview ||
    (command.action !== "StartReview" && !access.mayApprove)
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command)));
  const replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash))
      fail("CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
  }
  let review;
  let before = null;
  if (command.action === "StartReview") {
    const evidenceReferences = command.payload.evidenceReferences as string[];
    const validated = await ports.candidates.validate({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      canonicalProfileReference: customerReference(command.payload.canonicalProfileReference),
      candidateProfileReference: customerReference(command.payload.candidateProfileReference),
      canonicalProfileVersion: version(command.payload.canonicalProfileVersion),
      candidateProfileVersion: version(command.payload.candidateProfileVersion),
      evidenceReferences: evidenceReferences.map(customerReference),
      occurredAt: command.occurredAt,
    });
    if (!validated.valid || !validated.sameBrand || validated.broadFuzzyMatchUsed)
      fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
    review = startCustomerMergeReview({
      reviewReference: command.payload.reviewReference,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      canonicalProfileReference: command.payload.canonicalProfileReference,
      candidateProfileReference: command.payload.candidateProfileReference,
      canonicalProfileVersion: command.payload.canonicalProfileVersion,
      candidateProfileVersion: command.payload.candidateProfileVersion,
      evidence: validated.evidence,
      conflicts: validated.conflicts,
      linkedAccountReferences: validated.linkedAccountReferences,
      linkedTransactionReferences: validated.linkedTransactionReferences,
      consentEvidenceReferences: validated.consentEvidenceReferences,
      impactReference: validated.impactReference,
      rollbackReference: validated.rollbackReference,
      requestedBy: command.actorReference,
      requestedAt: command.occurredAt,
    });
  } else {
    const loaded = await ports.repository.load(customerReference(command.payload.reviewReference));
    if (
      !loaded ||
      loaded.tenantReference !== command.tenantReference ||
      loaded.brandReference !== command.brandReference
    )
      fail("CUSTOMER_PROFILE_STATE_CONFLICT");
    const existing = loaded as NonNullable<typeof loaded>;
    before = existing;
    let decisionEvidenceReference = command.operationReference;
    if (command.action === "Approve") {
      const approval = await ports.approval.validate({
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        reviewReference: existing.reviewReference,
        actorReference: command.actorReference,
        occurredAt: command.occurredAt,
      });
      if (
        !approval.approved ||
        approval.approverReference !== command.actorReference ||
        approval.approvedAt > command.occurredAt
      )
        fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      decisionEvidenceReference = approval.approvalReference;
    }
    review = decideCustomerMergeReview(existing, {
      expectedVersion: version(command.payload.expectedVersion),
      decision: command.action === "Approve" ? "Approve" : "Reject",
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: code(command.payload.reasonCode),
      decisionEvidenceReference,
    });
  }
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      review,
      mergedFact:
        review.status === "Approved"
          ? customerProfilesMergedFact(review, command.operationReference)
          : null,
      audit: await ports.audit.create({ command, before, after: review }),
      outcome: "Applied" as const,
    }),
  );
}
export async function queryCustomerMergeReviews(
  query: CustomerMergeReviewQuery,
  ports: CustomerMergeReviewPorts,
) {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized || !access.mayReview) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const granted = access as NonNullable<typeof access>;
  const result = await ports.projection.query(query);
  if (
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference ||
    result.projectionName !== "customer_merge_review_v1" ||
    result.projectionVersion !== 1 ||
    (query.reviewReference !== null && result.review?.reviewReference !== query.reviewReference)
  )
    fail();
  const permissions = Object.freeze({
    mayViewEvidence: granted.mayViewEvidence === true,
    mayReview: granted.mayReview === true,
    mayApprove: granted.mayApprove === true,
  });
  const review =
    result.review === null
      ? null
      : Object.freeze({
          ...result.review,
          evidence: permissions.mayViewEvidence ? result.review.evidence : null,
          consentEvidenceReferences: permissions.mayViewEvidence
            ? result.review.consentEvidenceReferences
            : null,
        });
  return Object.freeze({ ...result, permissions, review });
}
