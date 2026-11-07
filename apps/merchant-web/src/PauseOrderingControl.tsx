import { useEffect, useMemo, useState } from "react";
import { t } from "./i18n/i18n.js";
import {
  createServiceControlClient,
  serviceOperationReference,
  type ServiceControlState,
} from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";

const choices = [15, 30, 60, 120] as const;
/** WP-2423 store-service-controls (v15 M30): staff are warned this long before ordering resumes. */
export const pauseEndingWarningMs = 5 * 60_000;
/** The server's limit for a new pause (service-control-store `storeServicePauseLimitMs`). */
export const pauseLimitMs = 4 * 60 * 60_000;
/** "Pause 15 more min": the new end, or null when it would pass the 4-hour limit from now. */
export function pauseExtendedUntil(until: string, now: number): string | null {
  const next = Date.parse(until) + 15 * 60_000;
  return next > now + pauseLimitMs ? null : new Date(next).toISOString();
}
type ActivePause = ServiceControlState["activePauses"][number];
const modeOrder = ["DineIn", "Pickup", "Delivery"] as const;
/**
 * WP-2423 store-service-controls (v15 M30 review): "15 more min" adds a pause, so several can be
 * active at once. Guests stay paused to the chained end: the latest end among pauses that overlap
 * from now (the server's `pausedUntil` rule). The control shows and extends from that end and
 * Resume ends every pause in the chain; null when nothing is paused now.
 */
export function pauseChain(
  pauses: readonly ActivePause[],
  now: number,
): {
  readonly until: string;
  readonly pauses: readonly ActivePause[];
  readonly serviceModes: ActivePause["serviceModes"];
} | null {
  let until = now;
  const covered: ActivePause[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const pause of pauses) {
      if (covered.includes(pause)) continue;
      const from = Date.parse(pause.effectiveFrom),
        end = Date.parse(pause.effectiveUntil);
      if (from <= until && end > now && (covered.length > 0 || from <= now)) {
        covered.push(pause);
        if (end > until) until = end;
        changed = true;
      }
    }
  }
  if (covered.length === 0) return null;
  const serviceModes = covered.some((pause) => pause.serviceModes === null)
    ? null
    : modeOrder.filter((mode) => covered.some((pause) => pause.serviceModes?.includes(mode)));
  return { until: new Date(until).toISOString(), pauses: covered, serviceModes };
}
/** Re-read this often, so a pause that ended, or one set on another screen, shows as it is. */
export const pauseOrderingReadMs = 30_000;

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the busy-night brake where staff work (Home, Orders, Pickup
 * and the kitchen board). WP-2423 store-service-controls (v15 M30): at every Store, not only one
 * sending paid orders straight to the kitchen. Shown to whoever may pause ordering (the read
 * answers no to anyone else); it uses the Store's own pause, so every other page and guests see
 * the same thing. From 5 minutes before a pause ends it says so and offers 15 more minutes.
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
  const offered = true;
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
  const chain = view === null ? null : pauseChain(view.activePauses, now);
  const paused = chain ?? undefined;
  const pausedUntil = chain?.until;
  useEffect(() => {
    if (pausedUntil === undefined) return;
    const left = Date.parse(pausedUntil) - Date.now();
    // Wake at the warning point as well as at the end, so the warning shows on time.
    const warnIn = left - pauseEndingWarningMs;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        setRevision((value) => value + 1);
      },
      Math.max(0, Math.min(warnIn > 0 ? warnIn : left, pauseOrderingReadMs)) + 500,
    );
    return () => clearTimeout(timer);
  }, [pausedUntil]);
  if (!offered || view === null) return null;
  // Several commands (Resume of a chain) run one after another, each on the version before it.
  const run = async (...commands: Parameters<typeof client.execute>[0][]) => {
    setBusy(true);
    setFailed(false);
    try {
      for (const command of commands)
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
  const ending = paused !== undefined && Date.parse(paused.until) - now <= pauseEndingWarningMs;
  const extended = paused === undefined ? null : pauseExtendedUntil(paused.until, now);
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
          <span role={ending ? "alert" : undefined}>
            {ending
              ? t("Online ordering starts again at {time} (in {minutes} min).", {
                  time: storeTime(paused.until, view.timeZone),
                  minutes: Math.max(1, Math.ceil((Date.parse(paused.until) - now) / 60_000)),
                })
              : t("Ordering paused until {time}", {
                  time: storeTime(paused.until, view.timeZone),
                })}
          </span>{" "}
          {ending && extended !== null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run({
                  ...common,
                  command: "PauseService",
                  content: { effectiveUntil: extended, serviceModes: paused.serviceModes },
                })
              }
            >
              {t("Pause 15 more min")}
            </button>
          ) : null}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                ...paused.pauses.map((pause, index) => ({
                  ...common,
                  operationReference: serviceOperationReference(),
                  auditReference: serviceOperationReference(),
                  expectedVersion: view.expectedVersion + index,
                  command: "ResumeService" as const,
                  content: { pauseOperationReference: pause.closureReference },
                })),
              )
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
