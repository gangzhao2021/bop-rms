import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { SourceTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  createStoreFeaturesClient,
  StoreFeaturesClientError,
  type StoreFeatures,
  type StoreFeaturesClient,
} from "./store-features-client.js";

interface Modules {
  readonly counterOrder: boolean;
  readonly pickup: boolean;
  readonly inventory: boolean;
}
const modulesOf = (view: StoreFeatures): Modules => ({
  counterOrder: view.modules.counterOrder,
  pickup: view.modules.pickup,
  inventory: view.modules.inventory,
});
const rows: readonly { key: keyof Modules; name: () => string; detail: () => string }[] = [
  {
    key: "counterOrder",
    name: () => t("Counter ordering"),
    detail: () =>
      t("Take walk-up orders at the counter. Rounds staff enter for a table are not affected."),
  },
  {
    key: "pickup",
    name: () => t("Pickup orders from guests"),
    detail: () =>
      t(
        "Guests order ahead from the pickup QR code and collect at the counter. Turned off, a guest who scans it is told the store takes dine-in orders only.",
      ),
  },
  {
    key: "inventory",
    name: () => t("Inventory and recipes"),
    detail: () =>
      t(
        "Stock items, receiving, counts, waste and recipes. Turned off, these pages are hidden; stock already recorded is kept, and sold out is still set in Item availability.",
      ),
  },
];

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Section 88 STORE-CAPABILITY): the modules this Store
 * uses. The full-service setup turns off what a sit-down restaurant does not use; each module can
 * be turned back on. A change takes effect at once for every staff member; someone else's change
 * in between is shown and asked again.
 */
export function StoreFeaturesPage({
  csrf,
  client: injected,
}: {
  readonly csrf: string;
  readonly client?: StoreFeaturesClient;
}) {
  const client = useMemo(() => injected ?? createStoreFeaturesClient(csrf), [injected, csrf]);
  const [view, setView] = useState<StoreFeatures | null>(null);
  const [failed, setFailed] = useState<"Denied" | "Unavailable" | null>(null);
  const [draft, setDraft] = useState<Modules | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  // Turning guests' pickup off is asked once more (what staff do with pickups still waiting).
  const [confirming, setConfirming] = useState<null | "Template" | "Save">(null);
  // One reference per intended change, kept until it is answered (a retry is recorded once).
  const operation = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .read()
      .then((value) => {
        if (!active) return;
        setView(value);
        setDraft(modulesOf(value));
        setFailed(null);
      })
      .catch((error: unknown) => {
        if (active)
          setFailed(
            error instanceof StoreFeaturesClientError && error.code === "Denied"
              ? "Denied"
              : "Unavailable",
          );
      });
    return () => {
      active = false;
    };
  }, [client, refresh]);
  if (failed !== null)
    return (
      <WorkspacePage title={t("Store features")}>
        <StatePanel
          heading={
            failed === "Denied" ? t("Only the owner changes store features") : t("Unavailable")
          }
          tone={failed === "Denied" ? "neutral" : "error"}
          status
        >
          {failed === "Denied" ? null : (
            <>
              <p>{t("Store features could not be read. Check the connection and try again.")}</p>
              <button type="button" onClick={() => setRefresh((value) => value + 1)}>
                {t("Try again")}
              </button>
            </>
          )}
        </StatePanel>
      </WorkspacePage>
    );
  if (view === null || draft === null)
    return (
      <WorkspacePage title={t("Store features")}>
        <p role="status">{t("Reading store features…")}</p>
      </WorkspacePage>
    );
  const changed =
    draft.counterOrder !== view.modules.counterOrder ||
    draft.pickup !== view.modules.pickup ||
    draft.inventory !== view.modules.inventory;
  const fullService =
    view.templateCode === "FullService" &&
    !view.modules.counterOrder &&
    !view.modules.pickup &&
    !view.modules.inventory;
  const applyTemplate = () =>
    void run(
      (operationReference) =>
        client.applyFullService({ operationReference, expectedVersion: view.version }),
      t("The full-service restaurant setup is in use."),
    );
  const save = () =>
    void run(
      (operationReference) =>
        client.change({ operationReference, expectedVersion: view.version, modules: draft }),
      t("Saved. Staff see the change the next time a page opens."),
    );
  // Whether this change turns guests' pickup off, and what staff then hand over where.
  const pickupOff = (counterAfter: boolean) => (
    <div className="store-features__confirm" role="alert">
      <p>
        {counterAfter
          ? t(
              "Guests will no longer be able to order pickup. Pickup orders already placed are still handed over on the Pickup page.",
            )
          : t(
              "Guests will no longer be able to order pickup, and the Pickup page will be hidden. Hand over any pickup orders still waiting first.",
            )}
      </p>
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          disabled={busy}
          onClick={() => {
            const action = confirming;
            setConfirming(null);
            if (action === "Template") applyTemplate();
            else save();
          }}
        >
          {t("Turn off pickup")}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
          {t("Keep pickup")}
        </button>
      </div>
    </div>
  );
  const run = async (
    action: (operationReference: string) => Promise<StoreFeatures>,
    done: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    operation.current ??= newOperationReference();
    try {
      const next = await action(operation.current);
      operation.current = null;
      setView(next);
      setDraft(modulesOf(next));
      setMessage({ tone: "status", text: done });
    } catch (error) {
      if (error instanceof StoreFeaturesClientError && error.code === "Changed") {
        operation.current = null;
        setMessage({
          tone: "alert",
          text: t(
            "Someone else changed these settings. The page now shows them; check and save again.",
          ),
        });
        setRefresh((value) => value + 1);
      } else
        setMessage({
          tone: "alert",
          text:
            error instanceof StoreFeaturesClientError && error.code === "Denied"
              ? t("Only the owner changes store features.")
              : t("Not saved. Check the connection and try again."),
        });
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkspacePage title={t("Store features")}>
      <div className="store-features">
        <p className="store-features__intro">
          {t("Choose what this store uses. A change takes effect at once for all staff.")}
        </p>
        <section aria-labelledby="store-features-setup" className="store-features__setup">
          <h2 id="store-features-setup">{t("Full-service restaurant")}</h2>
          <p>
            {fullService
              ? t("This store uses the full-service restaurant setup.")
              : t(
                  "For a sit-down restaurant: turns off counter ordering, pickup orders from guests, and inventory and recipes. You can turn any of them back on below.",
                )}
          </p>
          {fullService ? null : (
            <button
              type="button"
              disabled={busy || confirming !== null}
              onClick={() => (view.modules.pickup ? setConfirming("Template") : applyTemplate())}
            >
              {t("Use the full-service setup")}
            </button>
          )}
          {confirming === "Template" ? pickupOff(false) : null}
        </section>
        <fieldset className="store-features__modules" disabled={busy}>
          <legend>{t("What this store uses")}</legend>
          {rows.map((row) => (
            <label key={row.key} className="store-features__row">
              <input
                type="checkbox"
                checked={draft[row.key]}
                onChange={(event) => {
                  operation.current = null;
                  setDraft({ ...draft, [row.key]: event.target.checked });
                }}
              />
              <span>
                <strong>{row.name()}</strong>
                <span className="store-features__detail">{row.detail()}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="store-features__actions">
          <button
            type="button"
            className="store-features__save"
            disabled={busy || !changed || confirming !== null}
            onClick={() => (view.modules.pickup && !draft.pickup ? setConfirming("Save") : save())}
          >
            {t("Save")}
          </button>
          {view.changedAt === null ? null : (
            <span className="store-features__changed">
              {t("Last changed")} <SourceTime instant={view.changedAt} />
            </span>
          )}
        </div>
        {confirming === "Save" ? pickupOff(draft.counterOrder) : null}
        {message === null ? null : (
          <p role={message.tone} className="store-features__message">
            {message.text}
          </p>
        )}
      </div>
    </WorkspacePage>
  );
}
