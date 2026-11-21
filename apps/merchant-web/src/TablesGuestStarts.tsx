import { useRef, useState } from "react";
import { createDiningSessionClient } from "./dining-session-client.js";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: the line at the top of Tables while guests can start free
 * tables, and for whoever may pause ordering, the way to stop that at the moment a queue forms. Asked
 * once, because only the owner can turn it back on and until then every guest at a free table is
 * sent to staff.
 */
export function TablesGuestStarts({
  starts,
  csrf,
  locked,
  reread,
  onResult,
  fetcher,
}: {
  readonly starts: { readonly version: number; readonly canTurnOff: boolean };
  readonly csrf: string;
  readonly locked: boolean;
  /** Reads the tables again and says whether guests can still start them (null: they can't). */
  readonly reread: () => Promise<unknown>;
  readonly onResult: (text: string) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // One reference per intended change, kept until it is answered (a retry is recorded once).
  const operation = useRef<string | null>(null);
  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    operation.current ??= newOperationReference();
    const off = t("New tables need staff to open them now.");
    try {
      await createDiningSessionClient(fetcher).turnOffGuestTableStart(csrf, {
        operationReference: operation.current,
        expectedVersion: starts.version,
      });
      operation.current = null;
      await reread();
      onResult(off);
    } catch {
      // A second tap, a lost answer or someone else's change: what counts is what the Store says now.
      const current = await reread().catch(() => starts);
      onResult(current === null ? off : t("Not saved. Check your connection and save again."));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <span className="dining-floor-guest-starts">
      {confirming ? (
        <>
          <span>
            {t(
              "New guests at free tables will be sent to staff. Only the owner can turn this back on.",
            )}
          </span>
          <button type="button" disabled={busy || locked} onClick={() => void turnOff()}>
            {busy ? t("Turning off…") : t("Yes, turn off")}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            {t("Keep on")}
          </button>
        </>
      ) : (
        <>
          <span>{t("Guests can start free tables.")}</span>
          {starts.canTurnOff ? (
            <button type="button" disabled={locked} onClick={() => setConfirming(true)}>
              {t("Turn off")}
            </button>
          ) : null}
        </>
      )}
    </span>
  );
}
