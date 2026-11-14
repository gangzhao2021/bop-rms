import type { CartBindingClient, CartBindingPrepared } from "./cart-binding-client.js";
import type { CustomerCartClient } from "./cart-client.js";
import { CartClientError, type CartView } from "./types.js";

export interface PickupCartCreationOptions {
  readonly binding: CartBindingClient;
  readonly cart: Pick<CustomerCartClient, "loadCurrent">;
  readonly csrf: {
    get(): string | null;
    set(value: string): void;
    /** Capture an opaque generation; every external set, including same-value resets, invalidates it. */
    capture(): () => boolean;
  };
  readonly generatePreparationReference: () => string;
  readonly online: () => boolean;
}
interface Plan {
  readonly logicalReference: string;
  readonly sourceCsrf: string;
  readCsrf: string;
  contextCurrent: () => boolean;
  phase: "Locate" | "Prepare" | "Activate" | "Recover" | "Read";
  preparationReference: string | null;
  prepared: CartBindingPrepared | null;
  cartReference: string | null;
  completed: boolean;
}
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const unknown = (): never => {
  throw new CartClientError("network_unknown");
};
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
  if (typeof value !== "string" || !referencePattern.test(value)) return unknown();
  return value;
}
function credential(value: unknown): string {
  if (typeof value !== "string" || !credentialPattern.test(value)) return unknown();
  return value;
}
function prepared(
  value: unknown,
  operationReference: string,
  sourceCsrf: string,
): CartBindingPrepared {
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
    raw.operationReference !== operationReference ||
    candidateCsrfToken === sourceCsrf ||
    recoveryProof === sourceCsrf ||
    recoveryProof === candidateCsrfToken ||
    typeof raw.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.expiresAt) ||
    !Number.isFinite(Date.parse(raw.expiresAt)) ||
    new Date(raw.expiresAt).toISOString() !== raw.expiresAt
  )
    return unknown();
  return Object.freeze({
    status: "Prepared",
    operationReference,
    candidateCsrfToken,
    recoveryProof,
    expiresAt: raw.expiresAt,
  });
}

/** Opt-in create adapter. All candidate credentials remain in private foreground memory. */
export function createPickupCartCreationCoordinator(
  options: PickupCartCreationOptions,
): Pick<CustomerCartClient, "createCart"> {
  let plan: Plan | null = null;
  let flight: Promise<CartView> | null = null;
  const online = () => {
    if (options.online() !== true) return unknown();
  };
  const generation = (current: Plan) => {
    if (current.contextCurrent() !== true) return unknown();
  };
  const context = (csrf: string, current: Plan) => {
    generation(current);
    if (options.csrf.get() !== csrf) return unknown();
  };
  const read = async (current: Plan) => {
    online();
    context(current.readCsrf, current);
    const result = await options.cart.loadCurrent();
    context(current.readCsrf, current);
    if (
      result !== null &&
      (result.schemaVersion !== 1 ||
        result.cart.orderType !== "Pickup" ||
        !referencePattern.test(result.cart.cartReference) ||
        (current.cartReference !== null && current.cartReference !== result.cart.cartReference))
    )
      return unknown();
    return result;
  };
  const activate = (current: Plan, candidate: CartBindingPrepared) => {
    online();
    context(current.sourceCsrf, current);
    return options.binding.activate({
      operationReference: candidate.operationReference,
      csrfToken: current.sourceCsrf,
      candidateCsrfToken: candidate.candidateCsrfToken,
      recoveryProof: candidate.recoveryProof,
    });
  };
  const confirm = (current: Plan, candidate: CartBindingPrepared, result: unknown) => {
    const raw = exact(result, ["status", "operationReference", "csrfToken"]);
    if (
      raw.status !== "Activated" ||
      raw.operationReference !== candidate.operationReference ||
      raw.csrfToken !== candidate.candidateCsrfToken
    )
      return unknown();
    generation(current);
    const existing = options.csrf.get();
    if (
      existing !== null &&
      existing !== current.sourceCsrf &&
      existing !== candidate.candidateCsrfToken
    )
      return unknown();
    options.csrf.set(candidate.candidateCsrfToken);
    current.contextCurrent = options.csrf.capture();
    context(candidate.candidateCsrfToken, current);
    current.readCsrf = candidate.candidateCsrfToken;
    current.phase = "Read";
    current.prepared = null;
  };
  const execute = async (current: Plan): Promise<CartView> => {
    try {
      online();
      generation(current);
      if (current.phase === "Locate") {
        const existing = await read(current);
        if (existing !== null) {
          current.phase = "Read";
          current.cartReference = existing.cart.cartReference;
          current.completed = true;
          return existing;
        }
        current.phase = "Prepare";
      }
      if (current.phase === "Prepare") {
        online();
        context(current.sourceCsrf, current);
        const operationReference = reference(options.generatePreparationReference());
        if (
          operationReference === current.logicalReference ||
          operationReference === current.preparationReference
        )
          return unknown();
        current.preparationReference = operationReference;
        const result = await options.binding.prepare({
          operationReference,
          csrfToken: current.sourceCsrf,
        });
        context(current.sourceCsrf, current);
        current.prepared = prepared(result, operationReference, current.sourceCsrf);
        current.phase = "Activate";
      }
      if (current.phase === "Activate") {
        online();
        context(current.sourceCsrf, current);
        const candidate = current.prepared;
        if (candidate === null) return unknown();
        current.phase = "Recover";
        confirm(current, candidate, await activate(current, candidate));
      } else if (current.phase === "Recover") {
        online();
        generation(current);
        const candidate = current.prepared;
        if (candidate === null) return unknown();
        let result: unknown;
        try {
          result = await options.binding.complete({
            operationReference: candidate.operationReference,
            csrfToken: candidate.candidateCsrfToken,
          });
        } catch {
          // Completion does not prove activation occurred. The same candidate may still be prepared.
          // Original-context authorization prevents a second activation after predecessor revocation.
          result = await activate(current, candidate);
        }
        confirm(current, candidate, result);
      }
      const result = await read(current);
      if (result === null) return unknown();
      current.cartReference = result.cart.cartReference;
      current.completed = true;
      return result;
    } catch (error) {
      try {
        generation(current);
      } catch {
        return unknown();
      }
      if (current.phase === "Locate" && error instanceof CartClientError) throw error;
      return unknown();
    }
  };
  return Object.freeze({
    createCart(input: { readonly operationReference: string }): Promise<CartView> {
      let logicalReference: string;
      try {
        logicalReference = reference(exact(input, ["operationReference"]).operationReference);
      } catch {
        return Promise.reject(new CartClientError("cart_request_invalid"));
      }
      if (flight !== null)
        return plan?.logicalReference === logicalReference
          ? flight
          : Promise.reject(new CartClientError("network_unknown"));
      try {
        online();
        if (plan === null || plan.logicalReference !== logicalReference) {
          if (plan !== null && !plan.completed && !["Locate", "Prepare"].includes(plan.phase))
            return unknown();
          const source = options.csrf.get();
          if (source === null) throw new CartClientError("cart_session_expired");
          const sourceCsrf = credential(source);
          plan = {
            logicalReference,
            sourceCsrf,
            readCsrf: sourceCsrf,
            contextCurrent: options.csrf.capture(),
            phase: "Locate",
            preparationReference: null,
            prepared: null,
            cartReference: null,
            completed: false,
          };
        }
        const currentPlan = plan;
        const current = Promise.resolve().then(() => execute(currentPlan));
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
      } catch (error) {
        return Promise.reject(
          error instanceof CartClientError ? error : new CartClientError("network_unknown"),
        );
      }
    },
  });
}
