import {
  parsePaymentReconciliationCheck,
  PaymentReconciliationError,
  paymentReconciliationOutcomes,
  type PaymentReconciliationOutcome,
} from "./payment-reconciliation.js";
import { parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference, parseProviderReference } from "./payment-provider-adapter.js";
import type { PaymentReconciliationQueryPorts } from "./ports/payment-reconciliation-ports.js";

function fail(code: ConstructorParameters<typeof PaymentReconciliationError>[0]): never {
  throw new PaymentReconciliationError(code);
}

function dependency(): never {
  return fail("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
}

function exact(value: unknown, fields: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof PaymentReconciliationError) throw error;
    return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
  }
}

function instant(value: unknown) {
  if (value === null) return null;
  try {
    return parsePaymentInstant(value);
  } catch {
    return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
  }
}

function reference(value: unknown) {
  if (value === null) return null;
  try {
    return parsePaymentReference(value);
  } catch {
    try {
      return parseProviderReference(value);
    } catch {
      return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
    }
  }
}

export function createPaymentReconciliationQueryService(ports: PaymentReconciliationQueryPorts) {
  return Object.freeze({
    async list(value: unknown) {
      const raw = exact(value, [
        "brandReference",
        "storeReference",
        "actorReference",
        "observedAt",
        "exactReference",
        "outcome",
        "hasException",
        "checkedFrom",
        "checkedUntil",
        "afterCheckedAt",
        "afterCheckReference",
        "limit",
      ]);
      let brandReference, storeReference, actorReference, observedAt;
      try {
        brandReference = parsePaymentReference(raw.brandReference);
        storeReference = parsePaymentReference(raw.storeReference);
        actorReference = parsePaymentReference(raw.actorReference);
        observedAt = parsePaymentInstant(raw.observedAt);
      } catch {
        return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      }
      const allowed = await ports.authorization
        .authorize({
          brandReference,
          storeReference,
          actorReference,
          purpose: "PaymentReconciliationRead",
          observedAt,
        })
        .catch(dependency);
      if (allowed !== true) return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      const outcome: PaymentReconciliationOutcome | null =
        raw.outcome === null
          ? null
          : typeof raw.outcome === "string" &&
              paymentReconciliationOutcomes.includes(raw.outcome as never)
            ? (raw.outcome as PaymentReconciliationOutcome)
            : fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      const hasException =
        raw.hasException === null || typeof raw.hasException === "boolean"
          ? raw.hasException
          : fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      const checkedFrom = instant(raw.checkedFrom);
      const checkedUntil = instant(raw.checkedUntil);
      const afterCheckedAt = instant(raw.afterCheckedAt);
      const afterCheckReference = (() => {
        try {
          return raw.afterCheckReference === null
            ? null
            : parsePaymentReference(raw.afterCheckReference);
        } catch {
          return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
        }
      })();
      if (
        !Number.isSafeInteger(raw.limit) ||
        (raw.limit as number) < 1 ||
        (raw.limit as number) > 100 ||
        (checkedFrom !== null &&
          checkedUntil !== null &&
          Date.parse(checkedFrom) > Date.parse(checkedUntil)) ||
        (afterCheckedAt === null) !== (afterCheckReference === null)
      )
        return fail("PAYMENT_RECONCILIATION_INPUT_INVALID");
      const filter = {
        brandReference,
        storeReference,
        exactReference: reference(raw.exactReference),
        outcome,
        hasException,
        checkedFrom,
        checkedUntil,
        afterCheckedAt,
        afterCheckReference,
        limit: raw.limit as number,
      };
      const rows = await ports.checks.list(filter).catch(dependency);
      if (rows.length > filter.limit) return dependency();
      const parsed = rows.map((row) => {
        try {
          return parsePaymentReconciliationCheck(row);
        } catch {
          return dependency();
        }
      });
      for (let index = 0; index < parsed.length; index += 1) {
        const current = parsed[index];
        const previous = parsed[index - 1];
        if (current === undefined) return dependency();
        const exactValues = [
          current.checkReference,
          current.runReference,
          current.candidateReference,
          current.paymentIntentReference,
          current.settlementReference,
          current.exceptionReference,
        ];
        if (
          current.brandReference !== brandReference ||
          current.storeReference !== storeReference ||
          (filter.exactReference !== null && !exactValues.includes(filter.exactReference)) ||
          (filter.outcome !== null && current.outcome !== filter.outcome) ||
          (filter.hasException !== null &&
            (current.exceptionReference !== null) !== filter.hasException) ||
          (filter.checkedFrom !== null &&
            Date.parse(current.checkedAt) < Date.parse(filter.checkedFrom)) ||
          (filter.checkedUntil !== null &&
            Date.parse(current.checkedAt) > Date.parse(filter.checkedUntil)) ||
          (filter.afterCheckedAt !== null &&
            (Date.parse(current.checkedAt) > Date.parse(filter.afterCheckedAt) ||
              (current.checkedAt === filter.afterCheckedAt &&
                current.checkReference.localeCompare(filter.afterCheckReference as string) <=
                  0))) ||
          (previous !== undefined &&
            (Date.parse(previous.checkedAt) < Date.parse(current.checkedAt) ||
              (previous.checkedAt === current.checkedAt &&
                previous.checkReference.localeCompare(current.checkReference) > 0)))
        )
          return dependency();
      }
      return Object.freeze(parsed);
    },
  });
}
