import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrderClosureStore,
  createPostgresOrderClosurePosition,
  type OrderClosureRecord,
  parseOrderingInstant,
} from "@rms/ordering";
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
import { createSettledOrderClose } from "./settled-order-close.js";

export type OrderCloseCommandErrorCode =
  | "ORDER_CLOSE_INPUT_INVALID"
  | "ORDER_CLOSE_PERMISSION_DENIED"
  | "ORDER_CLOSE_VERSION_CONFLICT"
  | "ORDER_CLOSE_ALREADY_CLOSED"
  | "ORDER_CLOSE_NOT_READY"
  | "ORDER_CLOSE_UNAVAILABLE";
/**
 * WP-2423 (B759): why an Order close was refused, so staff see the real reason (never a
 * permission message for an Order that is simply not ready). `reasons` are the settlement and
 * closure-eligibility reason codes of ORDER_CLOSE_NOT_READY.
 */
export class OrderCloseCommandError extends Error {
  constructor(
    readonly code: OrderCloseCommandErrorCode,
    readonly reasons: readonly string[] = [],
  ) {
    super(code);
    this.name = "OrderCloseCommandError";
  }
}
const fail = (): never => {
  throw new Error("ORDER_CLOSE_COMMAND_UNAVAILABLE");
};
const reference = (v: unknown) => String(parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID"));
export const refuseOrderClose = (
  code: OrderCloseCommandErrorCode,
  reasons: readonly string[] = [],
): never => {
  throw new OrderCloseCommandError(code, reasons);
};
export interface OrderCloseRunCommand {
  orderReference: string;
  operationReference: string;
  expectedOrderVersion: number;
  expectedClosureVersion: number;
  reasonCode: string;
}
/** A staff member, or the System closing a guest-started table (no person to name). */
export type DiningCloseActor =
  { readonly type: "User"; readonly reference: string } | { readonly type: "System" };

/**
 * The settled close of one dine-in Order, in the caller's transaction: Payment's financial finality
 * and Ordering's closure, each with its audit. The staff command and the System's close of a
 * guest-started table run this same path; the caller supplies who acts and from where.
 */
export async function runDiningOrderClose(input: {
  readonly tx: ConsumerTransaction;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly actor: DiningCloseActor;
  readonly sourceChannel: "MERCHANT_WEB" | "SYSTEM" | "CUSTOMER_PWA";
  readonly command: OrderCloseRunCommand;
  readonly now: string;
  authorize(): Promise<boolean>;
  newReference(): string;
  readonly audit: Pick<AppendAuditRecordInput, "retentionPolicyCode" | "retentionPolicyVersion">;
  resolveConfiguration(): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    diningSessionReference: string;
    guestSessionReference: string;
  }>;
}) {
  const { tx, scope, actor, sourceChannel, command, authorize } = input;
  const actorReference = actor.type === "User" ? actor.reference : null;
  // The closure record is this actor's, for this Order, in the Store resolved for the run.
  const authorizeRecord = async (_inner: ConsumerTransaction, record: OrderClosureRecord) =>
    record.orderReference === command.orderReference &&
    record.status === "Closed" &&
    record.actorType === actor.type &&
    (actorReference === null
      ? record.actorReference === null
      : String(record.actorReference) === actorReference) &&
    String(record.tenantReference) === String(scope.tenantReference) &&
    String(record.brandReference) === scope.brandReference &&
    String(record.storeReference) === scope.storeReference &&
    (await authorize());
  const closureAudit = async (record: OrderClosureRecord) => ({
    ...input.audit,
    auditId: input.newReference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor:
      actorReference === null ? { type: "System" } : { type: "User", reference: actorReference },
    actionCode: "ORDER_CLOSURE_RECORDED",
    targetType: "Order",
    targetId: record.orderReference,
    afterSummary: { status: "Closed", closureVersion: record.closureVersion },
    reasonCode: record.reasonCode,
    correlationId: record.operationReference,
    occurredAt: record.occurredAt,
    sourceChannel,
    dataClassification: "Restricted",
  });
  const receiptStore = createPostgresOrderClosureStore({
    ...scope,
    authorize: authorizeRecord,
    audit: closureAudit,
    closeEvidence: async () => fail(),
    reopenEvidence: async () => fail(),
  });
  const now = String(parseOrderingInstant(input.now));
  const prior = await receiptStore.readOperation(
    tx,
    {
      orderReference: command.orderReference,
      operationReference: command.operationReference,
      observedAt: now,
    },
    authorize,
  );
  if (
    prior &&
    (prior.status !== "Closed" ||
      prior.actorType !== actor.type ||
      (actorReference === null
        ? prior.actorReference !== null
        : String(prior.actorReference) !== actorReference) ||
      prior.orderVersion !== command.expectedOrderVersion ||
      prior.closureVersion !== command.expectedClosureVersion + 1 ||
      prior.reasonCode !== command.reasonCode)
  )
    return fail();
  const configuration = await input.resolveConfiguration();
  const sourceOptions = {
    ...scope,
    diningScope: scope,
    paymentScope: {
      ...scope,
      providerAccountReference: configuration.providerAccountReference,
      environment: configuration.environment,
    },
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
    // WP-2423 item 2: an Order whose every round was cancelled can be closed (nothing owed).
    includeCancelled: true,
  };
  const evidence = createDiningSettledCloseEvidence(sourceOptions);
  const observedAt = prior ? String(prior.occurredAt) : now;
  const evidenceInput = {
    ...scope,
    transaction: tx,
    orderReference: command.orderReference,
    diningSessionReference: configuration.diningSessionReference,
    guestSessionReference: configuration.guestSessionReference,
    observedAt,
  };
  const runtime = createSettledOrderClose({
    payment: {
      scope,
      providerAccountReference: configuration.providerAccountReference,
      environment: configuration.environment,
      authorize,
      audit: async (fact) => ({
        ...input.audit,
        auditId: input.newReference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDER_FINANCIAL_FINALITY_RECORDED",
        targetType: "Order",
        targetId: fact.orderReference,
        afterSummary: { classification: "Settled" },
        reasonCode: "ORDER_SETTLED",
        correlationId: fact.operationReference,
        occurredAt: fact.decidedAt,
        sourceChannel,
        dataClassification: "Restricted",
      }),
    },
    closure: { ...scope, authorize: authorizeRecord, audit: closureAudit },
    closeEvidence: async (_inner, _record, fact) =>
      (await evidence.load(evidenceInput, fact)).evidence,
  });
  const financial = {
    finalityReference: prior?.financialFinalityReference ?? reference(input.newReference()),
    operationReference: command.operationReference,
    orderReference: command.orderReference,
    expectedOrderVersion: command.expectedOrderVersion,
    observedAt,
  };
  let result;
  if (prior) {
    result = await runtime.commit(tx, { closure: prior, financial });
  } else {
    const position = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, {
      orderReference: command.orderReference,
      observedAt,
    });
    if (position.status !== "Open") return refuseOrderClose("ORDER_CLOSE_ALREADY_CLOSED");
    if (
      position.orderVersion !== command.expectedOrderVersion ||
      position.closureVersion !== command.expectedClosureVersion
    )
      return refuseOrderClose("ORDER_CLOSE_VERSION_CONFLICT");
    // WP-2423 (B759): the same evaluation the closure evidence applies, read first so a
    // refusal names what is outstanding (refund still processing, items not resolved, …).
    const readiness = await evidence.readiness(evidenceInput);
    if (readiness === null) return refuseOrderClose("ORDER_CLOSE_ALREADY_CLOSED");
    if (readiness.orderVersion !== command.expectedOrderVersion)
      return refuseOrderClose("ORDER_CLOSE_VERSION_CONFLICT");
    if (readiness.reasons.length > 0)
      return refuseOrderClose("ORDER_CLOSE_NOT_READY", readiness.reasons);
    const closureReference = reference(input.newReference());
    result = await runtime.commitPrepared(tx, {
      financial,
      authorizeIntent: authorize,
      prepareClosure: async (fact) => {
        const proof = await evidence.load(evidenceInput, fact);
        if (!proof.decision.eligible) return fail();
        return {
          ...scope,
          closureReference,
          operationReference: command.operationReference,
          orderReference: command.orderReference,
          closureVersion: position.closureVersion + 1,
          orderVersion: position.orderVersion,
          previousClosureReference: position.closureReference,
          status: "Closed",
          actorType: actor.type,
          actorReference,
          reasonCode: command.reasonCode,
          financialFinalityReference: fact.finalityReference,
          evidenceDigest: proof.evidenceDigest,
          occurredAt: observedAt,
        };
      },
    });
  }
  if ((await authorize()) !== true) return fail();
  return Object.freeze({
    status: result.status,
    closedOrderVersion: result.closure.orderVersion,
    closureVersion: result.closure.closureVersion,
  });
}
