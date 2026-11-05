import { useCallback, useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import {
  storeSupportClient,
  StoreSupportClientError,
  type StoreSupportAccessView,
  type StoreSupportLogEntry,
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

/**
 * WP-2423 取舍 15 (Owner 2026-10-28): Store setup → "Platform support", the Owner's own. Support may
 * look without asking; here the Owner says whether they may also change settings, for how long, and
 * reads everything they did. Off is the default. The Owner can do everything without support.
 */
export function StoreSupportAccessPanel({ csrf }: { readonly csrf: string }) {
  const [view, setView] = useState<StoreSupportAccessView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "unavailable">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setView(await storeSupportClient.access());
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
          <h4>{t("Support access log")}</h4>
          {view.log.length === 0 ? (
            <p>{t("Platform support hasn't opened your Store yet.")}</p>
          ) : (
            <table className="support-access__log">
              <thead>
                <tr>
                  <th scope="col">{t("When")}</th>
                  <th scope="col">{t("Who")}</th>
                  <th scope="col">{t("What")}</th>
                </tr>
              </thead>
              <tbody>
                {view.log.map((entry, index) => (
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
          )}
        </>
      )}
      {message === null ? null : <p role="status">{message}</p>}
    </section>
  );
}
