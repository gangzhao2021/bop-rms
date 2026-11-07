import { useContext, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { PaidOrderWatchContext } from "./PaidOrderAlarm.js";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the brake, on the pages staff work on. Whoever may pause
 * ordering may turn automatic sending off (recorded in their name); turning it on is the owner's.
 * Says nothing at a Store that does not have it on.
 */
export function PaidOrderSwitchLine({
  csrf,
  fetcher = fetch,
}: {
  readonly csrf: string | null | undefined;
  readonly fetcher?: typeof fetch;
}) {
  const watch = useContext(PaidOrderWatchContext);
  const [state, setState] = useState<"Idle" | "Asking" | "Busy" | "Off" | "Failed" | "Changed">(
    "Idle",
  );
  const operation = useRef<string | null>(null);
  if (state === "Off")
    return <p role="status">{t("Paid orders now wait for Accept on Orders.")}</p>;
  if (watch === null || !watch.on) return null;
  const turnOff = async () => {
    setState("Busy");
    operation.current ??= newOperationReference();
    try {
      const response = await fetcher("/merchant/orders/auto-accept/off", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf ?? "" },
        body: JSON.stringify({
          operationReference: operation.current,
          expectedVersion: watch.settingVersion,
        }),
      });
      if (response.status === 409) {
        operation.current = null;
        setState("Changed");
        return;
      }
      if (!response.ok) {
        setState("Failed");
        return;
      }
      operation.current = null;
      setState("Off");
    } catch {
      setState("Failed");
    }
  };
  return (
    <div className="paid-order-switch-line">
      <span>{t("Paid orders go straight to the kitchen")}</span>
      {watch.canTurnOff ? (
        state === "Asking" || state === "Busy" ? (
          <>
            {" · "}
            <button type="button" disabled={state === "Busy"} onClick={() => void turnOff()}>
              {t("Yes, turn off")}
            </button>{" "}
            <button type="button" disabled={state === "Busy"} onClick={() => setState("Idle")}>
              {t("Keep it on")}
            </button>
          </>
        ) : (
          <>
            {" · "}
            <button type="button" onClick={() => setState("Asking")}>
              {t("Turn off")}
            </button>
          </>
        )
      ) : null}
      {state === "Failed" ? (
        <span role="alert"> {t("Not saved. Check the connection and try again.")}</span>
      ) : null}
      {state === "Changed" ? (
        <span role="alert"> {t("Someone else changed this just now. Check it again.")}</span>
      ) : null}
    </div>
  );
}
