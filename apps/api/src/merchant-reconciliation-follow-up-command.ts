import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type IdentityActor,
} from "@bop/identity";
import { createPostgresStoreAssigneeEligibility } from "@bop/membership";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresReconciliationFollowUpStore,
  createReconciliationFollowUpService,
  parseReconciliationFollowUpCommand,
  ReconciliationFollowUpError,
} from "@rms/payment";
import { createMerchantReconciliationFollowUpTransactions } from "./merchant-reconciliation-follow-up-transactions.js";
import type { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
type Preparation = Parameters<typeof createMerchantOrdinaryRefundCommand>[0];
export function createMerchantReconciliationFollowUpCommand(options: {
  persistence: Preparation["persistence"];
  authentication: Preparation["authentication"];
  now(): string;
  reference(): string;
  /** Identity-owned current active target. Never synthesize a target login. */
  targetActor?(
    tx: ConsumerTransaction,
    reference: string,
    observedAt: string,
  ): Promise<IdentityActor>;
}) {
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "exceptionReference",
      "action",
      "assigneeReference",
      "expectedVersion",
      "operationReference",
    ]);
    if (raw.action === "AssignSelf" && raw.assigneeReference !== null)
      throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_INVALID");
    const exceptionReference = String(
      parseOpaqueUuidV7(raw.exceptionReference, "ACTOR_REFERENCE_INVALID"),
    );
    const bridge = await createMerchantReconciliationFollowUpTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      exceptionReference,
      verifyAssignee: async (tx, query) => {
        const authority = await bridge.resolveAuthority(tx);
        return createPostgresStoreAssigneeEligibility({
          authorize: async () => authority.authorize(),
          targetActor: async (_t, reference) => {
            const fresh = await bridge.resolveAuthority(tx);
            if (!(await fresh.authorize()))
              throw new Error("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
            if (reference === fresh.context.actor.actorReference) return fresh.context.actor;
            if (!options.targetActor) throw new Error("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
            return options.targetActor(tx, reference, String(fresh.context.resolvedAt));
          },
        })(tx, { context: authority.context, assigneeReference: query.assigneeReference });
      },
    });
    const records = createPostgresReconciliationFollowUpStore({
      scope: bridge.scope,
      authorize: bridge.authorize,
    });
    return bridge.transactions.run(async (tx) => {
      let command = parseReconciliationFollowUpCommand({
        ...raw,
        ...(raw.action === "AssignSelf"
          ? { action: "Assign", assigneeReference: bridge.actorReference }
          : {}),
        ...bridge.scope,
        actorReference: bridge.actorReference,
        occurredAt: String(parseCanonicalInstant(options.now())),
      });
      await records.lock(tx, command);
      const prior = await records.findOperation(tx, command);
      if (prior)
        command = parseReconciliationFollowUpCommand({
          ...command,
          occurredAt: prior.command.occurredAt,
        });
      const result = await createReconciliationFollowUpService({
        transactions: { run: (work) => work(tx) },
        now: options.now,
        authorize: bridge.authorize,
        records,
        audit: {
          append: async (transaction, { command: c }) => {
            await appendAuditRecordInTransaction(transaction, {
              auditId: String(parseOpaqueUuidV7(options.reference(), "ACTOR_REFERENCE_INVALID")),
              brandId: c.brandReference,
              storeId: c.storeReference,
              actor: { type: "User", reference: c.actorReference },
              actionCode: "PAYMENT_RECONCILIATION_FOLLOW_UP",
              targetType: "PaymentReconciliationException",
              targetId: c.exceptionReference,
              correlationId: c.operationReference,
              occurredAt: c.occurredAt,
              reasonCode: c.action === "Assign" ? "EXCEPTION_ASSIGNED" : "EXCEPTION_ACKNOWLEDGED",
              sourceChannel: "OPERATIONS",
              dataClassification: "Restricted",
              retentionPolicyCode: "PAYMENT_AUDIT",
              retentionPolicyVersion: 1,
            });
          },
        },
      }).execute(command);
      return Object.freeze({
        status: result.status,
        version: result.state.version,
        followUpStatus: result.state.status,
        ownerReference: result.state.ownerReference,
        acknowledgedByReference: result.state.acknowledgedByReference,
        updatedAt: result.state.updatedAt,
      });
    });
  };
}
