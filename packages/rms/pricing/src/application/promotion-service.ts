import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  parsePricingDigest,
  parsePricingReference,
  type PricingReference,
} from "../domain/money-tax-contract.js";
import {
  createPromotionSnapshot,
  simulatePromotions,
  type PromotionSnapshot,
} from "../domain/promotion.js";
import type {
  PromotionAction,
  PromotionEvent,
  PromotionOperationRecord,
  PromotionPorts,
} from "./ports/promotion-ports.js";

export type PromotionWorkflowErrorCode =
  | "PROMOTION_INPUT_INVALID"
  | "PROMOTION_PERMISSION_DENIED"
  | "PROMOTION_APPROVAL_REQUIRED"
  | "PROMOTION_VERSION_CONFLICT"
  | "PROMOTION_IDEMPOTENCY_CONFLICT"
  | "PROMOTION_CODE_CONFLICT"
  | "PROMOTION_LIFECYCLE_CONFLICT"
  | "PROMOTION_SIMULATION_FAILED"
  | "PROMOTION_DEPENDENCY_UNAVAILABLE";
export class PromotionWorkflowError extends Error {
  constructor(readonly code: PromotionWorkflowErrorCode) {
    super("Promotion operation is unavailable");
    this.name = "PromotionWorkflowError";
  }
}
const invalid = (): never => {
  throw new PromotionWorkflowError("PROMOTION_INPUT_INVALID");
};
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
}
function positive(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function dependency(error: unknown): never {
  if (
    error instanceof PromotionWorkflowError &&
    [
      "PROMOTION_VERSION_CONFLICT",
      "PROMOTION_IDEMPOTENCY_CONFLICT",
      "PROMOTION_CODE_CONFLICT",
    ].includes(error.code)
  )
    throw error;
  throw new PromotionWorkflowError("PROMOTION_DEPENDENCY_UNAVAILABLE");
}
function event(action: PromotionAction, aggregate: PromotionSnapshot, at: string): PromotionEvent {
  const types: Record<PromotionAction, PromotionEvent["eventType"]> = {
    CreateDraft: "PromotionDraftCreated",
    ReplaceDraft: "PromotionDraftReplaced",
    Publish: "PromotionPublished",
    Pause: "PromotionPaused",
    Archive: "PromotionArchived",
  };
  return Object.freeze({
    eventType: types[action],
    promotionReference: aggregate.promotionReference,
    versionReference: aggregate.versionReference,
    brandReference: aggregate.brandReference,
    aggregateVersion: aggregate.aggregateVersion,
    lifecycle: aggregate.lifecycle,
    snapshotDigest: aggregate.snapshotDigest,
    occurredAt: at,
  });
}
async function authorize(
  ports: PromotionPorts,
  action: PromotionAction,
  operationReference: PricingReference,
  promotionReference: PricingReference,
  at: string,
): Promise<{
  actor: PricingReference;
  brand: PricingReference;
  audit: AppendAuditRecordInput;
  approval: boolean;
  author: PricingReference | null;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, promotionReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new PromotionWorkflowError("PROMOTION_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "pricing.promotion.manage" ||
      evidence.permission.scopeKind !== "Brand" ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `PRICING_PROMOTION_${action.toUpperCase()}` ||
      audit.targetType !== "PricingPromotion" ||
      audit.targetId !== promotionReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      actor: parsePricingReference(actor),
      brand: parsePricingReference(context.brand.brandReference),
      audit,
      approval:
        evidence.approvalPermission?.effect === "Allow" &&
        evidence.approvalPermission.action === "pricing.promotion.approve" &&
        evidence.approvalPermission.scopeKind === "Brand",
      author:
        evidence.draftAuthorActorReference === null
          ? null
          : parsePricingReference(evidence.draftAuthorActorReference),
    };
  } catch {
    throw new PromotionWorkflowError("PROMOTION_PERMISSION_DENIED");
  }
}
export interface ExecutePromotionInput {
  readonly action: PromotionAction;
  readonly operationReference: PricingReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: PromotionSnapshot;
  readonly occurredAt: string;
}
export function createPromotionService(ports: PromotionPorts) {
  return Object.freeze({
    async execute(input: ExecutePromotionInput) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 5 ||
        !["CreateDraft", "ReplaceDraft", "Publish", "Pause", "Archive"].includes(input.action)
      )
        invalid();
      const at = instant(input.occurredAt);
      const operationReference = parsePricingReference(input.operationReference);
      const candidate = createPromotionSnapshot(input.candidate);
      const intent = parsePricingDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new PromotionWorkflowError("PROMOTION_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          aggregate: createPromotionSnapshot(prior.aggregate),
        });
      }
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.promotionReference,
        at,
      );
      if (candidate.brandReference !== auth.brand)
        throw new PromotionWorkflowError("PROMOTION_PERMISSION_DENIED");
      const current = await ports.repository.load(candidate.promotionReference).catch(dependency);
      if (input.action === "CreateDraft") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.lifecycle !== "Draft" ||
          candidate.aggregateVersion !== 1
        )
          throw new PromotionWorkflowError("PROMOTION_LIFECYCLE_CONFLICT");
        if (
          !(await ports.repository
            .codeAvailable({
              brandReference: candidate.brandReference,
              stableCode: candidate.stableCode,
              excludingPromotionReference: null,
            })
            .catch(dependency))
        )
          throw new PromotionWorkflowError("PROMOTION_CODE_CONFLICT");
      } else {
        const expected = positive(input.expectedAggregateVersion);
        if (current === null || current.aggregateVersion !== expected)
          throw new PromotionWorkflowError("PROMOTION_VERSION_CONFLICT");
        const target: Record<
          Exclude<PromotionAction, "CreateDraft">,
          PromotionSnapshot["lifecycle"]
        > = { ReplaceDraft: "Draft", Publish: "Published", Pause: "Paused", Archive: "Archived" };
        if (
          candidate.promotionReference !== current.promotionReference ||
          candidate.stableCode !== current.stableCode ||
          candidate.aggregateVersion !== expected + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.createdAt !== at ||
          candidate.lifecycle !== target[input.action]
        )
          invalid();
        if (
          (input.action === "ReplaceDraft" || input.action === "Publish") &&
          current.lifecycle !== "Draft"
        )
          throw new PromotionWorkflowError("PROMOTION_LIFECYCLE_CONFLICT");
        if (input.action === "Pause" && current.lifecycle !== "Published")
          throw new PromotionWorkflowError("PROMOTION_LIFECYCLE_CONFLICT");
        if (input.action === "Archive" && current.lifecycle === "Archived")
          throw new PromotionWorkflowError("PROMOTION_LIFECYCLE_CONFLICT");
      }
      if (!(await ports.facts.validate(candidate).catch(dependency)))
        throw new PromotionWorkflowError("PROMOTION_SIMULATION_FAILED");
      if (input.action === "Publish") {
        if (!auth.approval || auth.author === null || auth.author === auth.actor)
          throw new PromotionWorkflowError("PROMOTION_APPROVAL_REQUIRED");
        const baskets = await ports.facts.representativeBaskets(candidate).catch(dependency);
        if (
          baskets.length === 0 ||
          baskets.some((basket) => simulatePromotions([candidate], basket).selections.length === 0)
        )
          throw new PromotionWorkflowError("PROMOTION_SIMULATION_FAILED");
      }
      const record: PromotionOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: event(input.action, candidate, at),
      });
      const saved =
        input.action === "CreateDraft"
          ? await ports.repository.create({ record, audit: auth.audit }).catch(dependency)
          : await ports.repository
              .commit({
                record,
                expectedAggregateVersion: positive(input.expectedAggregateVersion),
                audit: auth.audit,
              })
              .catch(dependency);
      const aggregate = createPromotionSnapshot(saved.aggregate);
      if (
        saved.action !== record.action ||
        saved.operationReference !== record.operationReference ||
        !ports.references.equals(saved.operationIntentHash, record.operationIntentHash) ||
        aggregate.aggregateVersion !== candidate.aggregateVersion ||
        JSON.stringify(saved.event) !== JSON.stringify(record.event)
      )
        throw new PromotionWorkflowError("PROMOTION_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ status: "Applied" as const, aggregate });
    },
  });
}
