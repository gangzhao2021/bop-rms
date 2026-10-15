import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createStaffPinClient,
  StaffPinError,
  storeClockTime,
  type SignInEntry,
  type StaffPinClient,
  type StaffSwitchRead,
  type SwitchStaffChoice,
} from "./staff-pin-client.js";

/**
 * WP-2423 (design "A"): "Switch staff" on a store's shared tablet. A staff member picks their
 * name and types their six-digit PIN; a correct PIN signs them in. Works without a sign-in. The
 * PIN is only ever counted on screen (dots), is sent once and cleared at once.
 *
 * Operating continuity: PINs are checked by the store system, so they need the network. When it
 * is down the screen says so and offers "Try again"; staff sign in with their account once the
 * connection is back (runbook).
 */
export const PIN_LENGTH = 6;
/** A name picked and then left alone returns to the staff list, so the next person starts clean. */
export const KEYPAD_IDLE_MS = 60_000;

export type PinKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "Delete" | "Clear";
export function pressPinKey(pin: string, key: PinKey): string {
  if (key === "Clear") return "";
  if (key === "Delete") return pin.slice(0, -1);
  return pin.length >= PIN_LENGTH ? pin : pin + key;
}
/** A physical keyboard key as a keypad key (digits, Backspace, Delete, Escape). */
export function keyboardPinKey(key: string): PinKey | null {
  if (/^[0-9]$/u.test(key)) return key as PinKey;
  if (key === "Backspace") return "Delete";
  if (key === "Escape" || key === "Delete") return "Clear";
  return null;
}

export type SwitchMessage =
  | { readonly kind: "Rejected" }
  | { readonly kind: "Locked"; readonly until: string }
  | { readonly kind: "Busy"; readonly minutes: number }
  | { readonly kind: "Unavailable" }
  | { readonly kind: "SigningIn" };

export function switchMessageFor(error: unknown): SwitchMessage {
  if (!(error instanceof StaffPinError)) return { kind: "Unavailable" };
  if (error.code === "Rejected") return { kind: "Rejected" };
  if (error.code === "Locked" && error.detail.lockedUntil !== undefined)
    return { kind: "Locked", until: error.detail.lockedUntil };
  if (error.code === "Busy")
    return {
      kind: "Busy",
      minutes: Math.max(1, Math.ceil((error.detail.retryAfterSeconds ?? 60) / 60)),
    };
  return { kind: "Unavailable" };
}

export function switchMessageText(
  message: SwitchMessage,
  name: string,
  timeZone: string | undefined,
): string {
  switch (message.kind) {
    case "Rejected":
      return "That PIN didn't match. Try again. After 5 wrong tries the PIN locks for 15 minutes.";
    case "Locked":
      return `Too many wrong PINs. ${name}'s PIN is locked until ${storeClockTime(message.until, timeZone)}. Ask a manager to reset it, or sign in with your account.`;
    case "Busy":
      return `Too many tries on this tablet. Wait ${message.minutes} ${message.minutes === 1 ? "minute" : "minutes"}, or sign in with your account.`;
    case "Unavailable":
      return "Couldn't check the PIN. Check the connection and try again.";
    case "SigningIn":
      return `Signing in ${name}…`;
  }
}

/** The full sign-in staff use here (labelled when it is the internal pilot's test sign-in). */
export function SignInWithAccount({ entry }: { readonly entry: SignInEntry }) {
  return (
    <p className="staff-session__sign-in">
      <a className="shell-action" href={entry.path}>
        Sign in with your account
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

export type SwitchLoad =
  | { readonly kind: "Loading" }
  | StaffSwitchRead
  | { readonly kind: "Offline" }
  | { readonly kind: "Unavailable" };

export interface SwitchEntry {
  readonly person: SwitchStaffChoice;
  readonly pinLength: number;
  readonly busy: boolean;
  readonly message: SwitchMessage | null;
  /** Keypad held (lock or tablet limit) until this browser time. */
  readonly heldUntil: number | null;
}

/** What the screen shows; the page component owns the effects. */
export function StaffSwitchView({
  load,
  entry,
  now,
  onRetry,
  onChoose,
  onKey,
  onBack,
}: {
  readonly load: SwitchLoad;
  readonly entry: SwitchEntry | null;
  readonly now: number;
  readonly onRetry: () => void;
  readonly onChoose: (person: SwitchStaffChoice) => void;
  readonly onKey: (key: PinKey) => void;
  readonly onBack: () => void;
}) {
  const storeLabel = load.kind === "Ready" ? load.storeLabel : null;
  const timeZone = load.kind === "Ready" ? load.timeZone : undefined;
  const held = entry !== null && entry.heldUntil !== null && entry.heldUntil > now;
  const keysDisabled = entry === null || entry.busy || held;
  const keys: readonly PinKey[] = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Clear",
    "0",
    "Delete",
  ];
  return (
    <main id="main-content" tabIndex={-1} className="bop-shell__main staff-switch">
      <header className="staff-switch__header">
        <p className="staff-switch__brand">
          <strong aria-label="BOP">BOP</strong>
        </p>
        <h1>{storeLabel === null ? "Switch staff" : `Switch staff · ${storeLabel}`}</h1>
      </header>
      {load.kind === "Loading" ? (
        <p role="status" className="staff-switch__note">
          Loading staff…
        </p>
      ) : load.kind === "Offline" || load.kind === "Unavailable" ? (
        <section className="staff-switch__panel" role="alert" aria-labelledby="staff-switch-down">
          <h2 id="staff-switch-down">
            {load.kind === "Offline" ? "No connection" : "Couldn't load the staff list"}
          </h2>
          <p>
            {load.kind === "Offline"
              ? "This tablet can't reach the store system, and PINs need the connection. Check the Wi-Fi or network cable, then try again. Once the connection is back, you can also sign in with your account."
              : "The staff list couldn't be loaded. Check the connection and try again. If it keeps happening, sign in with your account."}
          </p>
          <button type="button" className="staff-switch__action" onClick={onRetry}>
            Try again
          </button>
        </section>
      ) : load.kind === "NotRegistered" ? (
        <section className="staff-switch__panel" aria-labelledby="staff-switch-unregistered">
          <h2 id="staff-switch-unregistered">This tablet isn&apos;t set up for staff PINs</h2>
          <p>A manager can set it up under “Shared tablets &amp; PINs” after signing in.</p>
          <SignInWithAccount entry={load.fullSignIn} />
        </section>
      ) : entry === null ? (
        <section className="staff-switch__panel" aria-labelledby="staff-switch-who">
          <h2 id="staff-switch-who" tabIndex={-1}>
            Who&apos;s working?
          </h2>
          {load.staff.length === 0 ? (
            <p>No one has set a PIN for this store yet.</p>
          ) : (
            <ul className="staff-switch__people">
              {load.staff.map((person) => (
                <li key={person.choice}>
                  <button
                    type="button"
                    className="staff-switch__person"
                    onClick={() => onChoose(person)}
                  >
                    {person.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="staff-switch__panel" aria-labelledby="staff-switch-pin">
          <h2 id="staff-switch-pin" tabIndex={-1}>
            Enter {entry.person.name}&apos;s PIN
          </h2>
          <div className="staff-switch__dots" aria-hidden="true">
            {Array.from({ length: PIN_LENGTH }, (_, index) => (
              <span key={index} data-filled={index < entry.pinLength ? "true" : "false"} />
            ))}
          </div>
          <p role="status" aria-live="polite" className="staff-switch__count">
            {entry.busy ? "Checking…" : `${entry.pinLength} of ${PIN_LENGTH} digits entered`}
          </p>
          <p role="alert" className="staff-switch__message" data-kind={entry.message?.kind}>
            {entry.message === null
              ? ""
              : switchMessageText(entry.message, entry.person.name, timeZone)}
          </p>
          <div className="staff-switch__keypad" role="group" aria-label="PIN keypad">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                className="staff-switch__key"
                data-key={key}
                disabled={
                  keysDisabled ||
                  ((key === "Delete" || key === "Clear") && entry.pinLength === 0) ||
                  (/^[0-9]$/u.test(key) && entry.pinLength >= PIN_LENGTH)
                }
                onClick={() => onKey(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="staff-switch__back"
            onClick={onBack}
            disabled={entry.busy}
          >
            Not {entry.person.name}? Choose someone else
          </button>
        </section>
      )}
      {load.kind === "Ready" ? (
        <footer className="staff-switch__footer">
          <p>Not on the list? Sign in with your account and choose “My PIN” to set one.</p>
          <SignInWithAccount entry={load.fullSignIn} />
        </footer>
      ) : null}
    </main>
  );
}

export function StaffSwitchPage({ client }: { readonly client?: StaffPinClient }) {
  const source = useMemo(() => client ?? createStaffPinClient(), [client]);
  const [load, setLoad] = useState<SwitchLoad>({ kind: "Loading" });
  const [person, setPerson] = useState<SwitchStaffChoice | null>(null);
  // The digits typed so far. Only their count is ever rendered.
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SwitchMessage | null>(null);
  const [heldUntil, setHeldUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef<AbortController | null>(null);
  const lastKey = useRef(Date.now());

  const read = useCallback(
    (quiet: boolean) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      if (!quiet) setLoad({ kind: "Loading" });
      void source.staffSwitch(controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setLoad(result);
        },
        (error: unknown) => {
          if (controller.signal.aborted || quiet) return;
          setLoad(
            error instanceof StaffPinError && error.code === "Offline"
              ? { kind: "Offline" }
              : { kind: "Unavailable" },
          );
        },
      );
    },
    [source],
  );
  useEffect(() => {
    read(false);
    return () => active.current?.abort();
  }, [read]);
  useEffect(() => {
    document.title = "Switch staff";
  }, []);

  const back = useCallback(() => {
    setPin("");
    setPerson(null);
    setMessage(null);
    setHeldUntil(null);
    // The list may have changed (a new PIN set, a staff member removed).
    read(true);
  }, [read]);

  const key = useCallback(
    (pressed: PinKey) => {
      if (busy || (heldUntil !== null && heldUntil > Date.now())) return;
      lastKey.current = Date.now();
      setPin((current) => pressPinKey(current, pressed));
      if (pressed !== "Delete" && pressed !== "Clear") setMessage(null);
    },
    [busy, heldUntil],
  );

  // Physical keyboard: digits, Backspace, Escape.
  useEffect(() => {
    if (person === null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const mapped = keyboardPinKey(event.key);
      if (mapped === null) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      key(mapped);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key, person]);

  // Six digits: send once and forget the PIN.
  useEffect(() => {
    if (person === null || pin.length !== PIN_LENGTH || busy) return;
    const sent = pin;
    setPin("");
    setBusy(true);
    setMessage(null);
    void source.unlock(person.choice, sent).then(
      (result) => {
        setMessage({ kind: "SigningIn" });
        window.location.assign(result.next);
      },
      (error: unknown) => {
        setBusy(false);
        if (error instanceof StaffPinError && error.code === "NotRegistered") {
          setPerson(null);
          read(false);
          return;
        }
        const next = switchMessageFor(error);
        setMessage(next);
        if (next.kind === "Locked") setHeldUntil(Date.parse(next.until));
        if (next.kind === "Busy") setHeldUntil(Date.now() + next.minutes * 60_000);
        lastKey.current = Date.now();
      },
    );
  }, [busy, person, pin, read, source]);

  // A held keypad opens again on time; a forgotten keypad goes back to the list.
  useEffect(() => {
    if (person === null) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (!busy && at - lastKey.current >= KEYPAD_IDLE_MS) back();
    }, 1_000);
    return () => clearInterval(timer);
  }, [back, busy, person]);

  // Move focus to the step's heading so screen readers follow the change.
  useEffect(() => {
    if (load.kind !== "Ready") return;
    document.getElementById(person === null ? "staff-switch-who" : "staff-switch-pin")?.focus();
  }, [load.kind, person]);

  const entry: SwitchEntry | null =
    person === null ? null : { person, pinLength: pin.length, busy, message, heldUntil };
  return (
    <StaffSwitchView
      load={load}
      entry={entry}
      now={now}
      onRetry={() => read(false)}
      onChoose={(chosen) => {
        lastKey.current = Date.now();
        setPin("");
        setMessage(null);
        setHeldUntil(null);
        setPerson(chosen);
      }}
      onKey={key}
      onBack={back}
    />
  );
}
