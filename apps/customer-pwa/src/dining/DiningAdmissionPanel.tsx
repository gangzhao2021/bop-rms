import { refreshContinuityToken } from "../entry/table-continuity.js";
import { t } from "../i18n/i18n.js";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  DiningAdmissionJourneyError,
  type createDiningAdmissionJourney,
} from "./dining-admission-journey.js";

export interface DiningAdmissionUi {
  readonly journey: ReturnType<typeof createDiningAdmissionJourney>;
  readonly generateOperationReference: () => string;
}
export type DiningAdmissionUiState =
  | "Ready"
  | "Invalid"
  | "Joining"
  | "Unknown"
  | "Bound"
  | "Unavailable"
  | DiningAdmissionRefusedState;
/** The server definitively refused the code: nothing to recover, a new code is needed. */
export type DiningAdmissionRefusedState =
  "CodeUsed" | "CodeNotAccepted" | "TooManyAttempts" | DiningQrJoinRefusedState;
/** WP-2423 item 8 ⑤: the scanned table can't be joined by QR right now. */
export type DiningQrJoinRefusedState =
  "QrPaused" | "NotOpen" | "CheckingOut" | "TableBusy" | "BeingCleaned" | "TableInUse";
const refusalText: Readonly<Record<DiningAdmissionRefusedState, string>> = {
  get CodeUsed() {
    return t(
      "This code was already used. Ask staff, or the person who invited you, for a new one.",
    );
  },
  get CodeNotAccepted() {
    return t(
      "That code didn’t work. Check it and try again, or ask staff or the person who invited you for a new one.",
    );
  },
  get TooManyAttempts() {
    return t("Too many tries. Wait a few minutes before trying again, or ask staff for help.");
  },
  get QrPaused() {
    return t(
      "Staff have paused joining by scan at this table. Ask staff, or the person who joined first, for the table’s join code.",
    );
  },
  get NotOpen() {
    return t("This table isn’t open yet. Please ask staff to seat you.");
  },
  get CheckingOut() {
    return t("This table is paying the bill, so no one new can join. Please ask staff.");
  },
  get TableBusy() {
    return t("Many phones joined this table just now. Please ask staff for help.");
  },
  get BeingCleaned() {
    return t("This table is being cleaned. Pick another table or ask staff.");
  },
  get TableInUse() {
    return t("People are using this table. If you’re together, join them, or ask staff.");
  },
};
/** What a refusal means to a guest who came to start the table, where that differs. */
const startRefusalText = (state: DiningAdmissionRefusedState) =>
  state === "NotOpen" || state === "TableBusy"
    ? t("This table can’t be started just now. Pick another table or ask staff.")
    : refusalText[state];
/** These refusals need a code; the others are about the table itself. */
const needsCode = (state: DiningAdmissionUiState) =>
  state === "Invalid" ||
  state === "CodeUsed" ||
  state === "CodeNotAccepted" ||
  state === "TooManyAttempts" ||
  state === "QrPaused";
/** Maps a failed attempt: a definitive refusal returns to entry, anything else stays recoverable. */
export function admissionStateForFailure(error: unknown): "Unknown" | DiningAdmissionRefusedState {
  if (!(error instanceof DiningAdmissionJourneyError)) return "Unknown";
  if (error.code === "code-used") return "CodeUsed";
  if (error.code === "code-not-accepted") return "CodeNotAccepted";
  if (error.code === "too-many-attempts") return "TooManyAttempts";
  if (error.code === "qr-paused") return "QrPaused";
  if (error.code === "table-not-open") return "NotOpen";
  if (error.code === "table-checking-out") return "CheckingOut";
  if (error.code === "table-busy") return "TableBusy";
  if (error.code === "table-being-cleaned") return "BeingCleaned";
  if (error.code === "table-in-use") return "TableInUse";
  return "Unknown";
}
function refused(state: DiningAdmissionUiState): state is DiningAdmissionRefusedState {
  return Object.hasOwn(refusalText, state);
}
/** WP-2423 (same-table-ordering): the pause before the one silent retry of an unconfirmed join. */
export const admissionAutoRetryMs = 600;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const framing = /^(?:[0-9]{6}|[A-Za-z0-9_-]{21}[AQgw])$/u;

export function DiningAdmissionPanel({
  service,
  contextEpoch,
  onStateChange,
  autoJoin = false,
  starting = false,
}: {
  readonly service?: DiningAdmissionUi | undefined;
  readonly contextEpoch?: object | undefined;
  /** The guest already tapped Start, or said who they are with: join with no second tap. */
  readonly autoJoin?: boolean;
  /** They came to start this table, not to join people at it. */
  readonly starting?: boolean;
  /** WP-2423 item 8 ⑤: the page keeps one primary action (joining, then the menu). */
  readonly onStateChange?: ((state: DiningAdmissionUiState) => void) | undefined;
}) {
  const [state, setState] = useState<DiningAdmissionUiState>(service ? "Ready" : "Unavailable");
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const input = useRef<HTMLInputElement>(null);
  const status = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const operation = useRef<string | null>(null);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    operation.current = null;
    if (input.current) input.current.value = "";
    setState(service ? "Ready" : "Unavailable");
    return () => {
      generation.current++;
    };
  }, [service, contextEpoch]);
  useEffect(() => {
    const changed = () => {
      if (!navigator.onLine && input.current) input.current.value = "";
      setOnline(navigator.onLine);
    };
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);
  const reported = useRef(onStateChange);
  reported.current = onStateChange;
  useEffect(() => reported.current?.(state), [state]);
  useEffect(() => {
    if (state === "Invalid" || refused(state)) input.current?.focus();
    else if (state === "Bound" || state === "Unknown") status.current?.focus();
  }, [state]);
  const [codeMode, setCodeMode] = useState(false);
  useEffect(() => setCodeMode(false), [service, contextEpoch]);
  /**
   * WP-2423 (same-table-ordering): an attempt whose answer can't be confirmed is retried once,
   * silently, with the same operation (never recorded twice) before the guest is asked to.
   */
  const unknownAfter = (resume: boolean, current: number) => {
    if (resume || generation.current !== current) {
      setState("Unknown");
      return;
    }
    setState("Joining");
    setTimeout(() => {
      if (generation.current !== current) return;
      busy.current = false;
      // Offline now: the guest retries once back online (the attempt is kept).
      if (typeof navigator !== "undefined" && navigator.onLine === false) setState("Unknown");
      else runCurrent.current(true);
    }, admissionAutoRetryMs);
  };
  /** `byQr`: join the scanned table with one tap (no code). */
  const run = (resume: boolean, byQr = false) => {
    if (busy.current || !online || !service || navigator.onLine === false) return;
    let request: Promise<unknown>;
    let expected = operation.current;
    const current = generation.current;
    if (!resume) {
      const value = byQr ? null : (input.current?.value ?? "");
      if (input.current) input.current.value = "";
      if (value !== null && !framing.test(value)) {
        setState("Invalid");
        input.current?.focus();
        return;
      }
      if (expected !== null) return;
      try {
        expected = service.generateOperationReference();
        if (!reference.test(expected)) throw new Error("invalid reference");
      } catch {
        setState("Unavailable");
        return;
      }
      operation.current = expected;
      busy.current = true;
      setState("Joining");
      try {
        request = service.journey.start({ operationReference: expected, joinCredential: value });
      } catch {
        request = Promise.reject(new Error("unavailable"));
      }
    } else {
      if (expected === null) return;
      busy.current = true;
      setState("Joining");
      try {
        request = service.journey.resume({ operationReference: expected });
      } catch {
        request = Promise.reject(new Error("unavailable"));
      }
    }
    void request
      .then(
        (result) => {
          if (generation.current !== current) return;
          try {
            const descriptors =
              result !== null && typeof result === "object"
                ? Object.getOwnPropertyDescriptors(result)
                : {};
            const valid =
              Reflect.ownKeys(descriptors).length === 2 &&
              descriptors.status?.value === "Bound" &&
              descriptors.operationReference?.value === expected;
            if (valid && navigator.onLine) {
              setState("Bound");
              // WP-2423 shared-table-checkout (b): seated now; keep the token for a lost cookie.
              void refreshContinuityToken();
            } else unknownAfter(resume, current);
          } catch {
            unknownAfter(resume, current);
          }
        },
        (error: unknown) => {
          if (generation.current !== current) return;
          const next = admissionStateForFailure(error);
          // A refused attempt is finished; the next submission is a new intent with a new code.
          if (next !== "Unknown") operation.current = null;
          if (next === "QrPaused") setCodeMode(true);
          if (next === "Unknown") unknownAfter(resume, current);
          else setState(next);
        },
      )
      .finally(() => {
        if (generation.current === current) busy.current = false;
      });
  };
  const joined = useRef<object | null>(null);
  const runCurrent = useRef(run);
  runCurrent.current = run;
  useEffect(() => {
    if (!autoJoin || service === undefined) return;
    const epoch = contextEpoch ?? service;
    if (joined.current === epoch) return;
    joined.current = epoch;
    runCurrent.current(false, true);
  }, [autoJoin, service, contextEpoch]);
  return (
    <DiningAdmissionView
      state={state}
      online={online}
      inputRef={input}
      statusRef={status}
      onSubmit={(event) => {
        event.preventDefault();
        run(false);
      }}
      onResume={() => run(true)}
      codeMode={codeMode}
      onJoinByScan={() => run(false, true)}
      onUseCode={() => setCodeMode(true)}
      starting={starting}
    />
  );
}

export function DiningAdmissionView({
  state,
  online,
  inputRef,
  statusRef,
  onSubmit,
  onResume,
  codeMode = false,
  onJoinByScan,
  onUseCode,
  starting = false,
}: {
  /** The guest came to start this table: no people to join and no code to ask anyone for. */
  readonly starting?: boolean;
  readonly state: DiningAdmissionUiState;
  readonly online: boolean;
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly statusRef?: RefObject<HTMLHeadingElement | null> | undefined;
  readonly onSubmit?: ((event: FormEvent<HTMLFormElement>) => void) | undefined;
  readonly onResume?: (() => void) | undefined;
  /** Show the code entry (the guest has a code, or joining by scan is paused). */
  readonly codeMode?: boolean;
  readonly onJoinByScan?: (() => void) | undefined;
  readonly onUseCode?: (() => void) | undefined;
}) {
  const entry = state === "Ready" || state === "Invalid" || refused(state);
  const showCode = entry && (codeMode || needsCode(state));
  // Starting, the join is on its way as soon as this shows.
  const showScan = entry && state !== "QrPaused" && !(starting && state === "Ready");
  // People turned up at the table first: joining them is what's left to do.
  const startsAgain = starting && state !== "TableInUse";
  return (
    <section
      className="dining-admission"
      aria-labelledby="dining-admission-heading"
      aria-busy={state === "Joining"}
    >
      <h2 id="dining-admission-heading" ref={statusRef} tabIndex={-1}>
        {state === "Bound"
          ? t("You’ve joined this table")
          : starting
            ? t("Order at this table")
            : t("Join this table")}
      </h2>
      {!online && (
        <p role="status">
          {t("You’re offline. Joining and recovery are paused. Reconnect, then try again.")}
        </p>
      )}
      {showScan && (
        <div className="dining-admission__scan">
          {starting ? null : (
            <p>{t("Tap to join the people at this table. You don’t need an account.")}</p>
          )}
          {refused(state) && !needsCode(state) && (
            <p role="alert">{starting ? startRefusalText(state) : refusalText[state]}</p>
          )}
          <button className="entry-action" type="button" disabled={!online} onClick={onJoinByScan}>
            {startsAgain ? t("Try again") : t("Join this table")}
          </button>
          {!showCode && !starting && (
            <button
              className="entry-secondary-action"
              type="button"
              disabled={!online}
              onClick={onUseCode}
            >
              {t("I have a join code")}
            </button>
          )}
        </div>
      )}
      {showCode && (
        <form onSubmit={onSubmit} noValidate>
          <p id="dining-admission-help">
            {t("Ask staff, or the person who joined your table first, for the table’s join code.")}
          </p>
          <label htmlFor="dining-join-credential">{t("Join code or invitation")}</label>
          <input
            ref={inputRef}
            id="dining-join-credential"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={22}
            aria-describedby={
              needsCode(state)
                ? "dining-admission-help dining-admission-error"
                : "dining-admission-help"
            }
            aria-invalid={needsCode(state)}
            disabled={!online}
          />
          {state === "Invalid" && (
            <p id="dining-admission-error" role="alert">
              {t("Enter the six-digit code you were given.")}
            </p>
          )}
          {refused(state) && needsCode(state) && (
            <p id="dining-admission-error" role="alert">
              {refusalText[state]}
            </p>
          )}
          <button
            className={showScan ? "entry-secondary-action" : "entry-action"}
            type="submit"
            disabled={!online}
          >
            {t("Join with this code")}
          </button>
        </form>
      )}
      {state === "Joining" && (
        <p role="status" aria-live="polite">
          {t("Checking your table connection…")}
        </p>
      )}
      {state === "Unknown" && (
        <div role="alert">
          <p>{t("We couldn’t add you to the table just now. Please try again.")}</p>
          <button className="entry-action" type="button" disabled={!online} onClick={onResume}>
            {t("Try again")}
          </button>
          <p>{t("If it still doesn’t work, ask staff for help.")}</p>
        </div>
      )}
      {state === "Bound" && (
        <p role="status">
          {t(
            "Your table connection is confirmed. You can continue to the menu. No order has been placed.",
          )}
        </p>
      )}
      {state === "Unavailable" && (
        <p role="status">
          {t(
            "Table joining is unavailable here. Ask staff for help. You can still browse the menu.",
          )}
        </p>
      )}
    </section>
  );
}
