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
  validTipTiers,
} from "./store-features-client.js";
import { createPickupClient } from "./pickup-client.js";
import { StoreTeaCharge } from "./StoreTeaCharge.js";
import type { PickupClient } from "./pickup.js";

/**
 * Pickup orders still waiting to be handed over, from Fulfillment's current pickup queue (the
 * same read as the Pickup page), page by page; null when the queue can't be read.
 */
export async function waitingPickupOrders(client: PickupClient): Promise<number | null> {
  let after: string | null = null;
  let count = 0;
  try {
    for (let page = 0; page < 20; page++) {
      const view = (await client.loadQueue({
        afterFulfillmentReference: after,
        includeCompleted: false,
      })) as { items: readonly unknown[]; nextAfterFulfillmentReference: string | null };
      count += view.items.length;
      if (view.nextAfterFulfillmentReference === null) return count;
      after = view.nextAfterFulfillmentReference;
    }
    return null;
  } catch {
    return null;
  }
}

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
const servicesOf = (value: StoreFeatures) => ({
  staffCall: value.services.staffCall,
  chaseDish: value.services.chaseDish,
  askPartySize: value.services.askPartySize,
});
const tipsDraftOf = (value: StoreFeatures) => ({
  enabled: value.tips.enabled,
  tiers: value.tips.tierPercents.map(String) as [string, string, string],
});

export function StoreFeaturesPage({
  csrf,
  storeReference,
  storeLabel,
  client: injected,
  pickup: injectedPickup,
}: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly client?: StoreFeaturesClient;
  readonly pickup?: PickupClient;
}) {
  const client = useMemo(() => injected ?? createStoreFeaturesClient(csrf), [injected, csrf]);
  const pickupQueue = useMemo(
    () => injectedPickup ?? createPickupClient({ csrf, storeReference, storeLabel }),
    [injectedPickup, csrf, storeReference, storeLabel],
  );
  // Before guests' pickup is turned off: how many pickup orders are still waiting.
  const [waiting, setWaiting] = useState<"Reading" | number | null>("Reading");
  const ask = (action: "Template" | "Save") => {
    setConfirming(action);
    setWaiting("Reading");
    void waitingPickupOrders(pickupQueue).then(setWaiting);
  };
  const [view, setView] = useState<StoreFeatures | null>(null);
  const [failed, setFailed] = useState<"Denied" | "Unavailable" | null>(null);
  const [draft, setDraft] = useState<Modules | null>(null);
  // WP-2423 item 8 ⑦ (Owner decision 4): the table switches, saved on their own.
  const [services, setServices] = useState<{
    staffCall: boolean;
    chaseDish: boolean;
    askPartySize: boolean;
  } | null>(null);
  // WP-2423 item 8 ⑦ (Owner decision 11): tips on or off, and the three percentages as typed.
  const [tips, setTips] = useState<{ enabled: boolean; tiers: [string, string, string] } | null>(
    null,
  );
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
        setServices(servicesOf(value));
        setTips(tipsDraftOf(value));
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
  if (view === null || draft === null || services === null || tips === null)
    return (
      <WorkspacePage title={t("Store features")}>
        <p role="status">{t("Reading store features…")}</p>
      </WorkspacePage>
    );
  const tierPercents = tips.tiers.map((value) =>
    /^[1-9][0-9]?$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN,
  );
  const tiersValid = validTipTiers(tierPercents);
  const tipsChanged =
    tips.enabled !== view.tips.enabled ||
    tierPercents.some((value, index) => value !== view.tips.tierPercents[index]);
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
        {waiting === "Reading"
          ? t("Checking the pickup orders still waiting…")
          : waiting === null
            ? t(
                "The pickup queue could not be read, so it isn't known whether pickup orders are still waiting. Check the Pickup page.",
              )
            : waiting === 0
              ? t("No pickup orders are waiting to be handed over.")
              : waiting === 1
                ? t("1 pickup order is still waiting to be handed over.")
                : t("{count} pickup orders are still waiting to be handed over.", {
                    count: waiting,
                  })}
      </p>
      <p>
        {counterAfter
          ? t(
              "Guests will no longer be able to order pickup. Pickup orders already placed are still handed over on the Pickup page.",
            )
          : typeof waiting === "number" && waiting > 0
            ? // v15 live check: the page stays while pickup orders wait (finding v).
              t(
                "Guests will no longer be able to order pickup. The Pickup page stays until the pickup orders still waiting are handed over, then it is hidden.",
              )
            : t(
                "Guests will no longer be able to order pickup, and the Pickup page will be hidden. Hand over any pickup orders still waiting first.",
              )}
      </p>
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          // Asked once the waiting count is known (or known to be unreadable).
          disabled={busy || waiting === "Reading"}
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
      setServices(servicesOf(next));
      setTips(tipsDraftOf(next));
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
              onClick={() => (view.modules.pickup ? ask("Template") : applyTemplate())}
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
            onClick={() => (view.modules.pickup && !draft.pickup ? ask("Save") : save())}
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
        <fieldset className="store-features__modules" disabled={busy}>
          <legend>{t("At the table")}</legend>
          <label className="store-features__row">
            <input
              type="checkbox"
              checked={services.staffCall}
              onChange={(event) => {
                operation.current = null;
                setServices({ ...services, staffCall: event.target.checked });
              }}
            />
            <span>
              <strong>{t("Guests can call staff")}</strong>
              <span className="store-features__detail">
                {t(
                  "A guest at the table taps “Call staff” on their phone; the table shows it on Tables, with a sound.",
                )}
              </span>
            </span>
          </label>
          <label className="store-features__row">
            <input
              type="checkbox"
              checked={services.chaseDish}
              onChange={(event) => {
                operation.current = null;
                setServices({ ...services, chaseDish: event.target.checked });
              }}
            />
            <span>
              <strong>{t("Servers can chase a dish")}</strong>
              <span className="store-features__detail">
                {t(
                  "On a table's order, “Chase” next to a dish not yet ready turns its kitchen ticket red with a sound, and counts the chases. A round can be chased once every 5 minutes.",
                )}
              </span>
            </span>
          </label>
          <label className="store-features__row">
            <input
              type="checkbox"
              checked={services.askPartySize}
              onChange={(event) => {
                operation.current = null;
                setServices({ ...services, askPartySize: event.target.checked });
              }}
            />
            <span>
              <strong>{t("Ask how many guests when opening a table")}</strong>
              <span className="store-features__detail">
                {t(
                  "Staff enter the number of guests when they open a table, and can change it later on the table.",
                )}
              </span>
            </span>
          </label>
        </fieldset>
        <div className="store-features__actions">
          <button
            type="button"
            className="store-features__save"
            disabled={
              busy ||
              (services.staffCall === view.services.staffCall &&
                services.chaseDish === view.services.chaseDish &&
                services.askPartySize === view.services.askPartySize)
            }
            onClick={() =>
              void run(
                (operationReference) =>
                  client.changeServices({
                    operationReference,
                    expectedVersion: view.services.version,
                    ...services,
                  }),
                t("Saved. Staff see the change the next time a page opens."),
              )
            }
          >
            {t("Save table settings")}
          </button>
        </div>
        {/* WP-2423 item 8 ⑦ 4b-2: the per-head tea charge (Dining's own setting). */}
        <StoreTeaCharge
          csrf={csrf}
          view={view}
          client={client}
          locked={busy}
          onSaved={(next) => setView(next)}
        />
        <fieldset className="store-features__modules" disabled={busy}>
          <legend>{t("Tips")}</legend>
          <label className="store-features__row">
            <input
              type="checkbox"
              checked={tips.enabled}
              onChange={(event) => {
                operation.current = null;
                setTips({ ...tips, enabled: event.target.checked });
              }}
            />
            <span>
              <strong>{t("Guests and staff can add a tip")}</strong>
              <span className="store-features__detail">
                {tips.enabled
                  ? t(
                      "At payment there are three percentages, No tip and Other amount. Nothing is chosen for the guest; the tip is worked out on the subtotal before tax.",
                    )
                  : t(
                      "No one is asked for a tip and none can be added. If your card machine asks for a tip, turn that off on the machine too.",
                    )}
              </span>
            </span>
          </label>
          {tips.enabled ? (
            <div className="store-features__row store-features__tiers">
              <span id="store-tip-tiers">{t("Tip percentages")}</span>
              {tips.tiers.map((value, index) => (
                <label key={index}>
                  <input
                    inputMode="numeric"
                    aria-describedby="store-tip-tiers store-tip-tiers-help"
                    aria-label={
                      index === 0
                        ? t("Lowest tip percentage")
                        : index === 1
                          ? t("Middle tip percentage")
                          : t("Highest tip percentage")
                    }
                    aria-invalid={!tiersValid}
                    value={value}
                    onChange={(event) => {
                      operation.current = null;
                      const tiers = [...tips.tiers] as [string, string, string];
                      tiers[index] = event.target.value;
                      setTips({ ...tips, tiers });
                    }}
                  />
                  %
                </label>
              ))}
              <span id="store-tip-tiers-help" className="store-features__detail">
                {tiersValid
                  ? t("Whole numbers from 1 to 50, lowest first.")
                  : t("Enter three different whole numbers from 1 to 50, lowest first.")}
              </span>
            </div>
          ) : null}
        </fieldset>
        <div className="store-features__actions">
          <button
            type="button"
            className="store-features__save"
            disabled={busy || !tipsChanged || (tips.enabled && !tiersValid)}
            onClick={() =>
              void run(
                (operationReference) =>
                  client.changeTips({
                    operationReference,
                    expectedVersion: view.tips.version,
                    enabled: tips.enabled,
                    // Tips off keeps the percentages, for when they are turned back on.
                    tierPercents: tiersValid ? tierPercents : [...view.tips.tierPercents],
                  }),
                tips.enabled
                  ? t("Saved. Guests and staff are offered these tips from now on.")
                  : t("Saved. No one is asked for a tip from now on."),
              )
            }
          >
            {t("Save tips")}
          </button>
          {view.tips.changedAt === null ? null : (
            <span className="store-features__changed">
              {t("Last changed")} <SourceTime instant={view.tips.changedAt} />
            </span>
          )}
        </div>
        {message === null ? null : (
          <p role={message.tone} className="store-features__message">
            {message.text}
          </p>
        )}
      </div>
    </WorkspacePage>
  );
}
