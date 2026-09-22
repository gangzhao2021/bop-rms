import { createHash } from "node:crypto";
import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parseOrdinaryRefundDispatch } from "./ordinary-refund-dispatch.js";
import { createRefundPaymentRequest } from "./payment-provider-adapter.js";
import type { RefundPaymentRequest } from "../contracts/payment-provider-adapter.js";
import {
  createOrdinaryRefundObservation,
  encodeOrdinaryRefundObservation,
  parseOrdinaryRefundObservation,
} from "./ordinary-refund-observation.js";

const fail = (): never => {
  throw new Error("ORDINARY_REFUND_CONFIRMATION_HISTORY_INVALID");
};

/** Internal projection, not an evidence ingestion API. The owning reader must
 * supply the complete persisted history and authenticated recovered request.
 * Channel failed/canceled alone is deliberately not a local release proof. */
export function deriveOrdinaryRefundConfirmedPosition(value: unknown) {
  const raw = exactPaymentObject(value, ["dispatch", "request", "observations", "observedAt"]);
  const dispatch = parseOrdinaryRefundDispatch(raw.dispatch);
  const request = createRefundPaymentRequest(raw.request as RefundPaymentRequest);
  const observedAt = parsePaymentInstant(raw.observedAt);
  if (
    !Array.isArray(raw.observations) ||
    raw.observations.length > 1000 ||
    observedAt < dispatch.startedAt
  )
    return fail();
  // Validate the recovered dispatch/request even for an empty history.
  const digest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(request, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        ),
      )
      .digest("hex");
  if (
    digest !== dispatch.providerRequestDigest ||
    request.context.brandReference !== dispatch.brandReference ||
    request.context.storeReference !== dispatch.storeReference ||
    request.context.paymentAttemptReference !== dispatch.paymentAttemptReference ||
    request.context.operationReference !== dispatch.providerOperationReference
  )
    return fail();
  const records = new Map<string, ReturnType<typeof parseOrdinaryRefundObservation>>();
  const audits = new Set<string>();
  for (const value of raw.observations) {
    const stored = parseOrdinaryRefundObservation(value);
    const rebuilt = createOrdinaryRefundObservation({
      dispatch,
      request,
      outcome: stored.outcome,
      observationReference: stored.observationReference,
      auditReference: stored.auditReference,
      recordedAt: stored.recordedAt,
    });
    const encoded = encodeOrdinaryRefundObservation(stored);
    if (stored.recordedAt > observedAt || encoded !== encodeOrdinaryRefundObservation(rebuilt))
      return fail();
    const existing = records.get(stored.observationReference);
    if (existing) {
      if (encodeOrdinaryRefundObservation(existing) !== encoded) return fail();
      continue;
    }
    if (audits.has(stored.auditReference)) return fail();
    audits.add(stored.auditReference);
    records.set(stored.observationReference, stored);
  }
  const history = [...records.values()].sort(
    (a, b) =>
      a.recordedAt.localeCompare(b.recordedAt) ||
      a.observationReference.localeCompare(b.observationReference),
  );
  let providerRefundReference: string | null = null;
  let createdAt: string | null = null;
  let terminalStatus: string | null = null;
  let confirmedAt: string | null = null;
  for (const record of history) {
    const result = record.outcome;
    if (result.kind !== "RefundObservation") continue;
    if (
      providerRefundReference !== null &&
      (providerRefundReference !== result.providerRefundReference || createdAt !== result.createdAt)
    )
      return fail();
    providerRefundReference = result.providerRefundReference;
    createdAt = result.createdAt;
    if (
      result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "canceled"
    ) {
      if (terminalStatus !== null && terminalStatus !== result.status) return fail();
      terminalStatus = result.status;
    }
    if (result.status === "succeeded" && confirmedAt === null) confirmedAt = record.recordedAt;
  }
  return Object.freeze({
    state: confirmedAt === null ? ("NeedsReconciliation" as const) : ("Confirmed" as const),
    confirmedMinor: confirmedAt === null ? 0n : request.amount.amountMinor,
    pendingMinor: confirmedAt === null ? request.amount.amountMinor : 0n,
    releasedMinor: 0n,
    confirmedAt,
    // Provider creation and local confirmation are distinct instants.
    providerCreatedAt: confirmedAt === null ? null : createdAt,
    providerRefundReference,
    observationCount: history.length,
    historyDigest:
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify(
            {
              dispatch,
              request,
              observations: history.map(encodeOrdinaryRefundObservation),
            },
            (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
          ),
        )
        .digest("hex"),
  });
}
