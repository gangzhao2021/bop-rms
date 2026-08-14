import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  analyzePriceCoverage,
  createPriceBookSnapshot,
  type PriceBookSnapshot,
  type PriceResolutionContext,
} from "../domain/price-resolution.js";
import {
  parsePricingDigest,
  parsePricingReference,
  type PricingDigest,
  type PricingReference,
} from "../domain/money-tax-contract.js";
import type {
  PriceBookAction,
  PriceBookEvent,
  PriceBookOperationRecord,
  PriceBookPorts,
} from "./ports/price-book-ports.js";

export type PriceBookWorkflowErrorCode =
  | "PRICE_BOOK_INPUT_INVALID"
  | "PRICE_BOOK_PERMISSION_DENIED"
  | "PRICE_BOOK_APPROVAL_REQUIRED"
  | "PRICE_BOOK_VERSION_CONFLICT"
  | "PRICE_BOOK_IDEMPOTENCY_CONFLICT"
  | "PRICE_BOOK_CODE_CONFLICT"
  | "PRICE_BOOK_LIFECYCLE_CONFLICT"
  | "PRICE_BOOK_COVERAGE_INVALID"
  | "PRICE_BOOK_DEPENDENCY_UNAVAILABLE";
export class PriceBookWorkflowError extends Error {
  constructor(readonly code: PriceBookWorkflowErrorCode) {
    super("Price Book operation is unavailable");
    this.name = "PriceBookWorkflowError";
  }
}
const invalid = (): never => {
  throw new PriceBookWorkflowError("PRICE_BOOK_INPUT_INVALID");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
}
function failure(error: unknown): never {
  if (
    error instanceof PriceBookWorkflowError &&
    [
      "PRICE_BOOK_VERSION_CONFLICT",
      "PRICE_BOOK_IDEMPOTENCY_CONFLICT",
      "PRICE_BOOK_CODE_CONFLICT",
    ].includes(error.code)
  )
    throw error;
  throw new PriceBookWorkflowError("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
}
async function authorize(
  ports: PriceBookPorts,
  action: PriceBookAction,
  operationReference: PricingReference,
  priceBookReference: PricingReference,
  at: string,
): Promise<{
  brand: PricingReference;
  actor: PricingReference;
  audit: AppendAuditRecordInput;
  approvalAllowed: boolean;
  draftAuthor: PricingReference | null;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, priceBookReference, observedAt: at })
    .catch(failure);
  if (evidence === null) throw new PriceBookWorkflowError("PRICE_BOOK_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "pricing.price-book.manage" ||
      evidence.permission.scopeKind !== "Brand" ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `PRICING_PRICE_BOOK_${action.toUpperCase()}` ||
      audit.targetType !== "PricingPriceBook" ||
      audit.targetId !== priceBookReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    const approvalAllowed =
      evidence.approvalPermission?.effect === "Allow" &&
      evidence.approvalPermission.action === "pricing.price-book.approve" &&
      evidence.approvalPermission.scopeKind === "Brand";
    return {
      brand: parsePricingReference(context.brand.brandReference),
      actor: parsePricingReference(actor),
      audit,
      approvalAllowed,
      draftAuthor:
        evidence.draftAuthorActorReference === null
          ? null
          : parsePricingReference(evidence.draftAuthorActorReference),
    };
  } catch {
    throw new PriceBookWorkflowError("PRICE_BOOK_PERMISSION_DENIED");
  }
}
function event(action: PriceBookAction, aggregate: PriceBookSnapshot, at: string): PriceBookEvent {
  const types: Record<PriceBookAction, PriceBookEvent["eventType"]> = {
    CreateDraft: "PriceBookDraftCreated",
    ReplaceDraft: "PriceBookDraftReplaced",
    Publish: "PriceBookVersionPublished",
    Archive: "PriceBookArchived",
  };
  return Object.freeze({
    eventType: types[action],
    priceBookReference: aggregate.priceBookReference,
    versionReference: aggregate.versionReference,
    brandReference: aggregate.brandReference,
    aggregateVersion: aggregate.aggregateVersion,
    lifecycle: aggregate.lifecycle,
    currencyCode: aggregate.currencyMetadata.currencyCode,
    snapshotDigest: aggregate.snapshotDigest,
    occurredAt: at,
  });
}
async function replay(
  ports: PriceBookPorts,
  operationReference: PricingReference,
  intent: PricingDigest,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior === null) return null;
  if (!ports.references.equals(prior.operationIntentHash, intent))
    throw new PriceBookWorkflowError("PRICE_BOOK_IDEMPOTENCY_CONFLICT");
  return Object.freeze({
    status: "AlreadyApplied" as const,
    aggregate: createPriceBookSnapshot(prior.aggregate),
  });
}
function record(
  action: PriceBookAction,
  operationReference: PricingReference,
  intent: PricingDigest,
  aggregate: PriceBookSnapshot,
  at: string,
): PriceBookOperationRecord {
  return Object.freeze({
    action,
    operationReference,
    operationIntentHash: intent,
    aggregate,
    event: event(action, aggregate, at),
  });
}
function verify(
  saved: PriceBookOperationRecord,
  expected: PriceBookOperationRecord,
  ports: PriceBookPorts,
): PriceBookSnapshot {
  const aggregate = createPriceBookSnapshot(saved.aggregate);
  if (
    saved.action !== expected.action ||
    saved.operationReference !== expected.operationReference ||
    !ports.references.equals(saved.operationIntentHash, expected.operationIntentHash) ||
    aggregate.priceBookReference !== expected.aggregate.priceBookReference ||
    aggregate.aggregateVersion !== expected.aggregate.aggregateVersion ||
    JSON.stringify(saved.event) !== JSON.stringify(expected.event)
  )
    throw new PriceBookWorkflowError("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
  return aggregate;
}
function successor(
  current: PriceBookSnapshot,
  candidate: PriceBookSnapshot,
  expected: number,
  lifecycle: PriceBookSnapshot["lifecycle"],
  at: string,
): void {
  if (
    candidate.priceBookReference !== current.priceBookReference ||
    candidate.brandReference !== current.brandReference ||
    candidate.stableCode !== current.stableCode ||
    candidate.aggregateVersion !== expected + 1 ||
    candidate.versionNumber !== current.versionNumber + 1 ||
    candidate.versionReference === current.versionReference ||
    candidate.lifecycle !== lifecycle ||
    candidate.createdAt !== at
  )
    invalid();
}
export function createPriceBookService(ports: PriceBookPorts) {
  async function commit(
    action: Exclude<PriceBookAction, "CreateDraft">,
    raw: Record<string, unknown>,
    lifecycle: PriceBookSnapshot["lifecycle"],
    requireApproval: boolean,
  ) {
    const reference = parsePricingReference(raw.priceBookReference);
    const expected = positive(raw.expectedAggregateVersion);
    const operationReference = parsePricingReference(raw.operationReference);
    const requestedAt = instant(raw.requestedAt);
    const candidate = createPriceBookSnapshot(raw.candidate as PriceBookSnapshot);
    const contexts = (raw.coverageContexts ?? []) as readonly PriceResolutionContext[];
    const intent = parsePricingDigest(
      ports.references.hashIntent(
        `${action}:${reference}:${expected}:${JSON.stringify(candidate, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`,
      ),
    );
    const prior = await replay(ports, operationReference, intent);
    if (prior !== null) return prior;
    const currentValue = await ports.repository.load(reference).catch(failure);
    if (currentValue === null)
      throw new PriceBookWorkflowError("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
    const current = createPriceBookSnapshot(currentValue);
    if (current.aggregateVersion !== expected)
      throw new PriceBookWorkflowError("PRICE_BOOK_VERSION_CONFLICT");
    if (
      current.lifecycle === "Archived" ||
      (action === "ReplaceDraft" && current.lifecycle !== "Draft") ||
      (action === "Publish" && current.lifecycle !== "Draft")
    )
      throw new PriceBookWorkflowError("PRICE_BOOK_LIFECYCLE_CONFLICT");
    successor(current, candidate, expected, lifecycle, requestedAt);
    const auth = await authorize(ports, action, operationReference, reference, requestedAt);
    if (auth.brand !== current.brandReference)
      throw new PriceBookWorkflowError("PRICE_BOOK_PERMISSION_DENIED");
    if (
      requireApproval &&
      (!auth.approvalAllowed || auth.draftAuthor === null || auth.draftAuthor === auth.actor)
    )
      throw new PriceBookWorkflowError("PRICE_BOOK_APPROVAL_REQUIRED");
    if (
      action === "Publish" &&
      analyzePriceCoverage(candidate, contexts).some((item) => item.status !== "Covered")
    )
      throw new PriceBookWorkflowError("PRICE_BOOK_COVERAGE_INVALID");
    if (!(await ports.facts.validate(candidate).catch(failure)))
      throw new PriceBookWorkflowError("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
    const operation = record(action, operationReference, intent, candidate, requestedAt);
    const saved = await ports.repository
      .commit({ record: operation, expectedAggregateVersion: expected, audit: auth.audit })
      .catch(failure);
    return Object.freeze({
      status: "Applied" as const,
      aggregate: verify(saved, operation, ports),
    });
  }
  return Object.freeze({
    async createDraft(value: unknown) {
      const raw = exact(value, ["candidate", "operationReference", "requestedAt"]);
      const candidate = createPriceBookSnapshot(raw.candidate as PriceBookSnapshot);
      const operationReference = parsePricingReference(raw.operationReference);
      const requestedAt = instant(raw.requestedAt);
      if (
        candidate.lifecycle !== "Draft" ||
        candidate.aggregateVersion !== 1 ||
        candidate.versionNumber !== 1 ||
        candidate.createdAt !== requestedAt
      )
        invalid();
      const intent = parsePricingDigest(
        ports.references.hashIntent(
          `CreateDraft:${JSON.stringify(candidate, (_key, item) => (typeof item === "bigint" ? item.toString() : item))}`,
        ),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const auth = await authorize(
        ports,
        "CreateDraft",
        operationReference,
        candidate.priceBookReference,
        requestedAt,
      );
      if (candidate.brandReference !== auth.brand)
        throw new PriceBookWorkflowError("PRICE_BOOK_PERMISSION_DENIED");
      if (
        !(await ports.repository
          .codeAvailable({
            brandReference: auth.brand,
            stableCode: candidate.stableCode,
            excludingPriceBookReference: null,
          })
          .catch(failure))
      )
        throw new PriceBookWorkflowError("PRICE_BOOK_CODE_CONFLICT");
      if (!(await ports.facts.validate(candidate).catch(failure)))
        throw new PriceBookWorkflowError("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
      const operation = record("CreateDraft", operationReference, intent, candidate, requestedAt);
      const saved = await ports.repository
        .create({ record: operation, audit: auth.audit })
        .catch(failure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verify(saved, operation, ports),
      });
    },
    replaceDraft(value: unknown) {
      const raw = exact(value, [
        "priceBookReference",
        "expectedAggregateVersion",
        "candidate",
        "operationReference",
        "requestedAt",
      ]);
      return commit("ReplaceDraft", raw, "Draft", false);
    },
    publish(value: unknown) {
      const raw = exact(value, [
        "priceBookReference",
        "expectedAggregateVersion",
        "candidate",
        "coverageContexts",
        "operationReference",
        "requestedAt",
      ]);
      return commit("Publish", raw, "Published", true);
    },
    archive(value: unknown) {
      const raw = exact(value, [
        "priceBookReference",
        "expectedAggregateVersion",
        "candidate",
        "operationReference",
        "requestedAt",
      ]);
      return commit("Archive", raw, "Archived", false);
    },
  });
}
