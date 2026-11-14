import {
  DiningBindingClientError,
  type DiningBindingClient,
  type DiningBindingPrepared,
} from "./dining-binding-client.js";

export interface DiningBindingCoordinatorOptions {
  readonly binding: DiningBindingClient;
  readonly csrf: {
    get(): string | null;
    set(value: string): void;
    capture(): () => boolean;
  };
  readonly online: () => boolean;
  readonly generatePreparationReference: () => string;
}
export interface DiningBindingConfirmation {
  readonly status: "Bound";
  readonly operationReference: string;
}
interface Plan {
  readonly logical: string;
  readonly admission: string;
  readonly sourceCsrf: string;
  currentCsrf: string;
  current: () => boolean;
  phase: "Prepare" | "Activate" | "Recover" | "Confirmed";
  technical: string | null;
  prepared: DiningBindingPrepared | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const token = /^[A-Za-z0-9_-]{43}$/u;
function unknown(): never {
  throw new DiningBindingClientError("outcome-unknown");
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return unknown();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return unknown();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unknown();
    result[key] = descriptor.value;
  }
  return result;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return unknown();
  return value;
}
function credential(value: unknown): string {
  if (typeof value !== "string" || !token.test(value)) return unknown();
  return value;
}
function prepared(value: unknown, operation: string, csrf: string): DiningBindingPrepared {
  const raw = exact(value, [
    "status",
    "operationReference",
    "candidateCsrfToken",
    "recoveryProof",
    "expiresAt",
  ]);
  const candidateCsrfToken = credential(raw.candidateCsrfToken);
  const recoveryProof = credential(raw.recoveryProof);
  if (
    raw.status !== "Prepared" ||
    raw.operationReference !== operation ||
    new Set([csrf, candidateCsrfToken, recoveryProof]).size !== 3 ||
    typeof raw.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.expiresAt) ||
    !Number.isFinite(Date.parse(raw.expiresAt)) ||
    new Date(raw.expiresAt).toISOString() !== raw.expiresAt
  )
    return unknown();
  return Object.freeze({
    status: "Prepared",
    operationReference: operation,
    candidateCsrfToken,
    recoveryProof,
    expiresAt: raw.expiresAt,
  });
}
function confirmed(value: unknown, operation: string, csrf: string) {
  const raw = exact(value, ["status", "operationReference", "csrfToken"]);
  if (raw.status !== "Activated" || raw.operationReference !== operation || raw.csrfToken !== csrf)
    return unknown();
}

/** Opt-in foreground coordination. Candidate material remains private and is never persisted. */
export function createDiningBindingCoordinator(options: DiningBindingCoordinatorOptions) {
  let plan: Plan | null = null;
  let flight: Promise<DiningBindingConfirmation> | null = null;
  function context(current: Plan) {
    if (
      options.online() !== true ||
      options.csrf.get() !== current.currentCsrf ||
      current.current() !== true
    )
      return unknown();
  }
  function activate(current: Plan, candidate: DiningBindingPrepared) {
    context(current);
    if (current.currentCsrf !== current.sourceCsrf) return unknown();
    return options.binding.activate({
      operationReference: candidate.operationReference,
      csrfToken: current.sourceCsrf,
      candidateCsrfToken: candidate.candidateCsrfToken,
      recoveryProof: candidate.recoveryProof,
    });
  }
  function install(current: Plan, candidate: DiningBindingPrepared, value: unknown) {
    confirmed(value, candidate.operationReference, candidate.candidateCsrfToken);
    context(current);
    options.csrf.set(candidate.candidateCsrfToken);
    current.current = options.csrf.capture();
    current.currentCsrf = candidate.candidateCsrfToken;
    context(current);
    current.prepared = null;
    current.phase = "Confirmed";
  }
  async function execute(current: Plan): Promise<DiningBindingConfirmation> {
    try {
      context(current);
      if (current.phase === "Confirmed") {
        if (current.technical === null) return unknown();
        const result = await options.binding.complete({
          operationReference: current.technical,
          csrfToken: current.currentCsrf,
        });
        context(current);
        confirmed(result, current.technical, current.currentCsrf);
      } else {
        if (current.phase === "Prepare") {
          const operation = reference(options.generatePreparationReference());
          if (operation === current.logical || operation === current.technical) return unknown();
          current.technical = operation;
          context(current);
          const result = await options.binding.prepare({
            operationReference: operation,
            csrfToken: current.sourceCsrf,
            admissionReference: current.admission,
          });
          context(current);
          current.prepared = prepared(result, operation, current.sourceCsrf);
          current.phase = "Activate";
        }
        const candidate = current.prepared;
        if (candidate === null) return unknown();
        if (current.phase === "Activate") {
          context(current);
          current.phase = "Recover";
          install(current, candidate, await activate(current, candidate));
        } else if (current.phase === "Recover") {
          context(current);
          let result: unknown;
          try {
            result = await options.binding.complete({
              operationReference: candidate.operationReference,
              csrfToken: candidate.candidateCsrfToken,
            });
          } catch {
            // Completion failure is not rollback evidence. Only the same acknowledged candidate may activate.
            result = await activate(current, candidate);
          }
          install(current, candidate, result);
        }
      }
      context(current);
      return Object.freeze({ status: "Bound", operationReference: current.logical });
    } catch {
      return unknown();
    }
  }
  return Object.freeze({
    bind(value: unknown): Promise<DiningBindingConfirmation> {
      let logical: string;
      let admission: string;
      try {
        const input = exact(value, ["operationReference", "admissionReference"]);
        logical = reference(input.operationReference);
        admission = reference(input.admissionReference);
      } catch {
        return Promise.reject(new DiningBindingClientError("request-invalid"));
      }
      if (flight !== null)
        return plan?.logical === logical && plan.admission === admission
          ? flight
          : Promise.reject(new DiningBindingClientError("outcome-unknown"));
      try {
        if (plan !== null && plan.logical === logical && plan.admission !== admission)
          return unknown();
        if (plan === null || plan.logical !== logical) {
          if (plan !== null && plan.phase !== "Prepare") return unknown();
          const sourceCsrf = credential(options.csrf.get());
          plan = {
            logical,
            admission,
            sourceCsrf,
            currentCsrf: sourceCsrf,
            current: options.csrf.capture(),
            phase: "Prepare",
            technical: null,
            prepared: null,
          };
        }
        const currentPlan = plan;
        context(currentPlan);
        const current = Promise.resolve()
          .then(() => execute(currentPlan))
          .then(
            (result) => {
              try {
                context(currentPlan);
                return result;
              } catch {
                return unknown();
              }
            },
            () => unknown(),
          );
        flight = current;
        void current.then(
          () => {
            if (flight === current) flight = null;
          },
          () => {
            if (flight === current) flight = null;
          },
        );
        return current;
      } catch {
        return Promise.reject(new DiningBindingClientError("outcome-unknown"));
      }
    },
  });
}
