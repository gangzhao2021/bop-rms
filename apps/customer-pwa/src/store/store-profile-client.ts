import { boundedFetch } from "../network/bounded-fetch.js";

/**
 * WP-2423: the Store the guest is ordering from, as its owner published it — address, phone and
 * today's hours with whether it is open now. Read for the guest's own Session only. Anything
 * unexpected means "not known": the page then shows nothing rather than a guessed fact.
 */
export interface StoreHoursInterval {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
}

export interface StoreProfile {
  readonly storeDisplayName: string;
  readonly address: {
    readonly addressLines: readonly string[];
    readonly locality: string;
    readonly regionCode: string;
    readonly postalCode: string;
    readonly countryCode: string;
  };
  readonly phone: string | null;
  readonly hours: {
    readonly status: "Open" | "Closed" | "Paused";
    readonly todayHours: readonly StoreHoursInterval[];
    readonly closesAt: string | null;
    readonly opensAt: string | null;
  } | null;
}

/** The current Store profile; null when it can't be read. */
export type StoreProfileLoader = () => Promise<StoreProfile | null>;

const localTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/u;
const e164 = /^\+[1-9][0-9]{6,14}$/u;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("store profile invalid");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)))
    throw new TypeError("store profile invalid");
  return raw;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.normalize("NFC").trim() ||
    /[\p{Cc}\p{Cf}<>]/u.test(value)
  )
    throw new TypeError("store profile invalid");
  return value;
}

function time(value: unknown): string {
  if (typeof value !== "string" || !localTime.test(value))
    throw new TypeError("store profile invalid");
  return value;
}

const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
  value === null ? null : parse(value);

/** Strict parser: exactly the published fields, nothing else. */
export function parseStoreProfile(value: unknown): StoreProfile {
  const root = record(value, ["schemaVersion", "store"]);
  if (root.schemaVersion !== 1) throw new TypeError("store profile invalid");
  const store = record(root.store, [
    "storeDisplayName",
    "brandDisplayName",
    "timeZone",
    "address",
    "phone",
    "hours",
  ]);
  const address = record(store.address, [
    "addressLines",
    "locality",
    "regionCode",
    "postalCode",
    "countryCode",
  ]);
  if (
    !Array.isArray(address.addressLines) ||
    address.addressLines.length < 1 ||
    address.addressLines.length > 3
  )
    throw new TypeError("store profile invalid");
  if (store.phone !== null && (typeof store.phone !== "string" || !e164.test(store.phone)))
    throw new TypeError("store profile invalid");
  const hours = nullable(store.hours, (raw) => {
    const value = record(raw, ["status", "todayHours", "closesAt", "opensAt"]);
    if (
      (value.status !== "Open" && value.status !== "Closed" && value.status !== "Paused") ||
      !Array.isArray(value.todayHours) ||
      value.todayHours.length > 12
    )
      throw new TypeError("store profile invalid");
    return Object.freeze({
      status: value.status,
      todayHours: Object.freeze(
        value.todayHours.map((entry: unknown) => {
          const interval = record(entry, ["startLocalTime", "endLocalTime", "endsNextDay"]);
          if (typeof interval.endsNextDay !== "boolean")
            throw new TypeError("store profile invalid");
          return Object.freeze({
            startLocalTime: time(interval.startLocalTime),
            endLocalTime: time(interval.endLocalTime),
            endsNextDay: interval.endsNextDay,
          });
        }),
      ),
      closesAt: nullable(value.closesAt, time),
      opensAt: nullable(value.opensAt, time),
    });
  });
  text(store.brandDisplayName, 160);
  text(store.timeZone, 64);
  return Object.freeze({
    storeDisplayName: text(store.storeDisplayName, 160),
    address: Object.freeze({
      addressLines: Object.freeze(address.addressLines.map((line: unknown) => text(line, 160))),
      locality: text(address.locality, 120),
      regionCode: text(address.regionCode, 12),
      postalCode: text(address.postalCode, 20),
      countryCode: (() => {
        const code = text(address.countryCode, 2);
        if (!/^[A-Z]{2}$/u.test(code)) throw new TypeError("store profile invalid");
        return code;
      })(),
    }),
    phone: store.phone,
    hours,
  });
}

/**
 * WP-2423 Q30: one page shows the Store's name and its hours from two components; both share one
 * read made within a few seconds, so a guest on a slow network waits for one round trip, not two.
 */
export const STORE_PROFILE_SHARE_MS = 5_000;

export function createStoreProfileClient(
  request: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): StoreProfileLoader {
  let shared: { readonly at: number; readonly read: Promise<StoreProfile | null> } | null = null;
  const read = async (): Promise<StoreProfile | null> => {
    try {
      const response = await boundedFetch(request, "/api/v1/customer/store", {
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json" },
      });
      if (response.status !== 200) return null;
      return parseStoreProfile(await response.json());
    } catch {
      return null;
    }
  };
  return () => {
    const at = now();
    if (shared === null || at - shared.at >= STORE_PROFILE_SHARE_MS) shared = { at, read: read() };
    return shared.read;
  };
}

/** A map search for the published address; the address is the Store's own public fact. */
export function storeDirectionsUrl(profile: StoreProfile): string {
  const { address } = profile;
  const query = [
    profile.storeDisplayName,
    ...address.addressLines,
    `${address.locality}, ${address.regionCode} ${address.postalCode}`,
    address.countryCode,
  ].join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
