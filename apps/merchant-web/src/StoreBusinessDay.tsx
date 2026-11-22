import { displayLocale, t } from "./i18n/i18n.js";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

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
  /** DEC-CLOSING-SUMMARY: when this day's last published period ends; absent when not known. */
  readonly closesAt?: string | null;
  /** Hours are published and this day has none (a holiday, a day off). */
  readonly closedToday?: boolean;
  /**
   * Batch 47 fix-up: a period is still open when the day ends (open 24 hours), so closesAt is
   * only the day's end, not a time the Store closes.
   */
  readonly openAtDayEnd?: boolean;
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
  /** WP-2423 item 8 ③ follow-up: when guests stop ordering in the current period, or null. */
  readonly lastOrdersAt: string | null;
  readonly closesAt: string | null;
  readonly closedToday: boolean;
  readonly openAtDayEnd: boolean;
} {
  const raw = value as Record<string, unknown> | null;
  const keys = [
    "businessDate",
    "startsAt",
    "endsAt",
    "timeZone",
    "observedAt",
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "lastOrdersAt")
      ? ["lastOrdersAt"]
      : []),
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "closesAt")
      ? ["closesAt"]
      : []),
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "closedToday")
      ? ["closedToday"]
      : []),
    ...(raw !== null && typeof raw === "object" && Object.hasOwn(raw, "openAtDayEnd")
      ? ["openAtDayEnd"]
      : []),
  ];
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
    (raw.lastOrdersAt !== undefined && raw.lastOrdersAt !== null && !isInstant(raw.lastOrdersAt)) ||
    (raw.closesAt !== undefined && raw.closesAt !== null && !isInstant(raw.closesAt)) ||
    (raw.closedToday !== undefined && typeof raw.closedToday !== "boolean") ||
    (raw.openAtDayEnd !== undefined && typeof raw.openAtDayEnd !== "boolean") ||
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
    lastOrdersAt: (raw.lastOrdersAt as string | null | undefined) ?? null,
    closesAt: (raw.closesAt as string | null | undefined) ?? null,
    closedToday: raw.closedToday === true,
    openAtDayEnd: raw.openAtDayEnd === true,
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

/**
 * Batch 34 (v15 b33 live): true once the Store's first business-day read has answered or failed
 * (or after BUSINESS_DAY_SETTLE_MS), so a screen whose controls depend on the day's hours (Pickup's
 * "Mark all not collected") can show them in the same pass as its list instead of inserting them
 * a moment later and pushing the list down. True outside a Store workspace.
 */
export const StoreBusinessDaySettledContext = createContext(true);
export function useStoreBusinessDaySettled(): boolean {
  return useContext(StoreBusinessDaySettledContext);
}
/**
 * Batch 36 (v15 b35 known limit): true while the Store's first business-day read has neither
 * answered nor failed (the BUSINESS_DAY_SETTLE_MS cap does not end it), so a screen keeps room
 * only for what that answer can still bring, never after it failed. False outside a workspace.
 */
export const StoreBusinessDayPendingContext = createContext(false);
export function useStoreBusinessDayPending(): boolean {
  return useContext(StoreBusinessDayPendingContext);
}
/** A first read that hangs no longer holds a screen back than this. */
export const BUSINESS_DAY_SETTLE_MS = 2_000;

/** Re-read at most this long after the last answer even when the day has not ended. */
export const BUSINESS_DAY_RECHECK_MS = 15 * 60_000;
/** After a failed read, try again this soon. */
export const BUSINESS_DAY_RETRY_MS = 60_000;

/**
 * Reads the Store's business day now, again one second after it ends (the next day has begun),
 * at least every BUSINESS_DAY_RECHECK_MS, and after a failure, or an answer whose day has already
 * ended by the device's clock, every BUSINESS_DAY_RETRY_MS.
 * recheck() reads at once when the known day has ended (a screen woken after the night).
 */
export function trackStoreBusinessDay(options: {
  load(signal: AbortSignal): Promise<{
    businessDate: string;
    startsAt: string;
    endsAt: string;
    closesAt?: string | null;
    closedToday?: boolean;
    openAtDayEnd?: boolean;
  }>;
  onDay(day: StoreBusinessDay): void;
  /** A read failed (it is tried again after BUSINESS_DAY_RETRY_MS). */
  onFailed?: () => void;
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
          ...(value.closesAt === undefined ? {} : { closesAt: value.closesAt }),
          ...(value.closedToday === undefined ? {} : { closedToday: value.closedToday }),
          ...(value.openAtDayEnd === undefined ? {} : { openAtDayEnd: value.openAtDayEnd }),
        }),
      );
      // A day the Store says has already ended by this device's clock (a device clock running
      // ahead, or the Store not yet past its turnover) is read again like a failure, not every
      // second: a screen left open must never ask the Store once a second all day.
      const untilEnd = Date.parse(value.endsAt) - now();
      schedule(untilEnd <= 0 ? BUSINESS_DAY_RETRY_MS : untilEnd + 1_000);
    } catch {
      if (active && !current.signal.aborted) {
        options.onFailed?.();
        schedule(BUSINESS_DAY_RETRY_MS);
      }
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
  // The scope whose first read has settled; another scope is unsettled from its first render.
  const [settledScope, setSettledScope] = useState<string | null>(null);
  // The scope whose first read answered or failed (the settle timer aside).
  const [answeredScope, setAnsweredScope] = useState<string | null>(null);
  // Batch 36 (v15 b35 live): a layout effect, so this read is sent before the reads the screen
  // below starts in its own effects (React runs those first). It was sent last of about 29 on
  // Home, waited about a second for a free connection, and the evening reminder waited on it.
  useLayoutEffect(() => {
    setDay(null);
    if (!enabled) return;
    const settle = () => setSettledScope(scopeKey);
    const answered = () => {
      settle();
      setAnsweredScope(scopeKey);
    };
    const settleTimer = setTimeout(settle, BUSINESS_DAY_SETTLE_MS);
    const tracker = trackStoreBusinessDay({
      load: (signal) => loadStoreBusinessDay(fetcher, signal),
      onFailed: answered,
      onDay: (value) => {
        answered();
        setDay((previous) =>
          previous !== null &&
          previous.businessDate === value.businessDate &&
          previous.startsAt === value.startsAt &&
          previous.endsAt === value.endsAt &&
          previous.closesAt === value.closesAt &&
          previous.closedToday === value.closedToday &&
          previous.openAtDayEnd === value.openAtDayEnd
            ? previous
            : value,
        );
      },
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") tracker.recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearTimeout(settleTimer);
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
    <StoreBusinessDayContext.Provider value={value}>
      <StoreBusinessDaySettledContext.Provider value={!enabled || settledScope === scopeKey}>
        <StoreBusinessDayPendingContext.Provider value={enabled && answeredScope !== scopeKey}>
          {children}
        </StoreBusinessDayPendingContext.Provider>
      </StoreBusinessDaySettledContext.Provider>
    </StoreBusinessDayContext.Provider>
  );
}

const dayMs = 86_400_000;
const dateValue = (businessDate: string) => Date.parse(`${businessDate}T00:00:00.000Z`);

/**
 * "Wed, Oct 14" for a business date (a date label, independent of any time zone); "Fri, Jan 1,
 * 2027" with its year when asked.
 */
export function businessDateText(businessDate: string, withYear = false): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    timeZone: "UTC",
    weekday: "short",
    ...(withYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  }).format(new Date(dateValue(businessDate)));
}

/**
 * "Today · Wed, Oct 14", "Yesterday · Tue, Oct 13" or "Mon, Oct 12" against the current day.
 * Batch 47 (v15 b46: a special date next New Year's Day read "Fri, Jan 1"): a date in another
 * year than the current day (or, when that is not known, this device's) says its year.
 */
export function businessDateLabel(businessDate: string, today: string | null | undefined): string {
  const currentYear =
    today === null || today === undefined ? String(new Date().getFullYear()) : today.slice(0, 4);
  const text = businessDateText(businessDate, businessDate.slice(0, 4) !== currentYear);
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

/** The Store-local calendar date ("2026-11-05") an instant falls on; UTC when the zone is unknown. */
function storeCalendarDate(instant: string, timeZone: string | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * WP-2423 M175: the date around an order's time on Orders and Pickup. An order placed at 00:08 on
 * Nov 5 that counts for Nov 4 reads "Thu, Nov 5 00:08 · counts for Wed, Nov 4", never
 * "Wed, Nov 4 00:08" (a time that day never had). An earlier day's order keeps its date before the
 * time; today's order placed today shows the time alone.
 */
export function orderWhenText(
  submittedAt: string,
  businessDate: string | null,
  today: string | null | undefined,
  timeZone: string | undefined,
): { readonly before: string; readonly after: string } {
  if (businessDate === null) return { before: "", after: "" };
  const calendarDate = storeCalendarDate(submittedAt, timeZone);
  if (calendarDate !== businessDate)
    return {
      before: businessDateLabel(calendarDate, today) + " ",
      after: t(" · counts for {businessDate}", {
        businessDate: businessDateLabel(businessDate, today),
      }),
    };
  if (today !== null && today !== undefined && businessDate !== today)
    return { before: businessDateLabel(businessDate, today) + " ", after: "" };
  return { before: "", after: "" };
}
