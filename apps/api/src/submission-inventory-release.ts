import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "@rms/ordering";
import {
  createPostgresSubmissionFinalValidationStore,
  createPostgresStockReservationStore,
  advanceInventoryReservation,
  planInventoryReservationSetRelease,
  systemReservationReleaseReasonCodes,
  type StockReservationWrite,
  type SystemReservationReleaseReasonCode,
} from "@rms/inventory";

/** The owning business fact that ends a submission's need for its reserved stock. */
export interface SubmissionInventoryReleaseSource {
  /** Versioned child-identity namespace; changing it changes every derived release reference. */
  readonly kind: string;
  /** Owning source UUIDv7; its timestamp prefix becomes the child references' prefix. */
  readonly reference: string;
  readonly submissionReference: string;
  readonly orderReference: string;
  /** When the owning source was decided; the release can never predate it. */
  readonly occurredAt: string;
}
export type SubmissionInventoryReleaseResult = Readonly<
  | { status: "Released" | "AlreadyApplied"; entryCount: number }
  /** NotTracked: nothing was reserved. AlreadyReleased: another release already returned the stock. */
  | { status: "NothingToRelease"; reason: "NotTracked" | "AlreadyReleased" }
  /** Left for staff: no partial release is ever written. */
  | {
      status: "NotReleasable";
      reason: "NoInventoryRecord" | "DeferredInventory" | "ProductionStarted" | "PartiallySettled";
    }
>;
/**
 * WP-2423 Q6 step 2a: per-line release of the stock reserved for some Order lines. Only per-line
 * (schema 2) reservations can be released line by line; a submission reserved with the legacy
 * submission-wide schema 1 is LegacyReservation and nothing is written.
 */
export type OrderLineInventoryReleaseResult = Readonly<
  | { status: "Released" | "AlreadyApplied"; entryCount: number }
  | { status: "NothingToRelease"; reason: "NotTracked" | "AlreadyReleased" }
  | {
      status: "NotReleasable";
      reason:
        | "NoInventoryRecord"
        | "DeferredInventory"
        | "ProductionStarted"
        | "PartiallySettled"
        | "LegacyReservation";
    }
>;
export interface SubmissionInventoryReleaseRequest {
  readonly source: SubmissionInventoryReleaseSource;
  /** Time written on new release movements; ignored for verification of an earlier release. */
  readonly releasedAt: string;
  /** Current source authority; re-checked before reads, before writes and after verification. */
  readonly authorize: () => Promise<boolean>;
}
const fail = (): never => {
  throw new Error("SUBMISSION_INVENTORY_RELEASE_UNAVAILABLE");
};
/** Stable nonsecret child identity; timestamp prefix comes from the owning source UUIDv7. */
function childReference(
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  source: SubmissionInventoryReleaseSource,
  reservation: string,
  role: "operation" | "movement" | "audit",
) {
  const h = createHash("sha256")
    .update(
      canonicalizeRfc8785([
        source.kind,
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        source.reference,
        reservation,
        role,
      ]),
    )
    .digest("hex");
  return parseOrderingReference(
    source.reference.slice(0, 14) +
      "7" +
      h.slice(0, 3) +
      "-8" +
      h.slice(3, 6) +
      "-" +
      h.slice(6, 18),
  );
}
/**
 * WP-2423 Q12: System release of a complete reserve-at-submission set for an owning source
 * (dining checkout cancellation, paid order that can no longer be fulfilled).
 * Policy: all-or-nothing. If any entry started production or was consumed, or the set is only
 * partly settled, nothing is written and the result is NotReleasable for staff to resolve.
 * The caller supplies the transaction and must roll it back on any thrown failure.
 */
export function createSubmissionInventoryRelease(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  systemActorReference: string;
  reasonCode: SystemReservationReleaseReasonCode;
  now(): string;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  const principal = parseOrderingReference(options.systemActorReference);
  const reasonCode = options.reasonCode;
  if (!(systemReservationReleaseReasonCodes as readonly string[]).includes(reasonCode))
    return fail();
  async function open(
    transaction: ConsumerTransaction,
    request: SubmissionInventoryReleaseRequest,
  ) {
    const raw = request.source;
    if (
      typeof raw.kind !== "string" ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}\/v[1-9][0-9]{0,3}$/u.test(raw.kind) ||
      typeof request.authorize !== "function"
    )
      return fail();
    const source: SubmissionInventoryReleaseSource = Object.freeze({
      kind: raw.kind,
      reference: parseOrderingReference(raw.reference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      orderReference: parseOrderingReference(raw.orderReference),
      occurredAt: parseOrderingInstant(raw.occurredAt),
    });
    const releasedAt = parseOrderingInstant(request.releasedAt);
    if (releasedAt < source.occurredAt || releasedAt > parseOrderingInstant(options.now()))
      return fail();
    const allowed = async () => (await request.authorize()) === true;
    if (!(await allowed())) return fail();
    const runner = {
      run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
    };
    const original = await createPostgresSubmissionFinalValidationStore(runner, scope, {
      authorize: async () => false,
      resolveCurrent: async () => fail(),
      authorizeSystemRelease: async (tx, input) =>
        tx === transaction &&
        input.systemActorReference === principal &&
        input.cancellationReference === source.reference &&
        input.submissionReference === source.submissionReference &&
        input.orderReference === source.orderReference &&
        input.observedAt === source.occurredAt &&
        (await allowed()),
    }).loadForSystemRelease({
      systemActorReference: principal,
      cancellationReference: source.reference,
      submissionReference: source.submissionReference,
      orderReference: source.orderReference,
      observedAt: source.occurredAt,
    });
    if (
      original !== null &&
      (String(original.orderReference) !== source.orderReference ||
        String(original.submissionReference) !== source.submissionReference)
    )
      return fail();
    const set = original?.reservationSet ?? null;
    const members = new Map(
      (set?.entries ?? []).map((entry) => [entry.reservation.reservationReference, entry]),
    );
    const child = (reservation: string, role: "operation" | "movement" | "audit") =>
      childReference(scope, source, reservation, role);
    // A release is written once at one instant within [source decision, this request].
    const inWindow = (at: string) => at >= source.occurredAt && at <= releasedAt;
    const store = createPostgresStockReservationStore(runner, scope, {
      systemActorReference: principal,
      reasonCode,
      authorize: async (tx, input) => {
        const member = members.get(input.reservation.reservationReference);
        return (
          tx === transaction &&
          member !== undefined &&
          member.accountReference === input.accountReference &&
          input.operationReference === child(input.reservation.reservationReference, "operation") &&
          inWindow(String(input.reservation.updatedAt)) &&
          (await allowed())
        );
      },
    });
    const verify = async (): Promise<SubmissionInventoryReleaseResult> => {
      if (set === null) return fail();
      let at: string | undefined;
      for (const entry of set.entries) {
        const prior = await store.verifySystemRelease(
          child(entry.reservation.reservationReference, "operation"),
        );
        if (
          prior === null ||
          prior.movementReference !== child(entry.reservation.reservationReference, "movement") ||
          prior.auditReference !== child(entry.reservation.reservationReference, "audit")
        )
          return fail();
        const next = prior.reservation,
          base = entry.reservation;
        if (
          next.reservationReference !== base.reservationReference ||
          canonicalizeRfc8785(next.binding) !== canonicalizeRfc8785(base.binding) ||
          canonicalizeRfc8785(next.unit) !== canonicalizeRfc8785(base.unit) ||
          next.originalQuantity !== base.originalQuantity ||
          next.createdAt !== base.createdAt ||
          !inWindow(String(next.updatedAt)) ||
          (at !== undefined && at !== String(next.updatedAt)) ||
          next.remainingQuantity !== "0" ||
          next.releasedQuantity !== base.originalQuantity ||
          next.consumedQuantity !== "0" ||
          next.productionStartedAt !== null ||
          next.version <= base.version
        )
          return fail();
        at = String(next.updatedAt);
      }
      if (!(await allowed())) return fail();
      return Object.freeze({ status: "AlreadyApplied", entryCount: set.entries.length });
    };
    return { source, releasedAt, allowed, original, set, store, child, verify };
  }
  /** Pre-check shared by release and verification; null means continue with the reservation set. */
  async function settle(
    opened: Awaited<ReturnType<typeof open>>,
  ): Promise<SubmissionInventoryReleaseResult | null> {
    if (opened.original === null)
      return Object.freeze({ status: "NotReleasable", reason: "NoInventoryRecord" });
    if (opened.original.items.some((item) => item.disposition === "Deferred"))
      return Object.freeze({ status: "NotReleasable", reason: "DeferredInventory" });
    if (opened.set === null) {
      if (!(await opened.allowed())) return fail();
      return Object.freeze({ status: "NothingToRelease", reason: "NotTracked" });
    }
    return null;
  }
  return Object.freeze({
    /**
     * WP-2423 Q6 step 2a: releases, all or nothing, the per-line reservations of the given cart
     * lines (Order lines' source cart lines). Idempotent per source: a replay finds the same child
     * operations and returns AlreadyApplied. The caller rolls back on any thrown failure.
     */
    async releaseLines(
      transaction: ConsumerTransaction,
      request: SubmissionInventoryReleaseRequest & {
        readonly cartLineReferences: readonly string[];
      },
    ): Promise<OrderLineInventoryReleaseResult> {
      const lines = new Set(
        request.cartLineReferences.map((line) => String(parseOrderingReference(line))),
      );
      if (lines.size === 0 || lines.size !== request.cartLineReferences.length) return fail();
      const opened = await open(transaction, request);
      const settled = await settle(opened);
      if (settled !== null) return settled;
      const { set, store, child, allowed, releasedAt } = opened;
      if (set === null) return fail();
      if (set.entries.some((entry) => entry.reservation.schemaVersion !== 2))
        return Object.freeze({ status: "NotReleasable", reason: "LegacyReservation" });
      const selected = set.entries.filter((entry) =>
        lines.has(String(entry.reservation.binding.cartItemReference)),
      );
      if (selected.length === 0) {
        if (!(await allowed())) return fail();
        return Object.freeze({ status: "NothingToRelease", reason: "NotTracked" });
      }
      let priors = 0;
      for (const entry of selected) {
        const prior = await store.resolveOperation(
          child(entry.reservation.reservationReference, "operation"),
        );
        if (prior !== null) {
          if (
            prior.movementReference !== child(entry.reservation.reservationReference, "movement") ||
            prior.auditReference !== child(entry.reservation.reservationReference, "audit") ||
            prior.reservation.remainingQuantity !== "0"
          )
            return fail();
          priors++;
        }
      }
      if (priors === selected.length) {
        if (!(await allowed())) return fail();
        return Object.freeze({ status: "AlreadyApplied", entryCount: selected.length });
      }
      if (priors !== 0) return fail();
      const current = [];
      let started = false,
        settledEntries = 0;
      for (const entry of selected) {
        const observed = await store.loadCurrent(entry.reservation.reservationReference);
        if (
          observed === null ||
          observed.accountReference !== entry.accountReference ||
          canonicalizeRfc8785(observed.reservation.binding) !==
            canonicalizeRfc8785(entry.reservation.binding)
        )
          return fail();
        const reservation = observed.reservation;
        if (reservation.productionStartedAt !== null || reservation.consumedQuantity !== "0")
          started = true;
        if (reservation.remainingQuantity === "0") settledEntries++;
        current.push({ accountReference: observed.accountReference, reservation });
      }
      if (!(await allowed())) return fail();
      if (started) return Object.freeze({ status: "NotReleasable", reason: "ProductionStarted" });
      if (settledEntries === selected.length)
        return Object.freeze({ status: "NothingToRelease", reason: "AlreadyReleased" });
      if (settledEntries !== 0)
        return Object.freeze({ status: "NotReleasable", reason: "PartiallySettled" });
      for (const { accountReference, reservation: before } of current) {
        const version = await store.loadAccountLedgerVersion(accountReference);
        if (version === null) return fail();
        const reservation = advanceInventoryReservation(before, {
          reservationReference: before.reservationReference,
          binding: before.binding,
          expectedVersion: before.version,
          action: "Release",
          quantity: before.remainingQuantity,
          occurredAt: releasedAt,
        });
        const operationReference = child(reservation.reservationReference, "operation");
        const result = await store.commit({
          operationReference,
          accountReference,
          action: "Release",
          expectedLedgerVersion: version,
          quantity: before.remainingQuantity,
          reservation,
          movementReference: child(reservation.reservationReference, "movement"),
          audit: {
            auditId: child(reservation.reservationReference, "audit"),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "INVENTORY_RESERVATION_RELEASE",
            targetType: "InventoryReservation",
            targetId: reservation.reservationReference,
            reasonCode,
            correlationId: operationReference,
            occurredAt: releasedAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        });
        if (result.status !== "Applied") return fail();
      }
      if (!(await allowed())) return fail();
      return Object.freeze({ status: "Released", entryCount: selected.length });
    },
    /** Verifies a release previously written for this exact source; never writes. */
    async verify(
      transaction: ConsumerTransaction,
      request: SubmissionInventoryReleaseRequest,
    ): Promise<SubmissionInventoryReleaseResult> {
      const opened = await open(transaction, request);
      return (await settle(opened)) ?? opened.verify();
    },
    /** Idempotent: a verified earlier release for this source returns AlreadyApplied. */
    async release(
      transaction: ConsumerTransaction,
      request: SubmissionInventoryReleaseRequest,
    ): Promise<SubmissionInventoryReleaseResult> {
      const opened = await open(transaction, request);
      const settled = await settle(opened);
      if (settled !== null) return settled;
      const { set, store, child, allowed, releasedAt } = opened;
      if (set === null) return fail();
      let priors = 0;
      for (const entry of set.entries)
        if (
          (await store.resolveOperation(
            child(entry.reservation.reservationReference, "operation"),
          )) !== null
        )
          priors++;
      if (priors === set.entries.length) return opened.verify();
      if (priors !== 0) return fail();
      const current = [];
      let started = false,
        settledEntries = 0;
      for (const entry of set.entries) {
        const observed = await store.loadCurrent(entry.reservation.reservationReference);
        if (
          observed === null ||
          observed.accountReference !== entry.accountReference ||
          canonicalizeRfc8785(observed.reservation.binding) !==
            canonicalizeRfc8785(entry.reservation.binding)
        )
          return fail();
        const reservation = observed.reservation;
        if (reservation.productionStartedAt !== null || reservation.consumedQuantity !== "0")
          started = true;
        if (reservation.remainingQuantity === "0") settledEntries++;
        current.push({ accountReference: observed.accountReference, reservation });
      }
      if (!(await allowed())) return fail();
      if (started) return Object.freeze({ status: "NotReleasable", reason: "ProductionStarted" });
      if (settledEntries === set.entries.length)
        return Object.freeze({ status: "NothingToRelease", reason: "AlreadyReleased" });
      if (settledEntries !== 0)
        return Object.freeze({ status: "NotReleasable", reason: "PartiallySettled" });
      const plan = planInventoryReservationSetRelease({ set, current, occurredAt: releasedAt });
      const writes: StockReservationWrite[] = [];
      // The store writes these in plan order inside one transaction, and every Release advances
      // its account's ledger by one, so a later write on the same account must expect the
      // version the earlier write produced (a round of several units can hold several
      // reservations on one account).
      const nextLedgerVersion = new Map<string, number>();
      for (const entry of plan.entries) {
        let version = nextLedgerVersion.get(entry.accountReference) ?? null;
        if (version === null) {
          version = await store.loadAccountLedgerVersion(entry.accountReference);
          if (version === null) return fail();
        }
        nextLedgerVersion.set(entry.accountReference, version + 1);
        const reservation = entry.reservation,
          operationReference = child(reservation.reservationReference, "operation");
        writes.push({
          operationReference,
          accountReference: entry.accountReference,
          action: "Release",
          expectedLedgerVersion: version,
          quantity: entry.quantity,
          reservation,
          movementReference: child(reservation.reservationReference, "movement"),
          audit: {
            auditId: child(reservation.reservationReference, "audit"),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "INVENTORY_RESERVATION_RELEASE",
            targetType: "InventoryReservation",
            targetId: reservation.reservationReference,
            reasonCode,
            correlationId: operationReference,
            occurredAt: releasedAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        });
      }
      const receipt = await store.releaseSet(
        { set, writes },
        async (tx, candidate) =>
          tx === transaction &&
          canonicalizeRfc8785(candidate) === canonicalizeRfc8785(set) &&
          (await allowed()),
      );
      if (receipt.status !== "Applied" || receipt.entries.length !== set.entries.length)
        return fail();
      await opened.verify();
      return Object.freeze({ status: "Released", entryCount: set.entries.length });
    },
  });
}
