import { useCallback, useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import {
  storeSupportClient,
  StoreSupportClientError,
  type StoreSupportSession,
  type StoreSupportView,
} from "./store-support-client.js";
import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import { SourceTime, StoreTimeZoneContext } from "./StoreTime.js";

/**
 * WP-2423 取舍 15 (Owner 2026-10-28), Section 88 PLT-SUPPORT-CASE: what platform support works from.
 * Pick a Store and read it; everything opened goes in that Store's log for its Owner. Changes are
 * the closed list here, only while the Owner allows it. If this page can't be reached, the Owner
 * can still do everything alone in their own Store setup.
 */
const orderTypeText = (type: string) =>
  type === "Pickup" ? t("Pickup") : type === "DineIn" ? t("Dine-in") : t("Other");
/** The order's state as staff say it; one this page doesn't know is "In progress", never a code. */
const orderPhaseText = (phase: string | null) => {
  switch (phase) {
    case "Submitted":
      return t("Waiting to be accepted");
    case "Accepted":
      return t("Accepted");
    case "InProgress":
      return t("Being made");
    case "Ready":
      return t("Ready");
    case "Completed":
    case "Closed":
      return t("Done");
    case "Cancelled":
      return t("Cancelled");
    case "Rejected":
      return t("Refused and refunded");
    case null:
      return t("Can't read this right now");
    default:
      return t("In progress");
  }
};

export function StoreSupportPage() {
  const [session, setSession] = useState<StoreSupportSession | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "unavailable">("loading");
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<StoreSupportView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadSession = useCallback(async () => {
    try {
      setSession(await storeSupportClient.session());
      setState("ready");
    } catch (error) {
      setState(
        error instanceof StoreSupportClientError && error.code === "Denied"
          ? "denied"
          : "unavailable",
      );
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  const open = async (storeReference: string) => {
    if (session === null) return;
    setPicked(storeReference);
    setView(null);
    setMessage(null);
    try {
      setView(await storeSupportClient.view(session.csrf, storeReference));
    } catch {
      setMessage(t("We can't open this Store right now. Try again in a moment."));
    }
  };
  const change = async (
    action: "SetUpKitchenLine" | "SetPickup",
    expectedVersion: number,
    done: string,
    value?: boolean,
  ) => {
    if (session === null || picked === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await storeSupportClient.command(session.csrf, picked, action, expectedVersion, value);
      setView(await storeSupportClient.view(session.csrf, picked));
      setMessage(done);
    } catch (error) {
      const code = error instanceof StoreSupportClientError ? error.code : "Unavailable";
      setMessage(
        code === "NotAllowedByOwner"
          ? t(
              "The Owner hasn't allowed changes right now. Ask them to allow it in their Store setup.",
            )
          : code === "OwnerOnly"
            ? t("Only the Owner can do this. Guide them through it on their own screen.")
            : t("That didn't go through. Open the Store again and retry."),
      );
      setView(await storeSupportClient.view(session.csrf, picked).catch(() => null));
    } finally {
      setBusy(false);
    }
  };
  if (state === "loading") return <p role="status">{t("Loading…")}</p>;
  if (state === "denied")
    return (
      <main className="store-support">
        <h1>{t("Platform support")}</h1>
        <p>{t("This page is for platform support staff. Sign in with a support account.")}</p>
      </main>
    );
  if (state === "unavailable" || session === null)
    return (
      <main className="store-support">
        <h1>{t("Platform support")}</h1>
        <div role="alert">
          <p>
            {t(
              "This page can't be reached right now. Owners can still do everything themselves in their Store setup.",
            )}
          </p>
          <button type="button" onClick={() => void loadSession()}>
            {t("Try again")}
          </button>
        </div>
      </main>
    );
  return (
    <main className="store-support">
      <header className="store-support__head">
        <h1>{t("Platform support")}</h1>
        <LanguageSwitch />
      </header>
      <p className="store-support__hint">
        {t("Signed in as {name}. Everything you open is listed for that Store's Owner.", {
          name: session.name,
        })}
      </p>
      <label>
        {t("Store")}
        <select
          value={picked ?? ""}
          onChange={(event) => {
            if (event.currentTarget.value !== "") void open(event.currentTarget.value);
          }}
        >
          <option value="">{t("Choose a Store")}</option>
          {session.stores.map((store) => (
            <option key={store.storeReference} value={store.storeReference}>
              {store.name}
            </option>
          ))}
        </select>
      </label>
      {message === null ? null : <p role="status">{message}</p>}
      {view === null ? null : (
        <StoreTimeZoneContext.Provider value={view.timeZone ?? undefined}>
          <h2>{view.name}</h2>
          <p>
            {view.ownerAllowsChanges ? (
              view.allowedUntil === null ? (
                t("The Owner allows you to change settings.")
              ) : (
                <>
                  {t("The Owner allows you to change settings until")}{" "}
                  <SourceTime instant={view.allowedUntil} />
                </>
              )
            ) : (
              t("Read-only: the Owner hasn't allowed changes right now.")
            )}
          </p>
          <h3>{t("Settings")}</h3>
          <dl className="store-support__facts">
            <dt>{t("Kitchen")}</dt>
            <dd>
              {view.kitchenSetUp ? t("Set up") : t("Not set up: guests can't order here yet")}
            </dd>
            <dt>{t("Pickup")}</dt>
            <dd>{view.features.pickup ? t("On") : t("Off")}</dd>
          </dl>
          {view.ownerAllowsChanges ? (
            <div className="card-actions">
              {view.kitchenSetUp ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      "SetUpKitchenLine",
                      view.kitchenVersion,
                      t("The kitchen is set up."),
                    )
                  }
                >
                  {t("Set up the kitchen")}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(
                    "SetPickup",
                    view.features.version,
                    t("Pickup changed."),
                    !view.features.pickup,
                  )
                }
              >
                {view.features.pickup ? t("Turn pickup off") : t("Turn pickup on")}
              </button>
            </div>
          ) : null}
          <p className="store-support__hint">
            {t(
              "You can't take payment, refund, comp, discount or void, or change staff, roles or payment accounts, even when changes are allowed. Guide the Owner to do those themselves.",
            )}
          </p>
          <h3>{t("Menus")}</h3>
          {view.menus.length === 0 ? (
            <p>{t("No menus yet.")}</p>
          ) : (
            <ul>
              {view.menus.map((menu, index) => (
                <li key={menu.name + index}>
                  {menu.name}: {menu.listed ? t("Listed") : t("Not listed")}
                </li>
              ))}
            </ul>
          )}
          <h3>{t("Recent orders")}</h3>
          {view.orders.length === 0 ? (
            <p>{t("No orders yet.")}</p>
          ) : (
            <table className="support-access__log">
              <thead>
                <tr>
                  <th scope="col">{t("Order")}</th>
                  <th scope="col">{t("When")}</th>
                  <th scope="col">{t("Type")}</th>
                  <th scope="col">{t("Status")}</th>
                  <th scope="col">{t("Items")}</th>
                  <th scope="col">{t("Guest")}</th>
                </tr>
              </thead>
              <tbody>
                {view.orders.map((order) => (
                  <tr key={order.orderNumber}>
                    <td data-label={t("Order")}>{order.orderNumber}</td>
                    <td data-label={t("When")}>
                      <SourceTime instant={order.createdAt} />
                    </td>
                    <td data-label={t("Type")}>{orderTypeText(order.orderType)}</td>
                    <td data-label={t("Status")}>{orderPhaseText(order.phase)}</td>
                    <td data-label={t("Items")}>{order.lineCount ?? "—"}</td>
                    <td data-label={t("Guest")}>{order.guest ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="store-support__hint">
            {t("Guest contact details are hidden from support.")}
          </p>
        </StoreTimeZoneContext.Provider>
      )}
    </main>
  );
}
