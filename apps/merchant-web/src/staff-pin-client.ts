import { displayLocale, t } from "./i18n/i18n.js";
/**
 * WP-2423 (Owner-approved design "A"): device-bound six-digit staff PIN quick switch.
 *
 * A manager sets up a shared store tablet; each staff member sets their own PIN after a full
 * sign-in; on a set-up tablet staff switch to themselves with the PIN. A PIN is sent once, never
 * kept, logged, put in a URL or stored in the browser. Responses are parsed as closed records.
 */

export interface SignInEntry {
  readonly path: string;
  readonly testOnly: boolean;
}
export interface SwitchStaffChoice {
  /** Opaque token the server gave this tablet for the person; sent back as is with the PIN. */
  readonly choice: string;
  readonly name: string;
}
export type StaffSwitchRead =
  | {
      readonly kind: "Ready";
      readonly storeLabel: string;
      readonly timeZone: string;
      readonly staff: readonly SwitchStaffChoice[];
      readonly fullSignIn: SignInEntry;
    }
  | { readonly kind: "NotRegistered"; readonly fullSignIn: SignInEntry };

export type PinState = "NotSet" | "Set" | "Reset";
export interface PinRecord {
  readonly state: PinState;
  readonly changedAt: string | null;
  readonly lockedUntil: string | null;
}
export interface PinStatus {
  readonly pin: PinRecord;
  readonly signIn: "Account" | "Pin";
  readonly verifiedUntil: string | null;
}
export interface StoreDevice {
  readonly device: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly registeredBy: string | null;
  readonly lastUsedAt: string | null;
}
export interface StaffPinRow extends PinRecord {
  readonly staff: string;
  readonly name: string;
}
export interface StoreDevicesRead {
  readonly thisDevice: { readonly device: string; readonly label: string } | null;
  readonly devices: readonly StoreDevice[] | null;
  readonly staffPins: readonly StaffPinRow[] | null;
}

export type StaffPinFailure =
  | "Rejected"
  | "Locked"
  | "Busy"
  | "NotRegistered"
  /** The person picked is no longer on this tablet's list (it changed since it was shown). */
  | "NotListed"
  | "Invalid"
  | "FullSignInRequired"
  | "Denied"
  | "AlreadyRegistered"
  | "PinNotSet"
  | "NotFound"
  | "Offline"
  | "Unavailable";
export type PinInvalidReason = "Format" | "Mismatch" | "TooSimple";

export class StaffPinError extends Error {
  constructor(
    readonly code: StaffPinFailure,
    readonly detail: {
      readonly lockedUntil?: string;
      readonly retryAfterSeconds?: number;
      readonly reason?: PinInvalidReason;
    } = {},
  ) {
    super(t("Staff PIN request was not completed"));
    this.name = "StaffPinError";
  }
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const PATH = /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,200}$/u;
const CSRF = /^[A-Za-z0-9_-]{43}$/u;
const OPAQUE = /^[A-Za-z0-9_.:=-]{1,200}$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,120}$/u;
const PIN = /^[0-9]{6}$/u;
const TIMEOUT_MS = 15_000;

const invalid = (): never => {
  throw new StaffPinError("Unavailable");
};
function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Readonly<Record<string, unknown>>;
}
const text = (value: unknown): string =>
  typeof value === "string" && SAFE_TEXT.test(value) ? value : invalid();
const opaque = (value: unknown): string =>
  typeof value === "string" && OPAQUE.test(value) ? value : invalid();
const instant = (value: unknown): string =>
  typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : invalid();
const optionalInstant = (value: unknown): string | null => (value === null ? null : instant(value));
const path = (value: unknown): string =>
  typeof value === "string" && PATH.test(value) ? value : invalid();
function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return invalid();
  try {
    new Intl.DateTimeFormat(displayLocale(), { timeZone: value });
  } catch {
    return invalid();
  }
  return value;
}
function signInEntry(value: unknown): SignInEntry {
  const raw = record(value, ["path", "testOnly"]);
  if (typeof raw.testOnly !== "boolean") return invalid();
  return Object.freeze({ path: path(raw.path), testOnly: raw.testOnly });
}
const pinStates: readonly PinState[] = ["NotSet", "Set", "Reset"];
function pinRecord(value: unknown): PinRecord {
  const raw = record(value, ["state", "changedAt", "lockedUntil"]);
  if (!pinStates.includes(raw.state as PinState)) return invalid();
  return Object.freeze({
    state: raw.state as PinState,
    changedAt: optionalInstant(raw.changedAt),
    lockedUntil: optionalInstant(raw.lockedUntil),
  });
}
function list<T>(value: unknown, item: (entry: unknown) => T, max = 500): readonly T[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return Object.freeze(value.map(item));
}
function storeDevice(value: unknown): StoreDevice {
  const raw = record(value, ["device", "label", "registeredAt", "registeredBy", "lastUsedAt"]);
  return Object.freeze({
    device: opaque(raw.device),
    label: text(raw.label),
    registeredAt: instant(raw.registeredAt),
    registeredBy: raw.registeredBy === null ? null : text(raw.registeredBy),
    lastUsedAt: optionalInstant(raw.lastUsedAt),
  });
}
function staffPinRow(value: unknown): StaffPinRow {
  const raw = record(value, ["staff", "name", "state", "changedAt", "lockedUntil"]);
  const pin = pinRecord({
    state: raw.state,
    changedAt: raw.changedAt,
    lockedUntil: raw.lockedUntil,
  });
  return Object.freeze({ staff: opaque(raw.staff), name: text(raw.name), ...pin });
}

export function parseStaffSwitch(status: number, value: unknown): StaffSwitchRead {
  if (status === 200) {
    const raw = record(value, ["storeLabel", "timeZone", "staff", "fullSignIn"]);
    return Object.freeze({
      kind: "Ready",
      storeLabel: text(raw.storeLabel),
      timeZone: timeZone(raw.timeZone),
      staff: list(raw.staff, (entry) => {
        const item = record(entry, ["choice", "name"]);
        return Object.freeze({ choice: opaque(item.choice), name: text(item.name) });
      }),
      fullSignIn: signInEntry(raw.fullSignIn),
    });
  }
  if (status === 404) {
    const raw = record(value, ["error", "fullSignIn"]);
    if (raw.error !== "device_not_registered") return invalid();
    return Object.freeze({ kind: "NotRegistered", fullSignIn: signInEntry(raw.fullSignIn) });
  }
  return invalid();
}
export function parsePinStatus(value: unknown): PinStatus {
  const raw = record(value, ["pin", "signIn", "verifiedUntil"]);
  if (raw.signIn !== "Account" && raw.signIn !== "Pin") return invalid();
  return Object.freeze({
    pin: pinRecord(raw.pin),
    signIn: raw.signIn,
    verifiedUntil: optionalInstant(raw.verifiedUntil),
  });
}
export function parseStoreDevices(value: unknown): StoreDevicesRead {
  const raw = record(value, ["thisDevice", "devices", "staffPins"]);
  let thisDevice: StoreDevicesRead["thisDevice"] = null;
  if (raw.thisDevice !== null) {
    const item = record(raw.thisDevice, ["device", "label"]);
    thisDevice = Object.freeze({ device: opaque(item.device), label: text(item.label) });
  }
  return Object.freeze({
    thisDevice,
    devices: raw.devices === null ? null : list(raw.devices, storeDevice),
    staffPins: raw.staffPins === null ? null : list(raw.staffPins, staffPinRow),
  });
}

/** Mirrors the server's easy-PIN rule for early feedback; the server stays authoritative. */
export function isTrivialPin(pin: string): boolean {
  if (!PIN.test(pin)) return false;
  const digits = [...pin].map(Number);
  const step = (delta: number) =>
    digits.every((digit, index) => index === 0 || digit - (digits[index - 1] ?? 0) === delta);
  if (step(0) || step(1) || step(-1)) return true;
  const repeats = (size: number) => pin === pin.slice(0, size).repeat(6 / size);
  return repeats(2) || repeats(3);
}
/** Local check before sending; the same reasons the server answers with. */
export function checkNewPin(pin: string, confirmation: string): PinInvalidReason | null {
  if (!PIN.test(pin)) return "Format";
  if (pin !== confirmation) return "Mismatch";
  if (isTrivialPin(pin)) return "TooSimple";
  return null;
}
export const validDeviceLabel = (label: string): boolean => {
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(trimmed);
};

async function json(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
function errorCode(value: unknown): string | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : null;
}
/** The shared answers: refused (sign-in or permission), unavailable. */
function common(status: number, code: string | null): never {
  if (status === 403 && code === "full_sign_in_required")
    throw new StaffPinError("FullSignInRequired");
  if (status === 401 || status === 403) throw new StaffPinError("Denied");
  throw new StaffPinError("Unavailable");
}

export interface StaffPinClient {
  staffSwitch(signal?: AbortSignal): Promise<StaffSwitchRead>;
  unlock(choice: string, pin: string): Promise<{ readonly next: string }>;
  pinStatus(signal?: AbortSignal): Promise<PinStatus>;
  setPin(pin: string, confirmation: string): Promise<PinRecord>;
  devices(signal?: AbortSignal): Promise<StoreDevicesRead>;
  registerDevice(label: string): Promise<StoreDevice>;
  revokeDevice(device: string): Promise<{ readonly signedOut: number }>;
  resetPin(staff: string): Promise<PinRecord>;
  /**
   * v15 cbff9d6f: on a registered tablet with nobody signed in, whether the orders this screen was
   * warning about still wait for acceptance (`acceptBy` null once they no longer do).
   */
  refundRecheck(orderNumbers: readonly string[], signal?: AbortSignal): Promise<RefundRecheck>;
}

export interface RefundRecheck {
  readonly checkedAt: string;
  readonly orders: readonly { readonly orderNumber: string; readonly acceptBy: string | null }[];
}
const ORDER_NUMBER = /^[A-Za-z0-9-]{1,20}$/u;
/** The tablet re-check answer, as a closed record naming only the asked orders. */
export function parseRefundRecheck(value: unknown, asked: readonly string[]): RefundRecheck {
  const raw = record(value, ["checkedAt", "orders"]);
  const orders = list(raw.orders, (entry) => {
    const order = record(entry, ["orderNumber", "acceptBy"]);
    const orderNumber =
      typeof order.orderNumber === "string" && ORDER_NUMBER.test(order.orderNumber)
        ? order.orderNumber
        : invalid();
    return Object.freeze({ orderNumber, acceptBy: optionalInstant(order.acceptBy) });
  });
  if (
    orders.length !== asked.length ||
    orders.some((order, index) => order.orderNumber !== asked[index])
  )
    return invalid();
  return Object.freeze({ checkedAt: instant(raw.checkedAt), orders });
}

export function createStaffPinClient(
  csrf: string | null = null,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): StaffPinClient {
  async function send(
    target: string,
    init: { method: "GET" } | { method: "POST"; body: unknown; csrf: boolean },
    signal?: AbortSignal,
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.method === "POST") {
      headers["Content-Type"] = "application/json";
      if (init.csrf) {
        if (csrf === null || !CSRF.test(csrf)) throw new StaffPinError("Unavailable");
        headers["X-BOP-CSRF"] = csrf;
      }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetcher(target, {
        method: init.method,
        headers,
        ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new StaffPinError(signal?.aborted ? "Unavailable" : "Offline");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    return { status: response.status, data: await json(response) };
  }
  const guard = <T>(parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      if (error instanceof StaffPinError) throw error;
      throw new StaffPinError("Unavailable");
    }
  };
  return Object.freeze({
    async staffSwitch(signal?: AbortSignal) {
      const { status, data } = await send("/merchant/staff-switch", { method: "GET" }, signal);
      if (status === 200 || status === 404) return guard(() => parseStaffSwitch(status, data));
      throw new StaffPinError("Unavailable");
    },
    async unlock(choice: string, pin: string) {
      if (!PIN.test(pin)) throw new StaffPinError("Rejected");
      if (!OPAQUE.test(choice)) throw new StaffPinError("Unavailable");
      const { status, data } = await send("/merchant/staff-switch/unlock", {
        method: "POST",
        body: { choice, pin },
        csrf: false,
      });
      const code = errorCode(data);
      if (status === 200)
        return guard(() => {
          const raw = record(data, ["status", "next"]);
          if (raw.status !== "SignedIn") return invalid();
          return Object.freeze({ next: path(raw.next) });
        });
      if (status === 401 && code === "pin_rejected") throw new StaffPinError("Rejected");
      if (status === 423 && code === "pin_locked") {
        const lockedUntil = guard(() =>
          instant((data as { lockedUntil?: unknown } | null)?.lockedUntil),
        );
        throw new StaffPinError("Locked", { lockedUntil });
      }
      if (status === 429) {
        const seconds = Number((data as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds);
        throw new StaffPinError("Busy", {
          retryAfterSeconds:
            Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : 60,
        });
      }
      if (status === 404 && code === "device_not_registered")
        throw new StaffPinError("NotRegistered");
      if (status === 409 && code === "staff_not_listed") throw new StaffPinError("NotListed");
      throw new StaffPinError("Unavailable");
    },
    async refundRecheck(orderNumbers: readonly string[], signal?: AbortSignal) {
      if (
        orderNumbers.length === 0 ||
        orderNumbers.length > 10 ||
        orderNumbers.some((value) => !ORDER_NUMBER.test(value))
      )
        throw new StaffPinError("Invalid");
      const asked = [...orderNumbers];
      const { status, data } = await send(
        "/merchant/staff-switch/refund-recheck",
        { method: "POST", body: { orderNumbers: asked }, csrf: false },
        signal,
      );
      if (status === 200) return guard(() => parseRefundRecheck(data, asked));
      const code = errorCode(data);
      if (status === 404 && code === "device_not_registered")
        throw new StaffPinError("NotRegistered");
      if (status === 429) throw new StaffPinError("Busy");
      throw new StaffPinError("Unavailable");
    },
    async pinStatus(signal?: AbortSignal) {
      const { status, data } = await send("/merchant/staff-pin", { method: "GET" }, signal);
      if (status === 200) return guard(() => parsePinStatus(data));
      return common(status, errorCode(data));
    },
    async setPin(pin: string, confirmation: string) {
      const { status, data } = await send("/merchant/staff-pin", {
        method: "POST",
        body: { pin, confirmation },
        csrf: true,
      });
      const code = errorCode(data);
      if (status === 200) return guard(() => pinRecord(record(data, ["pin"]).pin));
      if (status === 422 && code === "pin_invalid") {
        const reason = (data as { reason?: unknown } | null)?.reason;
        throw new StaffPinError("Invalid", {
          reason:
            reason === "Format" || reason === "Mismatch" || reason === "TooSimple"
              ? reason
              : "Format",
        });
      }
      return common(status, code);
    },
    async devices(signal?: AbortSignal) {
      const { status, data } = await send("/merchant/store-devices", { method: "GET" }, signal);
      if (status === 200) return guard(() => parseStoreDevices(data));
      return common(status, errorCode(data));
    },
    async registerDevice(label: string) {
      if (!validDeviceLabel(label)) throw new StaffPinError("Invalid");
      const { status, data } = await send("/merchant/store-devices/register", {
        method: "POST",
        body: { label: label.trim() },
        csrf: true,
      });
      const code = errorCode(data);
      if (status === 201) return guard(() => storeDevice(record(data, ["device"]).device));
      if (status === 409 && code === "device_already_registered")
        throw new StaffPinError("AlreadyRegistered");
      if (status === 422 && code === "label_invalid") throw new StaffPinError("Invalid");
      return common(status, code);
    },
    async revokeDevice(device: string) {
      const { status, data } = await send("/merchant/store-devices/revoke", {
        method: "POST",
        body: { device },
        csrf: true,
      });
      const code = errorCode(data);
      if (status === 200)
        return guard(() => {
          const raw = record(data, ["revoked", "signedOut"]);
          if (raw.revoked !== true || !Number.isSafeInteger(raw.signedOut)) return invalid();
          return Object.freeze({ signedOut: Math.max(0, raw.signedOut as number) });
        });
      if (status === 404 && code === "device_not_found") throw new StaffPinError("NotFound");
      return common(status, code);
    },
    async resetPin(staff: string) {
      const { status, data } = await send("/merchant/staff-pins/reset", {
        method: "POST",
        body: { staff },
        csrf: true,
      });
      const code = errorCode(data);
      if (status === 200) return guard(() => pinRecord(record(data, ["pin"]).pin));
      if (status === 404 && code === "staff_not_found") throw new StaffPinError("NotFound");
      if (status === 409 && code === "pin_not_set") throw new StaffPinError("PinNotSet");
      return common(status, code);
    },
  });
}

/**
 * "3:45 PM" in the store's time zone (the device's own zone, which on a store tablet is the
 * store's, when the store's is not known).
 */
export function storeClockTime(instantValue: string, zone: string | undefined): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    ...(zone === undefined ? {} : { timeZone: zone }),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instantValue));
}
/** "Oct 14, 2026" in the store's time zone. */
export function storeDate(instantValue: string, zone: string | undefined): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    ...(zone === undefined ? {} : { timeZone: zone }),
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(instantValue));
}
