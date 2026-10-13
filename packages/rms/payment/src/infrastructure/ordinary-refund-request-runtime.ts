import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderRefundBasisReader } from "@rms/ordering";
import {
  allocateOrdinaryRefundFromQuote,
  createPostgresPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteHistoryReader,
} from "@rms/pricing";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import {
  parseOrdinaryRefundRequest,
  ordinaryRefundPaymentAmount,
  type OrdinaryRefundCancellationClaim,
} from "../application/ordinary-refund-request.js";
import {
  createPostgresOrdinaryRefundRequestContextSource,
  createPostgresOrdinaryRefundRequestStore,
} from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { createPostgresOrdinaryRefundPricingSource } from "./ordinary-refund-pricing-source.js";
import { createPostgresCapturedBatchPaymentSource } from "./persistence/captured-batch-payment-source.js";
import { createPostgresPaymentIntentCreationStore } from "./persistence/payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./persistence/payment-terminal-store.js";
import { evaluateOrdinaryRefundEscalation } from "../application/ordinary-refund-escalation.js";
import { ordinaryRefundClaimKind } from "../application/ordinary-refund-request.js";
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_REQUEST_UNAVAILABLE");
};
const ref = (value: unknown) => String(parsePaymentReference(value));
function selection(value: unknown) {
  const hasClaim =
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "claim");
  const hasNote =
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "note");
  const raw = exactPaymentObject(value, [
    ...(hasClaim ? ["claim"] : []),
    ...(hasNote ? ["note"] : []),
    "orderReference",
    "requestReference",
    "operationReference",
    "actorReference",
    "expectedClaimVersion",
    "reasonCode",
    "items",
  ]);
  if (
    typeof raw.expectedClaimVersion !== "number" ||
    !Number.isSafeInteger(raw.expectedClaimVersion) ||
    raw.expectedClaimVersion < 0 ||
    raw.expectedClaimVersion >= 1000 ||
    typeof raw.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > 1000
  )
    return fail();
  const items = raw.items.map((value: unknown) => {
    const item = exactPaymentObject(value, [
      "orderBatchReference",
      "orderItemReference",
      "quantity",
    ]);
    if (
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999
    )
      return fail();
    return Object.freeze({
      orderBatchReference: ref(item.orderBatchReference),
      orderItemReference: ref(item.orderItemReference),
      quantity: item.quantity,
    });
  });
  if (
    new Set(items.map((item) => item.orderItemReference)).size !== items.length ||
    new Set(items.map((item) => item.orderBatchReference)).size > 100
  )
    return fail();
  return Object.freeze({
    orderReference: ref(raw.orderReference),
    requestReference: ref(raw.requestReference),
    operationReference: ref(raw.operationReference),
    actorReference: ref(raw.actorReference),
    expectedClaimVersion: raw.expectedClaimVersion,
    reasonCode: raw.reasonCode,
    items: Object.freeze(items),
    claim: hasClaim ? cancellationClaim(raw.claim) : null,
    // WP-2423 Q5: a reason "Other" needs a short staff note; no other reason carries one.
    note: hasNote ? ordinaryRefundRequestNote(raw.note) : null,
  });
}
export function ordinaryRefundRequestNote(value: unknown): string {
  if (typeof value !== "string") return fail();
  const note = value.trim();
  if (note.length < 1 || [...note].length > 200 || /[\p{Cc}]/u.test(note)) return fail();
  return note;
}
function cancellationClaim(value: unknown): OrdinaryRefundCancellationClaim {
  const raw = exactPaymentObject(value, ["kind", "cancellationReference", "cancellationDigest"]);
  if (
    raw.kind !== "Cancellation" ||
    typeof raw.cancellationDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(raw.cancellationDigest)
  )
    return fail();
  return Object.freeze({
    kind: "Cancellation" as const,
    cancellationReference: ref(raw.cancellationReference),
    cancellationDigest: raw.cancellationDigest,
  });
}
type Intent = ReturnType<typeof selection>;
type Scope = Parameters<typeof createPostgresOrdinaryRefundCaptureSource>[0]["scope"];
/** Internal composition only. Caller supplies the authenticated requester and retains
 * current permission/role fences through commit. Does not approve or dispatch refunds. */
export function createPostgresOrdinaryRefundRequestRuntime(options: {
  scope: Scope;
  authorize(
    tx: ConsumerTransaction,
    query: Intent & Scope & { observedAt: string },
  ): Promise<boolean>;
  now(): string;
  newAuditReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
  /** WP-2423 Q5: Store Business Date port. When present the result says whether this request
   * needs independent approval (RF-D01–D03), evaluated on the same history as the claim. */
  businessDate?(
    tx: ConsumerTransaction,
    query: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      occurredAt: string;
    },
  ): Promise<string>;
}) {
  const scope = Object.freeze({
    tenantReference: ref(options.scope.tenantReference),
    brandReference: ref(options.scope.brandReference),
    storeReference: ref(options.scope.storeReference),
    providerAccountReference: ref(options.scope.providerAccountReference),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  const resolve = async (tx: ConsumerTransaction, value: unknown, preview: boolean) => {
    const intent = selection(value),
      observedAt = parsePaymentInstant(options.now());
    if (
      (intent.reasonCode === "OTHER") !== (intent.note !== null) ||
      (intent.note !== null && intent.claim !== null)
    )
      return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, { ...scope, ...intent, observedAt })) !== true)
        return fail();
      return true;
    };
    await authorize();
    const context = await createPostgresOrdinaryRefundRequestContextSource({ scope, authorize })(
      tx,
      {
        orderReference: intent.orderReference,
        operationReference: intent.operationReference,
        observedAt,
      },
    );
    const previous = context.existing;
    if (
      previous &&
      (previous.actorReference !== intent.actorReference ||
        previous.requestReference !== intent.requestReference ||
        previous.reasonCode !== intent.reasonCode ||
        previous.expectedClaimVersion !== intent.expectedClaimVersion ||
        JSON.stringify(previous.claim ?? null) !== JSON.stringify(intent.claim))
    )
      return fail();
    if (!previous && intent.expectedClaimVersion !== context.history.length) return fail();
    // WP-2423 Q5: declined requests stop occupying units; a replay reproduces the allocation
    // against what occupied the Order when the original request was appended.
    const history = previous
      ? context.occupyingBefore(previous.expectedClaimVersion + 1)
      : context.occupying;
    const requestedAt = previous?.requestedAt ?? observedAt;
    const ownerScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    };
    const paymentScope = {
      ...ownerScope,
      providerAccountReference: scope.providerAccountReference,
      environment: scope.environment,
    };
    const runner = { run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx) };
    const captures = createPostgresCapturedBatchPaymentSource({ scope, authorize });
    const creation = createPostgresPaymentIntentCreationStore(runner, ownerScope, {
      now: () => requestedAt,
      generateObservationReference: fail,
    });
    const terminalStore = createPostgresPaymentTerminalStore(runner, paymentScope);
    const basisReader = createPostgresOrderRefundBasisReader({ ...scope, authorize });
    const payments = [];
    for (const batch of [...new Set(intent.items.map((item) => item.orderBatchReference))].sort()) {
      const captured = await captures.load(tx, {
        orderReference: intent.orderReference,
        orderBatchReference: batch,
        observedAt: requestedAt,
      });
      if (!captured) return fail();
      const stored = await creation.resolveOperation(captured.paymentOperationReference);
      const terminal = await terminalStore.read(captured.paymentIntentReference);
      if (
        !stored ||
        !terminal ||
        terminal.outcome !== "Succeeded" ||
        terminal.paymentAttemptReference !== stored.attempt.paymentAttemptReference
      )
        return fail();
      const preparation = stored.intent.preparation;
      const basis = await basisReader.load(tx, {
        orderReference: intent.orderReference,
        orderBatchReference: batch,
        submissionReference: preparation.submissionReference,
        quoteReference: preparation.quoteReference,
        observedAt: requestedAt,
      });
      const quote = await (
        basis.quoteVersion === 2
          ? createPostgresConfiguredPriceQuoteHistoryReader(runner, ownerScope)
          : createPostgresPriceQuoteHistoryReader(runner, ownerScope)
      ).load(preparation.quoteReference);
      if (!quote) return fail();
      const selected = intent.items.filter((item) => item.orderBatchReference === batch);
      if (
        selected.some(
          (item) =>
            !basis.items.some((source) => source.orderItemReference === item.orderItemReference),
        )
      )
        return fail();
      const allocation = allocateOrdinaryRefundFromQuote(quote, {
        // Item cancellation refunds exclude tip: ordinary allocation with tip = 0.
        tipAmountMinor: intent.claim === null ? preparation.tip.amountMinor : 0n,
        items: basis.items.map((item) => ({
          orderItemReference: item.orderItemReference,
          quoteLineReference: item.quoteLineReference,
          quantity: item.quantity,
          occupiedUnitOrdinals: history.flatMap((request) =>
            request.payments.flatMap((payment) =>
              payment.items
                .filter((old) => old.orderItemReference === item.orderItemReference)
                .flatMap((old) => old.refundUnitOrdinals),
            ),
          ),
          refundQuantity:
            selected.find((pick) => pick.orderItemReference === item.orderItemReference)
              ?.quantity ?? 0,
        })),
      });
      payments.push({
        paymentTransactionReference: terminal.paymentTransactionReference,
        paymentIntentReference: terminal.paymentIntentReference,
        paymentAttemptReference: terminal.paymentAttemptReference,
        firstCaptureReference: terminal.observationReference,
        sourceReference: allocation.sourceReference,
        sourceDigest: allocation.sourceDigest,
        items: allocation.items
          .filter((item) => item.refundQuantity > 0)
          .map((item) => ({
            orderItemReference: item.orderItemReference,
            refundUnitOrdinals: item.refundUnitOrdinals,
            components: item.components,
          })),
      });
    }
    const request = parseOrdinaryRefundRequest({
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      orderReference: intent.orderReference,
      requestReference: intent.requestReference,
      operationReference: intent.operationReference,
      actorReference: intent.actorReference,
      expectedClaimVersion: intent.expectedClaimVersion,
      reasonCode: intent.reasonCode,
      auditReference: previous?.auditReference ?? ref(options.newAuditReference()),
      requestedAt,
      policyVersion: "PILOT_ORDINARY_REFUND_V1",
      allocationVersion: "ORDINARY_REFUND_ALLOCATION_V1",
      currencyCode: "CAD",
      amountMinor: payments.reduce(
        (sum, payment) => sum + ordinaryRefundPaymentAmount(payment),
        0n,
      ),
      payments,
      ...(intent.claim === null ? {} : { claim: intent.claim }),
    });
    const captureSource = createPostgresOrdinaryRefundCaptureSource({
      scope,
      now: options.now,
      authorize,
      validatePricing: createPostgresOrdinaryRefundPricingSource({ scope, authorize }),
    });
    const store = createPostgresOrdinaryRefundRequestStore({
      scope,
      authorize,
      validateSources: captureSource,
    });
    const result = await (
      preview
        ? store.preview
        : (tx2: ConsumerTransaction, value2: unknown, audit2: unknown) =>
            store.record(tx2, value2, audit2, intent.note)
    )(tx, request, {
      auditId: request.auditReference,
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: intent.actorReference },
      actionCode: "PAYMENT_ORDINARY_REFUND_REQUESTED",
      targetType: "PaymentRefundRequest",
      targetId: request.requestReference,
      correlationId: intent.operationReference,
      occurredAt: requestedAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Restricted",
      reasonCode: request.reasonCode,
      retentionPolicyCode: options.retentionPolicyCode,
      retentionPolicyVersion: options.retentionPolicyVersion,
    });
    const escalation =
      options.businessDate === undefined
        ? null
        : await (async () => {
            const businessDate = options.businessDate;
            if (businessDate === undefined) return fail();
            const captured = await captureSource(tx, { request, history });
            const at = (occurredAt: string) =>
              businessDate(tx, {
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                occurredAt,
              });
            const selectedCaptures = [];
            for (const leg of request.payments) {
              const match = captured.find(
                (entry) => entry.paymentAttemptReference === leg.paymentAttemptReference,
              );
              if (!match) return fail();
              selectedCaptures.push({
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                orderReference: intent.orderReference,
                paymentReference: leg.paymentAttemptReference,
                firstCaptureReference: leg.firstCaptureReference,
                firstCapturedAt: match.firstCapturedAt,
                businessDate: await at(match.firstCapturedAt),
              });
            }
            const decision = evaluateOrdinaryRefundEscalation({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              orderReference: intent.orderReference,
              requestReference: request.requestReference,
              observedAt,
              businessDate: await at(observedAt),
              selectedCaptures,
              claims: [...history, request].map((entry) => ({
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                orderReference: intent.orderReference,
                requestReference: entry.requestReference,
                kind: ordinaryRefundClaimKind(entry),
                status: "Requested",
                amountMinor: entry.amountMinor,
                currencyCode: entry.currencyCode,
                noProviderEffectReference: null,
              })),
              manualAllocationOverride: false,
            });
            return Object.freeze({
              requiresIndependentApproval: decision.requiresIndependentApproval,
              reasons: decision.reasons,
            });
          })();
    await authorize();
    return Object.freeze({ ...result, request, escalation });
  };
  const record = async (tx: ConsumerTransaction, value: unknown) => {
    const result = await resolve(tx, value, false);
    if (result.status === "Previewed") return fail();
    return result;
  };
  return Object.assign(record, {
    async preview(tx: ConsumerTransaction, value: unknown) {
      const result = await resolve(tx, value, true);
      if (result.status !== "Previewed") return fail();
      return result;
    },
  });
}
