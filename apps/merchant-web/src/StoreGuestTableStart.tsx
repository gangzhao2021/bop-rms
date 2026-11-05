import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import {
  StoreFeaturesClientError,
  type StoreFeatures,
  type StoreFeaturesClient,
} from "./store-features-client.js";

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: guests start a free table by scanning. Dining's own switch,
 * saved on its own with the table settings' version. Only where guests pay each round first.
 * `tableAutoAccept`: whether paid table rounds go straight to the kitchen, once a Store can choose.
 * `onConflict`: someone else changed the table settings first, so the page reads them again.
 */
export function StoreGuestTableStart({
  view,
  client,
  locked,
  onSaved,
  onConflict,
  tableAutoAccept,
}: {
  readonly view: StoreFeatures;
  readonly client: StoreFeaturesClient;
  readonly locked: boolean;
  readonly onSaved: (next: StoreFeatures) => void;
  readonly onConflict: () => void;
  readonly tableAutoAccept?: boolean | undefined;
}) {
  const [chosen, setChosen] = useState(view.services.guestTableStart);
  // A changed saved value (saved here, on Tables or on another device) replaces the unsaved choice.
  const saved = view.services.guestTableStart;
  useEffect(() => setChosen(saved), [saved]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  // One reference per intended change, kept until it is answered (a retry is recorded once).
  const operation = useRef<string | null>(null);
  // Already on, it can still be turned off at a Store that has since moved to pay later.
  const allowed = view.guestTableStartAllowed || view.services.guestTableStart;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    operation.current ??= newOperationReference();
    try {
      const next = await client.changeServices({
        operationReference: operation.current,
        expectedVersion: view.services.version,
        staffCall: view.services.staffCall,
        chaseDish: view.services.chaseDish,
        askPartySize: view.services.askPartySize,
        guestTableStart: chosen,
      });
      operation.current = null;
      onSaved(next);
      setChosen(next.services.guestTableStart);
      setMessage({
        tone: "status",
        text: next.services.guestTableStart
          ? t("Saved. Guests can start free tables now.")
          : t("Saved. New tables need staff to open them; tables already started finish as usual."),
      });
    } catch (error) {
      const code = error instanceof StoreFeaturesClientError ? error.code : "Unavailable";
      if (code !== "Unavailable") operation.current = null;
      if (code === "Changed") onConflict();
      setMessage({
        tone: "alert",
        text:
          code === "GuestStartNeedsPayFirst"
            ? t("Only for stores where guests pay each round first.")
            : code === "Changed"
              ? t(
                  "Someone else changed these settings. The page now shows them; check and save again.",
                )
              : code === "Denied"
                ? t("Only the owner changes store features.")
                : t("Not saved. Check the connection and try again."),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="store-features__modules" disabled={locked || busy}>
      <legend>{t("Guests starting tables")}</legend>
      <label className="store-features__row">
        <input
          type="checkbox"
          checked={chosen}
          disabled={!allowed}
          onChange={(event) => {
            operation.current = null;
            setChosen(event.target.checked);
          }}
        />
        <span>
          <strong>{t("Guests can start a free table")}</strong>
          <span className="store-features__detail">
            {allowed
              ? t(
                  "A guest who scans a free table orders right away and pays each round on their phone. A finished table frees itself with no cleaning step: 20 minutes after the last activity if nobody ordered, 90 minutes if they did. The next party, or someone with a photo of the code, can also end a table quiet for 5 minutes with nothing owed, even if its guests are still sitting there. Nobody gets food without paying.",
                )
              : t("Only for stores where guests pay each round first.")}
          </span>
        </span>
      </label>
      {chosen && tableAutoAccept !== true ? (
        <p role="note">
          {tableAutoAccept === false
            ? t(
                "Each paid round still waits for Accept on Orders. Turn on “Send paid orders straight to the kitchen” if nobody watches Orders.",
              )
            : t("Each paid round still waits for Accept on Orders.")}
        </p>
      ) : null}
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          disabled={busy || locked || chosen === view.services.guestTableStart}
          onClick={() => void save()}
        >
          {t("Save this setting")}
        </button>
      </div>
      {message === null ? null : (
        <p role={message.tone} className="store-features__message">
          {message.text}
        </p>
      )}
    </fieldset>
  );
}
