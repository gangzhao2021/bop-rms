import { displayLocale, t } from "./i18n/i18n.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * WP-2423 Q21: the selected Store's current business day, from the Store owner (its published
 * time zone and business-day start — e.g. 04:00, so a late service after midnight still belongs to
 * the day it started). Every merchant "today" uses this, never the device's calendar day.
 */
export interface StoreBusinessDay {
  readonly businessDate: string;
  /** Start (inclusive) and end (exclusive) of the day; null until the Store's read has answered. */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  datePattern.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const isInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(value).toISOString() === value;

/** The `/merchant/business-day` answer; anything else is refused. */
export function parseStoreBusinessDay(value: unknown): StoreBusinessDay & {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly observedAt: string;
} {
  const keys = ["businessDate", "startsAt", "endsAt", "timeZone", "observedAt"];
  const raw = value as Record<string, unknown> | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(raw, key)) ||
    !isDate(raw.businessDate) ||
    !isInstant(raw.startsAt) ||
    !isInstant(raw.endsAt) ||
    !isInstant(raw.observedAt) ||
    typeof raw.timeZone !== "string" ||
    raw.timeZone.length === 0 ||
    raw.timeZone.length > 64 ||
    !(raw.startsAt <= raw.observedAt && raw.observedAt < raw.endsAt) ||
    // A business day lasts 23 to 25 hours (daylight-saving changes included).
    Date.parse(raw.endsAt) - Date.parse(raw.startsAt) < 23 * 3_600_000 ||
    Date.parse(raw.endsAt) - Date.parse(raw.startsAt) > 25 * 3_600_000
  )
    throw new Error("BUSINESS_DAY_INVALID");
  return Object.freeze({
    businessDate: raw.businessDate,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    timeZone: raw.timeZone,
    observedAt: raw.observedAt,
  });
}

export async function loadStoreBusinessDay(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReturnType<typeof parseStoreBusinessDay>> {
  const response = await fetcher("/merchant/business-day", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  )
    throw new Error("BUSINESS_DAY_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 4096) throw new Error("BUSINESS_DAY_UNAVAILABLE");
  return parseStoreBusinessDay(JSON.parse(text) as unknown);
}

export const StoreBusinessDayContext = createContext<StoreBusinessDay | null>(null);

/** The Store's current business day (null outside a Store workspace). */
export function useStoreBusinessDay(): StoreBusinessDay | null {
  return useContext(StoreBusinessDayContext);
}

/** Re-read at most this long after the last answer even when the day has not ended. */
export const BUSINESS_DAY_RECHECK_MS = 15 * 60_000;
/** After a failed read, try again this soon. */
export const BUSINESS_DAY_RETRY_MS = 60_000;

/**
 * Reads the Store's business day now, again one second after it ends (the next day has begun),
 * at least every BUSINESS_DAY_RECHECK_MS, and after a failure every BUSINESS_DAY_RETRY_MS.
 * recheck() reads at once when the known day has ended (a screen woken after the night).
 */
export function trackStoreBusinessDay(options: {
  load(signal: AbortSignal): Promise<{ businessDate: string; startsAt: string; endsAt: string }>;
  onDay(day: StoreBusinessDay): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let endsAt: string | null = null;
  let controller: AbortController | null = null;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => void read(),
      Math.max(1_000, Math.min(delay, BUSINESS_DAY_RECHECK_MS)),
    );
  };
  const read = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    try {
      const value = await options.load(current.signal);
      if (!active || current.signal.aborted) return;
      endsAt = value.endsAt;
      options.onDay(
        Object.freeze({
          businessDate: value.businessDate,
          startsAt: value.startsAt,
          endsAt: value.endsAt,
        }),
      );
      schedule(Date.parse(value.endsAt) - now() + 1_000);
    } catch {
      if (active && !current.signal.aborted) schedule(BUSINESS_DAY_RETRY_MS);
    }
  };
  void read();
  return Object.freeze({
    recheck() {
      if (active && (endsAt === null || now() >= Date.parse(endsAt))) void read();
    },
    stop() {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    },
  });
}

/**
 * Provides the selected Store's business day: starts from the workspace's Business Date, reads the
 * Store's day with its boundaries, and reads again as the day ends (and when a screen left open
 * overnight becomes visible again), so "today" turns over at the Store's business-day start.
 */
export function StoreBusinessDayProvider({
  initialBusinessDate,
  scopeKey,
  enabled,
  fetcher,
  children,
}: {
  readonly initialBusinessDate: string | null;
  /** The selected Store (and Session); a change starts over. */
  readonly scopeKey: string;
  /** False without a selected Store Session (or in the local demo): only the workspace date. */
  readonly enabled: boolean;
  readonly fetcher?: typeof fetch | undefined;
  readonly children: ReactNode;
}) {
  const [day, setDay] = useState<StoreBusinessDay | null>(null);
  useEffect(() => {
    setDay(null);
    if (!enabled) return;
    const tracker = trackStoreBusinessDay({
      load: (signal) => loadStoreBusinessDay(fetcher, signal),
      onDay: (value) =>
        setDay((previous) =>
          previous !== null &&
          previous.businessDate === value.businessDate &&
          previous.startsAt === value.startsAt &&
          previous.endsAt === value.endsAt
            ? previous
            : value,
        ),
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") tracker.recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      tracker.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [enabled, fetcher, scopeKey]);
  const value =
    day ??
    (initialBusinessDate === null
      ? null
      : { businessDate: initialBusinessDate, startsAt: null, endsAt: null });
  return (
    <StoreBusinessDayContext.Provider value={value}>{children}</StoreBusinessDayContext.Provider>
  );
}

const dayMs = 86_400_000;
const dateValue = (businessDate: string) => Date.parse(`${businessDate}T00:00:00.000Z`);

/** "Wed, Oct 14" for a business date (a date label, independent of any time zone). */
export function businessDateText(businessDate: string): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(dateValue(businessDate)));
}

/** "Today · Wed, Oct 14", "Yesterday · Tue, Oct 13" or "Mon, Oct 12" against the current day. */
export function businessDateLabel(businessDate: string, today: string | null | undefined): string {
  const text = businessDateText(businessDate);
  if (today === null || today === undefined) return text;
  const difference = Math.round((dateValue(today) - dateValue(businessDate)) / dayMs);
  return difference === 0
    ? t("Today · {text}", { text: text })
    : difference === 1
      ? t("Yesterday · {text}", { text: text })
      : text;
}

/**
 * WP-2423 D4: a table's Order opened on an earlier business day that had a round on a later one —
 * "Opened Sun, Oct 11 · ordered again Today · Thu, Oct 15". Its order number belongs to the day
 * it was opened; the later round is that later day's work.
 */
export function openedEarlierText(
  openedOn: string,
  listedOn: string,
  today: string | null | undefined,
): string {
  return t("Opened {openedOn} · ordered again {listedOn}", {
    openedOn: businessDateText(openedOn),
    listedOn: businessDateLabel(listedOn, today),
  });
}
