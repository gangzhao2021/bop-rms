const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const opaqueProof = /^[A-Za-z0-9_-]{22}$/u;
const humanCode = /^\d{6}$/u;

export interface PickupCodeView {
  readonly schemaVersion: 1;
  readonly status: "Ready";
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly storeDisplayName: string;
  readonly pickupInstruction: string;
  readonly generation: number;
  readonly proofKind: "Opaque" | "HumanCode";
  readonly proofValue: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export type PickupCodeState =
  | { readonly status: "hidden" }
  | { readonly status: "loading" }
  | { readonly status: "not-ready" }
  | { readonly status: "permission-denied" }
  | { readonly status: "not-found" }
  | { readonly status: "feature-disabled" }
  | { readonly status: "conflict" }
  | { readonly status: "unavailable" }
  | { readonly status: "offline" }
  | { readonly status: "expired" }
  | { readonly status: "ready"; readonly view: PickupCodeView; readonly refreshing: boolean };

export interface CustomerPickupCodeClient {
  load(orderReference: string): Promise<unknown>;
}

export type PickupCodeClientErrorCode =
  "permission_denied" | "not_found" | "feature_disabled" | "conflict" | "service_unavailable";

export class PickupCodeClientError extends Error {
  readonly code: PickupCodeClientErrorCode;

  constructor(code: PickupCodeClientErrorCode) {
    super("Pickup proof is unavailable.");
    this.name = "PickupCodeClientError";
    this.code = code;
  }
}

export function createUnavailablePickupCodeClient(): CustomerPickupCodeClient {
  return Object.freeze({
    async load(): Promise<never> {
      throw new PickupCodeClientError("service_unavailable");
    },
  });
}

function invalid(): never {
  throw new Error("invalid pickup proof");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return invalid();
  }
}

function normalized(value: unknown, maximum: number): string {
  if (typeof value !== "string") return invalid();
  const result = value.normalize("NFC").trim();
  if (result !== value || result.length < 1 || result.length > maximum) return invalid();
  return result;
}

function parseInstant(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    return invalid();
  return value;
}

export type PickupCodeResult = { readonly status: "NotReady" } | PickupCodeView;

export function parsePickupCodeResult(
  value: unknown,
  expectedOrderReference: string,
  expectedOrderNumber: string,
  nowMs: number,
): PickupCodeResult {
  let status: unknown;
  try {
    status =
      value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "status")?.value
        : undefined;
  } catch {
    return invalid();
  }
  const base = exact(
    value,
    status === "NotReady"
      ? ["schemaVersion", "status", "orderReference"]
      : [
          "schemaVersion",
          "status",
          "orderReference",
          "orderNumber",
          "storeDisplayName",
          "pickupInstruction",
          "generation",
          "proofKind",
          "proofValue",
          "observedAt",
          "expiresAt",
        ],
  );
  if (
    base.schemaVersion !== 1 ||
    base.orderReference !== expectedOrderReference ||
    !reference.test(String(base.orderReference))
  )
    return invalid();
  if (base.status === "NotReady") return Object.freeze({ status: "NotReady" });
  if (
    base.status !== "Ready" ||
    base.orderNumber !== expectedOrderNumber ||
    !/^[1-9][0-9]{0,18}$/u.test(String(base.orderNumber)) ||
    !Number.isSafeInteger(base.generation) ||
    (base.generation as number) < 1 ||
    (base.generation as number) > 2_147_483_647 ||
    (base.proofKind !== "Opaque" && base.proofKind !== "HumanCode") ||
    typeof base.proofValue !== "string" ||
    (base.proofKind === "Opaque" && !opaqueProof.test(base.proofValue)) ||
    (base.proofKind === "HumanCode" && !humanCode.test(base.proofValue))
  )
    return invalid();
  const observedAt = parseInstant(base.observedAt);
  const expiresAt = parseInstant(base.expiresAt);
  const observedMs = Date.parse(observedAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    observedMs > nowMs ||
    expiresMs <= nowMs ||
    expiresMs <= observedMs ||
    expiresMs - observedMs > 60 * 60 * 1000
  )
    return invalid();
  return Object.freeze({
    schemaVersion: 1,
    status: "Ready",
    orderReference: expectedOrderReference,
    orderNumber: expectedOrderNumber,
    storeDisplayName: normalized(base.storeDisplayName, 120),
    pickupInstruction: normalized(base.pickupInstruction, 500),
    generation: base.generation as number,
    proofKind: base.proofKind,
    proofValue: base.proofValue,
    observedAt,
    expiresAt,
  });
}

export interface PickupCodeController {
  getState(): PickupCodeState;
  reveal(): Promise<void>;
  refresh(): Promise<void>;
  close(): void;
  setOnline(value: boolean): void;
  dispose(): void;
  subscribe(listener: () => void): () => void;
}

export function createPickupCodeController(
  orderReference: string,
  orderNumber: string,
  client: CustomerPickupCodeClient,
  clock = () => Date.now(),
): PickupCodeController {
  let state: PickupCodeState = { status: "hidden" };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let stopped = false;
  let request = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const clearExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
  };
  const publish = (next: PickupCodeState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const clearProof = (next: PickupCodeState) => {
    request += 1;
    clearExpiry();
    publish(next);
  };
  const query = async () => {
    if (stopped || !reference.test(orderReference) || !/^[1-9][0-9]{0,18}$/u.test(orderNumber)) {
      clearProof({ status: "unavailable" });
      return;
    }
    if (!online) {
      clearProof({ status: "offline" });
      return;
    }
    const token = ++request;
    if (state.status === "ready") publish({ ...state, refreshing: true });
    else publish({ status: "loading" });
    try {
      const result = parsePickupCodeResult(
        await client.load(orderReference),
        orderReference,
        orderNumber,
        clock(),
      );
      if (stopped || !online || token !== request) return;
      clearExpiry();
      if (result.status === "NotReady") {
        publish({ status: "not-ready" });
        return;
      }
      publish({ status: "ready", view: result, refreshing: false });
      const delay = Date.parse(result.expiresAt) - clock();
      expiryTimer = setTimeout(() => clearProof({ status: "expired" }), Math.max(0, delay));
    } catch (error) {
      if (!stopped && token === request) {
        const status =
          error instanceof PickupCodeClientError
            ? error.code === "permission_denied"
              ? "permission-denied"
              : error.code === "not_found"
                ? "not-found"
                : error.code === "feature_disabled"
                  ? "feature-disabled"
                  : error.code === "conflict"
                    ? "conflict"
                    : "unavailable"
            : "unavailable";
        clearProof({ status });
      }
    }
  };
  return Object.freeze({
    getState: () => state,
    reveal: query,
    refresh: query,
    close() {
      clearProof({ status: "hidden" });
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) clearProof({ status: "offline" });
    },
    dispose() {
      stopped = true;
      request += 1;
      clearExpiry();
      listeners.clear();
      state = { status: "hidden" };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
