import type { PaymentTerminalEnvelope } from "../contracts/payment-terminal-event.js";
import {
  buildPaymentStatusProjection,
  equivalentPaymentStatus,
  parsePaymentStatusProjection,
  PaymentStatusProjectionError,
  type PaymentStatusFreshness,
  type PaymentStatusProjection,
} from "./payment-status-projection.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentTerminalEnvelope } from "./payment-terminal-event.js";
import type {
  PaymentStatusProjectionPorts,
  PaymentStatusQueryPorts,
} from "./ports/payment-status-projection-ports.js";

export const paymentStatusProjectionConsumer = "payment.status-projection:v1" as const;

function fail(code: ConstructorParameters<typeof PaymentStatusProjectionError>[0]): never {
  throw new PaymentStatusProjectionError(code);
}

function dependency(): never {
  return fail("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
}

function projection(value: unknown) {
  try {
    return parsePaymentStatusProjection(value);
  } catch {
    return dependency();
  }
}

function event(value: unknown) {
  try {
    return parsePaymentTerminalEnvelope(value);
  } catch {
    return fail("PAYMENT_STATUS_INPUT_INVALID");
  }
}

function build(
  envelope: PaymentTerminalEnvelope,
  generationReference: unknown,
  projectedAt: unknown,
  rebuiltAt?: unknown,
) {
  try {
    return buildPaymentStatusProjection({
      event: envelope,
      generationReference,
      projectedAt,
      ...(rebuiltAt === undefined ? {} : { lastRebuiltAt: rebuiltAt }),
    });
  } catch {
    return dependency();
  }
}

export function createPaymentStatusProjectionService(ports: PaymentStatusProjectionPorts) {
  return Object.freeze({
    async consume(value: unknown) {
      const envelope = event(value);
      const candidate = build(
        envelope,
        ports.references.generateGeneration(),
        ports.references.now(),
      );
      const outcome = await ports.repository
        .consume({
          consumerName: paymentStatusProjectionConsumer,
          event: envelope,
          projection: candidate,
        })
        .catch(dependency);
      if (outcome.status === "Conflict") return fail("PAYMENT_STATUS_VERSION_CONFLICT");
      const stored = projection(outcome.projection);
      if (
        stored.snapshot.paymentIntentReference !== envelope.aggregateId ||
        !equivalentPaymentStatus(candidate, stored)
      )
        return fail("PAYMENT_STATUS_VERSION_CONFLICT");
      return Object.freeze({ status: outcome.status, projection: stored });
    },

    async rebuild(value: unknown) {
      const raw = exact(value, [
        "brandReference",
        "storeReference",
        "actorReference",
        "requestedAt",
      ]);
      let brandReference, storeReference, actorReference, requestedAt;
      try {
        brandReference = parsePaymentReference(raw.brandReference);
        storeReference = parsePaymentReference(raw.storeReference);
        actorReference = parsePaymentReference(raw.actorReference);
        requestedAt = parsePaymentInstant(raw.requestedAt);
      } catch {
        return fail("PAYMENT_STATUS_INPUT_INVALID");
      }
      const authorized = await ports.rebuild
        .authorize({
          brandReference,
          storeReference,
          actorReference,
          purpose: "RebuildPaymentStatusProjection",
          requestedAt,
        })
        .catch(dependency);
      if (authorized !== true) return fail("PAYMENT_STATUS_PERMISSION_DENIED");
      const events = await ports.rebuild
        .loadTerminalEvents({ brandReference, storeReference })
        .catch(dependency);
      let generationReference;
      try {
        generationReference = parsePaymentReference(ports.references.generateGeneration());
      } catch {
        return dependency();
      }
      const seen = new Set<string>();
      const projections = events.map((candidate) => {
        const parsed = event(candidate);
        if (
          parsed.tenantId !== brandReference ||
          parsed.storeId !== storeReference ||
          seen.has(parsed.aggregateId)
        )
          return fail("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
        seen.add(parsed.aggregateId);
        return build(parsed, generationReference, requestedAt, requestedAt);
      });
      const saved = await ports.repository
        .rebuild({
          brandReference,
          storeReference,
          generationReference,
          rebuiltAt: requestedAt,
          projections,
        })
        .catch(dependency);
      if (saved.length !== projections.length) return dependency();
      const parsedSaved = saved.map(projection);
      for (const expected of projections) {
        const actual = parsedSaved.find(
          (candidate) =>
            candidate.snapshot.paymentIntentReference === expected.snapshot.paymentIntentReference,
        );
        if (actual === undefined || !equivalentPaymentStatus(expected, actual)) return dependency();
      }
      return Object.freeze({
        status: "Rebuilt" as const,
        generationReference,
        count: parsedSaved.length,
        projections: Object.freeze(parsedSaved),
      });
    },
  });
}

function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("PAYMENT_STATUS_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function nullableReference(value: unknown): string | null {
  if (value === null) return null;
  try {
    return parsePaymentReference(value);
  } catch {
    return fail("PAYMENT_STATUS_INPUT_INVALID");
  }
}

function requiredReference(value: unknown): string {
  try {
    return parsePaymentReference(value);
  } catch {
    return fail("PAYMENT_STATUS_INPUT_INVALID");
  }
}

function nullableInstant(value: unknown): string | null {
  if (value === null) return null;
  try {
    return parsePaymentInstant(value);
  } catch {
    return fail("PAYMENT_STATUS_INPUT_INVALID");
  }
}

export function createPaymentStatusQueryService(ports: PaymentStatusQueryPorts) {
  const authorize = async (raw: Record<string, unknown>) => {
    let brandReference, storeReference, actorReference, observedAt;
    try {
      brandReference = parsePaymentReference(raw.brandReference);
      storeReference = parsePaymentReference(raw.storeReference);
      actorReference = parsePaymentReference(raw.actorReference);
      observedAt = parsePaymentInstant(raw.observedAt);
    } catch {
      return fail("PAYMENT_STATUS_INPUT_INVALID");
    }
    const allowed = await ports.authorization
      .authorize({
        brandReference,
        storeReference,
        actorReference,
        purpose: "PaymentStatusRead",
        observedAt,
      })
      .catch(dependency);
    if (allowed !== true) return fail("PAYMENT_STATUS_PERMISSION_DENIED");
    return { brandReference, storeReference, observedAt };
  };
  const scoped = (
    candidate: PaymentStatusProjection,
    brandReference: string,
    storeReference: string,
  ) => {
    if (
      candidate.snapshot.brandReference !== brandReference ||
      candidate.snapshot.storeReference !== storeReference
    )
      return dependency();
    return candidate;
  };
  return Object.freeze({
    async get(value: unknown) {
      const raw = exact(value, [
        "brandReference",
        "storeReference",
        "actorReference",
        "paymentIntentReference",
        "observedAt",
      ]);
      const scope = await authorize(raw);
      const paymentIntentReference = requiredReference(raw.paymentIntentReference);
      const result = await ports.projections
        .load({ ...scope, paymentIntentReference })
        .catch(dependency);
      if (result === null) return fail("PAYMENT_STATUS_NOT_FOUND");
      return scoped(projection(result), scope.brandReference, scope.storeReference);
    },

    async list(value: unknown) {
      const raw = exact(value, [
        "brandReference",
        "storeReference",
        "actorReference",
        "observedAt",
        "exactPaymentOrOrderReference",
        "terminalStatus",
        "occurredFrom",
        "occurredUntil",
        "afterOccurredAt",
        "afterPaymentIntentReference",
        "freshnessStatus",
        "limit",
      ]);
      const scope = await authorize(raw);
      const terminalStatus: "Succeeded" | "Failed" | null =
        raw.terminalStatus === null
          ? null
          : raw.terminalStatus === "Succeeded" || raw.terminalStatus === "Failed"
            ? raw.terminalStatus
            : fail("PAYMENT_STATUS_INPUT_INVALID");
      const freshnessStatus =
        raw.freshnessStatus === null
          ? null
          : ["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(raw.freshnessStatus))
            ? (raw.freshnessStatus as PaymentStatusFreshness)
            : fail("PAYMENT_STATUS_INPUT_INVALID");
      const occurredFrom = nullableInstant(raw.occurredFrom);
      const occurredUntil = nullableInstant(raw.occurredUntil);
      const afterOccurredAt = nullableInstant(raw.afterOccurredAt);
      const afterPaymentIntentReference = nullableReference(raw.afterPaymentIntentReference);
      if (
        !Number.isSafeInteger(raw.limit) ||
        (raw.limit as number) < 1 ||
        (raw.limit as number) > 100 ||
        (occurredFrom !== null &&
          occurredUntil !== null &&
          Date.parse(occurredFrom) > Date.parse(occurredUntil)) ||
        (afterOccurredAt === null) !== (afterPaymentIntentReference === null)
      )
        return fail("PAYMENT_STATUS_INPUT_INVALID");
      const filter = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        exactPaymentOrOrderReference: nullableReference(raw.exactPaymentOrOrderReference),
        terminalStatus,
        occurredFrom,
        occurredUntil,
        afterOccurredAt,
        afterPaymentIntentReference,
        freshnessStatus,
        limit: raw.limit as number,
      };
      const rows = await ports.projections.list(filter).catch(dependency);
      if (rows.length > filter.limit) return dependency();
      const parsed = rows.map((row) =>
        scoped(projection(row), scope.brandReference, scope.storeReference),
      );
      for (let index = 0; index < parsed.length; index += 1) {
        const current = parsed[index];
        const previous = parsed[index - 1];
        if (current === undefined) return dependency();
        const snap = current.snapshot;
        if (
          (filter.exactPaymentOrOrderReference !== null &&
            filter.exactPaymentOrOrderReference !== snap.paymentIntentReference &&
            filter.exactPaymentOrOrderReference !== snap.orderReference) ||
          (filter.terminalStatus !== null && filter.terminalStatus !== snap.terminalStatus) ||
          (filter.freshnessStatus !== null && filter.freshnessStatus !== current.freshnessStatus) ||
          (filter.occurredFrom !== null &&
            Date.parse(snap.terminalOccurredAt) < Date.parse(filter.occurredFrom)) ||
          (filter.occurredUntil !== null &&
            Date.parse(snap.terminalOccurredAt) > Date.parse(filter.occurredUntil)) ||
          (filter.afterOccurredAt !== null &&
            (Date.parse(snap.terminalOccurredAt) > Date.parse(filter.afterOccurredAt) ||
              (snap.terminalOccurredAt === filter.afterOccurredAt &&
                snap.paymentIntentReference.localeCompare(
                  filter.afterPaymentIntentReference as string,
                ) <= 0))) ||
          (previous !== undefined &&
            (Date.parse(previous.snapshot.terminalOccurredAt) <
              Date.parse(snap.terminalOccurredAt) ||
              (previous.snapshot.terminalOccurredAt === snap.terminalOccurredAt &&
                previous.snapshot.paymentIntentReference.localeCompare(
                  snap.paymentIntentReference,
                ) > 0)))
        )
          return dependency();
      }
      return Object.freeze(parsed);
    },
  });
}
