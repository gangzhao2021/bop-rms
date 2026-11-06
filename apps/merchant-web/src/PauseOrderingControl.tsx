import { useContext, useEffect, useMemo, useState } from "react";
import { t } from "./i18n/i18n.js";
import {
  createServiceControlClient,
  serviceOperationReference,
  type ServiceControlState,
} from "./service-control-client.js";
import { PaidOrderWatchContext } from "./PaidOrderAlarm.js";
import { storeTime } from "./StoreTime.js";

const choices = [15, 30, 60] as const;
/** Re-read this often, so a pause that ended, or one set on another screen, shows as it is. */
export const pauseOrderingReadMs = 30_000;

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the busy-night brake where staff work, on Orders and the
 * kitchen board, at a Store sending paid orders straight to the kitchen (others see nothing new).
 * Shown to whoever may pause ordering (the read answers no to anyone else); it uses the Store's own
 * pause, so every other page and guests see the same thing.
 */
export function PauseOrderingControl({
  csrf,
  storeReference,
  fetcher,
}: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const watch = useContext(PaidOrderWatchContext);
  const offered = watch?.on === true;
  const client = useMemo(() => createServiceControlClient(fetcher ?? fetch), [fetcher]);
  const [view, setView] = useState<ServiceControlState | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!offered) return;
    const controller = new AbortController();
    client
      .load(storeReference, controller.signal)
      .then((next) => {
        setView(next);
        setNow(Date.now());
      })
      .catch(() => setView(null));
    const timer = setTimeout(() => setRevision((value) => value + 1), pauseOrderingReadMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, offered, storeReference, revision]);
  // A pause whose time has passed is over, whatever the last read said.
  const paused = view?.activePauses.find((pause) => Date.parse(pause.effectiveUntil) > now);
  useEffect(() => {
    if (paused === undefined) return;
    const left = Date.parse(paused.effectiveUntil) - Date.now();
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        setRevision((value) => value + 1);
      },
      Math.max(0, Math.min(left, pauseOrderingReadMs)) + 500,
    );
    return () => clearTimeout(timer);
  }, [paused]);
  if (!offered || view === null) return null;
  const run = async (command: Parameters<typeof client.execute>[0]) => {
    setBusy(true);
    setFailed(false);
    try {
      await client.execute(command, csrf, new AbortController().signal);
      setAsking(false);
      setRevision((value) => value + 1);
    } catch {
      // Often it changed on another screen (a pause ended or was set): show it as it is now.
      setFailed(true);
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };
  const common = {
    operationReference: serviceOperationReference(),
    auditReference: serviceOperationReference(),
    configurationReference: view.configurationReference,
    expectedVersion: view.expectedVersion,
  };
  return (
    <div
      className="pause-ordering"
      data-asking={asking && paused === undefined ? "true" : undefined}
    >
      {paused !== undefined ? (
        <>
          <span>
            {t("Ordering paused until {time}", {
              time: storeTime(paused.effectiveUntil, view.timeZone),
            })}
          </span>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run({
                ...common,
                command: "ResumeService",
                content: { pauseOperationReference: paused.closureReference },
              })
            }
          >
            {t("Resume")}
          </button>
        </>
      ) : asking ? (
        <>
          <span>{t("Guests can't order while paused. Orders already paid still come in.")}</span>
          <span className="pause-ordering__choices">
            {choices.map((minutes) => (
              <button
                key={minutes}
                type="button"
                disabled={busy}
                onClick={() =>
                  void run({
                    ...common,
                    command: "PauseService",
                    content: {
                      effectiveUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
                      serviceModes: null,
                    },
                  })
                }
              >
                {t("{minutes} min", { minutes })}
              </button>
            ))}{" "}
            <button type="button" disabled={busy} onClick={() => setAsking(false)}>
              {t("Cancel")}
            </button>
          </span>
        </>
      ) : (
        <button type="button" onClick={() => setAsking(true)}>
          {t("Pause ordering")}
        </button>
      )}
      {failed ? (
        <span role="alert" className="pause-ordering__failed">
          {t("Not saved. It may have changed on another screen; this shows it as it is now.")}
        </span>
      ) : null}
    </div>
  );
}
