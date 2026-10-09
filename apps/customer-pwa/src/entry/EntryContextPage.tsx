import { DiningAdmissionPanel, type DiningAdmissionUi } from "../dining/DiningAdmissionPanel.js";
import { CustomerPage } from "../journey/CustomerPage.js";
import { formatClockTime } from "../journey/format.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
} from "./types.js";

const serviceModeLabels = Object.freeze({
  DineIn: "Dine in",
  Pickup: "Pickup",
  Delivery: "Delivery",
});

const unavailableClient: CustomerEntryClient = Object.freeze({
  hasEntry: false,
  async start() {
    return Object.freeze({ kind: "Missing" });
  },
  async retry() {
    return Object.freeze({ kind: "Missing" });
  },
});

export interface EntryContextPageProps {
  readonly diningAdmission?: DiningAdmissionUi | undefined;
  readonly client?: CustomerEntryClient | undefined;
  readonly onEstablished?: ((context: CustomerEntryEstablishedContext) => void) | undefined;
}

export function EntryContextPage({
  client = unavailableClient,
  onEstablished,
  diningAdmission,
}: EntryContextPageProps) {
  const initial = (): CustomerEntryScreenState =>
    client.hasEntry ? Object.freeze({ kind: "Loading" }) : Object.freeze({ kind: "Missing" });
  const [result, setResult] = useState<{
    client: CustomerEntryClient;
    state: CustomerEntryScreenState;
  }>(() => ({ client, state: initial() }));
  const state = result.client === client ? result.state : initial();
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const established = useRef(onEstablished);
  const runCurrent = useRef<((action: "start" | "retry") => Promise<void>) | null>(null);

  useLayoutEffect(() => {
    established.current = onEstablished;
  }, [onEstablished]);
  useLayoutEffect(() => {
    let active = true;
    let busy = false;
    async function run(action: "start" | "retry") {
      if (!active || busy) return;
      busy = true;
      setResult({ client, state: Object.freeze({ kind: "Loading" }) });
      try {
        // Start after commit, allowing StrictMode cleanup to retire its first generation.
        await Promise.resolve();
        if (!active) return;
        const next = await client[action]();
        if (!active) return;
        setResult({ client, state: next });
        if (next.kind === "Established") established.current?.(next.context);
      } catch {
        if (active) setResult({ client, state: Object.freeze({ kind: "ServiceUnavailable" }) });
      } finally {
        busy = false;
      }
    }
    runCurrent.current = run;
    void run("start");
    return () => {
      active = false;
      runCurrent.current = null;
    };
  }, [client]);

  useEffect(() => {
    if (state.kind !== "Loading") heading.current?.focus();
  }, [state.kind]);

  const retry = (): void => {
    void runCurrent.current?.("retry");
  };

  return (
    <EntryContextView
      diningAdmission={diningAdmission}
      headingRef={heading}
      onContinue={() => navigate("/menu")}
      onRetry={retry}
      state={state}
    />
  );
}

export interface EntryContextViewProps {
  readonly diningAdmission?: DiningAdmissionUi | undefined;
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly onContinue?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly state: CustomerEntryScreenState;
}

export function EntryContextView({
  diningAdmission,
  headingRef,
  onContinue,
  onRetry,
  state,
}: EntryContextViewProps) {
  const established = state.kind === "Established" ? state.context : null;
  return (
    <CustomerPage
      step="entry"
      store={
        established
          ? {
              storeName: established.storeDisplayName,
              brandName: established.brandDisplayName,
              serviceMode: established.channel,
            }
          : undefined
      }
      className="entry-page"
      fallbackTitle="Start your order"
    >
      <section className="entry-card" aria-live="polite" aria-busy={state.kind === "Loading"}>
        <EntryState
          diningAdmission={diningAdmission}
          headingRef={headingRef}
          onContinue={onContinue}
          onRetry={onRetry}
          state={state}
        />
      </section>
      <aside className="entry-help" aria-labelledby="entry-help-heading">
        <h2 id="entry-help-heading">Need help?</h2>
        <p>
          Ask a staff member for an accessible ordering option. Tell staff about allergies before
          ordering; the QR code does not record allergy or health information.
        </p>
      </aside>
    </CustomerPage>
  );
}

function StateHeading({
  children,
  headingRef,
}: Readonly<{
  children: React.ReactNode;
  headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
}>) {
  return (
    <h2 id="entry-heading" ref={headingRef} tabIndex={-1}>
      {children}
    </h2>
  );
}

function RetryAction({
  onRetry,
  disabled = false,
}: Readonly<{ onRetry?: (() => void) | undefined; disabled?: boolean }>) {
  return onRetry ? (
    <button className="entry-action" type="button" onClick={onRetry} disabled={disabled}>
      Try again
    </button>
  ) : null;
}

function RateLimitedState({
  seconds,
  onRetry,
  headingRef,
}: Readonly<{
  seconds: number;
  onRetry?: (() => void) | undefined;
  headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
}>) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    const until = performance.now() + seconds * 1000;
    const timer = setInterval(() => {
      const next = Math.max(0, Math.ceil((until - performance.now()) / 1000));
      setRemaining(next);
      if (next === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [seconds]);
  return (
    <div className="entry-state entry-state--warning" role="status">
      <StateHeading headingRef={headingRef}>Please wait before trying again</StateHeading>
      <p>No order was submitted. You can ask a staff member for help.</p>
      <p aria-live="off">
        {remaining > 0 ? "Try again in " + remaining + " seconds." : "You can try again now."}
      </p>
      <RetryAction onRetry={onRetry} disabled={remaining > 0} />
    </div>
  );
}

function EntryState({
  diningAdmission,
  headingRef,
  onContinue,
  onRetry,
  state,
}: Readonly<EntryContextViewProps>) {
  if (state.kind === "Loading")
    return (
      <div role="status">
        <StateHeading headingRef={headingRef}>Checking this location</StateHeading>
        <p>Confirming the latest public ordering options…</p>
      </div>
    );

  if (state.kind === "Missing")
    return (
      <div role="status">
        <StateHeading headingRef={headingRef}>Scan the location QR code</StateHeading>
        <p>
          This page needs the QR code at the table or pickup location. No store search is shown.
        </p>
      </div>
    );

  if (state.kind === "RequestInvalid" || state.kind === "EntryUnavailable")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>This entry link can’t be used</StateHeading>
        <p>Scan the location QR code again or ask a staff member for help.</p>
      </div>
    );

  if (state.kind === "RateLimited")
    return (
      <RateLimitedState
        key={state.retryAfterSeconds}
        seconds={state.retryAfterSeconds}
        headingRef={headingRef}
        onRetry={onRetry}
      />
    );

  if (state.kind === "Offline")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>You’re offline</StateHeading>
        <p>No request or order was submitted. Reconnect, then try again.</p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  if (state.kind === "ServiceUnavailable" || state.kind === "CommandFailed")
    return (
      <div className="entry-state entry-state--error" role="alert">
        <StateHeading headingRef={headingRef}>Ordering is unavailable</StateHeading>
        <p>No order was submitted. Try again or ask a staff member for help.</p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  const { context } = state;
  const locationOpen = context.operatingState === "Open";
  return (
    <div>
      <StateHeading headingRef={headingRef}>Ready to order</StateHeading>
      <p className="entry-context">
        {context.channel === "DineIn"
          ? `Your table at ${context.storeDisplayName} is confirmed for dine-in.`
          : `Pickup from ${context.storeDisplayName} is selected.`}
      </p>
      <dl className="entry-details">
        <div>
          <dt>Location status</dt>
          <dd>{locationOpen ? "Open for ordering" : "Not accepting orders"}</dd>
        </div>
        <div>
          <dt>Available service</dt>
          <dd>
            {context.availableServiceModes.length > 0
              ? context.availableServiceModes.map((mode) => serviceModeLabels[mode]).join(", ")
              : "None right now"}
          </dd>
        </div>
        <div>
          <dt>Order by</dt>
          <dd>
            <time dateTime={context.contextExpiresAt}>
              {formatClockTime(context.contextExpiresAt)}
            </time>
          </dd>
        </div>
      </dl>
      {context.channel === "DineIn" &&
      context.publicTableReference !== null &&
      locationOpen &&
      context.availableServiceModes.includes("DineIn") ? (
        <DiningAdmissionPanel contextEpoch={context} service={diningAdmission} />
      ) : null}
      {locationOpen ? (
        onContinue ? (
          <button className="entry-action" type="button" onClick={onContinue}>
            Continue to menu
          </button>
        ) : (
          <p role="status">Menu navigation is unavailable. Scan the location QR code again.</p>
        )
      ) : (
        <p className="entry-closed" role="status">
          This location is not accepting orders. Ask staff about current hours or alternatives.
        </p>
      )}
    </div>
  );
}
