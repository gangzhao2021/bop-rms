import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { t } from "./i18n/i18n.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createStoreKitchenSetupClient,
  StoreKitchenSetupClientError,
  type StoreKitchenSetupView,
} from "./store-kitchen-setup-client.js";
import { SourceTime } from "./StoreTime.js";

/**
 * WP-2423 item 11 (Owner 2026-11-01): Store setup → "Kitchen". Says whether this Store's kitchen is
 * set up and what is missing; one step sets up its one kitchen line (Owner 取舍 5: one kitchen
 * screen per Store, dishes divided by kitchen sections). A dish the line can't take is named here
 * before an order strands. A change applies to orders confirmed from then on.
 */
export function StoreKitchenSetupPanel({ csrf }: { readonly csrf: string }) {
  const client = useMemo(() => createStoreKitchenSetupClient({ csrf }), [csrf]);
  const [view, setView] = useState<StoreKitchenSetupView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "unavailable">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A retry after an unknown outcome repeats the same operation, so it can't apply twice.
  const pending = useRef<string | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const { hash } = useLocation();
  const load = useCallback(async () => {
    try {
      setView(await client.load());
      setState("ready");
    } catch (error) {
      setState(
        error instanceof StoreKitchenSetupClientError && error.code === "PermissionDenied"
          ? "denied"
          : "unavailable",
      );
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  // The listing refusal links here.
  useEffect(() => {
    if (state === "ready" && hash === "#kitchen-setup") section.current?.scrollIntoView();
  }, [state, hash]);
  const apply = async (done: string) => {
    if (view === null || busy) return;
    setBusy(true);
    setMessage(null);
    pending.current ??= serviceOperationReference();
    try {
      await client.apply({
        operationReference: pending.current,
        expectedVersion: view.version,
      });
      pending.current = null;
      setMessage(done);
      await load();
    } catch (error) {
      const code = error instanceof StoreKitchenSetupClientError ? error.code : "OutcomeUnknown";
      if (code !== "OutcomeUnknown" && code !== "Unavailable") pending.current = null;
      setMessage(
        code === "Conflict"
          ? t("Someone else changed this kitchen just now. Here is what it is now.")
          : code === "PermissionDenied"
            ? t("You can't change this kitchen. Ask the Owner or Store Manager.")
            : t("We couldn't confirm that went through. Check your connection and try again."),
      );
      if (code === "Conflict") await load();
    } finally {
      setBusy(false);
    }
  };
  if (state === "denied") return null;
  return (
    <section
      ref={section}
      id="kitchen-setup"
      className="kitchen-setup"
      aria-labelledby="kitchen-setup-heading"
    >
      <h3 id="kitchen-setup-heading">{t("Kitchen")}</h3>
      {state === "loading" ? <p role="status">{t("Loading the kitchen…")}</p> : null}
      {state === "unavailable" ? (
        <div role="status">
          <p>{t("We can't show the kitchen setup right now. Nothing was changed.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </div>
      ) : null}
      {state === "ready" && view !== null ? (
        view.version === 0 ? (
          <>
            <p role="note">
              {t(
                "Guests can't order at this Store until its kitchen is set up: an order here would be paid and never reach a kitchen.",
              )}
            </p>
            <p className="kitchen-setup__hint">
              {t(
                "One kitchen line takes every dish and shows them on this Store's Kitchen screen. You can divide dishes by kitchen section afterwards.",
              )}
            </p>
            {view.canChange ? (
              <div className="card-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void apply(t("The kitchen is set up. New orders go to it from now on."))
                  }
                >
                  {t("Set up one kitchen line for all dishes")}
                </button>
              </div>
            ) : (
              <p role="note">{t("Ask the Owner or Store Manager to set this up.")}</p>
            )}
          </>
        ) : (
          <>
            <p>
              {t("One kitchen line takes this Store's dishes, since")}{" "}
              {view.inEffectFrom === null ? null : <SourceTime instant={view.inEffectFrom} />}
            </p>
            {view.uncoveredDishes.length === 0 ? (
              <p className="kitchen-setup__hint">
                {t("Every dish with a recipe can reach the kitchen.")}
              </p>
            ) : (
              <div role="alert">
                <p>
                  {t(
                    "These dishes can't reach the kitchen: their recipes need something this kitchen isn't set up for. An order for one would be paid and not reach the kitchen.",
                  )}
                </p>
                <ul className="kitchen-setup__dishes">
                  {view.uncoveredDishes.map((dish) => (
                    <li key={dish}>{dish}</li>
                  ))}
                </ul>
                {view.canChange ? (
                  <div className="card-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void apply(t("The kitchen now takes these dishes, for orders from now on."))
                      }
                    >
                      {t("Let the kitchen take these dishes")}
                    </button>
                  </div>
                ) : (
                  <p role="note">{t("Ask the Owner or Store Manager to fix this.")}</p>
                )}
              </div>
            )}
            <p className="kitchen-setup__hint">
              {t(
                "A change applies to orders confirmed from now on. Orders already confirmed keep what they got.",
              )}
            </p>
            <p className="kitchen-setup__hint">
              {t(
                "If a paid order doesn't appear on the Kitchen screen during service: make it from the Orders page, or cancel and refund it there. Then fix the dish here.",
              )}
            </p>
          </>
        )
      ) : null}
      {message !== null ? <p role="status">{message}</p> : null}
    </section>
  );
}
