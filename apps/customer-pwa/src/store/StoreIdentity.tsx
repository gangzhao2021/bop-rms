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

/** Reads the guest's Store once per mount; null until known and whenever it can't be read. */
export function useStoreProfile(load: StoreProfileLoader | null): StoreProfile | null {
  const [profile, setProfile] = useState<StoreProfile | null>(() => load?.last?.() ?? null);
  useEffect(() => {
    if (load === null) return;
    let active = true;
    load()
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch(() => {
        if (active) setProfile(null);
      });
    return () => {
      active = false;
    };
  }, [load]);
  return profile;
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
  if (hours.status === "Paused")
    return { label: t("Online ordering paused"), detail: t("Ask staff to order in person") };
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
            <span>{t("Today")}</span>{" "}
            {profile.hours.todayKind === null
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
 * still add something for them. Nothing otherwise.
 */
export function OrdersStoppedNotice({ load }: { readonly load: StoreProfileLoader | null }) {
  const profile = useStoreProfile(load);
  const hours = profile?.hours ?? null;
  if (hours === null || !hours.ordersStopped) return null;
  return (
    <section className="orders-stopped" role="status" aria-label={t("Last orders")}>
      <p>
        <strong>
          {hours.lastOrdersAt === null
            ? t("The kitchen has stopped taking orders for today.")
            : endSentence(
                t("The kitchen stopped taking orders at {time}", {
                  time: formatStoreLocalTime(hours.lastOrdersAt),
                }),
              )}
        </strong>{" "}
        {t("You can’t send a new order from your phone now. To add something, ask a staff member.")}
      </p>
    </section>
  );
}
