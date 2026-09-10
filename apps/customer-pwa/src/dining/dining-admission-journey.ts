import {
  createDiningBindingCoordinator,
  type DiningBindingCoordinatorOptions,
  type DiningBindingConfirmation,
} from "./dining-binding-coordinator.js";
import type { DiningJoinClient } from "./dining-join-client.js";

export class DiningAdmissionJourneyError extends Error {
  constructor(readonly code: "request-invalid" | "outcome-unknown") {
    super("dining admission is unavailable");
    this.name = "DiningAdmissionJourneyError";
  }
}
export interface DiningAdmissionJourneyOptions extends DiningBindingCoordinatorOptions {
  readonly join: DiningJoinClient;
  readonly generateBindingOperationReference: () => string;
}
interface Plan {
  readonly operation: string;
  rawJoin: string | null;
  csrf: string;
  current: () => boolean;
  phase: "Join" | "Bind" | "Bound";
  admission: string | null;
  bindingOperation: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const token = /^[A-Za-z0-9_-]{43}$/u;
function unknown(): never {
  throw new DiningAdmissionJourneyError("outcome-unknown");
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
  const record: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unknown();
    record[key] = descriptor.value;
  }
  return record;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return unknown();
  return value;
}
function csrf(value: unknown): string {
  if (typeof value !== "string" || !token.test(value)) return unknown();
  return value;
}
function joinCredential(value: unknown): string {
  if (
    typeof value !== "string" ||
    !(/^[0-9]{6}$/u.test(value) || /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value))
  )
    return unknown();
  return value;
}
/** One foreground admission intent. Resume needs no raw Join credential after receipt validation. */
export function createDiningAdmissionJourney(options: DiningAdmissionJourneyOptions) {
  let plan: Plan | null = null;
  let flight: Promise<DiningBindingConfirmation> | null = null;
  function context(current: Plan) {
    if (
      options.online() !== true ||
      options.csrf.get() !== current.csrf ||
      current.current() !== true
    )
      return unknown();
  }
  const binding = createDiningBindingCoordinator({
    binding: options.binding,
    online: options.online,
    generatePreparationReference() {
      if (plan === null) return unknown();
      context(plan);
      const value = reference(options.generatePreparationReference());
      if (value === plan.operation) return unknown();
      return value;
    },
    csrf: {
      get: () => options.csrf.get(),
      capture: () => options.csrf.capture(),
      set(value) {
        const current = plan;
        if (current === null || current.phase !== "Bind") return unknown();
        context(current);
        const next = csrf(value);
        options.csrf.set(next);
        current.csrf = next;
        current.current = options.csrf.capture();
        context(current);
      },
    },
  });
  async function execute(current: Plan): Promise<DiningBindingConfirmation> {
    context(current);
    if (current.phase === "Join") {
      if (current.rawJoin === null) return unknown();
      const result = await options.join.join({
        operationReference: current.operation,
        csrfToken: current.csrf,
        joinCredential: current.rawJoin,
      });
      context(current);
      const receipt = exact(result, ["status", "operationReference", "admissionReference"]);
      const admission = reference(receipt.admissionReference);
      if (receipt.status !== "Joined" || receipt.operationReference !== current.operation)
        return unknown();
      current.admission = admission;
      current.rawJoin = null;
      current.phase = "Bind";
    }
    context(current);
    if (current.admission === null) return unknown();
    if (current.bindingOperation === null) {
      const value = reference(options.generateBindingOperationReference());
      if (value === current.operation) return unknown();
      current.bindingOperation = value;
      context(current);
    }
    const result = await binding.bind({
      operationReference: current.bindingOperation,
      admissionReference: current.admission,
    });
    context(current);
    const receipt = exact(result, ["status", "operationReference"]);
    if (receipt.status !== "Bound" || receipt.operationReference !== current.bindingOperation)
      return unknown();
    current.phase = "Bound";
    return Object.freeze({ status: "Bound", operationReference: current.operation });
  }
  function run(current: Plan): Promise<DiningBindingConfirmation> {
    try {
      context(current);
      if (flight !== null) return flight;
      const pending = Promise.resolve()
        .then(() => execute(current))
        .then((result) => {
          context(current);
          return result;
        })
        .catch(() => unknown());
      flight = pending;
      void pending.then(
        () => {
          if (flight === pending) flight = null;
        },
        () => {
          if (flight === pending) flight = null;
        },
      );
      return pending;
    } catch {
      return Promise.reject(new DiningAdmissionJourneyError("outcome-unknown"));
    }
  }
  return Object.freeze({
    start(value: unknown): Promise<DiningBindingConfirmation> {
      let operation: string, rawJoin: string;
      try {
        const input = exact(value, ["operationReference", "joinCredential"]);
        operation = reference(input.operationReference);
        rawJoin = joinCredential(input.joinCredential);
      } catch {
        return Promise.reject(new DiningAdmissionJourneyError("request-invalid"));
      }
      try {
        if (plan !== null) {
          if (
            flight !== null &&
            plan.phase === "Join" &&
            plan.operation === operation &&
            plan.rawJoin === rawJoin
          )
            return run(plan);
          return unknown();
        }
        const source = csrf(options.csrf.get());
        const candidate: Plan = {
          operation,
          rawJoin,
          csrf: source,
          current: options.csrf.capture(),
          phase: "Join",
          admission: null,
          bindingOperation: null,
        };
        context(candidate);
        plan = candidate;
        return run(candidate);
      } catch {
        return Promise.reject(new DiningAdmissionJourneyError("outcome-unknown"));
      }
    },
    resume(value: unknown): Promise<DiningBindingConfirmation> {
      let operation: string;
      try {
        operation = reference(exact(value, ["operationReference"]).operationReference);
      } catch {
        return Promise.reject(new DiningAdmissionJourneyError("request-invalid"));
      }
      if (plan === null || plan.operation !== operation)
        return Promise.reject(new DiningAdmissionJourneyError("outcome-unknown"));
      return run(plan);
    },
  });
}
