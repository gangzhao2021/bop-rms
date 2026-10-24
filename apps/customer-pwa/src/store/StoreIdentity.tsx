import { listSeparator, t } from "../i18n/i18n.js";
import { useEffect, useState } from "react";
import { formatLocalityLine, formatStoreLocalTime } from "../journey/format.js";
import { formatStorePhone } from "../journey/StoreContact.js";
import {
  storeDirectionsUrl,
  type StoreProfile,
  type StoreProfileLoader,
} from "./store-profile-client.js";

/** Reads the guest's Store once per mount; null until known and whenever it can't be read. */
export function useStoreProfile(load: StoreProfileLoader | null): StoreProfile | null {
  const [profile, setProfile] = useState<StoreProfile | null>(null);
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

/** "Open now · until 6:00 p.m.", "Closed · opens at 1:00 p.m.", "Online ordering paused". */
export function storeStatusLine(hours: NonNullable<StoreProfile["hours"]>): {
  readonly label: string;
  readonly detail: string | null;
} {
  if (hours.status === "Paused")
    return { label: t("Online ordering paused"), detail: t("Ask staff to order in person") };
  if (hours.status === "Open")
    return {
      label: t("Open now"),
      detail:
        hours.closesAt === null
          ? null
          : t("until {value1}", { value1: formatStoreLocalTime(hours.closesAt) }),
    };
  return {
    label: "Closed",
    detail:
      hours.opensAt !== null
        ? t("opens at {value1}", { value1: formatStoreLocalTime(hours.opensAt) })
        : hours.todayHours.length === 0
          ? "closed today"
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
        <p className="store-identity__hours">
          <span>{t("Today")}</span> {todayHoursText(profile.hours)}
        </p>
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
 * The menu's one-line store status with the hours and address a tap away. The line's height is
 * kept from the first render, so nothing below moves when the Store's facts arrive.
 */
export function StoreStatusStrip({ load }: { readonly load: StoreProfileLoader | null }) {
  const profile = useStoreProfile(load);
  if (load === null) return null;
  const status = profile?.hours ? storeStatusLine(profile.hours) : null;
  return (
    <section className="store-strip" aria-label={t("Store hours and address")}>
      {profile === null ? null : (
        <details className="store-strip__details">
          <summary>
            {status === null ? (
              <span className="store-strip__label">{profile.address.addressLines[0]}</span>
            ) : (
              <>
                <span
                  className={`store-strip__label store-strip__label--${profile.hours?.status.toLowerCase()}`}
                >
                  {status.label}
                </span>
                {status.detail === null ? null : (
                  <span className="store-strip__detail"> · {status.detail}</span>
                )}
              </>
            )}
            <span className="store-strip__more">{t("Hours and address")}</span>
          </summary>
          <div className="store-strip__panel">
            <StoreDetails profile={profile} />
          </div>
        </details>
      )}
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
