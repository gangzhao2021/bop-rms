import { t } from "./i18n/i18n.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { StepUpVerification } from "./StepUpVerification.js";
import {
  checkNewPin,
  createStaffPinClient,
  StaffPinError,
  storeClockTime,
  storeDate,
  type PinInvalidReason,
  type PinRecord,
  type PinStatus,
  type StaffPinClient,
} from "./staff-pin-client.js";

/**
 * WP-2423 (design "A"): "My PIN" in the workspace footer. Each staff member sets or changes their
 * own six-digit PIN for the store's shared tablets after a full sign-in. A PIN sign-in is
 * reminded that refunds, price and staff changes need the authenticator code or a full sign-in.
 */
export const PIN_ELEVATION_EXPLANATION = Object.freeze({
  /** TEST-ONLY sign-in (internal test): the authenticator code is entered on this page. */
  code: "Open your authenticator app and enter the six-digit code shown for this store. Codes change every 30 seconds. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.",
  /** DEC-COGNITO-STORE-STAFF: the staff member signs in again in a small window. */
  signIn: t(
    "Confirm it is you by signing in again with your password and authenticator app. After you verify, refunds, price changes and staff changes can go ahead on this PIN sign-in until the time shown.",
  ),
});
export const PIN_FULL_SIGN_IN_TEXT = t(
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to change your PIN.",
);

export type PinStatusSnapshot =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly status: PinStatus }
  | { readonly kind: "Failed" };

/** One shared read per sign-in: the footer renders in both the sidebar and the compact menu. */
class PinStatusStore {
  private snapshot: PinStatusSnapshot = { kind: "Loading" };
  private readonly listeners = new Set<() => void>();
  private started = false;
  constructor(private readonly client: StaffPinClient) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      this.refresh();
    }
    return () => this.listeners.delete(listener);
  };
  readonly get = () => this.snapshot;
  set(next: PinStatusSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  refresh() {
    void this.client.pinStatus().then(
      (status) => this.set({ kind: "Ready", status }),
      () => {
        if (this.snapshot.kind !== "Ready") this.set({ kind: "Failed" });
      },
    );
  }
  update(change: (status: PinStatus) => PinStatus) {
    if (this.snapshot.kind === "Ready")
      this.set({ kind: "Ready", status: change(this.snapshot.status) });
    else this.refresh();
  }
}
const stores = new WeakMap<StaffPinClient, PinStatusStore>();
const defaultClients = new Map<string, StaffPinClient>();
function storeFor(client: StaffPinClient): PinStatusStore {
  let store = stores.get(client);
  if (store === undefined) {
    store = new PinStatusStore(client);
    stores.set(client, store);
  }
  return store;
}
/** Starts a client's shared status from a known answer (rendering without a request). */
export function primePinStatus(client: StaffPinClient, status: PinStatus): void {
  storeFor(client).set({ kind: "Ready", status });
}
function defaultClient(csrf: string): StaffPinClient {
  let client = defaultClients.get(csrf);
  if (client === undefined) {
    client = createStaffPinClient(csrf);
    defaultClients.clear();
    defaultClients.set(csrf, client);
  }
  return client;
}

export function pinStateText(pin: PinRecord, timeZone: string | undefined): string {
  if (pin.state === "NotSet")
    return t("Set a PIN to switch quickly on this store's shared tablets.");
  if (pin.state === "Reset")
    return t("A manager reset your PIN. Set a new one to use the shared tablets.");
  return pin.changedAt === null
    ? t("Your PIN is set.")
    : t("PIN set on {changedAt}.", { changedAt: storeDate(pin.changedAt, timeZone) });
}
export const pinInvalidText: Record<PinInvalidReason, string> = {
  Format: t("Enter exactly 6 digits."),
  Mismatch: t("The two PINs don't match."),
  TooSimple: t("That PIN is too easy to guess. Choose a different one."),
};
export const PIN_SAVED_TEXT = t("Your PIN is saved. Use it on this store's shared tablets.");
export const PIN_SESSION_NOTICE = t(
  "Signed in with PIN. Refunds, price changes and staff changes need your authenticator code or a full sign-in.",
);

export function pinSaveFailureText(error: unknown): string {
  if (error instanceof StaffPinError) {
    if (error.code === "Invalid") return pinInvalidText[error.detail.reason ?? "Format"];
    if (error.code === "FullSignInRequired") return PIN_FULL_SIGN_IN_TEXT;
    if (error.code === "Denied")
      return t("Your sign-in has ended or doesn't allow this. Sign in again, then set your PIN.");
  }
  return t("Your PIN couldn't be saved. Check the connection and try again.");
}

const digitsOnly = (value: string) => value.replace(/[^0-9]/gu, "").slice(0, 6);

export function StaffPinControls({
  csrf,
  timeZone,
  client,
  fetcher,
}: {
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly client?: StaffPinClient;
  /** For the authenticator check (tests). */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const source = client ?? defaultClient(csrf);
  const store = storeFor(source);
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "done" | "error"; text: string } | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ids = "staff-pin-" + useId().replace(/[^A-Za-z0-9_-]/gu, "");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const status = snapshot.kind === "Ready" ? snapshot.status : null;
  const verified =
    status !== null && status.verifiedUntil !== null && Date.parse(status.verifiedUntil) > now;
  const pinSignIn = status?.signIn === "Pin";
  const open = () => {
    setResult(null);
    setPin("");
    setConfirmation("");
    setNeedsVerification(false);
    if (snapshot.kind !== "Ready") store.refresh();
    dialog.current?.showModal();
    first.current?.focus();
  };
  const onVerified = (validUntil: string) => {
    store.update((current) => ({ ...current, verifiedUntil: validUntil }));
    setNeedsVerification(false);
    setNow(Date.now());
  };
  const save = async () => {
    if (busy) return;
    const local = checkNewPin(pin, confirmation);
    if (local !== null) {
      setResult({ tone: "error", text: pinInvalidText[local] });
      return;
    }
    const sentPin = pin,
      sentConfirmation = confirmation;
    setPin("");
    setConfirmation("");
    setBusy(true);
    setResult(null);
    try {
      const saved = await source.setPin(sentPin, sentConfirmation);
      store.update((current) => ({ ...current, pin: saved }));
      setNeedsVerification(false);
      setResult({ tone: "done", text: PIN_SAVED_TEXT });
    } catch (error) {
      if (error instanceof StaffPinError && error.code === "FullSignInRequired")
        setNeedsVerification(true);
      setResult({ tone: "error", text: pinSaveFailureText(error) });
      first.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  // WP-2423 item 7: one label everywhere; the text beside it already names the authenticator app.
  const verification = () => (
    <StepUpVerification
      purpose="PinSessionElevation"
      csrf={csrf}
      verifiedUntil={status?.verifiedUntil ?? null}
      onVerified={onVerified}
      label={t("Verify it's you")}
      hint={false}
      fetcher={fetcher}
      loadServerStatus={false}
      explanation={PIN_ELEVATION_EXPLANATION}
    />
  );
  const locked =
    status !== null && status.pin.lockedUntil !== null && Date.parse(status.pin.lockedUntil) > now;
  return (
    <div className="staff-pin">
      {pinSignIn ? (
        <section className="staff-pin__notice" aria-label={t("PIN sign-in")}>
          <p>{PIN_SESSION_NOTICE}</p>
          {verification()}
        </section>
      ) : null}
      {status !== null && !pinSignIn && status.pin.state !== "Set" ? (
        <button type="button" className="staff-pin__prompt" onClick={open}>
          {status.pin.state === "Reset"
            ? t("Your PIN was reset. Set a new one.")
            : t("Set your PIN")}
        </button>
      ) : null}
      <button type="button" className="staff-pin__open" onClick={open}>
        {t("My PIN")}
      </button>
      <dialog
        ref={dialog}
        className="step-up-dialog staff-pin__dialog"
        aria-labelledby={ids + "-title"}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          setPin("");
          setConfirmation("");
        }}
      >
        <h2 id={ids + "-title"}>{t("My PIN")}</h2>
        <p role="status">
          {status === null
            ? snapshot.kind === "Failed"
              ? t("Your PIN details couldn't be loaded. You can still set a new PIN.")
              : t("Loading your PIN details…")
            : pinStateText(status.pin, timeZone)}
          {locked && status?.pin.lockedUntil
            ? t(" It is locked until {lockedUntil} after too many wrong tries.", {
                lockedUntil: storeClockTime(status.pin.lockedUntil, timeZone),
              })
            : ""}
        </p>
        {needsVerification || (pinSignIn && !verified) ? (
          <div className="staff-pin__verify">
            <p>{PIN_FULL_SIGN_IN_TEXT}</p>
            {verification()}
          </div>
        ) : null}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={ids + "-new"}>{t("New PIN")}</label>
          <input
            ref={first}
            id={ids + "-new"}
            name="new-pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            pattern="[0-9]{6}"
            aria-describedby={ids + "-rules"}
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(digitsOnly(event.currentTarget.value))}
          />
          <label htmlFor={ids + "-again"}>{t("Enter it again")}</label>
          <input
            id={ids + "-again"}
            name="confirm-pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            pattern="[0-9]{6}"
            value={confirmation}
            disabled={busy}
            onChange={(event) => setConfirmation(digitsOnly(event.currentTarget.value))}
          />
          <p id={ids + "-rules"} className="staff-pin__rules">
            {t("6 digits. Avoid easy PINs like 000000 or 123456.")}
          </p>
          <p role="alert" className="staff-pin__result" data-tone={result?.tone}>
            {result?.text ?? ""}
          </p>
          <div className="card-actions">
            <button type="submit" disabled={busy}>
              {busy ? t("Saving…") : t("Save PIN")}
            </button>
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
              {t("Close")}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
