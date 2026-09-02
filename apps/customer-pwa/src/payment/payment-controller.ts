import {
  getPaymentOperationReference,
  setPaymentOperationReference,
} from "../session/customer-transaction-context.js";
import type { PaymentMode, PaymentObservation, PaymentState } from "./types.js";

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeReason = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type PaymentClientErrorCode =
  "provider_unavailable" | "service_unavailable" | "network_unknown";

export class PaymentClientError extends Error {
  readonly code: PaymentClientErrorCode;

  constructor(code: PaymentClientErrorCode) {
    super("Payment is unavailable.");
    this.name = "PaymentClientError";
    this.code = code;
  }
}

export interface CustomerPaymentClient {
  available(): boolean;
  create(operationReference: string): Promise<unknown>;
  observe(operationReference: string): Promise<unknown>;
}

export function createUnavailablePaymentClient(): CustomerPaymentClient {
  const unavailable = async (): Promise<never> => {
    throw new PaymentClientError("provider_unavailable");
  };
  return Object.freeze({ available: () => false, create: unavailable, observe: unavailable });
}

function plain(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid");
  const raw: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("invalid");
    raw[key] = descriptor.value;
  }
  return raw;
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const raw = plain(value);
  const keys = Object.keys(raw);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
    throw new Error("invalid");
  return raw;
}

function parseObservation(value: unknown, expectedOperation: string): PaymentObservation {
  const base = plain(value);
  if (
    base.schemaVersion !== 1 ||
    base.operationReference !== expectedOperation ||
    !reference.test(String(base.operationReference))
  )
    throw new Error("invalid");
  if (base.status === "Pending" || base.status === "Unknown") {
    exact(value, ["schemaVersion", "operationReference", "status"]);
    return Object.freeze({
      schemaVersion: 1,
      operationReference: expectedOperation,
      status: base.status,
    });
  }
  if (base.status === "Failed") {
    const raw = exact(value, ["schemaVersion", "operationReference", "status", "safeReasonCode"]);
    if (typeof raw.safeReasonCode !== "string" || !safeReason.test(raw.safeReasonCode))
      throw new Error("invalid");
    return Object.freeze({
      schemaVersion: 1,
      operationReference: expectedOperation,
      status: "Failed",
      safeReasonCode: raw.safeReasonCode,
    });
  }
  if (base.status === "Succeeded") {
    const raw = exact(value, ["schemaVersion", "operationReference", "status", "orderReference"]);
    if (typeof raw.orderReference !== "string" || !reference.test(raw.orderReference))
      throw new Error("invalid");
    return Object.freeze({
      schemaVersion: 1,
      operationReference: expectedOperation,
      status: "Succeeded",
      orderReference: raw.orderReference,
    });
  }
  throw new Error("invalid");
}

export interface PaymentController {
  getState(): PaymentState;
  load(): Promise<void>;
  start(): Promise<void>;
  retry(): Promise<void>;
  setOnline(value: boolean): void;
  subscribe(listener: () => void): () => void;
}

function operationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 15) | 112;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createPaymentController(
  mode: PaymentMode,
  client: CustomerPaymentClient,
  keyFactory = operationKey,
): PaymentController {
  let state: PaymentState = { status: "loading" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  const listeners = new Set<() => void>();
  const publish = (next: PaymentState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const accept = (value: unknown, operationReference: string) => {
    let observation: PaymentObservation;
    try {
      observation = parseObservation(value, operationReference);
    } catch {
      setPaymentOperationReference(null);
      publish({ status: "provider-unavailable" });
      return;
    }
    if (observation.status === "Pending") {
      publish({ status: "pending", operationReference });
    } else if (observation.status === "Unknown") {
      publish({ status: "unknown", operationReference, canRetrySameOperation: true });
    } else if (observation.status === "Failed") {
      publish({
        status: "failed",
        operationReference,
        safeReasonCode: observation.safeReasonCode,
      });
    } else {
      publish({
        status: "succeeded",
        operationReference,
        orderReference: observation.orderReference,
      });
    }
  };
  const fail = (error: unknown, operationReference: string | null) => {
    if (
      error instanceof PaymentClientError &&
      error.code === "network_unknown" &&
      operationReference
    ) {
      publish({ status: "unknown", operationReference, canRetrySameOperation: true });
      return;
    }
    setPaymentOperationReference(null);
    publish({ status: "provider-unavailable" });
  };
  const create = async (operationReference: string) => {
    if (!online) {
      publish({ status: "offline" });
      return;
    }
    publish({ status: "pending", operationReference });
    try {
      accept(await client.create(operationReference), operationReference);
    } catch (error) {
      fail(error, operationReference);
    }
  };
  const observe = async (operationReference: string) => {
    if (!online) {
      publish({ status: "offline" });
      return;
    }
    publish({ status: "pending", operationReference });
    try {
      accept(await client.observe(operationReference), operationReference);
    } catch (error) {
      fail(error, operationReference);
    }
  };
  const available = () => {
    try {
      return client.available() === true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    getState: () => state,
    async load() {
      if (!online) {
        publish({ status: "offline" });
        return;
      }
      if (mode === "handoff") {
        publish(available() ? { status: "ready" } : { status: "provider-unavailable" });
        return;
      }
      const operationReference = getPaymentOperationReference();
      if (operationReference === null || !reference.test(operationReference)) {
        setPaymentOperationReference(null);
        publish({ status: "context-missing" });
        return;
      }
      if (!available()) {
        publish({ status: "provider-unavailable" });
        return;
      }
      await observe(operationReference);
    },
    async start() {
      if (mode !== "handoff" || state.status !== "ready") return;
      const operationReference = keyFactory();
      if (!reference.test(operationReference)) {
        publish({ status: "provider-unavailable" });
        return;
      }
      setPaymentOperationReference(operationReference);
      await create(operationReference);
    },
    async retry() {
      if (state.status !== "unknown") return;
      if (mode === "result") await observe(state.operationReference);
      else await create(state.operationReference);
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) publish({ status: "offline" });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
