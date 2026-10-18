import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  cardMachineBackEntryWindowMs,
  CardMachinePaymentError,
  createOrdinaryRefundRoleResolver,
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundApprovalReader,
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundCurrentEscalationSource,
  createPostgresOrdinaryRefundRequestContextSource,
  listOrdinaryRefundApprovalReferences,
  observeOrdinaryRefundOrderAfterFence,
  ordinaryRefundClaimKind,
  ordinaryRefundPaymentAmount,
  parseCardMachineRefundRecord,
  parseCardMachineSlipReference,
  parsePaymentDigest,
  parsePaymentInstant,
} from "@rms/payment";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import { CardMachineRefundCommandError } from "./merchant-card-machine-refund.js";
import { refundReadAccess } from "./merchant-refund-read-authority.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
const fail = (code: CardMachineRefundCommandError["code"]): never => {
  throw new CardMachineRefundCommandError(code);
};

export function parseCardMachineOrdinaryRefundCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "requestReference",
      "slipReference",
      "refundedAt",
    ]);
    const ref = (input: unknown) => String(parseOpaqueUuidV7(input, "ACTOR_REFERENCE_INVALID"));
    return Object.freeze({
      operationReference: ref(raw.operationReference),
      orderReference: ref(raw.orderReference),
      requestReference: ref(raw.requestReference),
      slipReference:
        raw.slipReference === null ? null : parseCardMachineSlipReference(raw.slipReference),
      /** When the machine refund was actually made, if not just now (e.g. during an outage). */
      refundedAt: raw.refundedAt === null ? null : String(parsePaymentInstant(raw.refundedAt)),
    });
  } catch (error) {
    if (error instanceof CardMachineRefundCommandError) throw error;
    return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
  }
}

export interface CardMachineOrdinaryRefundResult {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly orderReference: string;
  readonly requestReference: string;
  readonly amountMinor: string;
  readonly refundedAt: string;
  /** The order's digital receipt gained a refund version, or the order has none (counter
   * customers keep the machine's own slip), or it could not be issued now (retry the same
   * command; the refund itself stays recorded). */
  readonly receipt: "Issued" | "NoDigitalReceipt" | "NotIssued";
}

/**
 * WP-2423 item 4 (DEC-COUNTER-PAYMENT-RECORD, partial refunds): an ordinary refund request of a
 * payment taken on the Store's own card machine was refunded on that machine; staff record it.
 * The request itself went through the online rules (Manager request with reason and per-item
 * quantities, allocation incl. tax and tip from the original quote, cumulative cap) and, when the
 * escalation rules require it now, an Owner/Finance approval (or the sole operator's own) must be
 * recorded first. The amount is the request's, never typed. No Provider is called. The person
 * recording is a refund handler (a Manager who may request or an Owner/Finance member who may
 * approve); a kitchen display sign-in records nothing.
 */
export function createMerchantCardMachineOrdinaryRefund(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope,
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    roleMapping: unknown;
  }>;
  /** Store Business Date (owner composition) for the escalation rules evaluated now. */
  businessDate: Parameters<
    typeof createPostgresOrdinaryRefundCurrentEscalationSource
  >[0]["businessDate"];
  nextReference(): string;
  /** After commit: append a refund version to the order's digital receipt, if it has one. */
  issueRefundReceipt?(request: { orderReference: string }): Promise<"Issued" | "NoDigitalReceipt">;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
  onUnexpected?(error: unknown): void;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CardMachineOrdinaryRefundResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseCardMachineOrdinaryRefundCommand(input.command);
    const intentDigest = parsePaymentDigest(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "CardMachineOrdinaryRefund/v1",
            orderReference: command.orderReference,
            requestReference: command.requestReference,
            slipReference: command.slipReference,
            refundedAt: command.refundedAt,
          }),
        ),
    );
    let recorded: Omit<CardMachineOrdinaryRefundResult, "receipt">;
    try {
      const denied = () => fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
      // WP-2423: one authorized run. The caller (Session, Store access) and their refund-handler
      // role are resolved in full once at the start and once more before the commit (inside this
      // transaction, so a withdrawn permission or ended Session never commits the record); the
      // Payment owner reads in between, taken under the Order's refund fence, use the run's
      // no-query guard. No Provider is called.
      recorded = await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                "merchant.access",
                session.sessionReference,
              ).catch(denied);
              if ((await current.allowed()) !== true) return denied();
              const tx = businessTransaction(transaction);
              const scope = {
                tenantReference: String(current.selected.tenantReference),
                brandReference: String(current.context.brand.brandReference),
                storeReference: String(current.store.storeReference),
              };
              const actorReference = String(current.actorReference);
              const observedAt = String(current.context.resolvedAt);
              const configuration = await options.resolveConfiguration(tx, scope);
              const workforce = createMerchantWorkforcePermissionSource({
                resolveContext: async () => ({
                  tenantReference: scope.tenantReference,
                  context: current.context,
                }),
              });
              const role = createOrdinaryRefundRoleResolver(configuration.roleMapping);
              // Refund handlers only: a Manager who may request or an Owner/Finance member who
              // may approve (the same people who read refunds).
              const handler = async () =>
                (
                  await refundReadAccess(
                    workforce,
                    tx,
                    { ...scope, actorReference, observedAt },
                    role,
                    current.kdsOperatorProfileAllows,
                  )
                ).canRead;
              if (!(await handler())) return denied();
              return { current, tx, scope, actorReference, observedAt, configuration, handler };
            },
            recheck: async ({ current, handler }) =>
              (await current.allowed()) === true && (await handler()),
            denied,
          },
          async (authority) => {
            const { tx, scope, actorReference, observedAt, configuration } = authority.scope;
            const byOrder = async (
              _tx: ConsumerTransaction,
              query: { orderReference?: string; requestReference?: string },
            ) =>
              (query.orderReference === undefined ||
                query.orderReference === command.orderReference) &&
              (query.requestReference === undefined ||
                query.requestReference === command.requestReference) &&
              (await authority.guard());
            const cards = createPostgresCardMachinePaymentStore({
              scope,
              authorize: async (_tx, query) => byOrder(tx, query),
            });
            const reply = (
              status: CardMachineOrdinaryRefundResult["status"],
              refund: { amountMinor: bigint; refundedAt: string },
            ) =>
              Object.freeze({
                status,
                orderReference: command.orderReference,
                requestReference: command.requestReference,
                amountMinor: refund.amountMinor.toString(),
                refundedAt: String(refund.refundedAt),
              });
            const prior = await cards.loadRefundByOperation(tx, command.operationReference);
            if (prior !== null) {
              if (
                prior.intentDigest !== intentDigest ||
                prior.actorReference !== actorReference ||
                prior.sourceKind !== "OrdinaryRefund" ||
                prior.sourceReference !== command.requestReference
              )
                return fail("CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT");
              return reply("AlreadyRecorded", prior);
            }
            // The request, as recorded (history under the Order's refund fence), read at a time
            // taken once that fence is held: another request recorded for the Order meanwhile is
            // part of the history (v15 2026-10-18, dd750045).
            const historyObservedAt = await observeOrdinaryRefundOrderAfterFence(
              tx,
              scope,
              command.orderReference,
              observedAt,
              options.persistence.now,
            );
            const context = await createPostgresOrdinaryRefundRequestContextSource({
              scope,
              // Read-only: the Order's refund fence only (canonical lock order, Payment request store).
              fence: "OrderOnly",
              authorize: (t, query) => byOrder(t, query),
            })(tx, {
              orderReference: command.orderReference,
              operationReference: options.nextReference(),
              observedAt: historyObservedAt,
            });
            const request = context.history.find(
              (entry) => entry.requestReference === command.requestReference,
            );
            if (context.existing !== null || request === undefined)
              return fail("CARD_MACHINE_REFUND_NOT_FOUND");
            if (context.declines.has(request.requestReference))
              return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
            const leg = request.payments[0];
            if (
              leg === undefined ||
              request.payments.length !== 1 ||
              ordinaryRefundClaimKind(request) !== "Ordinary"
            )
              return fail("CARD_MACHINE_REFUND_NOT_FOUND");
            const payment = await cards.loadByIntent(tx, leg.paymentIntentReference);
            if (
              payment === null ||
              payment.orderReference !== command.orderReference ||
              payment.cardMachinePaymentReference !== leg.paymentTransactionReference
            )
              return fail("CARD_MACHINE_REFUND_NOT_FOUND");
            if (
              (await cards.loadRefundBySource(tx, "OrdinaryRefund", request.requestReference)) !==
              null
            )
              return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
            // The same escalation rules as the online first send, evaluated now: an escalated refund
            // needs its approval recorded before the machine refund is recorded.
            const escalation = await createPostgresOrdinaryRefundCurrentEscalationSource({
              scope,
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
              authorize: (t, query) => byOrder(t, query),
              businessDate: options.businessDate,
            })(tx, {
              orderReference: command.orderReference,
              requestReference: request.requestReference,
            });
            if (escalation.decision.requiresIndependentApproval) {
              const subject = await createPostgresOrdinaryRefundApprovalSubjectSource({
                scope,
                authorize: (t, query) => byOrder(t, query),
              })(tx, {
                orderReference: command.orderReference,
                requestReference: request.requestReference,
                observedAt: escalation.observedAt,
              });
              const read = createPostgresOrdinaryRefundApprovalReader({
                scope,
                authorize: (t, query) => byOrder(t, query),
              });
              let approved = false;
              for (const approvalReference of await listOrdinaryRefundApprovalReferences(
                tx,
                scope,
                {
                  orderReference: command.orderReference,
                  requestReference: request.requestReference,
                },
              )) {
                const stored = await read(tx, {
                  orderReference: command.orderReference,
                  approvalReference,
                  observedAt: escalation.observedAt,
                });
                if (
                  stored !== null &&
                  stored.approval.subject.requestReference === request.requestReference &&
                  stored.approval.subject.allocationDigest === subject.subject.allocationDigest &&
                  stored.approval.requesterReference === request.actorReference
                )
                  approved = true;
              }
              if (!approved) return fail("CARD_MACHINE_REFUND_APPROVAL_REQUIRED");
            }
            const amount = ordinaryRefundPaymentAmount(leg);
            const recordedAt = parsePaymentInstant(options.persistence.now());
            const refundedAt =
              command.refundedAt === null ? recordedAt : parsePaymentInstant(command.refundedAt);
            if (
              refundedAt > recordedAt ||
              refundedAt < request.requestedAt ||
              refundedAt < payment.takenAt ||
              Date.parse(recordedAt) - Date.parse(refundedAt) > cardMachineBackEntryWindowMs
            )
              return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
            const saved = await cards.recordRefund(
              tx,
              parseCardMachineRefundRecord({
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                cardMachineRefundReference: options.nextReference(),
                cardMachinePaymentReference: payment.cardMachinePaymentReference,
                orderReference: command.orderReference,
                operationReference: command.operationReference,
                intentDigest,
                sourceKind: "OrdinaryRefund",
                sourceReference: request.requestReference,
                amountMinor: amount,
                slipReference: command.slipReference,
                refundedAt,
                recordedAt,
                actorReference,
                auditReference: options.nextReference(),
              }),
            );
            return reply(saved.status === "Created" ? "Recorded" : "AlreadyRecorded", saved.refund);
          },
        ),
      );
    } catch (error) {
      if (error instanceof CardMachineRefundCommandError) throw error;
      if (error instanceof CardMachinePaymentError) {
        if (error.code === "CARD_MACHINE_IDEMPOTENCY_CONFLICT")
          return fail("CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT");
        if (error.code === "CARD_MACHINE_REFUND_EXCEEDS_PAYMENT")
          return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
        if (error.code === "CARD_MACHINE_PERMISSION_DENIED")
          return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
        if (error.code === "CARD_MACHINE_INPUT_INVALID")
          return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return fail("CARD_MACHINE_REFUND_UNAVAILABLE");
    }
    // The refund is committed; the receipt follows (a failure leaves it to the same retry).
    let receipt: CardMachineOrdinaryRefundResult["receipt"] = "NoDigitalReceipt";
    if (options.issueRefundReceipt !== undefined)
      try {
        receipt = await options.issueRefundReceipt({ orderReference: command.orderReference });
      } catch (error) {
        receipt = "NotIssued";
        try {
          options.onUnexpected?.(error);
        } catch {
          // Reporting never changes the answer.
        }
      }
    return Object.freeze({ ...recorded, receipt });
  };
}
