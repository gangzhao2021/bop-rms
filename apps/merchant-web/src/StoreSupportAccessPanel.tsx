import { useCallback, useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import {
  storeSupportClient,
  StoreSupportClientError,
  type StoreSupportAccessView,
  type StoreSupportLogCursor,
  type StoreSupportLogEntry,
  type StoreSupportLogSummary,
  type StoreSupportMode,
} from "./store-support-client.js";
import { SourceTime } from "./StoreTime.js";

/** What support did, in the Owner's words. A new kind of action still shows, never a code. */
function logText(entry: StoreSupportLogEntry): string {
  if (entry.kind === "Viewed")
    return entry.subjectCode === "MerchantOverview"
      ? t("Looked at whether your Store is ready and when its last order came")
      : t("Looked at your Store's details and recent orders");
  if (entry.kind === "Changed")
    return entry.subjectCode === "KitchenLine"
      ? t("Set up your kitchen")
      : entry.subjectCode === "Pickup"
        ? t("Changed whether guests can order pickup")
        : t("Changed a setting");
  return t("Tried something that was refused; nothing changed");
}

/** How many of the newest records show before "Show all". */
export const supportLogShown = 5;

/**
 * b18 (Owner 2026-11-14): the log leads with what support changed or tried, the lines that matter;
 * the many "looked" lines are counted, and every record of the Store's log is reachable ("Show
 * all", then page by page). What is said about the log is read from all of it on the server, never
 * from the records on screen. Collapsed only on screen: nothing is left out or removed.
 */
export function supportLogSummary(summary: StoreSupportLogSummary) {
  return {
    acted: summary.acted,
    actedCount: summary.actedCount,
    looks: summary.looks,
    lastLook: summary.lastLookAt,
    total: summary.total,
  };
}

function SupportLogTable({ log }: { readonly log: readonly StoreSupportLogEntry[] }) {
  return (
    <table className="support-access__log">
      <thead>
        <tr>
          <th scope="col">{t("When")}</th>
          <th scope="col">{t("Who")}</th>
          <th scope="col">{t("What")}</th>
        </tr>
      </thead>
      <tbody>
        {log.map((entry, index) => (
          <tr key={entry.occurredAt + index}>
            <td data-label={t("When")}>
              <SourceTime instant={entry.occurredAt} />
            </td>
            <td data-label={t("Who")}>{entry.supportName}</td>
            <td data-label={t("What")}>{logText(entry)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SupportAccessLog({ view }: { readonly view: StoreSupportAccessView }) {
  const [all, setAll] = useState(false);
  // Pages read after the first, in order; reset when the Store's log is read again.
  const [more, setMore] = useState<{
    readonly log: readonly StoreSupportLogEntry[];
    readonly next: StoreSupportLogCursor | null;
  }>({ log: [], next: view.logNext });
  const [reading, setReading] = useState<"idle" | "reading" | "failed">("idle");
  useEffect(() => {
    setMore({ log: [], next: view.logNext });
    setReading("idle");
  }, [view]);
  const { acted, actedCount, looks, lastLook, total } = supportLogSummary(view.summary);
  if (total === 0)
    return (
      <>
        <h4>{t("Support access log")}</h4>
        <p>{t("Platform support hasn't opened your Store yet.")}</p>
      </>
    );
  const loaded = [...view.log, ...more.log];
  const readMore = async () => {
    if (more.next === null || reading === "reading") return;
    setReading("reading");
    try {
      const page = await storeSupportClient.accessLogPage(more.next);
      setMore((old) => ({ log: [...old.log, ...page.log], next: page.logNext }));
      setReading("idle");
    } catch {
      setReading("failed");
    }
  };
  return (
    <>
      <h4>{t("What support changed or tried")}</h4>
      {actedCount === 0 ? (
        <p>{t("Platform support hasn't changed or tried to change anything.")}</p>
      ) : (
        <>
          <SupportLogTable log={acted} />
          {actedCount > acted.length ? (
            <p>
              {t(
                "The newest {shown} of {count} are listed here; every one is in the access log below.",
                { shown: acted.length, count: actedCount },
              )}
            </p>
          ) : null}
        </>
      )}
      {looks === 0 ? null : (
        <p>
          {looks === 1
            ? t("Support looked at your Store once, last")
            : t("Support looked at your Store {looks} times, last", { looks })}{" "}
          {lastLook === null ? null : <SourceTime instant={lastLook} />}
        </p>
      )}
      <h4>{t("Support access log")}</h4>
      {all ? (
        <>
          <SupportLogTable log={loaded} />
          {loaded.length < total ? (
            <p>{t("Showing {shown} of {total} records.", { shown: loaded.length, total })}</p>
          ) : null}
          {reading === "failed" ? (
            <p role="status">{t("The earlier records could not be read. Try again.")}</p>
          ) : null}
          <p className="card-actions">
            {more.next !== null ? (
              <button
                type="button"
                className="support-access__toggle"
                disabled={reading === "reading"}
                onClick={() => void readMore()}
              >
                {reading === "reading" ? t("Loading…") : t("Show earlier records")}
              </button>
            ) : null}
            <button type="button" className="support-access__toggle" onClick={() => setAll(false)}>
              {t("Show fewer")}
            </button>
          </p>
        </>
      ) : (
        <>
          <SupportLogTable log={loaded.slice(0, supportLogShown)} />
          {total > supportLogShown ? (
            <button
              type="button"
              className="support-access__toggle"
              aria-expanded={false}
              onClick={() => setAll(true)}
            >
              {t("Show all {count} records", { count: total })}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * WP-2423 取舍 15 (Owner 2026-10-28): Store setup → "Platform support", the Owner's own. Support may
 * look without asking; here the Owner says whether they may also change settings, for how long, and
 * reads everything they did. Off is the default. The Owner can do everything without support.
 */
export function StoreSupportAccessPanel({
  csrf,
  onHidden,
}: {
  readonly csrf: string;
  /** b18: told when this person isn't shown platform support. */
  readonly onHidden?: () => void;
}) {
  const [view, setView] = useState<StoreSupportAccessView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "unavailable">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const read = await storeSupportClient.access();
      // b18: what the page says about the log comes from the whole log; without it, say nothing.
      if (typeof read.summary?.total !== "number") throw new Error("summary missing");
      setView(read);
      setState("ready");
    } catch (error) {
      setState(
        error instanceof StoreSupportClientError && error.code === "Denied"
          ? "hidden"
          : "unavailable",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (state === "hidden") onHidden?.();
  }, [state, onHidden]);
  if (state === "hidden" || state === "loading") return null;
  const change = async (mode: StoreSupportMode, hours: 1 | 4 | 24 | null, done: string) => {
    if (view === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setView(await storeSupportClient.changeAccess(csrf, view.version, mode, hours));
      setMessage(done);
    } catch {
      setMessage(t("That didn't go through. Nothing changed. Try again."));
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      id="support-access"
      className="support-access"
      aria-labelledby="support-access-heading"
    >
      <h3 id="support-access-heading">{t("Platform support")}</h3>
      {state === "unavailable" || view === null ? (
        <div role="status">
          <p>{t("We can't show this right now. Nothing was changed.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </div>
      ) : (
        <>
          <p>
            {t(
              "Platform support can look at your Store's settings and recent orders to help you, without asking each time. Guest contact details stay hidden from them, and every look is listed below.",
            )}
          </p>
          <p className="support-access__hint">
            {t("TEST ONLY: the real wording of this in your service agreement isn't written yet.")}
          </p>
          <p>
            {view.mode === "Off" ? (
              t("Platform support can't change your settings.")
            ) : view.mode === "Standing" ? (
              t("Platform support can change your settings until you turn this off.")
            ) : (
              <>
                {t("Platform support can change your settings until")}{" "}
                {view.allowedUntil === null ? null : <SourceTime instant={view.allowedUntil} />}
              </>
            )}
          </p>
          <div className="card-actions">
            {view.mode === "Standing" ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change("Standing", null, t("Platform support can change your settings."))
                }
              >
                {t("Allow platform support to change my settings")}
              </button>
            )}
            {view.mode === "Limited" ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change("Limited", 1, t("Allowed for one hour. It ends by itself."))
                }
              >
                {t("Allow for one hour")}
              </button>
            )}
            {view.mode === "Off" ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change("Off", null, t("Platform support can't change anything now."))
                }
              >
                {t("Turn off now")}
              </button>
            )}
          </div>
          <p className="support-access__hint">
            {t(
              "Whatever you allow here, support can never take payment, refund, comp, discount or void, or change staff, roles or payment accounts. Those stay yours, and you can do everything here without support.",
            )}
          </p>
          <SupportAccessLog view={view} />
        </>
      )}
      {message === null ? null : <p role="status">{message}</p>}
    </section>
  );
}
