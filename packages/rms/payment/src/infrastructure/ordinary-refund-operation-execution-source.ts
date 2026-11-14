import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrdinaryRefundOperation } from "../application/ordinary-refund-operation.js";
import { assertOrdinaryRefundExecutor } from "../application/ordinary-refund-executor.js";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";
import {
  ordinaryRefundClaimKind,
  type OrdinaryRefundRequest,
} from "../application/ordinary-refund-request.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { createPostgresOrdinaryRefundExecutionBalanceSource } from "./persistence/ordinary-refund-request-store.js";

type CaptureOptions = Parameters<typeof createPostgresOrdinaryRefundCaptureSource>[0];
type ExecutorQuery = Pick<
  CaptureOptions["scope"],
  "tenantReference" | "brandReference" | "storeReference"
> & {
  readonly orderReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
};
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_EXECUTION_SOURCE_UNAVAILABLE");
};

/** Query for the cancellation authority port. The composition root must verify
 * that the Ordering item-cancellation record binds exactly this refund request. */
export interface OrdinaryRefundCancellationAuthorityQuery {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly requestReference: string;
  readonly cancellationReference: string;
  readonly cancellationDigest: string;
  readonly actorReference: string;
  readonly amountMinor: bigint;
  readonly observedAt: string;
}
export type OrdinaryRefundCancellationAuthority = (
  tx: ConsumerTransaction,
  query: OrdinaryRefundCancellationAuthorityQuery,
) => Promise<boolean>;

/** Cancellation claims are auto-approved by their Ordering cancellation record:
 * no requester/executor role or independent approver. Fails closed without the port. */
export async function assertOrdinaryRefundCancellationAuthority(
  tx: ConsumerTransaction,
  port: OrdinaryRefundCancellationAuthority | undefined,
  request: OrdinaryRefundRequest,
  observedAt: string,
): Promise<void> {
  const claim = request.claim;
  if (claim === undefined || typeof port !== "function") return denied();
  const allowed = await port(tx, {
    tenantReference: request.tenantReference,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
    orderReference: request.orderReference,
    requestReference: request.requestReference,
    cancellationReference: claim.cancellationReference,
    cancellationDigest: claim.cancellationDigest,
    actorReference: request.actorReference,
    amountMinor: request.amountMinor,
    observedAt,
  });
  if (allowed !== true) return denied();
}
const denied = (): never => {
  throw new Error("ORDINARY_REFUND_CANCELLATION_AUTHORITY_DENIED");
};

/** Actual original capture/Pricing/current occupancy and executor source.
 * Caller retains the transaction fences. Escalation and independent approval
 * are separate mandatory gates; this result never authorizes Provider I/O. */
export function createPostgresOrdinaryRefundOperationExecutionSource(
  options: Omit<CaptureOptions, "now"> & {
    executor(tx: ConsumerTransaction, query: ExecutorQuery): Promise<unknown>;
    /** Mandatory for Cancellation claims; absent means those claims fail closed. */
    cancellationAuthority?: OrdinaryRefundCancellationAuthority;
  },
) {
  return async (tx: ConsumerTransaction, value: unknown, at: string) => {
    const operation = parseOrdinaryRefundOperation(value);
    const observedAt = parsePaymentInstant(at);
    if (
      operation.preparedAt > observedAt ||
      operation.tenantReference !== options.scope.tenantReference ||
      operation.brandReference !== options.scope.brandReference ||
      operation.storeReference !== options.scope.storeReference ||
      operation.providerAccountReference !== options.scope.providerAccountReference ||
      operation.environment !== options.scope.environment
    )
      return fail();
    const current = await createPostgresOrdinaryRefundExecutionBalanceSource({
      scope: options.scope,
      authorize: options.authorize,
      validateSources: createPostgresOrdinaryRefundCaptureSource({
        ...options,
        now: () => observedAt,
      }),
    })(tx, {
      orderReference: operation.orderReference,
      requestReference: operation.requestReference,
    });
    if (observedAt > current.observedAt || current.claimVersion !== operation.claimVersion)
      return fail();
    const leg = current.request.payments.find(
      (p) => p.paymentAttemptReference === operation.paymentAttemptReference,
    );
    const position = current.positions.find(
      (p) => p.paymentAttemptReference === operation.paymentAttemptReference,
    );
    if (
      !leg ||
      !position ||
      leg.paymentTransactionReference !== operation.paymentTransactionReference ||
      leg.paymentIntentReference !== operation.paymentIntentReference ||
      leg.firstCaptureReference !== operation.firstCaptureReference ||
      position.requestAmountMinor !== operation.amountMinor
    )
      return fail();
    if (ordinaryRefundClaimKind(current.request) === "Cancellation") {
      // Executor is the cancelling actor; there is never an independent approval.
      if (
        operation.executorReference !== current.request.actorReference ||
        operation.approvalReference !== null
      )
        return fail();
      await assertOrdinaryRefundCancellationAuthority(
        tx,
        options.cancellationAuthority,
        current.request,
        current.observedAt,
      );
      return Object.freeze({
        position,
        observedAt: current.observedAt,
        claimVersion: current.claimVersion,
      });
    }
    const expected = {
      tenantReference: operation.tenantReference,
      brandReference: operation.brandReference,
      storeReference: operation.storeReference,
      orderReference: operation.orderReference,
      actorReference: operation.executorReference,
    };
    assertOrdinaryRefundExecutor({
      expected,
      observedAt: current.observedAt,
      authority: await options.executor(tx, { ...expected, observedAt: current.observedAt }),
    });
    return Object.freeze({
      position,
      observedAt: current.observedAt,
      claimVersion: current.claimVersion,
    });
  };
}
