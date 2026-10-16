import { StatePanel } from "@bop-rms/ui";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StepUpVerification } from "./StepUpVerification.js";
import { StoreTimeZoneContext, friendlyStoreTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { PIN_ELEVATION_EXPLANATION } from "./StaffPinControls.js";
import {
  createStaffPinClient,
  StaffPinError,
  storeClockTime,
  validDeviceLabel,
  type StaffPinClient,
  type StaffPinRow,
  type StoreDevice,
  type StoreDevicesRead,
} from "./staff-pin-client.js";

/**
 * WP-2423 (design "A", Section 88 IAM-SESSION-LIST): a store manager sets up the store's shared
 * tablets for staff PINs, removes a lost or replaced tablet, and resets a staff member's PIN.
 * Sections the signed-in person may not use are not shown at all.
 */
export type DevicesLoad =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly read: StoreDevicesRead }
  | { readonly kind: "Denied" | "Offline" | "Failed" }
  /** A PIN sign-in must confirm it is the staff member first; the guidance says so once. */
  | { readonly kind: "NeedsVerification" };

export type PendingAction =
  | { readonly kind: "Remove"; readonly device: StoreDevice }
  | { readonly kind: "Reset"; readonly person: StaffPinRow };

export const FULL_SIGN_IN_GUIDANCE =
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to manage shared tablets and PINs.";

export function staffPinStatusText(
  row: StaffPinRow,
  timeZone: string | undefined,
  now: number,
): string {
  if (row.lockedUntil !== null && Date.parse(row.lockedUntil) > now)
    return `Locked until ${storeClockTime(row.lockedUntil, timeZone)}`;
  if (row.state === "Set") return "PIN set";
  if (row.state === "Reset") return "Reset — waiting for a new PIN";
  return "No PIN";
}

export function commandFailureText(error: unknown, action: "Register" | PendingAction): string {
  const code = error instanceof StaffPinError ? error.code : "Unavailable";
  if (code === "FullSignInRequired") return FULL_SIGN_IN_GUIDANCE;
  if (code === "Denied") return "You don't have permission to do this. Ask the store owner.";
  if (code === "Offline" || code === "Unavailable")
    return "Nothing changed. Check the connection and try again.";
  if (action === "Register") {
    if (code === "AlreadyRegistered")
      return "This tablet is already set up. The page is refreshed.";
    if (code === "Invalid") return "Enter a tablet name of 1 to 40 characters.";
  } else if (action.kind === "Remove") {
    if (code === "NotFound")
      return `${action.device.label} was already removed. The list is refreshed.`;
  } else {
    if (code === "NotFound")
      return `${action.person.name} is no longer on this store's staff. The list is refreshed.`;
    if (code === "PinNotSet")
      return `${action.person.name} has no PIN to reset. The list is refreshed.`;
  }
  return "Nothing changed. Try again.";
}

/**
 * What a refused command changes on the page. A PIN sign-in that must confirm it is the staff
 * member gets the verification section only: its guidance is not repeated in a "Not done" panel.
 */
export function commandFailureOutcome(
  error: unknown,
  action: "Register" | PendingAction,
): {
  readonly needsVerification: boolean;
  readonly message: { readonly tone: "error"; readonly text: string } | null;
} {
  if (error instanceof StaffPinError && error.code === "FullSignInRequired")
    return { needsVerification: true, message: null };
  return {
    needsVerification: false,
    message: { tone: "error", text: commandFailureText(error, action) },
  };
}

export function removedText(label: string, signedOut: number): string {
  return signedOut === 0
    ? `${label} is removed. No one was signed in on it with a PIN.`
    : `${label} is removed. ${signedOut} ${signedOut === 1 ? "person was" : "people were"} signed out.`;
}

/** What the page shows; the page component owns loading and commands. */
export function StoreDevicesView({
  load,
  storeLabel,
  timeZone,
  now,
  label,
  busy,
  message,
  needsVerification,
  verification,
  pending,
  onLabel,
  onRegister,
  onAsk,
  onRefresh,
  dialog = null,
}: {
  readonly load: DevicesLoad;
  readonly storeLabel: string;
  readonly timeZone: string | undefined;
  readonly now: number;
  readonly label: string;
  readonly busy: boolean;
  readonly message: { readonly tone: "neutral" | "error"; readonly text: string } | null;
  readonly needsVerification: boolean;
  readonly verification: ReactNode;
  /** The confirmation dialog, kept inside the page frame. */
  readonly dialog?: ReactNode;
  readonly pending: PendingAction | null;
  readonly onLabel: (value: string) => void;
  readonly onRegister: () => void;
  readonly onAsk: (action: PendingAction) => void;
  readonly onRefresh: () => void;
}) {
  const read = load.kind === "Ready" ? load.read : null;
  const locked = busy || pending !== null;
  return (
    <WorkspacePage
      title="Shared tablets & PINs"
      meta={storeLabel}
      actions={
        <button type="button" disabled={busy || load.kind === "Loading"} onClick={onRefresh}>
          Refresh
        </button>
      }
      className="store-devices"
    >
      <p className="store-devices__intro">
        On a shared tablet, staff switch to themselves with their own 6-digit PIN instead of signing
        in each time. Refunds, price and staff changes still need a full sign-in or the
        authenticator code.
      </p>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not done" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {needsVerification ? (
        <section className="store-devices__verify" aria-label="Confirm it's you">
          <p>{FULL_SIGN_IN_GUIDANCE}</p>
          {verification}
        </section>
      ) : null}
      {load.kind === "NeedsVerification" ? null : load.kind === "Loading" ? (
        <p role="status">Loading shared tablets and PINs…</p>
      ) : load.kind === "Denied" ? (
        <StatePanel heading="No access" tone="error" status>
          <p>Your role can&apos;t manage shared tablets or staff PINs. Ask the store owner.</p>
        </StatePanel>
      ) : load.kind === "Offline" || load.kind === "Failed" ? (
        <StatePanel heading="Couldn't load this page" tone="error" status>
          <p>
            {load.kind === "Offline"
              ? "This device can't reach the store system. Check the connection, then try again."
              : "Shared tablets and PINs couldn't be loaded. Try again in a moment."}{" "}
            Tablets already set up keep working.
          </p>
          <button type="button" onClick={onRefresh}>
            Try again
          </button>
        </StatePanel>
      ) : read === null ? null : (
        <>
          {read.devices === null ? null : (
            <section className="store-devices__section" aria-labelledby="store-devices-this">
              <h2 id="store-devices-this">This tablet</h2>
              {read.thisDevice !== null ? (
                <p>This tablet is set up as “{read.thisDevice.label}”.</p>
              ) : (
                <form
                  className="store-devices__register"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    onRegister();
                  }}
                >
                  <p>
                    Staff can then switch to themselves here with their 6-digit PIN. Refunds, price
                    and staff changes still need a full sign-in. Do this on the shared tablet
                    itself, not on a personal phone or computer.
                  </p>
                  <label htmlFor="store-devices-label">Tablet name</label>
                  <input
                    id="store-devices-label"
                    name="tablet-name"
                    maxLength={40}
                    autoComplete="off"
                    placeholder="e.g. Front counter"
                    aria-describedby="store-devices-label-hint"
                    value={label}
                    disabled={locked}
                    onChange={(event) => onLabel(event.currentTarget.value)}
                  />
                  <p id="store-devices-label-hint" className="store-devices__hint">
                    A name staff recognise, up to 40 characters.
                  </p>
                  <button type="submit" disabled={locked || !validDeviceLabel(label)}>
                    {busy ? "Setting up…" : "Set up this tablet for staff PINs"}
                  </button>
                </form>
              )}
            </section>
          )}
          {read.devices === null ? null : (
            <section className="store-devices__section" aria-labelledby="store-devices-list">
              <h2 id="store-devices-list">Shared tablets</h2>
              {read.devices.length === 0 ? (
                <p>No tablets are set up yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Tablet</th>
                      <th scope="col">Set up by</th>
                      <th scope="col">Set up on</th>
                      <th scope="col">Last used</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {read.devices.map((device) => (
                      <tr key={device.device}>
                        <td>
                          {device.label}
                          {read.thisDevice?.device === device.device ? " (this tablet)" : ""}
                        </td>
                        <td data-label="Set up by">{device.registeredBy ?? "—"}</td>
                        <td data-label="Set up on">
                          {friendlyStoreTime(device.registeredAt, timeZone)}
                        </td>
                        <td data-label="Last used">
                          {device.lastUsedAt === null
                            ? "Not used yet"
                            : friendlyStoreTime(device.lastUsedAt, timeZone)}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={locked}
                            aria-label={`Remove ${device.label}`}
                            onClick={() => onAsk({ kind: "Remove", device })}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
          {read.staffPins === null ? null : (
            <section className="store-devices__section" aria-labelledby="store-devices-pins">
              <h2 id="store-devices-pins">Staff PINs</h2>
              {read.staffPins.length === 0 ? (
                <p>No staff at this store yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {read.staffPins.map((row) => (
                      <tr key={row.staff}>
                        <td>{row.name}</td>
                        <td data-label="Status">{staffPinStatusText(row, timeZone, now)}</td>
                        <td>
                          {row.state === "Set" ? (
                            <button
                              type="button"
                              disabled={locked}
                              aria-label={`Reset ${row.name}'s PIN`}
                              onClick={() => onAsk({ kind: "Reset", person: row })}
                            >
                              Reset PIN
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}
      {dialog}
    </WorkspacePage>
  );
}

export function StoreDevicesPage({
  csrf,
  storeLabel,
  timeZone: zoneProp,
  client,
  fetcher,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  readonly timeZone?: string | undefined;
  readonly client?: StaffPinClient;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const contextZone = useContext(StoreTimeZoneContext);
  const timeZone = zoneProp ?? contextZone;
  const source = useMemo(() => client ?? createStaffPinClient(csrf), [client, csrf]);
  const [load, setLoad] = useState<DevicesLoad>({ kind: "Loading" });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "neutral" | "error"; text: string } | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const active = useRef<AbortController | null>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setNow(Date.now());
    void source.devices(controller.signal).then(
      (read) => {
        if (!controller.signal.aborted) setLoad({ kind: "Ready", read });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const code = error instanceof StaffPinError ? error.code : "Unavailable";
        if (code === "FullSignInRequired") {
          setNeedsVerification(true);
          setLoad({ kind: "NeedsVerification" });
          return;
        }
        setLoad({
          kind: code === "Denied" ? "Denied" : code === "Offline" ? "Offline" : "Failed",
        });
      },
    );
  }, [source]);
  useEffect(() => {
    refresh();
    return () => active.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (pending !== null && !confirmDialog.current?.open) confirmDialog.current?.showModal();
    if (pending === null && confirmDialog.current?.open) confirmDialog.current.close();
  }, [pending]);

  const failed = (error: unknown, action: "Register" | PendingAction) => {
    const outcome = commandFailureOutcome(error, action);
    if (outcome.needsVerification) setNeedsVerification(true);
    setMessage(outcome.message);
    if (
      error instanceof StaffPinError &&
      ["AlreadyRegistered", "NotFound", "PinNotSet"].includes(error.code)
    )
      refresh();
  };
  const register = async () => {
    if (busy || !validDeviceLabel(label)) return;
    setBusy(true);
    setMessage(null);
    try {
      const device = await source.registerDevice(label);
      setLabel("");
      setMessage({
        tone: "neutral",
        text: `This tablet is set up as “${device.label}”. Staff can now switch to themselves here with their PIN.`,
      });
      refresh();
    } catch (error) {
      failed(error, "Register");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (pending === null || busy) return;
    const action = pending;
    setBusy(true);
    setMessage(null);
    try {
      if (action.kind === "Remove") {
        const result = await source.revokeDevice(action.device.device);
        setMessage({ tone: "neutral", text: removedText(action.device.label, result.signedOut) });
      } else {
        await source.resetPin(action.person.staff);
        setMessage({
          tone: "neutral",
          text: `${action.person.name}'s PIN is reset. They sign in with their account and set a new one.`,
        });
      }
      refresh();
    } catch (error) {
      failed(error, action);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <StoreDevicesView
      load={load}
      storeLabel={storeLabel}
      timeZone={timeZone}
      now={now}
      label={label}
      busy={busy}
      message={message}
      needsVerification={needsVerification}
      verification={
        <StepUpVerification
          purpose="PinSessionElevation"
          csrf={csrf}
          verifiedUntil={verifiedUntil}
          onVerified={(until) => {
            setVerifiedUntil(until);
            setNeedsVerification(false);
            setMessage({ tone: "neutral", text: "Verified. Try again now." });
            if (load.kind !== "Ready") refresh();
          }}
          // WP-2423 item 7: the same label as the sidebar; the guidance above already names
          // the authenticator app, so the button's own hint is not repeated.
          label="Verify it's you"
          hint={false}
          fetcher={fetcher}
          loadServerStatus={false}
          explanation={PIN_ELEVATION_EXPLANATION}
        />
      }
      pending={pending}
      onLabel={setLabel}
      onRegister={() => void register()}
      onAsk={(action) => {
        setMessage(null);
        setPending(action);
      }}
      onRefresh={refresh}
      dialog={
        <dialog
          ref={confirmDialog}
          className="order-cancel-dialog store-devices__confirm"
          aria-labelledby="store-devices-confirm-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setPending(null);
          }}
        >
          {pending === null ? null : (
            <>
              <h2 id="store-devices-confirm-title">
                {pending.kind === "Remove"
                  ? `Remove ${pending.device.label}?`
                  : `Reset ${pending.person.name}'s PIN?`}
              </h2>
              <p>
                {pending.kind === "Remove"
                  ? "Anyone signed in on it with a PIN is signed out, and it will need to be set up again."
                  : "They sign in with their account and set a new one. This also unlocks a locked PIN and signs them out of PIN sign-ins."}
              </p>
              <div className="card-actions">
                <button
                  type="button"
                  data-variant="destructive"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "Working…" : pending.kind === "Remove" ? "Remove tablet" : "Reset PIN"}
                </button>
                <button type="button" disabled={busy} onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </dialog>
      }
    />
  );
}
