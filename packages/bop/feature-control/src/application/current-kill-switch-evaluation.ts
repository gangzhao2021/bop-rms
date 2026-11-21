import { revalidateTenantContext } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import {
  createFeatureControlDefinition,
  evaluateFeatureControl,
  parseFeatureControlReference,
  parseFeatureControlKey,
  parseFeatureControlInstant,
  parseRolloutBucket,
  type FeatureControlEvaluation,
  type KillSwitchDefinition,
} from "../contracts/feature-control.js";

export class CurrentKillSwitchEvaluationError extends Error {
  readonly code = "FEATURE_CONTROL_EVALUATION_UNAVAILABLE";
  constructor() {
    super("current Kill Switch evaluation unavailable");
    this.name = "CurrentKillSwitchEvaluationError";
  }
}
export interface CurrentKillSwitchEvaluationPorts {
  readonly clock: { now(): string };
  /** Bound to the current request/session; resolves current authority, never a cached login snapshot. */
  readonly context: {
    resolveCurrent(input: { readonly observedAt: string }): Promise<TenantContext | null>;
  };
  readonly definitions: {
    loadCurrent(input: {
      readonly key: string;
      readonly observedAt: string;
    }): Promise<readonly KillSwitchDefinition[]>;
  };
}
const fail = (): never => {
  throw new CurrentKillSwitchEvaluationError();
};
const admission = (value: FeatureControlEvaluation) =>
  JSON.stringify({
    control: value.effectiveControl,
    backend: value.backendExecution,
    reason: value.reason,
    mode: value.killMode,
    inFlightPolicy: value.inFlightPolicy,
  });
/** Current observation only; consumers re-evaluate at each new-work boundary. */
export function createCurrentKillSwitchEvaluationService(
  ports: CurrentKillSwitchEvaluationPorts,
  scope: Readonly<{ brandReference: string; storeReference: string | null }>,
) {
  const brand: string = parseFeatureControlReference(scope.brandReference);
  const store: string | null =
    scope.storeReference === null ? null : parseFeatureControlReference(scope.storeReference);
  return Object.freeze({
    async evaluate(
      input: Readonly<{ key: string; rolloutBucket: number; evaluatedAt: string }>,
    ): Promise<FeatureControlEvaluation> {
      try {
        const key = parseFeatureControlKey(input.key),
          rolloutBucket = parseRolloutBucket(input.rolloutBucket);
        const evaluatedAt = parseFeatureControlInstant(input.evaluatedAt);
        const startedAt = parseFeatureControlInstant(ports.clock.now());
        if (evaluatedAt > startedAt) return fail();
        const authorize = async (at: string) => {
          const value = await ports.context.resolveCurrent({ observedAt: at });
          if (value === null) return fail();
          const context = revalidateTenantContext(value);
          if (
            context.brand.brandReference !== brand ||
            (context.store?.storeReference ?? null) !== store ||
            context.resolvedAt !== at
          )
            return fail();
          return context;
        };
        const first = await authorize(startedAt);
        const identity = JSON.stringify(first.actor);
        const readAt = parseFeatureControlInstant(ports.clock.now());
        if (readAt < startedAt) return fail();
        const raw = await ports.definitions.loadCurrent({ key, observedAt: readAt });
        if (
          !Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Array.prototype ||
          raw.length > 2 ||
          Reflect.ownKeys(raw).length !== raw.length + 1
        )
          return fail();
        const definitions = Object.freeze(
          Array.from({ length: raw.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
            if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
            const value: unknown = descriptor.value;
            const definition = createFeatureControlDefinition(value);
            if (
              definition.kind !== "KillSwitch" ||
              definition.key !== key ||
              definition.scope.brandReference !== brand ||
              (definition.scope.storeReference !== null &&
                definition.scope.storeReference !== store)
            )
              return fail();
            return definition;
          }),
        );
        if (new Set(definitions.map((d) => d.scope.storeReference)).size !== definitions.length)
          return fail();
        const completedAt = parseFeatureControlInstant(ports.clock.now());
        if (completedAt < readAt) return fail();
        const current = await authorize(completedAt);
        if (JSON.stringify(current.actor) !== identity) return fail();
        const returnedAt = parseFeatureControlInstant(ports.clock.now());
        if (returnedAt < completedAt) return fail();
        const observed = evaluateFeatureControl({
          tenantContext: current,
          key,
          definitions,
          rolloutBucket,
          evaluatedAt,
        });
        const completed = evaluateFeatureControl({
          tenantContext: current,
          key,
          definitions,
          rolloutBucket,
          evaluatedAt: returnedAt,
        });
        if (admission(observed) !== admission(completed)) return fail();
        return observed;
      } catch {
        return fail();
      }
    },
  });
}
