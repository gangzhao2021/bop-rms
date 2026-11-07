import { listSeparator, t } from "../i18n/i18n.js";
import { useEffect, useState } from "react";
import { endSentence, formatLocalityLine, formatStoreLocalTime } from "../journey/format.js";
import { formatStorePhone } from "../journey/StoreContact.js";
import {
  storeDirectionsUrl,
  type StoreProfile,
  type StoreProfileLoader,
} from "./store-profile-client.js";
import { dayKindLabel, intervalsText, nextOpeningText, storeDayName } from "./store-hours-text.js";
import {
  nextStoreBoundaryMs,
  storeServicePhase,
  storeServiceReadMs,
  type StoreServicePhase,
} from "./store-service.js";

/**
 * Reads the guest's Store; null until known and whenever it can't be read. WP-2423
 * store-service-controls (v15 M34): an open page reads it again every minute and just after each
 * moment the answer changes (last orders, the end of a pause, closing), so a menu left open across
 * last orders says so by itself.
 */
export function useStoreProfile(load: StoreProfileLoader | null): StoreProfile | null {
  return useStoreService(load).profile;
}

export function useStoreService(load: StoreProfileLoader | null): {
  readonly profile: StoreProfile | null;
  readonly phase: StoreServicePhase;
  readonly minutesLeft: number | null;
} {
  const [profile, setProfile] = useState<StoreProfile | null>(() => load?.last?.() ?? null);
  const [reads, setReads] = useState(0);
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (load === null) return;
    let active = true;
    load(reads === 0 ? undefined : { fresh: true })
      .then((value) => {
        if (!active) return;
        setProfile(value);
        setAt(Date.now());
      })
      .catch(() => {
        if (active) setProfile(null);
      });
    return () => {
      active = false;
    };
  }, [load, reads]);
  useEffect(() => {
    if (load === null) return;
    const boundary = nextStoreBoundaryMs(profile, Date.now());
    const timer = setTimeout(() => setReads((value) => value + 1), boundary ?? storeServiceReadMs);
    return () => clearTimeout(timer);
    // `reads` too: a re-read answered from the shared read keeps the same profile object.
  }, [load, profile, reads]);
  const { phase, minutesLeft } = storeServicePhase(profile, at);
  return { profile, phase, minutesLeft };
}

/**
 * "Open now · until 10:00 p.m. · last orders 9:30 p.m.", "Closed · opens at 1:00 p.m.",
 * "Closed · opens tomorrow at 11:00 a.m.", "Online ordering paused".
 */
export function storeStatusLine(
  hours: NonNullable<StoreProfile["hours"]>,
  { lastOrders = true }: { readonly lastOrders?: boolean } = {},
): {
  readonly label: string;
  readonly detail: string | null;
} {
  // WP-2423 store-service-controls (v15 M30): until when, never "ask staff" (a pickup guest has
  // no staff to ask); the page that refuses an order says what to do for its own service.
  if (hours.status === "Paused")
    return {
      label: t("Online ordering paused"),
      detail:
        hours.pausedUntil === null
          ? null
          : // Its own words: "until" alone reads as the opening hours in Chinese ("营业至").
            t("resumes at {time}", { time: formatStoreLocalTime(hours.pausedUntil) }),
    };
  if (hours.status === "Open")
    return {
      label: t("Open now"),
      detail:
        [
          hours.closesAt === null
            ? null
            : t("until {value1}", { value1: formatStoreLocalTime(hours.closesAt) }),
          // WP-2423 item 8 ③ (decision 16): the kitchen's last orders, when the Store set them.
          hours.lastOrdersAt === null || !lastOrders
            ? null
            : hours.ordersStopped
              ? t("kitchen stopped taking orders at {time}", {
                  time: formatStoreLocalTime(hours.lastOrdersAt),
                })
              : t("last orders {time}", { time: formatStoreLocalTime(hours.lastOrdersAt) }),
        ]
          .filter((part) => part !== null)
          .join(" · ") || null,
    };
  return {
    label: t("Closed"),
    detail:
      hours.opensAt !== null
        ? t("opens at {value1}", { value1: formatStoreLocalTime(hours.opensAt) })
        : hours.nextOpening !== null
          ? nextOpeningText(hours.nextOpening, hours.localDate, "Line")
          : hours.todayHours.length === 0
            ? t("closed today")
            : null,
  };
}

/** "7:00 a.m.–11:00 a.m., 1:00 p.m.–6:00 p.m." or "Closed today". */
export function todayHoursText(hours: NonNullable<StoreProfile["hours"]>): string {
  if (hours.todayHours.length === 0) return t("Closed today");
  return hours.todayHours
    .map(
      (interval) =>
        `${formatStoreLocalTime(interval.startLocalTime)}–${formatStoreLocalTime(interval.endLocalTime)}${
          interval.endsNextDay ? t(" (next day)") : ""
        }`,
    )
    .join(listSeparator());
}

function StoreDetails({ profile }: { readonly profile: StoreProfile }) {
  return (
    <>
      {profile.hours === null ? null : (
        <>
          <p className="store-identity__hours">
            {/* M117: after midnight the Store is still in last night's period: say tonight's. */}
            <span>{profile.hours.tonight ? t("Tonight") : t("Today")}</span>{" "}
            {profile.hours.tonight
              ? `${formatStoreLocalTime(profile.hours.tonight.startLocalTime)}–${formatStoreLocalTime(
                  profile.hours.tonight.endLocalTime,
                )}${t(" (next day)")}`
              : profile.hours.todayKind === null
                ? todayHoursText(profile.hours)
                : `${dayKindLabel(profile.hours.todayKind, profile.hours.todayHours)}${
                    profile.hours.todayHours.length === 0
                      ? ""
                      : ` · ${intervalsText(profile.hours.todayHours)}`
                  }`}
          </p>
          {profile.hours.upcoming.length === 0 ? null : (
            <div className="store-identity__upcoming">
              <h3>{t("Holidays and special hours this week")}</h3>
              <ul>
                {profile.hours.upcoming.map((day) => (
                  <li key={day.localDate}>
                    <span>{storeDayName(day.localDate, profile.hours?.localDate ?? null)}</span>{" "}
                    {dayKindLabel(day.kind, day.intervals)}
                    {day.intervals.length === 0 ? "" : ` · ${intervalsText(day.intervals)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <address className="store-identity__address">
        {profile.address.addressLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
        <span>{formatLocalityLine(profile.address)}</span>
      </address>
      <p className="store-identity__links">
        <a href={storeDirectionsUrl(profile)} target="_blank" rel="noopener noreferrer">
          {t("Directions")}
          <span className="sr-only"> {t("(opens a map in a new tab)")}</span>
        </a>
        {profile.phone === null ? null : (
          <a href={`tel:${profile.phone}`}>
            {t("Call")} {formatStorePhone(profile.phone)}
          </a>
        )}
      </p>
    </>
  );
}

/**
 * The menu's one-line store status (decision 16: the Store's details are at the bottom of the
 * menu). The line's height is kept from the first render, so nothing below moves when the Store's
 * facts arrive.
 */
export function StoreStatusStrip({ load }: { readonly load: StoreProfileLoader | null }) {
  const profile = useStoreProfile(load);
  if (load === null) return null;
  const hours = profile?.hours ?? null;
  const status = hours === null ? null : storeStatusLine(hours, { lastOrders: false });
  // Two lines that never wrap, their height kept from the first render: the status, then the
  // kitchen's last orders and this week's holidays when there are any.
  return (
    <section className="store-strip" aria-label={t("Store hours and address")}>
      {hours === null || status === null ? null : (
        <>
          <p className="store-strip__line">
            <span
              className={`store-strip__label store-strip__label--${hours.status.toLowerCase()}`}
            >
              {status.label}
            </span>
            {status.detail === null ? null : (
              <span className="store-strip__detail"> · {status.detail}</span>
            )}
          </p>
          <p className="store-strip__line store-strip__line--more">
            {hours.status === "Open" && hours.lastOrdersAt !== null ? (
              <span className={hours.ordersStopped ? "store-strip__stopped" : undefined}>
                {hours.ordersStopped
                  ? t("Kitchen stopped taking orders at {time}", {
                      time: formatStoreLocalTime(hours.lastOrdersAt),
                    })
                  : t("Last orders {time}", { time: formatStoreLocalTime(hours.lastOrdersAt) })}
              </span>
            ) : null}
            {hours.upcoming.length > 0 ? (
              <a className="store-strip__more" href="#store-info">
                {t("Holidays this week")}
              </a>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * WP-2423 item 8 ③ (Owner decision 16): the Store at the bottom of the menu — open now and until
 * when, the kitchen's last orders, today's hours (a holiday or special hours said so), the
 * holidays and special hours in the next 7 days, the address with directions and the phone a tap
 * away. Nothing when the Store's facts can't be read.
 */
export function StoreInfoSection({ load }: { readonly load: StoreProfileLoader | null }) {
  const profile = useStoreProfile(load);
  if (profile === null) return null;
  const status = profile.hours ? storeStatusLine(profile.hours) : null;
  return (
    <section
      id="store-info"
      className="store-identity store-info"
      aria-labelledby="store-info-heading"
    >
      <h2 id="store-info-heading">{profile.storeDisplayName}</h2>
      {status === null ? null : (
        <p className="store-identity__status">
          <strong
            className={`store-strip__label store-strip__label--${profile.hours?.status.toLowerCase()}`}
          >
            {status.label}
          </strong>
          {status.detail === null ? null : <span> · {status.detail}</span>}
        </p>
      )}
      <StoreDetails profile={profile} />
    </section>
  );
}

/** The start page's store card: open now, today's hours, address with directions, phone. */
export function StoreIdentityCard({ load }: { readonly load: StoreProfileLoader | null }) {
  const profile = useStoreProfile(load);
  if (profile === null) return null;
  const status = profile.hours ? storeStatusLine(profile.hours) : null;
  return (
    <section className="store-identity" aria-labelledby="store-identity-heading">
      <h2 id="store-identity-heading">{profile.storeDisplayName}</h2>
      {status === null ? null : (
        <p className="store-identity__status">
          <strong
            className={`store-strip__label store-strip__label--${profile.hours?.status.toLowerCase()}`}
          >
            {status.label}
          </strong>
          {status.detail === null ? null : <span> · {status.detail}</span>}
        </p>
      )}
      <StoreDetails profile={profile} />
    </section>
  );
}

/**
 * WP-2423 item 8 ③ follow-up (v15 2026-10-28): after last orders the menu says so above the dishes
 * — guests can't send new orders or rounds now (checkout refuses them), and a staff member can
 * still add something for them. WP-2423 store-service-controls (v15 M30/M34): read live, it also
 * counts down the last 30 minutes before last orders and says when a pause of this guest's service
 * ends — in words for this guest's service (a pickup guest has no staff member to ask).
 */
export function OrdersStoppedNotice({
  load,
  channel = "DineIn",
}: {
  readonly load: StoreProfileLoader | null;
  readonly channel?: "DineIn" | "Pickup";
}) {
  const { profile, phase, minutesLeft } = useStoreService(load);
  const hours = profile?.hours ?? null;
  const text = storeServiceNoticeText(hours, phase, minutesLeft, channel);
  if (text === null) return null;
  return (
    <section
      className="orders-stopped"
      role={phase === "Soon" ? "status" : "alert"}
      aria-label={t("Last orders")}
    >
      <p>
        <strong>{text.headline}</strong>
        {text.detail === null ? null : <> {text.detail}</>}
      </p>
    </section>
  );
}

/** The notice's words for a service phase; null when there is nothing to say. */
export function storeServiceNoticeText(
  hours: StoreProfile["hours"] | null,
  phase: StoreServicePhase,
  minutesLeft: number | null,
  channel: "DineIn" | "Pickup",
): { readonly headline: string; readonly detail: string | null } | null {
  if (hours === null) return null;
  if (phase === "Soon" && hours.lastOrdersAt !== null && minutesLeft !== null)
    return {
      headline: t("Last orders at {time} — {minutes} min left.", {
        time: formatStoreLocalTime(hours.lastOrdersAt),
        minutes: minutesLeft,
      }),
      detail: null,
    };
  if (phase === "Paused") {
    const until = hours.pausedUntil === null ? null : formatStoreLocalTime(hours.pausedUntil);
    if (channel === "Pickup")
      return until === null
        ? {
            headline: t("Online pickup ordering is paused for a short while."),
            detail: t("You can order at the counter, or try again in a few minutes."),
          }
        : {
            headline: t("Online pickup ordering is paused until {time}.", { time: until }),
            detail: t("You can order at the counter, or come back after {time}.", { time: until }),
          };
    return {
      headline:
        until === null
          ? t("Ordering from your phone is paused for a short while.")
          : t("Ordering from your phone is paused until {time}.", { time: until }),
      detail: t("A staff member can take your order."),
    };
  }
  // WP-2423 store-service-controls (v15 M34 review): closed (closing time came while the cart or
  // checkout stayed open, or this service is off) says so, and when a pickup guest can order next.
  if (phase === "Closed") {
    const opening =
      hours.opensAt !== null && hours.localDate !== null
        ? { localDate: hours.localDate, startLocalTime: hours.opensAt }
        : hours.nextOpening;
    if (channel === "Pickup")
      return {
        headline: t("Online pickup ordering is closed now."),
        detail: opening === null ? null : endSentence(nextOpeningText(opening, hours.localDate)),
      };
    return {
      headline: t("Ordering from your phone is closed now."),
      detail: t("A staff member can help you."),
    };
  }
  if (phase === "Stopped") {
    const headline =
      hours.lastOrdersAt === null
        ? t("The kitchen has stopped taking orders for today.")
        : endSentence(
            t("The kitchen stopped taking orders at {time}", {
              time: formatStoreLocalTime(hours.lastOrdersAt),
            }),
          );
    return {
      headline,
      detail:
        channel === "Pickup"
          ? t("You can’t place a pickup order from your phone now.")
          : t(
              "You can’t send a new order from your phone now. To add something, ask a staff member.",
            ),
    };
  }
  return null;
}
