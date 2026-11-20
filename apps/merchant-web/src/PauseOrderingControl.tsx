import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
type ServiceMode = (typeof modeOrder)[number];
/** One or two services' ordering, as one phrase in staff words ("Pickup ordering"). */
function servicesPhrase(modes: readonly ServiceMode[]): string {
  const key = modes.join("+");
  switch (key) {
    case "DineIn":
      return t("Table ordering");
    case "Pickup":
      return t("Pickup ordering");
    case "Delivery":
      return t("Delivery ordering");
    case "DineIn+Pickup":
      return t("Table and pickup ordering");
    case "DineIn+Delivery":
      return t("Table and delivery ordering");
    default:
      return t("Pickup and delivery ordering");
  }
}
/**
 * WP-2423 store-service-controls (v15 M30 live check): a pause of some services only names them
 * and the services still open, so staff can tell table ordering is still open while pickup is
 * paused. Null when the pause stops every service the Store offers (the control then says
 * "Ordering paused").
 */
export function pausedServices(
  modes: readonly string[] | null,
  enabled: readonly string[],
): { readonly paused: string; readonly open: string } | null {
  if (modes === null) return null;
  const offered = modeOrder.filter((mode) => enabled.includes(mode));
  const paused = modeOrder.filter((mode) => modes.includes(mode));
  const open = offered.filter((mode) => !paused.includes(mode));
  if (paused.length === 0 || open.length === 0) return null;
  return { paused: servicesPhrase(paused), open: servicesPhrase(open) };
}

/** Re-read this often, so a pause that ended, or one set on another screen, shows as it is. */
export const pauseOrderingReadMs = 30_000;

/** The pause line: until when, or (in the last 5 minutes) when ordering starts again. */
export function pauseLineText(
  until: string,
  services: ReturnType<typeof pausedServices>,
  timeZone: string,
  now: number,
  ending: boolean,
): string {
  const time = storeTime(until, timeZone);
  const minutes = Math.max(1, Math.ceil((Date.parse(until) - now) / 60_000));
  if (services === null)
    return ending
      ? t("Online ordering starts again at {time} (in {minutes} min).", { time, minutes })
      : t("Ordering paused until {time}", { time });
  return ending
    ? t("{services} starts again at {time} (in {minutes} min). {open} is still open.", {
        services: services.paused,
        open: services.open,
        time,
        minutes,
      })
    : t("{services} paused until {time} · {open} still open", {
        services: services.paused,
        open: services.open,
        time,
      });
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the busy-night brake where staff work (Home, Orders, Pickup
 * and the kitchen board). WP-2423 store-service-controls (v15 M30): at every Store, not only one
 * sending paid orders straight to the kitchen. Shown to whoever may pause ordering (the read
 * answers no to anyone else); it uses the Store's own pause, so every other page and guests see
 * the same thing. From 5 minutes before a pause ends it says so and offers 15 more minutes.
 */
/**
 * What the control knows of the Store's pause. "Pending": not answered yet (its place is kept, so
 * the page under it does not move when it answers). "Denied": this person may not pause (nothing
 * shown). "Unknown": the read failed before it ever answered (its place stays kept; it is read again
 * on the usual cycle). A later failed read keeps the last answer instead of hiding the control, so
 * a network blip never moves the page under it (WP-2423 batch 31: a phone kitchen's tickets jumped
 * 68 px when it appeared after the board, and again on every failed read). "Withdrawn": the
 * workspace said this person sees it, but the read is now refused (the permission was taken away
 * during the session): its place stays kept, hidden and out of reach, so the page does not jump
 * 52 px (WP-2423 batch 33); it is read again on the usual cycle.
 */
export interface PauseOrderingRead {
  readonly status: "Pending" | "Denied" | "Withdrawn" | "Unknown" | "Known";
  readonly view: ServiceControlState | null;
  /** When the last answer came, for the pause line's countdown. */
  readonly answeredAt: number;
  readonly reload: () => void;
}

/**
 * WP-2423 batch 32: whether the workspace says this person sees Pause ordering (undefined: it did
 * not say, so the read decides). False: no read and no kept place, so Home, Orders, Pickup and the
 * kitchen board never move when a refused read would have collapsed the place (52 px, 1.4-2.9 s
 * after opening, under a tap aimed at a row).
 */
export const PauseOrderingShownContext = createContext<boolean | undefined>(undefined);

/** The Store's pause, read now and every `pauseOrderingReadMs`; `storeReference` undefined: none. */
export function usePauseOrderingRead(
  storeReference: string | undefined,
  fetcher?: typeof fetch,
): PauseOrderingRead {
  const shown = useContext(PauseOrderingShownContext);
  const notShown = shown === false;
  const client = useMemo(() => createServiceControlClient(fetcher ?? fetch), [fetcher]);
  const [answer, setAnswer] = useState<{
    readonly status: PauseOrderingRead["status"];
    readonly view: ServiceControlState | null;
    readonly answeredAt: number;
  }>(() => ({ status: notShown ? "Denied" : "Pending", view: null, answeredAt: Date.now() }));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (storeReference === undefined || notShown) return;
    const controller = new AbortController();
    client
      // Batch 36: the first read joins Home's; a read after a pause or resume never does.
      .load(storeReference, controller.signal, revision === 0)
      .then((next) => setAnswer({ status: "Known", view: next, answeredAt: Date.now() }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // The client's answer to 403: this person may not pause.
        if (error instanceof Error && error.message.startsWith("Permission denied"))
          setAnswer({
            status: shown === true ? "Withdrawn" : "Denied",
            view: null,
            answeredAt: Date.now(),
          });
        else
          setAnswer((current) =>
            current.status === "Known" ? current : { ...current, status: "Unknown" },
          );
      });
    const timer = setTimeout(() => setRevision((value) => value + 1), pauseOrderingReadMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, storeReference, revision, notShown, shown]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return useMemo(
    () =>
      notShown
        ? { status: "Denied" as const, view: null, answeredAt: answer.answeredAt, reload }
        : { ...answer, reload },
    [answer, reload, notShown],
  );
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: the busy-night brake where staff work (Home, Orders, Pickup
 * and the kitchen board). WP-2423 store-service-controls (v15 M30): at every Store, not only one
 * sending paid orders straight to the kitchen. Shown to whoever may pause ordering (the read
 * answers no to anyone else); it uses the Store's own pause, so every other page and guests see
 * the same thing. From 5 minutes before a pause ends it says so and offers 15 more minutes.
 * `read`: the page's own read of the pause (the kitchen board waits for it before it opens).
 */
export function PauseOrderingControl({
  csrf,
  storeReference,
  fetcher,
  read,
}: {
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch | undefined;
  readonly read?: PauseOrderingRead | undefined;
}) {
  const client = useMemo(() => createServiceControlClient(fetcher ?? fetch), [fetcher]);
  const own = usePauseOrderingRead(read === undefined ? storeReference : undefined, fetcher);
  const current = read ?? own;
  const view = current.view;
  const reload = current.reload;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [current.answeredAt]);
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
        reload();
      },
      Math.max(0, Math.min(warnIn > 0 ? warnIn : left, pauseOrderingReadMs)) + 500,
    );
    return () => clearTimeout(timer);
  }, [pausedUntil, reload]);
  if (
    current.status === "Pending" ||
    current.status === "Unknown" ||
    current.status === "Withdrawn"
  )
    // Its place is kept, hidden and out of reach, until the first answer (or while a read the
    // workspace promised is refused).
    return (
      <div className="pause-ordering" data-place-kept="true" aria-hidden="true">
        <button type="button" tabIndex={-1} disabled>
          {t("Pause ordering")}
        </button>
      </div>
    );
  if (view === null) return null;
  // Several commands (Resume of a chain) run one after another, each on the version before it.
  const run = async (...commands: Parameters<typeof client.execute>[0][]) => {
    setBusy(true);
    setFailed(false);
    try {
      for (const command of commands)
        await client.execute(command, csrf, new AbortController().signal);
      setAsking(false);
      reload();
    } catch {
      // Often it changed on another screen (a pause ended or was set): show it as it is now.
      setFailed(true);
      reload();
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
            {pauseLineText(
              paused.until,
              pausedServices(paused.serviceModes, view.enabledServiceModes),
              view.timeZone,
              now,
              ending,
            )}
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
