import {
  FulfillmentReadinessError,
  parseReadinessDigest,
  parseReadinessInstant,
  parseReadinessReference,
  type ReadinessDigest,
  type ReadinessInstant,
  type ReadinessReference,
} from "./fulfillment-readiness.js";

/**
 * WP-2423 Q6 step 2: staff cancel some lines of a paid pickup order before the kitchen starts
 * them. Fulfillment records each cancelled line as an append-only fact that advances the pickup
 * aggregate by one version; the line no longer counts toward Ready, the pickup proof or handoff.
 */
export const fulfillmentItemCancellationActionCode = "FULFILLMENT_ITEM_CANCELLED" as const;
export const fulfillmentItemCancellationReasonCode = "ORDER_CANCELLED_BEFORE_PREPARATION" as const;

export type FulfillmentItemCancellationResult =
  | {
      readonly status: "Recorded" | "AlreadyRecorded";
      readonly fulfillmentReference: ReadinessReference;
      readonly itemCount: number;
      /** Phase after the cancellation; Ready when every remaining line was already ready. */
      readonly canonicalPhase: "Pending" | "Ready";
      readonly evidenceDigest: ReadinessDigest;
    }
  | { readonly status: "NoFulfillment" };

export interface FulfillmentItemCancellationRecord {
  readonly cancellationReference: ReadinessReference;
  readonly operationReference: ReadinessReference;
  readonly fulfillmentReference: ReadinessReference;
  readonly fulfillmentItemReference: ReadinessReference;
  readonly orderReference: ReadinessReference;
  readonly orderBatchReference: ReadinessReference;
  readonly orderItemReference: ReadinessReference;
  readonly orderCancellationReference: ReadinessReference;
  readonly actorReference: ReadinessReference;
  readonly aggregateVersionBefore: bigint;
  readonly aggregateVersionAfter: bigint;
  readonly phaseBefore: "Pending";
  readonly phaseAfter: "Pending" | "Ready";
  readonly evidenceDigest: ReadinessDigest;
  readonly auditReference: ReadinessReference;
  readonly cancelledAt: ReadinessInstant;
}

const maximumBigint = 9_223_372_036_854_775_807n;

function unavailable(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE");
}

function versionValue(value: unknown): bigint {
  const text = typeof value === "bigint" ? value.toString(10) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,18}$/u.test(text)) return unavailable();
  const parsed = BigInt(text);
  if (parsed > maximumBigint) return unavailable();
  return parsed;
}

export const fulfillmentItemCancellationColumns =
  "fulfillment_item_cancellation_id,operation_id,fulfillment_id,fulfillment_item_id,order_id,order_batch_id," +
  "order_item_id,order_cancellation_id,actor_id,aggregate_version_before::text AS aggregate_version_before," +
  "aggregate_version_after::text AS aggregate_version_after,phase_before,phase_after,evidence_digest,audit_id," +
  "cancelled_at";

export function parseFulfillmentItemCancellationRow(
  row: unknown,
): FulfillmentItemCancellationRecord {
  try {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return unavailable();
    const r = row as Record<string, unknown>;
    const before = versionValue(r.aggregate_version_before);
    const after = versionValue(r.aggregate_version_after);
    if (
      after !== before + 1n ||
      r.phase_before !== "Pending" ||
      (r.phase_after !== "Pending" && r.phase_after !== "Ready")
    )
      return unavailable();
    return Object.freeze({
      cancellationReference: parseReadinessReference(r.fulfillment_item_cancellation_id),
      operationReference: parseReadinessReference(r.operation_id),
      fulfillmentReference: parseReadinessReference(r.fulfillment_id),
      fulfillmentItemReference: parseReadinessReference(r.fulfillment_item_id),
      orderReference: parseReadinessReference(r.order_id),
      orderBatchReference: parseReadinessReference(r.order_batch_id),
      orderItemReference: parseReadinessReference(r.order_item_id),
      orderCancellationReference: parseReadinessReference(r.order_cancellation_id),
      actorReference: parseReadinessReference(r.actor_id),
      aggregateVersionBefore: before,
      aggregateVersionAfter: after,
      phaseBefore: "Pending" as const,
      phaseAfter: r.phase_after,
      evidenceDigest: parseReadinessDigest(r.evidence_digest),
      auditReference: parseReadinessReference(r.audit_id),
      cancelledAt: parseReadinessInstant(
        r.cancelled_at instanceof Date ? r.cancelled_at.toISOString() : r.cancelled_at,
      ),
    });
  } catch {
    return unavailable();
  }
}

export interface FulfillmentReadinessFoldItem {
  readonly fulfillmentItemReference: string;
  readonly orderItemReference: string;
  readonly orderedQuantity: number;
}

export interface FulfillmentReadinessFoldReady {
  readonly fulfillmentItemReference: string;
  readonly orderItemReference: string;
  readonly readyQuantity: number;
  readonly aggregateVersionBefore: bigint;
  readonly aggregateVersionAfter: bigint;
  readonly phaseBefore: "Pending" | "Ready";
  readonly phaseAfter: "Pending" | "Ready";
  readonly occurredAt: string;
}

export interface FulfillmentReadinessFold {
  readonly aggregateVersion: bigint;
  readonly canonicalPhase: "Pending" | "Ready";
  readonly ready: ReadonlyMap<string, number>;
  readonly cancelled: ReadonlySet<string>;
  /** Latest owner fact; the instant the order became ready once the phase is Ready. */
  readonly readyAt: string | null;
}

/** Phase rule shared by every writer: the remaining (not cancelled) lines are all ready. */
export function fulfillmentPhaseFor(
  items: readonly FulfillmentReadinessFoldItem[],
  ready: ReadonlySet<string> | ReadonlyMap<string, number>,
  cancelled: ReadonlySet<string>,
): "Pending" | "Ready" {
  const active = items.filter((item) => !cancelled.has(item.fulfillmentItemReference));
  return active.length > 0 && active.every((item) => ready.has(item.fulfillmentItemReference))
    ? "Ready"
    : "Pending";
}

/**
 * Replays ready and cancellation facts in aggregate version order. Each fact advances the version
 * by one from 1; a line is ready or cancelled at most once and never both; a cancellation only
 * happens while the pickup is Pending. Throws when the stored history is not exactly that.
 */
export function foldFulfillmentReadiness(input: {
  readonly items: readonly FulfillmentReadinessFoldItem[];
  readonly ready: readonly FulfillmentReadinessFoldReady[];
  readonly cancellations: readonly FulfillmentItemCancellationRecord[];
}): FulfillmentReadinessFold {
  const facts = [
    ...input.ready.map((fact) => ({ kind: "Ready" as const, fact })),
    ...input.cancellations.map((fact) => ({ kind: "Cancelled" as const, fact })),
  ].sort((left, right) =>
    left.fact.aggregateVersionAfter < right.fact.aggregateVersionAfter
      ? -1
      : left.fact.aggregateVersionAfter > right.fact.aggregateVersionAfter
        ? 1
        : 0,
  );
  const ready = new Map<string, number>();
  const cancelled = new Set<string>();
  let version = 1n;
  let phase: "Pending" | "Ready" = "Pending";
  let readyAt: string | null = null;
  for (const { kind, fact } of facts) {
    const item = input.items.find(
      (value) => value.fulfillmentItemReference === fact.fulfillmentItemReference,
    );
    if (
      item === undefined ||
      item.orderItemReference !== fact.orderItemReference ||
      ready.has(item.fulfillmentItemReference) ||
      cancelled.has(item.fulfillmentItemReference) ||
      fact.aggregateVersionBefore !== version ||
      fact.aggregateVersionAfter !== version + 1n ||
      fact.phaseBefore !== phase
    )
      return unavailable();
    if (kind === "Ready") {
      if ((fact as FulfillmentReadinessFoldReady).readyQuantity !== item.orderedQuantity)
        return unavailable();
      ready.set(item.fulfillmentItemReference, item.orderedQuantity);
    } else {
      if (phase !== "Pending") return unavailable();
      cancelled.add(item.fulfillmentItemReference);
    }
    phase = fulfillmentPhaseFor(input.items, ready, cancelled);
    if (fact.phaseAfter !== phase) return unavailable();
    const at =
      kind === "Ready" ? (fact as FulfillmentReadinessFoldReady).occurredAt : fact.cancelledAt;
    if (readyAt === null || at > readyAt) readyAt = at;
    version = fact.aggregateVersionAfter;
  }
  return Object.freeze({
    aggregateVersion: version,
    canonicalPhase: phase,
    ready,
    cancelled,
    readyAt,
  });
}
