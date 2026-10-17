import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { storeTime } from "./StoreTime.js";
import {
  activityRecorded,
  activityRetryMs,
  createStaffSessionClient,
  isOperationalScreen,
  remaining,
  sessionNotice,
  shouldReportActivity,
  type SessionDeadlines,
  type SessionRead,
  type SignInEntry,
  type StaffSessionClient,
} from "./staff-session.js";

/** WP-2423 Q18: the sign-in staff actually use here (the labelled test sign-in in the pilot). */
export function StaffSignInLink({
  client,
  label = "Sign in",
}: {
  readonly client?: StaffSessionClient;
  readonly label?: string;
}) {
  const source = useMemo(() => client ?? createStaffSessionClient(), [client]);
  const [entry, setEntry] = useState<SignInEntry | "Loading" | "Unavailable">("Loading");
  const load = useCallback(() => {
    setEntry("Loading");
    source.signInEntry().then(setEntry, () => setEntry("Unavailable"));
  }, [source]);
  useEffect(load, [load]);
  if (entry === "Loading") return <p className="staff-session__hint">Finding the sign-in page…</p>;
  if (entry === "Unavailable")
    return (
      <p className="staff-session__hint" role="alert">
        The sign-in page could not be reached.{" "}
        <button type="button" onClick={load}>
          Try again
        </button>
      </p>
    );
  return (
    <p className="staff-session__sign-in">
      <a className="shell-action" href={entry.path}>
        {label}
      </a>
      {entry.testOnly ? (
        <span className="staff-session__test-only">
          <strong>TEST-ONLY</strong> internal pilot sign-in. A live store signs in with each staff
          member’s own account.
        </span>
      ) : null}
    </p>
  );
}

/** WP-2423 Q18: shown wherever a staff page needs a Session and there is none. */
export function StaffSignedOutPanel({
  client,
  heading = "Sign in required",
  message = "Sign in to open your Store workspace.",
}: {
  readonly client?: StaffSessionClient;
  readonly heading?: string;
  readonly message?: string;
}) {
  return (
    <StatePanel heading={heading} tone="neutral" status>
      <p>{message}</p>
      <StaffSignInLink {...(client ? { client } : {})} />
    </StatePanel>
  );
}

/**
 * WP-2423 Q18: "Switch staff" on a shared tablet — ends this staff member's Session and opens the
 * sign-in so the next person signs in as themselves. Nothing of the previous Session stays usable.
 */
export function StaffSwitchButton({
  client,
  label = "Switch staff",
}: {
  readonly client?: StaffSessionClient;
  readonly label?: string;
}) {
  const source = useMemo(() => client ?? createStaffSessionClient(), [client]);
  const [state, setState] = useState<"Idle" | "Working" | "Failed">("Idle");
  return (
    <div className="staff-session__switch">
      <button
        type="button"
        disabled={state === "Working"}
        onClick={() => {
          setState("Working");
          void (async () => {
            try {
              await source.signOut();
              const entry = await source.signInEntry();
              window.location.assign(entry.path);
            } catch {
              setState("Failed");
            }
          })();
        }}
      >
        {state === "Working" ? "Signing out…" : label}
      </button>
      {state === "Failed" ? (
        <p role="alert" className="staff-session__hint">
          Sign-out did not finish. Check the connection and try again.
        </p>
      ) : null}
    </div>
  );
}

function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 5_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

/**
 * WP-2423 Q18: keeps the staff Session alive while staff work, warns before it ends (idle or the
 * 12-hour limit), and covers the screen with a working sign-in once it has ended.
 */
export function StaffSessionGuard({
  csrf,
  path,
  timeZone,
  client,
  awaitingAcceptance = false,
  onCover,
}: {
  readonly csrf: string;
  readonly path: string;
  readonly timeZone: string | undefined;
  readonly client?: StaffSessionClient;
  /**
   * A paid order is waiting for acceptance with a refund deadline (v15 c9b377cb decision): while
   * the screen is visible it counts as in use, like Orders, so the sign-in does not lapse in the
   * middle of an acceptance window. Still bounded by visibility and the 12-hour limit.
   */
  readonly awaitingAcceptance?: boolean;
  /**
   * The signed-out cover's slot for urgent store warnings (the refund countdown), or null when
   * there is no cover. What sounds must stay readable on the screen staff see.
   */
  readonly onCover?: (slot: HTMLElement | null) => void;
}) {
  const source = useMemo(() => client ?? createStaffSessionClient(), [client]);
  const [current, setCurrent] = useState<SessionDeadlines | null>(null);
  const [ended, setEnded] = useState<"Idle" | "Absolute" | "SignedOut" | null>(null);
  const [staying, setStaying] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const lastInput = useRef(Date.now());
  const lastReport = useRef(Number.NEGATIVE_INFINITY);
  // An unrecorded or failed report is retried from this time without losing the staff input.
  const nextAttempt = useRef(Number.NEGATIVE_INFINITY);
  const misses = useRef(0);
  const lastVerify = useRef(Number.NEGATIVE_INFINITY);
  const inFlight = useRef(false);
  const verifying = useRef(false);
  const verifiedEnd = useRef(false);
  const operational = isOperationalScreen(path) || awaitingAcceptance;
  const notice = current === null ? { kind: "None" as const } : sessionNotice(current, Date.now());
  const now = useNow(notice.kind !== "None");
  const dialog = useRef<HTMLHeadingElement>(null);

  /**
   * Covers the screen only after the server has explicitly said the Session ended
   * (`401 session_ended`) on a fresh deadline read. Busy, refused or unreachable checks never sign
   * staff out; the next report or check retries.
   */
  const confirmEnded = useCallback(
    async (reason: "Idle" | "Absolute" | "SignedOut") => {
      if (verifying.current) return;
      verifying.current = true;
      try {
        const read = await source.expiry(csrf);
        if (read === "Ended") {
          setEnded(reason);
          return;
        }
        setCurrent(read);
        setUnconfirmed(false);
        verifiedEnd.current = false;
      } catch {
        setUnconfirmed(true);
      } finally {
        verifying.current = false;
      }
    },
    [csrf, source],
  );
  const apply = useCallback(
    (read: SessionRead) => {
      if (read === "Ended") {
        void confirmEnded("SignedOut");
        return;
      }
      setCurrent(read);
      setUnconfirmed(false);
    },
    [confirmEnded],
  );
  const report = useCallback(
    async (force = false) => {
      if (inFlight.current) return;
      const at = Date.now();
      if (!force && at < nextAttempt.current) return;
      if (
        !force &&
        !shouldReportActivity({
          visible: document.visibilityState === "visible",
          operational,
          lastInputAt: lastInput.current,
          lastReportAt: lastReport.current,
          now: at,
        })
      )
        return;
      inFlight.current = true;
      try {
        const read = await source.activity(csrf);
        apply(read);
        if (read === "Ended" || activityRecorded(read, Date.now())) {
          lastReport.current = at;
          misses.current = 0;
        } else {
          // The server skipped the write (the Session row was busy with this page's own reads):
          // keep the input pending and try again shortly, off the page's read timers.
          misses.current += 1;
          nextAttempt.current = Date.now() + activityRetryMs(misses.current);
        }
      } catch {
        // Refused or offline: keep the last known deadlines and the pending input; retry in 15 s.
        nextAttempt.current = Date.now() + 15_000;
      } finally {
        inFlight.current = false;
      }
    },
    [apply, csrf, operational, source],
  );

  // Opening a staff page is activity; staff input marks the screen as used.
  useEffect(() => {
    void report(true);
    const used = () => {
      lastInput.current = Date.now();
    };
    const shown = () => {
      if (document.visibilityState !== "visible") return;
      lastInput.current = Date.now();
      void report();
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", used, options);
    window.addEventListener("keydown", used, options);
    window.addEventListener("touchstart", used, options);
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.removeEventListener("pointerdown", used, options);
      window.removeEventListener("keydown", used, options);
      window.removeEventListener("touchstart", used, options);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [report]);

  // Each tick: report activity if due. Before warning, re-read the deadlines (another tab may have
  // extended them) at most every 30 s; when the clock says the Session ended, confirm with the
  // server before covering the screen.
  useEffect(() => {
    if (ended !== null) return;
    void report();
    if (current === null) return;
    const local = sessionNotice(current, now);
    if (local.kind === "None" || verifying.current) return;
    if (local.kind === "Ended") {
      if (!verifiedEnd.current || now - lastVerify.current >= 30_000) {
        verifiedEnd.current = true;
        lastVerify.current = now;
        void confirmEnded(local.reason);
      }
      return;
    }
    if (now - lastVerify.current < 30_000) return;
    lastVerify.current = now;
    verifying.current = true;
    void source
      .expiry(csrf)
      .then(
        (read) => {
          // The explicit server answer on a fresh read (e.g. signed out on another screen).
          if (read === "Ended") setEnded("SignedOut");
          else setCurrent(read);
        },
        () => undefined,
      )
      .finally(() => {
        verifying.current = false;
      });
  }, [confirmEnded, csrf, current, ended, now, report, source]);

  useEffect(() => {
    if (ended !== null) dialog.current?.focus();
  }, [ended]);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    onCover?.(ended === null ? null : slot);
  }, [ended, onCover, slot]);
  useEffect(() => () => onCover?.(null), [onCover]);

  const checkAgain = async () => {
    setChecking(true);
    try {
      const read = await source.expiry(csrf);
      if (read !== "Ended") {
        // Still signed in after all: remove the cover and resume normally.
        setCurrent(read);
        setUnconfirmed(false);
        verifiedEnd.current = false;
        lastVerify.current = Date.now();
        lastReport.current = Number.NEGATIVE_INFINITY;
        nextAttempt.current = Number.NEGATIVE_INFINITY;
        setEnded(null);
      }
    } catch {
      // Unreachable: stay on the cover; the sign-in link still works.
    } finally {
      setChecking(false);
    }
  };

  if (ended !== null)
    return (
      <div className="staff-session__cover">
        <section
          className="staff-session__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="staff-session-ended"
        >
          {/* An order about to be refunded stays in view here (filled by the refund warning). */}
          <div className="staff-session__urgent" ref={setSlot} />
          <h2 id="staff-session-ended" tabIndex={-1} ref={dialog}>
            You’ve been signed out
          </h2>
          <p>
            {ended === "Idle"
              ? `For security, this screen signs out after ${current?.idleTimeoutMinutes ?? 30} minutes without use.`
              : ended === "Absolute"
                ? "A sign-in lasts at most 12 hours. Sign in again to keep working."
                : "This sign-in has ended (signed out here or on another screen)."}
          </p>
          <StaffSignInLink client={source} label="Sign in again" />
          <button type="button" disabled={checking} onClick={() => void checkAgain()}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </section>
      </div>
    );
  if (current === null || notice.kind === "None") return null;
  if (notice.kind === "Ended")
    return unconfirmed ? (
      <section className="staff-session__notice" role="alert" aria-label="Sign-in check">
        <p>
          <strong>Your sign-in may have ended.</strong> It could not be checked right now; check the
          connection. If an action is refused, sign in again.
        </p>
      </section>
    ) : null;
  const at = storeTime(notice.at, timeZone);
  return (
    <section
      className="staff-session__notice"
      role="alert"
      aria-label={notice.kind === "IdleWarning" ? "Signing out soon" : "Sign-in ending"}
    >
      {notice.kind === "IdleWarning" ? (
        <>
          <p>
            <strong>Still there?</strong> This screen signs out at {at} (in{" "}
            {remaining(notice.at, current, now)}) because it hasn’t been used.
          </p>
          <button
            type="button"
            className="shell-action"
            disabled={staying}
            onClick={() => {
              setStaying(true);
              lastInput.current = Date.now();
              void report(true).finally(() => setStaying(false));
            }}
          >
            {staying ? "Staying signed in…" : "Stay signed in"}
          </button>
        </>
      ) : (
        <>
          <p>
            <strong>Sign in again at {at}.</strong> A sign-in lasts at most 12 hours, so this one
            ends at {at} (in {remaining(notice.at, current, now)}). Finish what you’re doing;
            staying active does not extend it.
          </p>
          <StaffSwitchButton client={source} />
        </>
      )}
    </section>
  );
}
