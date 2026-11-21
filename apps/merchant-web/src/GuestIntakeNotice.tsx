import { useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { SourceTime } from "./StoreTime.js";

/**
 * WP-2423 item 13 ② (Owner 2026-11-05): while the platform has paused this merchant's new guests,
 * every staff member sees it on Home, with since when and the reason support gave, and what still
 * works. Nothing is shown while new guests are taken, or when the read fails (the refusals staff
 * meet then say the same thing in place).
 */
export interface GuestIntakeRead {
  readonly paused: boolean;
  readonly since: string | null;
  readonly reason: string | null;
}
export async function loadGuestIntake(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<GuestIntakeRead> {
  const response = await fetcher("/merchant/store/guest-intake", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error("GUEST_INTAKE_UNAVAILABLE");
  const raw = (await response.json()) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object" || typeof raw.paused !== "boolean")
    throw new Error("GUEST_INTAKE_UNAVAILABLE");
  return Object.freeze({
    paused: raw.paused,
    since: typeof raw.since === "string" ? raw.since : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  });
}

const REFRESH_MS = 60_000;

export function GuestIntakeLine({ read }: { readonly read: GuestIntakeRead }) {
  if (!read.paused) return null;
  return (
    <section className="ordering-ending-notice" aria-label={t("New guests")}>
      <p className="ordering-ending-notice__title">
        {t("New guests are paused for this restaurant by the platform")}
        {read.since === null ? null : (
          <>
            {" · "}
            {t("since")} <SourceTime instant={read.since} />
          </>
        )}
      </p>
      {read.reason === null ? null : <p>{t("Reason: {reason}", { reason: read.reason })}</p>}
      <p>
        {t(
          "Guests can't scan to order, the counter can't take new orders and no new table can be opened. Tables already seated and orders already placed carry on: serve, take payment and refund as usual. Ask BOP support about it.",
        )}
      </p>
    </section>
  );
}

export function GuestIntakeNotice({ fetcher }: { readonly fetcher?: typeof fetch | undefined }) {
  const [read, setRead] = useState<GuestIntakeRead | null>(null);
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!live) return;
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      loadGuestIntake(fetcher, controller.signal).then(setRead, () => undefined);
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [fetcher, live]);
  return read === null ? null : <GuestIntakeLine read={read} />;
}
