import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { SourceTime } from "./StoreTime.js";
import {
  StoreFeaturesClientError,
  type StoreFeatures,
  type StoreFeaturesClient,
} from "./store-features-client.js";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: paid orders go straight to the kitchen, off until the owner
 * turns it on. One switch: a merchant has one idea here, and it covers whichever of pickup and tables
 * that pay first the Store offers (the record keeps the two apart, for when one asks). Saved on its
 * own, against the version the owner saw.
 */
export function StorePaidOrderAutoAccept({
  view,
  client,
  locked,
  onSaved,
}: {
  readonly view: StoreFeatures;
  readonly client: StoreFeaturesClient;
  readonly locked: boolean;
  readonly onSaved: (next: StoreFeatures) => void;
}) {
  const saved = view.autoAccept.pickup || view.autoAccept.dineIn;
  const [draft, setDraft] = useState<boolean | null>(null);
  const on = draft ?? saved;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const operation = useRef<string | null>(null);
  const save = async () => {
    if (busy || locked || on === saved) return;
    operation.current ??= newOperationReference();
    setBusy(true);
    setMessage(null);
    try {
      const next = await client.changeAutoAccept({
        operationReference: operation.current,
        expectedVersion: view.autoAccept.version,
        pickup: on,
        dineIn: on,
      });
      operation.current = null;
      setDraft(null);
      onSaved(next);
      setMessage({
        tone: "status",
        text: on
          ? t("Saved. Paid orders now go straight to the kitchen.")
          : t("Saved. Paid orders wait for Accept on Orders again."),
      });
    } catch (error) {
      if (error instanceof StoreFeaturesClientError && error.code === "Changed") {
        operation.current = null;
        setDraft(null);
        setMessage({
          tone: "alert",
          text: t(
            "Someone else changed these settings. The page now shows them; check and save again.",
          ),
        });
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
    <>
      <fieldset className="store-features__modules" disabled={busy || locked}>
        <legend>{t("Paid orders")}</legend>
        <label className="store-features__row">
          <input
            type="checkbox"
            checked={on}
            onChange={(event) => {
              operation.current = null;
              setDraft(event.target.checked);
            }}
          />
          <span>
            <strong>{t("Send paid orders straight to the kitchen")}</strong>
            <span className="store-features__detail">
              {t(
                "Nobody needs to watch Orders: a paid order goes to the kitchen screen at once, unless the store is paused or closed, or the order has alcohol or is very large.",
              )}
            </span>
            <span className="store-features__detail">
              {t(
                "Keep the kitchen screen on with sound. If you can't make one, tap Can't make it on Orders for a full refund.",
              )}
            </span>
          </span>
        </label>
      </fieldset>
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          disabled={busy || locked || on === saved}
          onClick={() => void save()}
        >
          {t("Save paid orders")}
        </button>
        {view.autoAccept.changedAt === null ? null : (
          <span className="store-features__changed">
            {t("Last changed")} <SourceTime instant={view.autoAccept.changedAt} />
          </span>
        )}
      </div>
      {message === null ? null : (
        <p role={message.tone} className="store-features__message">
          {message.text}
        </p>
      )}
    </>
  );
}
