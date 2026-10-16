const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const opaqueProof = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
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
  /** WP-2423: the six-digit code the guest reads to staff; null for a proof issued before codes. */
  readonly counterCode: string | null;
  readonly observedAt: string;
  readonly expiresAt: string;
}

/**
 * WP-2423: the order is ready but has no code to show. `CounterOrder`: staff took it at the
 * counter; `CodePending`: the code is still being issued; `CodeUnavailable`: its time window
 * ended or code checks were locked. Staff hand the order over after checking name or phone.
 */
export type PickupWithoutCodeReason = "CounterOrder" | "CodePending" | "CodeUnavailable";
export interface PickupWithoutCodeView {
  readonly status: "ReadyWithoutCode";
  readonly orderNumber: string;
  readonly reason: PickupWithoutCodeReason;
}

export type PickupCodeState =
  | { readonly status: "hidden" }
  | {
      readonly status: "ready-without-code";
      readonly orderNumber: string;
      readonly reason: PickupWithoutCodeReason;
    }
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
  subscribeContextChange?(listener: () => void): () => void;
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

export type PickupCodeResult =
  { readonly status: "NotReady" } | PickupWithoutCodeView | PickupCodeView;

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
      : status === "ReadyWithoutCode"
        ? ["schemaVersion", "status", "orderReference", "orderNumber", "reason"]
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
            "counterCode",
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
  if (base.status === "ReadyWithoutCode") {
    if (
      base.orderNumber !== expectedOrderNumber ||
      (base.reason !== "CounterOrder" &&
        base.reason !== "CodePending" &&
        base.reason !== "CodeUnavailable")
    )
      return invalid();
    return Object.freeze({
      status: "ReadyWithoutCode",
      orderNumber: expectedOrderNumber,
      reason: base.reason,
    });
  }
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
    (base.proofKind === "HumanCode" && !humanCode.test(base.proofValue)) ||
    (base.counterCode !== null &&
      (typeof base.counterCode !== "string" || !humanCode.test(base.counterCode)))
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
    counterCode: base.counterCode as string | null,
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
  /**
   * WP-2423: the order is Ready, so the code is issued within seconds. While following, a
   * not-ready or briefly unavailable answer is checked again on a short backoff until the code
   * arrives, instead of waiting for the next order status refresh.
   */
  followUntilReady?(active: boolean): void;
}

/** Retry delays after a not-ready or unavailable answer while following; the last one repeats. */
export const pickupCodeFollowDelaysMs: readonly number[] = Object.freeze([
  2_000, 3_000, 5_000, 8_000, 15_000,
]);

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
  let following = false;
  let followAttempt = 0;
  let followTimer: ReturnType<typeof setTimeout> | null = null;
  const clearFollow = () => {
    if (followTimer) clearTimeout(followTimer);
    followTimer = null;
  };
  const listeners = new Set<() => void>();
  let unsubscribeContext: (() => void) | undefined;
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
    clearFollow();
    clearExpiry();
    publish(next);
  };
  const scheduleFollow = () => {
    clearFollow();
    if (!following || stopped || !online) return;
    const delay =
      pickupCodeFollowDelaysMs[Math.min(followAttempt, pickupCodeFollowDelaysMs.length - 1)] ??
      15_000;
    followAttempt += 1;
    followTimer = setTimeout(() => {
      followTimer = null;
      if (following && !stopped) void query(true);
    }, delay);
  };
  /** A quiet follow-up keeps the current not-ready text on screen instead of flashing "checking". */
  const query = async (quiet = false): Promise<void> => {
    clearFollow();
    if (stopped || !reference.test(orderReference) || !/^[1-9][0-9]{0,18}$/u.test(orderNumber)) {
      clearProof({ status: "unavailable" });
      return;
    }
    if (!online) {
      clearProof({ status: "offline" });
      return;
    }
    const token = ++request;
    clearExpiry();
    if (!quiet) publish({ status: "loading" });
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
        scheduleFollow();
        return;
      }
      if (result.status === "ReadyWithoutCode") {
        publish({
          status: "ready-without-code",
          orderNumber: result.orderNumber,
          reason: result.reason,
        });
        // A code still being issued is followed until it arrives; the other reasons are final.
        if (result.reason === "CodePending") scheduleFollow();
        return;
      }
      followAttempt = 0;
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
        if (status === "unavailable") scheduleFollow();
      }
    }
  };
  return Object.freeze({
    getState: () => state,
    reveal: () => query(),
    refresh: () => query(),
    close() {
      clearProof({ status: "hidden" });
    },
    setOnline(value: boolean) {
      online = value;
      if (!value) {
        clearFollow();
        clearProof({ status: "offline" });
      } else if (following && state.status === "offline") void query();
    },
    followUntilReady(active: boolean) {
      if (following === active) return;
      following = active;
      followAttempt = 0;
      clearFollow();
      if (
        active &&
        (state.status === "not-ready" ||
          state.status === "unavailable" ||
          (state.status === "ready-without-code" && state.reason === "CodePending"))
      )
        scheduleFollow();
    },
    dispose() {
      stopped = true;
      following = false;
      clearFollow();
      request += 1;
      clearExpiry();
      unsubscribeContext?.();
      unsubscribeContext = undefined;
      listeners.clear();
      state = { status: "hidden" };
    },
    subscribe(listener: () => void) {
      if (stopped) return () => undefined;
      listeners.add(listener);
      if (listeners.size === 1)
        unsubscribeContext = client.subscribeContextChange?.(() =>
          clearProof({ status: "permission-denied" }),
        );
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeContext?.();
          unsubscribeContext = undefined;
          clearProof({ status: "hidden" });
        }
      };
    },
  });
}
