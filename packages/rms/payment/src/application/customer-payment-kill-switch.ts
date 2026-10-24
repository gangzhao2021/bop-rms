import {
  createFeatureControlDefinition,
  evaluateFeatureControlInScope,
  parseRolloutBucket,
  type KillSwitchDefinition,
} from "@bop/feature-control";
import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { paymentProviderAdmissionKillSwitchKey } from "./payment-kill-switch.js";
import type { PaymentIntentCreationPorts } from "./ports/payment-intent-creation-ports.js";
import type { PaymentKillSwitchPort } from "./ports/payment-kill-switch-ports.js";

export interface CustomerPaymentKillSwitchOptions {
  readonly authorization: PaymentIntentCreationPorts["authorization"];
  readonly definitions: {
    loadCurrent(input: {
      readonly key: string;
      readonly observedAt: string;
    }): Promise<readonly KillSwitchDefinition[]>;
  };
  readonly clock: { now(): string };
  /** Stable server assignment, not a caller-selected rollout bucket. */
  readonly rollout: { bucketForGuest(guestSessionReference: string): number };
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
}
const unavailable = (): never => {
  throw new Error("customer payment safety unavailable");
};
/** Request-local composition; real Guest authorization owns identity and submission access. */
export function createCustomerPaymentKillSwitch(
  options: CustomerPaymentKillSwitchOptions,
  binding: Readonly<{ paymentOperationReference: string; submissionReference: string }>,
): PaymentKillSwitchPort {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const operation = parsePaymentReference(binding.paymentOperationReference),
    submission = parsePaymentReference(binding.submissionReference);
  let pinnedGuest: string | undefined, last: string | undefined;
  const now = () => {
    const value = parsePaymentInstant(options.clock.now());
    if (last !== undefined && value < last) return unavailable();
    last = value;
    return value;
  };
  return Object.freeze({
    async evaluate(input: Parameters<PaymentKillSwitchPort["evaluate"]>[0]) {
      try {
        const raw = exactPaymentObject(input, [
          "key",
          "action",
          "brandReference",
          "storeReference",
          "evaluatedAt",
        ]);
        if (
          raw.key !== paymentProviderAdmissionKillSwitchKey ||
          raw.action !== "CreatePaymentIntent" ||
          raw.brandReference !== scope.brandReference ||
          raw.storeReference !== scope.storeReference
        )
          return unavailable();
        const at = parsePaymentInstant(raw.evaluatedAt);
        if (at > now()) return unavailable();
        const authorize = async () => {
          const value = await options.authorization.authorize({
            action: "CreatePaymentIntent",
            paymentOperationReference: operation,
            submissionReference: submission,
            observedAt: now(),
          });
          if (value === null) return unavailable();
          const data = exactPaymentObject(value, [
            "action",
            "guestSessionReference",
            "brandReference",
            "storeReference",
          ]);
          if (
            data.action !== "CreatePaymentIntent" ||
            data.brandReference !== scope.brandReference ||
            data.storeReference !== scope.storeReference
          )
            return unavailable();
          const guest = String(parsePaymentReference(data.guestSessionReference));
          if (pinnedGuest !== undefined && pinnedGuest !== guest) return unavailable();
          pinnedGuest = guest;
          return guest;
        };
        const guest = await authorize();
        const bucket = parseRolloutBucket(options.rollout.bucketForGuest(guest));
        const values = await options.definitions.loadCurrent({
          key: paymentProviderAdmissionKillSwitchKey,
          observedAt: now(),
        });
        if (
          !Array.isArray(values) ||
          Object.getPrototypeOf(values) !== Array.prototype ||
          values.length > 2 ||
          Reflect.ownKeys(values).length !== values.length + 1
        )
          return unavailable();
        const definitions = Object.freeze(
          Array.from({ length: values.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(values, String(i));
            if (!d?.enumerable || !("value" in d)) return unavailable();
            const value = createFeatureControlDefinition(d.value);
            if (
              value.kind !== "KillSwitch" ||
              value.key !== paymentProviderAdmissionKillSwitchKey ||
              value.scope.brandReference !== scope.brandReference ||
              (value.scope.storeReference !== null &&
                value.scope.storeReference !== scope.storeReference)
            )
              return unavailable();
            return value;
          }),
        );
        if (new Set(definitions.map((d) => d.scope.storeReference)).size !== definitions.length)
          return unavailable();
        await authorize();
        const completedAt = now();
        const evaluate = (evaluatedAt: string) =>
          evaluateFeatureControlInScope({
            scope,
            key: paymentProviderAdmissionKillSwitchKey,
            definitions,
            rolloutBucket: bucket,
            evaluatedAt,
          });
        const observed = evaluate(at),
          completed = evaluate(completedAt);
        const comparable = (value: typeof observed) =>
          JSON.stringify({
            control: value.effectiveControl,
            execution: value.backendExecution,
            reason: value.reason,
            mode: value.killMode,
            inFlight: value.inFlightPolicy,
          });
        if (comparable(observed) !== comparable(completed)) return unavailable();
        return observed;
      } catch {
        return unavailable();
      }
    },
  });
}
