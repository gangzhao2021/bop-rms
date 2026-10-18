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
export type DiningAdmissionRefusedState = "CodeUsed" | "CodeNotAccepted" | "TooManyAttempts";
const refusalText: Readonly<Record<DiningAdmissionRefusedState, string>> = {
  CodeUsed: "This code was already used. Ask staff, or the person who invited you, for a new one.",
  CodeNotAccepted:
    "That code didn’t work. Check it and try again, or ask staff or the person who invited you for a new one.",
  TooManyAttempts: "Too many tries. Wait a few minutes before trying again, or ask staff for help.",
};
/** Maps a failed attempt: a definitive refusal returns to entry, anything else stays recoverable. */
export function admissionStateForFailure(error: unknown): "Unknown" | DiningAdmissionRefusedState {
  if (!(error instanceof DiningAdmissionJourneyError)) return "Unknown";
  if (error.code === "code-used") return "CodeUsed";
  if (error.code === "code-not-accepted") return "CodeNotAccepted";
  if (error.code === "too-many-attempts") return "TooManyAttempts";
  return "Unknown";
}
function refused(state: DiningAdmissionUiState): state is DiningAdmissionRefusedState {
  return Object.hasOwn(refusalText, state);
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const framing = /^(?:[0-9]{6}|[A-Za-z0-9_-]{21}[AQgw])$/u;

export function DiningAdmissionPanel({
  service,
  contextEpoch,
}: {
  readonly service?: DiningAdmissionUi | undefined;
  readonly contextEpoch?: object | undefined;
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
  useEffect(() => {
    if (state === "Invalid" || refused(state)) input.current?.focus();
    else if (state === "Bound" || state === "Unknown") status.current?.focus();
  }, [state]);
  const run = (resume: boolean) => {
    if (busy.current || !online || !service || navigator.onLine === false) return;
    let request: Promise<unknown>;
    let expected = operation.current;
    const current = generation.current;
    if (!resume) {
      const value = input.current?.value ?? "";
      if (input.current) input.current.value = "";
      if (!framing.test(value)) {
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
            setState(valid && navigator.onLine ? "Bound" : "Unknown");
          } catch {
            setState("Unknown");
          }
        },
        (error: unknown) => {
          if (generation.current !== current) return;
          const next = admissionStateForFailure(error);
          // A refused attempt is finished; the next submission is a new intent with a new code.
          if (next !== "Unknown") operation.current = null;
          setState(next);
        },
      )
      .finally(() => {
        if (generation.current === current) busy.current = false;
      });
  };
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
}: {
  readonly state: DiningAdmissionUiState;
  readonly online: boolean;
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly statusRef?: RefObject<HTMLHeadingElement | null> | undefined;
  readonly onSubmit?: ((event: FormEvent<HTMLFormElement>) => void) | undefined;
  readonly onResume?: (() => void) | undefined;
}) {
  const entry = state === "Ready" || state === "Invalid" || refused(state);
  return (
    <section
      className="dining-admission"
      aria-labelledby="dining-admission-heading"
      aria-busy={state === "Joining"}
    >
      <h2 id="dining-admission-heading" ref={statusRef} tabIndex={-1}>
        {state === "Bound" ? "You’ve joined this table" : "Join this table"}
      </h2>
      {!online && (
        <p role="status">
          You’re offline. Joining and recovery are paused. Reconnect, then try again.
        </p>
      )}
      {entry && (
        <form onSubmit={onSubmit} noValidate>
          <p id="dining-admission-help">
            Ask staff, or the person who joined your table first, for the table’s code. Scanning the
            table QR code alone does not join the table.
          </p>
          <label htmlFor="dining-join-credential">Join code or invitation</label>
          <input
            ref={inputRef}
            id="dining-join-credential"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={22}
            aria-describedby={
              state === "Invalid" || refused(state)
                ? "dining-admission-help dining-admission-error"
                : "dining-admission-help"
            }
            aria-invalid={state === "Invalid" || refused(state)}
            disabled={!online}
          />
          {state === "Invalid" && (
            <p id="dining-admission-error" role="alert">
              Enter the six-digit code you were given.
            </p>
          )}
          {refused(state) && (
            <p id="dining-admission-error" role="alert">
              {refusalText[state]}
            </p>
          )}
          <button className="entry-action" type="submit" disabled={!online}>
            Join table
          </button>
        </form>
      )}
      {state === "Joining" && (
        <p role="status" aria-live="polite">
          Checking your table connection…
        </p>
      )}
      {state === "Unknown" && (
        <div role="alert">
          <p>
            We couldn’t confirm the result. Recover this attempt before starting another. If it
            still cannot be confirmed, ask staff for help.
          </p>
          <button className="entry-action" type="button" disabled={!online} onClick={onResume}>
            Recover this attempt
          </button>
        </div>
      )}
      {state === "Bound" && (
        <p role="status">
          Your table connection is confirmed. You can continue to the menu. No order has been
          placed.
        </p>
      )}
      {state === "Unavailable" && (
        <p role="status">
          Table joining is unavailable here. Ask staff for help. You can still browse the menu.
        </p>
      )}
    </section>
  );
}
