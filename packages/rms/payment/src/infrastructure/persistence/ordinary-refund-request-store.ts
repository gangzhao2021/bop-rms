import { evaluateOrdinaryRefundEscalation } from "../../application/ordinary-refund-escalation.js";
import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  decodeOrdinaryRefundRequest,
  encodeOrdinaryRefundRequest,
  ordinaryRefundClaimKind,
  ordinaryRefundPaymentAmount,
  parseOrdinaryRefundRequest,
  type OrdinaryRefundRequest,
} from "../../application/ordinary-refund-request.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
const fail = (code = "ORDINARY_REFUND_REQUEST_CONFLICT"): never => {
  throw new Error(code);
};
type Scope = Pick<OrdinaryRefundRequest, "tenantReference" | "brandReference" | "storeReference">;
const sameScope = (a: Scope, b: Scope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.storeReference === b.storeReference;

async function loadRequestHistory(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
  observedAt: string,
) {
  const records = await tx.query(
    "SELECT claim_version::text AS version,record_json::text AS record FROM rms_payment.ordinary_refund_request " +
      "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY claim_version LIMIT 1001",
    [scope.brandReference, scope.storeReference, orderReference],
  );
  if (records.rows.length > 1000) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  return Object.freeze(
    records.rows.map((row, index) => {
      const prior = decodeOrdinaryRefundRequest(row.record);
      if (
        row.version !== String(index + 1) ||
        prior.expectedClaimVersion !== index ||
        !sameScope(scope, prior) ||
        prior.orderReference !== orderReference ||
        prior.requestedAt > observedAt
      )
        return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
      return prior;
    }),
  );
}

/** WP-2423 Q5: durable no-Provider-effect declines of this Order's requests (RF-D04).
 * claimCount: how many requests the Order had when the request was declined. */
export interface OrdinaryRefundDecline {
  readonly declineReference: string;
  readonly requestReference: string;
  readonly declinerReference: string;
  readonly reasonCode: string;
  readonly declinedAt: string;
  readonly claimCount: number;
}
async function loadRequestDeclines(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
  history: readonly OrdinaryRefundRequest[],
  observedAt: string,
): Promise<ReadonlyMap<string, OrdinaryRefundDecline>> {
  const records = await tx.query(
    "SELECT decline_id::text AS decline,request_id::text AS request,requester_id::text AS requester,decliner_id::text AS decliner,reason_code,claim_count::text AS claims,declined_at FROM rms_payment.ordinary_refund_decline " +
      "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY claim_count,decline_id LIMIT 1001",
    [scope.brandReference, scope.storeReference, orderReference],
  );
  if (records.rows.length > 1000) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  const declines = new Map<string, OrdinaryRefundDecline>();
  for (const row of records.rows) {
    const requestReference = String(parsePaymentReference(row.request));
    const index = history.findIndex((entry) => entry.requestReference === requestReference);
    const request = history[index];
    const claimCount = Number(row.claims);
    const at = row.declined_at;
    const declinedAt = parsePaymentInstant(at instanceof Date ? at.toISOString() : at);
    if (
      !request ||
      declines.has(requestReference) ||
      ordinaryRefundClaimKind(request) !== "Ordinary" ||
      String(parsePaymentReference(row.requester)) !== request.actorReference ||
      !Number.isSafeInteger(claimCount) ||
      claimCount <= index ||
      claimCount > history.length ||
      declinedAt < request.requestedAt ||
      declinedAt > observedAt ||
      typeof row.reason_code !== "string"
    )
      return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    declines.set(
      requestReference,
      Object.freeze({
        declineReference: String(parsePaymentReference(row.decline)),
        requestReference,
        declinerReference: String(parsePaymentReference(row.decliner)),
        reasonCode: row.reason_code,
        declinedAt,
        claimCount,
      }),
    );
  }
  return declines;
}
/** Requests that occupied the Order when the request with claim version `version` was
 * appended (a request declined before that no longer occupied anything); for the current
 * position pass Infinity. Declines never change claim versions. */
function occupyingAt(
  history: readonly OrdinaryRefundRequest[],
  declines: ReadonlyMap<string, OrdinaryRefundDecline>,
  version: number,
): readonly OrdinaryRefundRequest[] {
  return Object.freeze(
    history.slice(0, Number.isFinite(version) ? version - 1 : history.length).filter((entry) => {
      const decline = declines.get(entry.requestReference);
      return decline === undefined || decline.claimCount >= version;
    }),
  );
}

/**
 * Canonical advisory-lock order for refund requests (v15 2026-10-17, 40P01):
 *   1. `OrdinaryRefundRequest:<brand>:<store>:<request operation>` — only when appending (or
 *      replaying) that request operation;
 *   2. `PaymentReceiptOrder:<brand>:<store>:<order>` — the Order's refund fence.
 * A transaction never requests a request-operation fence while it holds the Order fence. Every
 * request append takes the Order fence before it writes, so a read-only path (request status,
 * the refund item list, progress, recording a card-machine refund) takes the Order fence alone
 * (`fence: "OrderOnly"`) and still sees a stable request set; it may then read any number of
 * requests of that Order without taking a request-operation fence after the Order fence.
 */
export async function acquireOrdinaryRefundRequestFences(
  tx: ConsumerTransaction,
  scope: Pick<Scope, "brandReference" | "storeReference">,
  operationReference: string | null,
  orderReference: string,
): Promise<void> {
  const prefix = scope.brandReference + ":" + scope.storeReference + ":";
  if (operationReference !== null)
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrdinaryRefundRequest:" + prefix + operationReference,
    ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "PaymentReceiptOrder:" + prefix + orderReference,
  ]);
}

interface RequestContextQuery {
  readonly orderReference: string;
  readonly operationReference: string;
  readonly observedAt: string;
}

/** Internal request composition input. Retain the caller transaction through
 * allocation and record; never expose immutable financial history directly to a browser.
 * Replays must retain the original request clock/audit and compare the original intent.
 */
export function createPostgresOrdinaryRefundRequestContextSource(options: {
  readonly scope: Scope;
  /** "OrderOnly" for read-only callers that never append this operation; see
   * acquireOrdinaryRefundRequestFences for the canonical lock order. */
  readonly fence?: "RequestOperationAndOrder" | "OrderOnly";
  readonly authorize: (
    tx: ConsumerTransaction,
    query: RequestContextQuery & Scope,
  ) => Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const orderOnly = options.fence === "OrderOnly";
  if (!orderOnly && options.fence !== undefined && options.fence !== "RequestOperationAndOrder")
    return fail();
  return async (tx: ConsumerTransaction, value: RequestContextQuery) => {
    const raw = exactPaymentObject(value, ["orderReference", "operationReference", "observedAt"]);
    const query = Object.freeze({
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      observedAt: parsePaymentInstant(raw.observedAt),
    });
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true)
        return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await acquireOrdinaryRefundRequestFences(
      tx,
      scope,
      orderOnly ? null : query.operationReference,
      query.orderReference,
    );
    const records = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_request " +
        "WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [scope.brandReference, scope.storeReference, query.operationReference],
    );
    if (records.rows.length > 1) return fail();
    const existing =
      records.rows.length === 0 ? null : decodeOrdinaryRefundRequest(records.rows[0]?.record);
    if (
      existing &&
      (!sameScope(scope, existing) ||
        existing.orderReference !== query.orderReference ||
        existing.operationReference !== query.operationReference ||
        existing.requestedAt > query.observedAt)
    )
      return fail();
    const history = await loadRequestHistory(tx, scope, query.orderReference, query.observedAt);
    const declines = await loadRequestDeclines(
      tx,
      scope,
      query.orderReference,
      history,
      query.observedAt,
    );
    const matching = history.filter(
      (request) => request.operationReference === query.operationReference,
    );
    if (
      existing === null
        ? matching.length !== 0
        : matching.length !== 1 ||
          encodeOrdinaryRefundRequest(matching[0]) !== encodeOrdinaryRefundRequest(existing)
    )
      return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    await authorize();
    return Object.freeze({
      existing,
      /** Complete history: claim versions and replay identity. */
      history,
      /** WP-2423 Q5: requests that currently occupy the Order (declined ones excluded). */
      occupying: occupyingAt(history, declines, Infinity),
      /** Requests that occupied the Order when the request of this claim version was appended. */
      occupyingBefore: (version: number) => occupyingAt(history, declines, version),
      declines,
    });
  };
}

export interface PositionQuery {
  readonly orderReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly observedAt: string;
}
/** Request occupancy with mandatory owning outcome resolution. Never interpret
 * age as released balance; confirmed amounts remain occupied. */
export function createPostgresOrdinaryRefundRequestPositionSource(options: {
  readonly scope: Scope;
  readonly authorize: (tx: ConsumerTransaction, query: PositionQuery & Scope) => Promise<boolean>;
  readonly readOutcome: (
    tx: ConsumerTransaction,
    input: {
      request: OrdinaryRefundRequest;
      payment: OrdinaryRefundRequest["payments"][number];
      observedAt: string;
    },
  ) => Promise<{
    confirmedMinor: bigint;
    pendingMinor: bigint;
    observationCount: number;
    historyDigest: string;
  } | null>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: PositionQuery) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "paymentTransactionReference",
      "paymentIntentReference",
      "paymentAttemptReference",
      "observedAt",
    ]);
    const query = {
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      paymentTransactionReference: String(parsePaymentReference(raw.paymentTransactionReference)),
      paymentIntentReference: String(parsePaymentReference(raw.paymentIntentReference)),
      paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
      observedAt: parsePaymentInstant(raw.observedAt),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true)
        return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        query.orderReference,
    ]);
    const fullHistory = await loadRequestHistory(tx, scope, query.orderReference, query.observedAt);
    const positionDeclines = await loadRequestDeclines(
      tx,
      scope,
      query.orderReference,
      fullHistory,
      query.observedAt,
    );
    // WP-2423 Q5: a declined request has no Provider effect and occupies nothing (RF-D04).
    const history = occupyingAt(fullHistory, positionDeclines, Infinity);
    let pendingMinor = 0n;
    let confirmedMinor = 0n;
    let observationCount = 0;
    let confirmedOrderAllocationMinor = 0n;
    let confirmedTipMinor = 0n;
    let unallocatedConfirmedMinor = 0n;
    const claimedUnits = new Set<string>();
    const outcomes: string[] = [];
    for (const request of history)
      for (const payment of request.payments) {
        if (payment.paymentAttemptReference !== query.paymentAttemptReference) continue;
        if (
          payment.paymentIntentReference !== query.paymentIntentReference ||
          payment.paymentTransactionReference !== query.paymentTransactionReference
        )
          return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
        for (const item of payment.items)
          for (const ordinal of item.refundUnitOrdinals) {
            const key = item.orderItemReference + ":" + ordinal;
            if (claimedUnits.has(key)) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
            claimedUnits.add(key);
          }
        const amount = ordinaryRefundPaymentAmount(payment);
        const outcome = await options.readOutcome(tx, {
          request,
          payment,
          observedAt: query.observedAt,
        });
        if (outcome === null) {
          pendingMinor += amount;
          continue;
        }
        if (
          outcome.confirmedMinor < 0n ||
          outcome.pendingMinor < 0n ||
          outcome.confirmedMinor + outcome.pendingMinor !== amount ||
          !Number.isSafeInteger(outcome.observationCount) ||
          outcome.observationCount < 0 ||
          !/^sha256:[a-f0-9]{64}$/u.test(outcome.historyDigest)
        )
          return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
        pendingMinor += outcome.pendingMinor;
        confirmedMinor += outcome.confirmedMinor;
        // The persisted operation confirms this exact immutable request amount.
        // A partially confirmed amount does not identify which components settled.
        if (outcome.confirmedMinor === amount && outcome.pendingMinor === 0n) {
          const tip = payment.items.reduce((sum, item) => sum + item.components.tipAmountMinor, 0n);
          confirmedTipMinor += tip;
          confirmedOrderAllocationMinor += amount - tip;
        } else {
          unallocatedConfirmedMinor += outcome.confirmedMinor;
        }
        observationCount += outcome.observationCount;
        outcomes.push(outcome.historyDigest);
      }
    if (pendingMinor + confirmedMinor > 9223372036854775807n)
      return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    await authorize();
    return Object.freeze({
      confirmedMinor,
      pendingMinor,
      confirmedOrderAllocationMinor,
      confirmedTipMinor,
      unallocatedConfirmedMinor,
      version: fullHistory.length + positionDeclines.size + observationCount + 1,
      snapshotDigest:
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify({
              tenantReference: query.tenantReference,
              brandReference: query.brandReference,
              storeReference: query.storeReference,
              orderReference: query.orderReference,
              paymentTransactionReference: query.paymentTransactionReference,
              paymentIntentReference: query.paymentIntentReference,
              paymentAttemptReference: query.paymentAttemptReference,
              history: history.map(encodeOrdinaryRefundRequest),
              declined: [...positionDeclines.keys()].sort(),
              outcomes,
            }),
          )
          .digest("hex"),
    });
  };
}

/** Read the persisted approval subject under the same Order fence as claims.
 * The digest covers all ordinary Requested occupancy; approval persistence and
 * first dispatch must resolve this again. Future outcomes must join this history
 * before release/confirmation can be enabled.
 */
export function createPostgresOrdinaryRefundApprovalSubjectSource(options: {
  readonly scope: Scope;
  readonly authorize: (
    tx: ConsumerTransaction,
    query: Scope & { readonly orderReference: string; readonly requestReference: string },
  ) => Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "requestReference", "observedAt"]);
    const query = {
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      requestReference: String(parsePaymentReference(raw.requestReference)),
      observedAt: parsePaymentInstant(raw.observedAt),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true)
        return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        query.orderReference,
    ]);
    const history = await loadRequestHistory(tx, scope, query.orderReference, query.observedAt);
    const matches = history.filter(
      (request) => request.requestReference === query.requestReference,
    );
    if (matches.length !== 1) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    const request = matches[0];
    if (request === undefined) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
    await authorize();
    return Object.freeze({
      subject: Object.freeze({
        ...scope,
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        policyVersion: request.policyVersion,
        claimsDigest: hash(
          JSON.stringify({
            ...scope,
            orderReference: request.orderReference,
            history: history.map(encodeOrdinaryRefundRequest),
          }),
        ),
        allocationDigest: hash(encodeOrdinaryRefundRequest(request)),
      }),
      requesterReference: request.actorReference,
      claimVersion: history.length,
      request,
    });
  };
}

/** Caller owns the transaction. No default authority, fabricated capture balance,
 * approval or dispatch. All recorded requests remain occupied until an explicit
 * append-only release/result reader is implemented and installed. */
export function createPostgresOrdinaryRefundRequestStore(options: {
  readonly scope: Scope;
  readonly authorize: (tx: ConsumerTransaction, request: OrdinaryRefundRequest) => Promise<boolean>;
  /** Must validate original capture/Order membership and exact Pricing allocation
   * against retained owner fences. Other occupancy includes compensation; do not
   * include the ordinary requests supplied in history a second time. */
  readonly validateSources: (
    tx: ConsumerTransaction,
    input: {
      readonly request: OrdinaryRefundRequest;
      readonly history: readonly OrdinaryRefundRequest[];
    },
  ) => Promise<
    readonly {
      readonly paymentAttemptReference: string;
      readonly capturedAmountMinor: bigint;
      readonly otherOccupiedAmountMinor: bigint;
    }[]
  >;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  async function evaluate(
    tx: ConsumerTransaction,
    value: unknown,
    auditValue: unknown,
    append: boolean,
    note: string | null = null,
  ) {
    const request = parseOrdinaryRefundRequest(value);
    if (
      (note !== null &&
        (typeof note !== "string" ||
          note !== note.trim() ||
          note.length < 1 ||
          [...note].length > 200 ||
          request.reasonCode !== "OTHER" ||
          ordinaryRefundClaimKind(request) !== "Ordinary")) ||
      (note === null && append && request.reasonCode === "OTHER")
    )
      return fail("ORDINARY_REFUND_NOTE_INVALID");
    const encoded = encodeOrdinaryRefundRequest(request);
    if (!sameScope(scope, request)) return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    const authorize = async () => {
      if ((await options.authorize(tx, request)) !== true)
        return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    };
    const audit = validateAuditRecord(auditValue);
    if (
      audit.auditId !== request.auditReference ||
      audit.brandId !== scope.brandReference ||
      audit.storeId !== scope.storeReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== request.actorReference ||
      audit.actionCode !== "PAYMENT_ORDINARY_REFUND_REQUESTED" ||
      audit.reasonCode !== request.reasonCode ||
      audit.targetType !== "PaymentRefundRequest" ||
      audit.targetId !== request.requestReference ||
      audit.correlationId !== request.operationReference ||
      audit.occurredAt !== request.requestedAt ||
      audit.dataClassification !== "Restricted" ||
      audit.beforeSummary !== undefined ||
      audit.afterSummary !== undefined
    )
      return fail("ORDINARY_REFUND_AUDIT_INVALID");
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await acquireOrdinaryRefundRequestFences(
      tx,
      scope,
      request.operationReference,
      request.orderReference,
    );
    const existing = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_request " +
        "WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [scope.brandReference, scope.storeReference, request.operationReference],
    );
    if (existing.rows.length > 1) return fail();
    if (existing.rows.length === 1) {
      if (!append) return fail();
      const prior = decodeOrdinaryRefundRequest(existing.rows[0]?.record);
      if (encodeOrdinaryRefundRequest(prior) !== encoded) return fail();
      const priorNote = await tx.query(
        "SELECT note FROM rms_payment.ordinary_refund_request_note WHERE brand_id=$1 AND store_id=$2 AND request_id=$3",
        [scope.brandReference, scope.storeReference, request.requestReference],
      );
      if ((priorNote.rows[0]?.note ?? null) !== note || priorNote.rows.length > 1) return fail();
      await authorize();
      return Object.freeze({
        status: "AlreadyCommitted" as const,
        claimVersion: prior.expectedClaimVersion + 1,
      });
    }
    const history = await loadRequestHistory(
      tx,
      scope,
      request.orderReference,
      request.requestedAt,
    );
    if (history.length >= 1000) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
    if (request.expectedClaimVersion !== history.length) return fail();
    // WP-2423 Q5: declined requests no longer occupy units or balance.
    const occupying = occupyingAt(
      history,
      await loadRequestDeclines(tx, scope, request.orderReference, history, request.requestedAt),
      Infinity,
    );
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    const now = clock.rows[0]?.now;
    if (
      clock.rows.length !== 1 ||
      parsePaymentInstant(now instanceof Date ? now.toISOString() : now) < request.requestedAt
    )
      return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
    const balances = await options.validateSources(tx, {
      request,
      history: occupying,
    });
    if (!Array.isArray(balances) || balances.length !== request.payments.length)
      return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
    const seen = new Set<string>();
    for (const payment of request.payments) {
      const balance = balances.find(
        (entry) => entry.paymentAttemptReference === payment.paymentAttemptReference,
      );
      if (
        !balance ||
        seen.has(balance.paymentAttemptReference) ||
        typeof balance.capturedAmountMinor !== "bigint" ||
        balance.capturedAmountMinor <= 0n ||
        balance.capturedAmountMinor > 9223372036854775807n ||
        typeof balance.otherOccupiedAmountMinor !== "bigint" ||
        balance.otherOccupiedAmountMinor < 0n
      )
        return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
      seen.add(balance.paymentAttemptReference);
      let occupied = balance.otherOccupiedAmountMinor;
      for (const prior of occupying) {
        for (const previous of prior.payments) {
          if (previous.paymentAttemptReference !== payment.paymentAttemptReference) continue;
          if (
            previous.paymentTransactionReference !== payment.paymentTransactionReference ||
            previous.paymentIntentReference !== payment.paymentIntentReference ||
            previous.firstCaptureReference !== payment.firstCaptureReference ||
            previous.sourceReference !== payment.sourceReference ||
            previous.sourceDigest !== payment.sourceDigest
          )
            return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
          occupied += ordinaryRefundPaymentAmount(previous);
        }
        // Unit occupancy is Order-wide, including attempts from other batches.
        for (const previous of prior.payments)
          for (const oldItem of previous.items) {
            const item = payment.items.find(
              (candidate) => candidate.orderItemReference === oldItem.orderItemReference,
            );
            if (
              item?.refundUnitOrdinals.some((ordinal) =>
                oldItem.refundUnitOrdinals.includes(ordinal),
              )
            )
              return fail();
          }
      }
      if (occupied + ordinaryRefundPaymentAmount(payment) > balance.capturedAmountMinor)
        return fail("ORDINARY_REFUND_BALANCE_EXCEEDED");
    }
    await authorize();
    if (!append)
      return Object.freeze({ status: "Previewed" as const, claimVersion: history.length });
    await tx.query("SAVEPOINT ordinary_refund_request_append", []);
    try {
      const result = await tx.query(
        "INSERT INTO rms_payment.ordinary_refund_request " +
          "(tenant_id,brand_id,store_id,order_id,request_id,operation_id,actor_id,audit_id,claim_version,amount_minor,requested_at,record_json) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          request.orderReference,
          request.requestReference,
          request.operationReference,
          request.actorReference,
          request.auditReference,
          history.length + 1,
          request.amountMinor.toString(),
          request.requestedAt,
          encoded,
        ],
      );
      if (result.rowCount !== 1) return fail();
      // WP-2423 Q5: the staff note of an "Other" reason; Confidential, never placed in Audit.
      if (note !== null) {
        const noted = await tx.query(
          "INSERT INTO rms_payment.ordinary_refund_request_note (tenant_id,brand_id,store_id,order_id,request_id,actor_id,note,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            request.orderReference,
            request.requestReference,
            request.actorReference,
            note,
            request.requestedAt,
          ],
        );
        if (noted.rowCount !== 1) return fail();
      }
      await appendAuditRecordInTransaction(tx, audit);
      await authorize();
      await tx.query("RELEASE SAVEPOINT ordinary_refund_request_append", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_request_append", []);
      await tx.query("RELEASE SAVEPOINT ordinary_refund_request_append", []);
      throw error;
    }
    return Object.freeze({ status: "Created" as const, claimVersion: history.length + 1 });
  }
  return {
    async record(
      tx: ConsumerTransaction,
      value: unknown,
      auditValue: unknown,
      note: string | null = null,
    ) {
      const result = await evaluate(tx, value, auditValue, true, note);
      if (result.status === "Previewed") return fail();
      return result;
    },
    async preview(tx: ConsumerTransaction, value: unknown, auditValue: unknown) {
      const result = await evaluate(tx, value, auditValue, false);
      if (result.status !== "Previewed") return fail();
      return result;
    },
  };
}

/** Revalidate an already occupied request without reserving it twice.
 * All currently supported requests remain pending. Explicit outcome/release
 * history must be incorporated before those transitions can be enabled.
 */
export function createPostgresOrdinaryRefundExecutionBalanceSource(
  options: Parameters<typeof createPostgresOrdinaryRefundRequestStore>[0],
) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "requestReference"]);
    const orderReference = String(parsePaymentReference(raw.orderReference));
    const requestReference = String(parsePaymentReference(raw.requestReference));
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        orderReference,
    ]);
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    if (clock.rows.length !== 1) return fail();
    const time = clock.rows[0]?.now;
    const observedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
    const history = await loadRequestHistory(tx, scope, orderReference, observedAt);
    const index = history.findIndex((request) => request.requestReference === requestReference);
    const request = history[index];
    if (!request) return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, request)) !== true)
        return fail("ORDINARY_REFUND_PERMISSION_DENIED");
    };
    await authorize();
    const declines = await loadRequestDeclines(tx, scope, orderReference, history, observedAt);
    // WP-2423 Q5: a declined request can never be executed.
    if (declines.has(requestReference)) return fail("ORDINARY_REFUND_DECLINED");
    // Reproduce original allocation using history preceding that request.
    // Later claims count toward current balance, not its original unit selection.
    const sources = await options.validateSources(tx, {
      request,
      history: occupyingAt(history, declines, index + 1),
    });
    if (!Array.isArray(sources) || sources.length !== request.payments.length) return fail();
    const positions = request.payments.map((payment) => {
      const matches = sources.filter(
        (entry) => entry.paymentAttemptReference === payment.paymentAttemptReference,
      );
      const source = matches[0];
      if (
        matches.length !== 1 ||
        !source ||
        typeof source.capturedAmountMinor !== "bigint" ||
        source.capturedAmountMinor <= 0n ||
        source.capturedAmountMinor > 9223372036854775807n ||
        typeof source.otherOccupiedAmountMinor !== "bigint" ||
        source.otherOccupiedAmountMinor < 0n
      )
        return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
      let occupied = source.otherOccupiedAmountMinor;
      for (const prior of occupyingAt(history, declines, Infinity))
        for (const leg of prior.payments) {
          if (leg.paymentAttemptReference !== payment.paymentAttemptReference) continue;
          if (
            leg.paymentIntentReference !== payment.paymentIntentReference ||
            leg.paymentTransactionReference !== payment.paymentTransactionReference ||
            leg.firstCaptureReference !== payment.firstCaptureReference ||
            leg.sourceReference !== payment.sourceReference ||
            leg.sourceDigest !== payment.sourceDigest
          )
            return fail("ORDINARY_REFUND_SOURCE_UNAVAILABLE");
          occupied += ordinaryRefundPaymentAmount(leg);
        }
      if (occupied > source.capturedAmountMinor) return fail("ORDINARY_REFUND_BALANCE_EXCEEDED");
      return Object.freeze({
        paymentAttemptReference: payment.paymentAttemptReference,
        requestAmountMinor: ordinaryRefundPaymentAmount(payment),
        capturedAmountMinor: source.capturedAmountMinor,
        occupiedAmountMinor: occupied,
        unoccupiedAmountMinor: source.capturedAmountMinor - occupied,
      });
    });
    await authorize();
    return Object.freeze({
      request,
      claimVersion: history.length,
      observedAt,
      positions: Object.freeze(positions),
    });
  };
}

/** Complete current ordinary claims, not a browser-provided cumulative amount.
 * Original capture/Pricing and Store business-date ports must retain their owner
 * fences. Pending-only history cannot release or confirm claims yet.
 * This request format permits canonical original allocation only, no override. */
export function createPostgresOrdinaryRefundEscalationSource(options: {
  scope: Scope;
  authorize(tx: ConsumerTransaction, request: OrdinaryRefundRequest): Promise<boolean>;
  captures(
    tx: ConsumerTransaction,
    input: { request: OrdinaryRefundRequest; history: readonly OrdinaryRefundRequest[] },
  ): Promise<readonly { paymentAttemptReference: string; firstCapturedAt: string }[]>;
  businessDate(tx: ConsumerTransaction, query: Scope & { occurredAt: string }): Promise<string>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "requestReference"]);
    const orderReference = String(parsePaymentReference(raw.orderReference));
    const requestReference = String(parsePaymentReference(raw.requestReference));
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        orderReference,
    ]);
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    if (clock.rows.length !== 1) return fail();
    const time = clock.rows[0]?.now;
    const observedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
    const history = await loadRequestHistory(tx, scope, orderReference, observedAt);
    const index = history.findIndex((entry) => entry.requestReference === requestReference);
    const request = history[index];
    if (!request || (await options.authorize(tx, request)) !== true) return fail();
    const declines = await loadRequestDeclines(tx, scope, orderReference, history, observedAt);
    // A declined request is closed: it is never evaluated for approval or dispatch.
    if (declines.has(requestReference)) return fail("ORDINARY_REFUND_DECLINED");
    const captures = await options.captures(tx, {
      request,
      history: occupyingAt(history, declines, index + 1),
    });
    if (!Array.isArray(captures) || captures.length !== request.payments.length) return fail();
    const selectedCaptures = [];
    for (const leg of request.payments) {
      const matches = captures.filter(
        (entry) => entry.paymentAttemptReference === leg.paymentAttemptReference,
      );
      if (matches.length !== 1 || !matches[0]) return fail();
      const firstCapturedAt = parsePaymentInstant(matches[0].firstCapturedAt);
      selectedCaptures.push({
        ...scope,
        orderReference,
        paymentReference: leg.paymentAttemptReference,
        firstCaptureReference: leg.firstCaptureReference,
        firstCapturedAt,
        businessDate: await options.businessDate(tx, { ...scope, occurredAt: firstCapturedAt }),
      });
    }
    const decision = evaluateOrdinaryRefundEscalation({
      ...scope,
      orderReference,
      requestReference,
      observedAt,
      businessDate: await options.businessDate(tx, { ...scope, occurredAt: observedAt }),
      selectedCaptures,
      claims: history.map((entry) => ({
        ...scope,
        orderReference,
        requestReference: entry.requestReference,
        kind: ordinaryRefundClaimKind(entry),
        // WP-2423 Q5: a declined request is durable no-Provider-effect evidence (RF-D04).
        status: declines.has(entry.requestReference) ? "Rejected" : "Requested",
        amountMinor: entry.amountMinor,
        currencyCode: entry.currencyCode,
        noProviderEffectReference: declines.get(entry.requestReference)?.declineReference ?? null,
      })),
      manualAllocationOverride: false,
    });
    if ((await options.authorize(tx, request)) !== true) return fail();
    return Object.freeze({ decision, observedAt, claimVersion: history.length, requestReference });
  };
}

/** WP-2423 Q5: the staff note of a request whose reason is "Other" (Confidential). Owner read
 * for authorized staff screens only; never logged or placed in Audit. */
export async function readOrdinaryRefundRequestNote(
  tx: ConsumerTransaction,
  scope: Scope,
  requestReference: string,
): Promise<string | null> {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    String(parsePaymentReference(scope.brandReference)),
    String(parsePaymentReference(scope.storeReference)),
  ]);
  const result = await tx.query(
    "SELECT note FROM rms_payment.ordinary_refund_request_note WHERE brand_id=$1 AND store_id=$2 AND request_id=$3",
    [scope.brandReference, scope.storeReference, String(parsePaymentReference(requestReference))],
  );
  if (result.rows.length > 1) return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  const note = result.rows[0]?.note;
  if (note === undefined) return null;
  if (typeof note !== "string") return fail("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
  return note;
}
