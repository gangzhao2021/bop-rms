import { randomBytes } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderRefundBasisReader } from "@rms/ordering";
import type { RefundPaymentRequest } from "../contracts/payment-provider-adapter.js";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import {
  ordinaryRefundClaimKind,
  ordinaryRefundPaymentAmount,
  type OrdinaryRefundCancellationClaim,
  type OrdinaryRefundRequest,
} from "../application/ordinary-refund-request.js";
import type { OrdinaryRefundOperation } from "../application/ordinary-refund-operation.js";
import type { OrdinaryRefundCancellationAuthority } from "./ordinary-refund-operation-execution-source.js";
import { createPostgresOrdinaryRefundRequestRuntime } from "./ordinary-refund-request-runtime.js";
import { createPostgresOrdinaryRefundOperationRuntime } from "./ordinary-refund-operation-runtime.js";
import { createPostgresOrdinaryRefundPricingSource } from "./ordinary-refund-pricing-source.js";
import { createPostgresOrdinaryRefundSendRuntime } from "./ordinary-refund-send-runtime.js";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "./ordinary-refund-reconciliation-runtime.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import {
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundRequestContextSource,
} from "./persistence/ordinary-refund-request-store.js";
import {
  createPostgresOrdinaryRefundClaimOutcomeReader,
  createPostgresOrdinaryRefundDispatchReader,
  createPostgresOrdinaryRefundPreparedReader,
} from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresCapturedBatchPaymentSource } from "./persistence/captured-batch-payment-source.js";
import { createPostgresPaymentIntentCreationStore } from "./persistence/payment-intent-creation-store.js";

const fail = (code = "CANCELLATION_REFUND_UNAVAILABLE"): never => {
  throw new Error(code);
};
const ref = (value: unknown) => String(parsePaymentReference(value));

export interface CancellationRefundScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
}
/** Every query carries the Store scope; most carry orderReference and, after a
 * request exists, requestReference. The port must re-check the caller's current
 * cancellation authority (e.g. ordering.order.cancel) and return true only then. */
export interface CancellationRefundAuthorizeQuery {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference?: string;
  readonly requestReference?: string;
}
type BusinessDate = Parameters<
  typeof createPostgresOrdinaryRefundOperationRuntime
>[0]["businessDate"];
export interface CancellationRefundRuntimeOptions {
  readonly scope: CancellationRefundScope;
  authorize(tx: ConsumerTransaction, query: CancellationRefundAuthorizeQuery): Promise<boolean>;
  /** Verifies the Ordering item-cancellation record binds exactly this refund request. */
  readonly cancellationAuthority: OrdinaryRefundCancellationAuthority;
  readonly businessDate: BusinessDate;
  now(): string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}
export interface CancellationRefundPreviewInput {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReferences: readonly string[];
  readonly actorReference: string;
  readonly reasonCode: string;
}
export interface CancellationRefundRecordInput extends CancellationRefundPreviewInput {
  readonly requestReference: string;
  readonly requestOperationReference: string;
  readonly refundOperationReference: string;
  readonly requestAuditReference: string;
  readonly operationAuditReference: string;
  readonly cancellationReference: string;
  readonly cancellationDigest: string;
}
export interface CancellationRefundComponents {
  readonly netAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
  readonly tipAmountMinor: bigint;
  readonly serviceChargeAmountMinor: bigint;
  readonly serviceChargeTaxAmountMinor: bigint;
}
export interface CancellationRefundPreview {
  readonly amountMinor: bigint;
  readonly components: CancellationRefundComponents;
  readonly items: readonly {
    readonly orderItemReference: string;
    readonly refundUnitOrdinals: readonly number[];
    readonly components: CancellationRefundComponents;
    readonly amountMinor: bigint;
  }[];
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
}
export interface CancellationRefundRecordResult {
  readonly status: "Created" | "AlreadyCommitted";
  readonly request: OrdinaryRefundRequest;
  readonly operation: OrdinaryRefundOperation;
  readonly amountMinor: bigint;
}
export type CancellationRefundStatus = "Pending" | "Refunded" | "Failed";

function normalizeScope(value: CancellationRefundScope): CancellationRefundScope {
  const scope = Object.freeze({
    tenantReference: ref(value.tenantReference),
    brandReference: ref(value.brandReference),
    storeReference: ref(value.storeReference),
    providerAccountReference: ref(value.providerAccountReference),
    environment: value.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  return scope;
}
function previewInput(value: unknown, extra: readonly string[] = []) {
  try {
    return parsePreviewInput(value, extra);
  } catch {
    return fail("CANCELLATION_REFUND_INPUT_INVALID");
  }
}
function parsePreviewInput(value: unknown, extra: readonly string[]) {
  const raw = exactPaymentObject(value, [
    "orderReference",
    "orderBatchReference",
    "orderItemReferences",
    "actorReference",
    "reasonCode",
    ...extra,
  ]);
  if (
    typeof raw.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
    !Array.isArray(raw.orderItemReferences) ||
    raw.orderItemReferences.length < 1 ||
    raw.orderItemReferences.length > 1000
  )
    return fail("CANCELLATION_REFUND_INPUT_INVALID");
  const items = (raw.orderItemReferences as unknown[]).map(ref).sort();
  if (new Set(items).size !== items.length) return fail("CANCELLATION_REFUND_INPUT_INVALID");
  return {
    raw,
    input: Object.freeze({
      orderReference: ref(raw.orderReference),
      orderBatchReference: ref(raw.orderBatchReference),
      orderItemReferences: Object.freeze(items),
      actorReference: ref(raw.actorReference),
      reasonCode: raw.reasonCode,
    }),
  };
}
function cancellationClaim(reference: unknown, digest: unknown): OrdinaryRefundCancellationClaim {
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    return fail("CANCELLATION_REFUND_INPUT_INVALID");
  return Object.freeze({
    kind: "Cancellation" as const,
    cancellationReference: ref(reference),
    cancellationDigest: digest,
  });
}
/** Throwaway identity for no-write previews only; never persisted. */
function ephemeralReference(): string {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
async function databaseNow(tx: ConsumerTransaction) {
  const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
  if (clock.rows.length !== 1) return fail();
  const time = clock.rows[0]?.now;
  return parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
}
function zeroComponents(): Record<keyof CancellationRefundComponents, bigint> {
  return {
    netAmountMinor: 0n,
    taxAmountMinor: 0n,
    tipAmountMinor: 0n,
    serviceChargeAmountMinor: 0n,
    serviceChargeTaxAmountMinor: 0n,
  };
}
function summarize(request: OrdinaryRefundRequest): CancellationRefundPreview {
  const payment = request.payments[0];
  if (request.payments.length !== 1 || !payment) return fail();
  const total = zeroComponents();
  const items = payment.items.map((item) => {
    for (const key of Object.keys(total) as (keyof CancellationRefundComponents)[])
      total[key] += item.components[key];
    return Object.freeze({
      orderItemReference: item.orderItemReference,
      refundUnitOrdinals: item.refundUnitOrdinals,
      components: item.components,
      amountMinor: Object.values(item.components).reduce((sum, part) => sum + part, 0n),
    });
  });
  return Object.freeze({
    amountMinor: request.amountMinor,
    components: Object.freeze(total),
    items: Object.freeze(items),
    paymentTransactionReference: payment.paymentTransactionReference,
    paymentIntentReference: payment.paymentIntentReference,
    paymentAttemptReference: payment.paymentAttemptReference,
  });
}

function operationOptions(
  options: CancellationRefundRuntimeOptions,
  scope: CancellationRefundScope,
) {
  const ownerScope = {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const denied = (): never => {
    // Ordinary requester/executor/approver authority is never available here.
    throw new Error("CANCELLATION_REFUND_ORDINARY_AUTHORITY_UNAVAILABLE");
  };
  return {
    scope: ownerScope,
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
    authorize: (tx: ConsumerTransaction, query: CancellationRefundAuthorizeQuery) =>
      options.authorize(tx, query),
    validatePricing: createPostgresOrdinaryRefundPricingSource({
      scope: ownerScope,
      authorize: (tx, request) => options.authorize(tx, request),
    }),
    executor: async () => denied(),
    authority: async () => denied(),
    businessDate: options.businessDate,
    cancellationAuthority: options.cancellationAuthority,
  };
}

/** In-transaction Payment side of a staff item cancellation. The caller owns the
 * transaction and writes the Ordering cancellation record first; the refund goes
 * through the ordinary refund pipeline as a Cancellation claim (tip excluded,
 * no ordinary escalation, authorized by the cancellation record). No Provider I/O. */
export function createPostgresCancellationRefundRuntime(options: CancellationRefundRuntimeOptions) {
  const scope = normalizeScope(options.scope);
  if (
    typeof options.cancellationAuthority !== "function" ||
    typeof options.authorize !== "function" ||
    typeof options.businessDate !== "function"
  )
    return fail();
  const runner = (tx: ConsumerTransaction) => ({
    run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
  });
  /** Full original quantity of each selected line in the batch. */
  const lineQuantities = async (
    tx: ConsumerTransaction,
    input: CancellationRefundPreviewInput,
    observedAt: string,
  ) => {
    const query = {
      ...scope,
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
    };
    const allowed = async () => (await options.authorize(tx, query)) === true;
    if (!(await allowed())) return fail("CANCELLATION_REFUND_PERMISSION_DENIED");
    const ownerScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    };
    const captured = await createPostgresCapturedBatchPaymentSource({
      scope,
      authorize: allowed,
    }).load(tx, {
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
      observedAt,
    });
    if (!captured) return fail("CANCELLATION_REFUND_PAYMENT_UNAVAILABLE");
    const stored = await createPostgresPaymentIntentCreationStore(runner(tx), ownerScope, {
      now: () => observedAt,
      generateObservationReference: fail,
    }).resolveOperation(captured.paymentOperationReference);
    if (!stored) return fail("CANCELLATION_REFUND_PAYMENT_UNAVAILABLE");
    const preparation = stored.intent.preparation;
    const basis = await createPostgresOrderRefundBasisReader({
      ...ownerScope,
      authorize: allowed,
    }).load(tx, {
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
      submissionReference: preparation.submissionReference,
      quoteReference: preparation.quoteReference,
      observedAt,
    });
    return input.orderItemReferences.map((orderItemReference) => {
      const line = basis.items.find((item) => item.orderItemReference === orderItemReference);
      if (!line) return fail("CANCELLATION_REFUND_LINE_UNAVAILABLE");
      return Object.freeze({
        orderBatchReference: input.orderBatchReference,
        orderItemReference,
        quantity: line.quantity,
      });
    });
  };
  const requestRuntime = (newAuditReference: () => string) =>
    createPostgresOrdinaryRefundRequestRuntime({
      scope,
      authorize: (tx, query) => options.authorize(tx, query),
      now: options.now,
      newAuditReference,
      retentionPolicyCode: options.retentionPolicyCode,
      retentionPolicyVersion: options.retentionPolicyVersion,
    });
  const context = createPostgresOrdinaryRefundRequestContextSource({
    scope,
    authorize: (tx, query) => options.authorize(tx, query),
  });
  const refuseOccupied = (
    history: readonly OrdinaryRefundRequest[],
    input: CancellationRefundPreviewInput,
  ) => {
    // A line already (partly) refunded must go through ordinary refund instead.
    for (const prior of history)
      for (const payment of prior.payments)
        for (const item of payment.items)
          if (input.orderItemReferences.includes(item.orderItemReference))
            return fail("CANCELLATION_REFUND_LINE_ALREADY_REFUNDED");
  };
  const operationRuntime = createPostgresOrdinaryRefundOperationRuntime(
    operationOptions(options, scope),
  );
  const readPrepared = createPostgresOrdinaryRefundPreparedReader({
    scope: operationOptions(options, scope).scope,
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
    authorize: (tx, query) => options.authorize(tx, query),
  });
  return Object.freeze({
    /** No writes. Refunds every unit of each selected line, tip excluded. */
    async preview(tx: ConsumerTransaction, value: CancellationRefundPreviewInput) {
      const { input } = previewInput(value);
      const observedAt = parsePaymentInstant(options.now());
      const operationReference = ephemeralReference();
      const current = await context(tx, {
        orderReference: input.orderReference,
        operationReference,
        observedAt,
      });
      if (current.existing) return fail();
      refuseOccupied(current.history, input);
      const items = await lineQuantities(tx, input, observedAt);
      const result = await requestRuntime(ephemeralReference).preview(tx, {
        orderReference: input.orderReference,
        requestReference: ephemeralReference(),
        operationReference,
        actorReference: input.actorReference,
        expectedClaimVersion: current.history.length,
        reasonCode: input.reasonCode,
        items,
        // Placeholder binding: only selects the Cancellation allocation (tip = 0).
        claim: cancellationClaim(ephemeralReference(), "sha256:" + "0".repeat(64)),
      });
      return summarize(result.request);
    },
    /** Records the Cancellation request and its prepared refund operation in the
     * caller's transaction; the dispatch/send machinery sends it after commit. */
    async record(
      tx: ConsumerTransaction,
      value: CancellationRefundRecordInput,
    ): Promise<CancellationRefundRecordResult> {
      const identities = [
        "requestReference",
        "requestOperationReference",
        "refundOperationReference",
        "requestAuditReference",
        "operationAuditReference",
        "cancellationReference",
        "cancellationDigest",
      ] as const;
      const { raw, input } = previewInput(value, identities);
      const parsed = (() => {
        try {
          return {
            ids: {
              requestReference: ref(raw.requestReference),
              requestOperationReference: ref(raw.requestOperationReference),
              refundOperationReference: ref(raw.refundOperationReference),
              requestAuditReference: ref(raw.requestAuditReference),
              operationAuditReference: ref(raw.operationAuditReference),
            },
            claim: cancellationClaim(raw.cancellationReference, raw.cancellationDigest),
          };
        } catch {
          return fail("CANCELLATION_REFUND_INPUT_INVALID");
        }
      })();
      const { ids, claim } = parsed;
      const observedAt = parsePaymentInstant(options.now());
      const current = await context(tx, {
        orderReference: input.orderReference,
        operationReference: ids.requestOperationReference,
        observedAt,
      });
      const previous = current.existing;
      if (previous) {
        if (
          previous.requestReference !== ids.requestReference ||
          previous.actorReference !== input.actorReference ||
          previous.claim?.cancellationReference !== claim.cancellationReference ||
          previous.claim.cancellationDigest !== claim.cancellationDigest ||
          previous.payments
            .flatMap((payment) => payment.items.map((item) => item.orderItemReference))
            .sort()
            .join(",") !== input.orderItemReferences.join(",")
        )
          return fail("CANCELLATION_REFUND_REPLAY_CONFLICT");
      } else refuseOccupied(current.history, input);
      const requestedAt = previous?.requestedAt ?? observedAt;
      const items = await lineQuantities(tx, input, requestedAt);
      const requested = await requestRuntime(() => ids.requestAuditReference)(tx, {
        orderReference: input.orderReference,
        requestReference: ids.requestReference,
        operationReference: ids.requestOperationReference,
        actorReference: input.actorReference,
        expectedClaimVersion: previous?.expectedClaimVersion ?? current.history.length,
        reasonCode: input.reasonCode,
        items,
        claim,
      });
      const request = requested.request;
      const payment = request.payments[0];
      if (ordinaryRefundClaimKind(request) !== "Cancellation" || !payment) return fail();
      const prepared = await operationRuntime.prepareAndRecord(
        tx,
        {
          orderReference: input.orderReference,
          requestReference: ids.requestReference,
          paymentAttemptReference: payment.paymentAttemptReference,
          operationReference: ids.refundOperationReference,
          providerOperationReference: ids.refundOperationReference,
          executorReference: input.actorReference,
          auditReference: ids.operationAuditReference,
          approvalReference: null,
        },
        {
          reasonCode: request.reasonCode,
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        },
      );
      const operation = await readPrepared(tx, {
        orderReference: input.orderReference,
        requestReference: ids.requestReference,
        paymentAttemptReference: payment.paymentAttemptReference,
        observedAt: await databaseNow(tx),
      });
      if (
        !operation ||
        operation.operationReference !== ids.refundOperationReference ||
        operation.approvalReference !== null ||
        operation.executorReference !== request.actorReference ||
        operation.amountMinor !== ordinaryRefundPaymentAmount(payment)
      )
        return fail();
      return Object.freeze({
        status:
          requested.status === "Created" || prepared.status === "Created"
            ? ("Created" as const)
            : ("AlreadyCommitted" as const),
        request,
        operation,
        amountMinor: request.amountMinor,
      });
    },
  });
}

/** Read the Payment outcome of one Cancellation request. No Provider I/O.
 * Failed means the Provider reported failed/canceled: the amount stays occupied
 * and needs staff follow-up; it is never silently released. */
export async function readCancellationRefundStatus(
  tx: ConsumerTransaction,
  value: {
    readonly scope: CancellationRefundScope;
    readonly orderReference: string;
    readonly requestReference: string;
    authorize(tx: ConsumerTransaction, query: CancellationRefundAuthorizeQuery): Promise<boolean>;
  },
): Promise<{
  readonly status: CancellationRefundStatus;
  readonly amountMinor: bigint;
  readonly confirmedMinor: bigint;
}> {
  const scope = normalizeScope(value.scope);
  const ownerScope = {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const orderReference = ref(value.orderReference);
  const requestReference = ref(value.requestReference);
  const query = { ...ownerScope, orderReference, requestReference };
  const allowed = async () => (await value.authorize(tx, query)) === true;
  const observedAt = await databaseNow(tx);
  const current = await createPostgresOrdinaryRefundApprovalSubjectSource({
    scope: ownerScope,
    authorize: allowed,
  })(tx, { orderReference, requestReference, observedAt });
  const request = current.request;
  if (ordinaryRefundClaimKind(request) !== "Cancellation") return fail();
  const recover = createPostgresOrdinaryRefundRecoverySource({
    scope: ownerScope,
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
    authorize: allowed,
  });
  const read = createPostgresOrdinaryRefundClaimOutcomeReader({
    scope: ownerScope,
    authorize: allowed,
    recover,
  });
  let status: CancellationRefundStatus = "Refunded";
  let confirmedMinor = 0n;
  for (const payment of request.payments) {
    const result = await read(tx, {
      orderReference,
      requestReference,
      paymentAttemptReference: payment.paymentAttemptReference,
      observedAt,
    });
    if (
      result &&
      (result.operation.amountMinor !== ordinaryRefundPaymentAmount(payment) ||
        result.operation.providerAccountReference !== scope.providerAccountReference ||
        result.operation.environment !== scope.environment)
    )
      return fail();
    confirmedMinor += result?.position.confirmedMinor ?? 0n;
    const leg: CancellationRefundStatus =
      result?.position.state === "Confirmed"
        ? "Refunded"
        : result?.position.providerTerminalStatus === "failed" ||
            result?.position.providerTerminalStatus === "canceled"
          ? "Failed"
          : "Pending";
    if (leg === "Failed") status = "Failed";
    else if (leg === "Pending" && status === "Refunded") status = "Pending";
  }
  if (!(await allowed())) return fail("CANCELLATION_REFUND_PERMISSION_DENIED");
  return Object.freeze({ status, amountMinor: request.amountMinor, confirmedMinor });
}

/** After-commit driver: first dispatch through the committed journal (never a
 * second submit), otherwise query-only reconciliation. Reuses ordinary runtimes. */
export function createPostgresCancellationRefundFollowUp(
  options: CancellationRefundRuntimeOptions & {
    readonly transactions: {
      run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T>;
    };
    readonly provider: {
      refundPayment(request: RefundPaymentRequest): Promise<unknown>;
      lookupRefund(request: RefundPaymentRequest): Promise<unknown>;
    };
    generateObservationIdentity(): { observationReference: string; auditReference: string };
    dispatchIdentity(): { dispatchReference: string; auditReference: string };
  },
) {
  const scope = normalizeScope(options.scope);
  const dispatchOptions = operationOptions(options, scope);
  const authorize = (tx: ConsumerTransaction, query: CancellationRefundAuthorizeQuery) =>
    options.authorize(tx, query);
  const send = createPostgresOrdinaryRefundSendRuntime({
    dispatch: dispatchOptions,
    authorizeRecovery: authorize,
    transactions: options.transactions,
    provider: options.provider,
    generateObservationIdentity: () => options.generateObservationIdentity(),
  });
  const reconcile = createPostgresOrdinaryRefundReconciliationRuntime({
    scope: dispatchOptions.scope,
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
    authorize,
    transactions: options.transactions,
    provider: options.provider,
  });
  const dispatched = createPostgresOrdinaryRefundDispatchReader({
    scope: dispatchOptions.scope,
    authorize,
  });
  const status = (tx: ConsumerTransaction, orderReference: string, requestReference: string) =>
    readCancellationRefundStatus(tx, {
      scope,
      orderReference,
      requestReference,
      authorize,
    });
  return Object.freeze({
    async drive(value: {
      readonly orderReference: string;
      readonly requestReference: string;
      readonly operationReference: string;
    }): Promise<{ readonly status: CancellationRefundStatus; readonly amountMinor: bigint }> {
      const raw = exactPaymentObject(value, [
        "orderReference",
        "requestReference",
        "operationReference",
      ]);
      const orderReference = ref(raw.orderReference);
      const requestReference = ref(raw.requestReference);
      const operationReference = ref(raw.operationReference);
      const before = await options.transactions.run(async (tx) => {
        const journal = await dispatched(tx, { orderReference, operationReference });
        if (journal && journal.operation.requestReference !== requestReference) return fail();
        const subject = await createPostgresOrdinaryRefundApprovalSubjectSource({
          scope: dispatchOptions.scope,
          authorize,
        })(tx, { orderReference, requestReference, observedAt: await databaseNow(tx) });
        if (ordinaryRefundClaimKind(subject.request) !== "Cancellation") return fail();
        return {
          journaled: journal !== null,
          reasonCode: subject.request.reasonCode,
          current: await status(tx, orderReference, requestReference),
        };
      });
      if (!before.journaled) {
        const identity = exactPaymentObject(options.dispatchIdentity(), [
          "dispatchReference",
          "auditReference",
        ]);
        await send(
          {
            orderReference,
            requestReference,
            operationReference,
            dispatchReference: ref(identity.dispatchReference),
            auditReference: ref(identity.auditReference),
            approvalReference: null,
          },
          {
            reasonCode: before.reasonCode,
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          },
        );
      } else if (before.current.status === "Pending") {
        const identity = exactPaymentObject(options.generateObservationIdentity(), [
          "observationReference",
          "auditReference",
        ]);
        await reconcile({
          orderReference,
          operationReference,
          observationReference: ref(identity.observationReference),
          auditReference: ref(identity.auditReference),
        });
      } else
        return Object.freeze({
          status: before.current.status,
          amountMinor: before.current.amountMinor,
        });
      const after = await options.transactions.run((tx) =>
        status(tx, orderReference, requestReference),
      );
      return Object.freeze({ status: after.status, amountMinor: after.amountMinor });
    },
  });
}
