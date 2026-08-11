import { AppFrame } from "@bop-rms/ui";
import { useEffect, useRef, useState } from "react";
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
  readonly client?: CustomerEntryClient | undefined;
  readonly onEstablished?: ((context: CustomerEntryEstablishedContext) => void) | undefined;
}

export function EntryContextPage({
  client = unavailableClient,
  onEstablished,
}: EntryContextPageProps) {
  const [state, setState] = useState<CustomerEntryScreenState>(
    client.hasEntry ? Object.freeze({ kind: "Loading" }) : Object.freeze({ kind: "Missing" }),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let current = true;
    void client.start().then((next) => {
      if (current) {
        if (next.kind === "Established") onEstablished?.(next.context);
        setState(next);
      }
    });
    return () => {
      current = false;
    };
  }, [client, onEstablished]);

  useEffect(() => {
    if (state.kind !== "Loading") heading.current?.focus();
  }, [state.kind]);

  const retry = (): void => {
    setState(Object.freeze({ kind: "Loading" }));
    void client.retry().then((next) => {
      if (next.kind === "Established") onEstablished?.(next.context);
      setState(next);
    });
  };

  return (
    <EntryContextView
      headingRef={heading}
      onContinue={() => navigate("/menu")}
      onRetry={retry}
      state={state}
    />
  );
}

export interface EntryContextViewProps {
  readonly headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  readonly onContinue?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly state: CustomerEntryScreenState;
}

export function EntryContextView({
  headingRef,
  onContinue,
  onRetry,
  state,
}: EntryContextViewProps) {
  const established = state.kind === "Established" ? state.context : null;
  const title = established?.brandDisplayName ?? "Start your order";
  const description = established
    ? `${established.storeDisplayName} · ${established.channel === "DineIn" ? "Dine in" : "Pickup"}`
    : "Scan the location QR code to begin safely";

  return (
    <AppFrame title={title} description={description}>
      <section className="entry-card" aria-live="polite" aria-busy={state.kind === "Loading"}>
        <EntryState
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
    </AppFrame>
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

function RetryAction({ onRetry }: Readonly<{ onRetry?: (() => void) | undefined }>) {
  return onRetry ? (
    <button className="entry-action" type="button" onClick={onRetry}>
      Try again
    </button>
  ) : null;
}

function EntryState({ headingRef, onContinue, onRetry, state }: Readonly<EntryContextViewProps>) {
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
      <StateHeading headingRef={headingRef}>{context.storeDisplayName}</StateHeading>
      <p className="entry-context">
        {context.channel === "DineIn"
          ? "Your table is confirmed for dine-in."
          : "Pickup is selected."}
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
          <dt>Language</dt>
          <dd>{context.locale}</dd>
        </div>
        <div>
          <dt>Entry expires</dt>
          <dd>
            <time dateTime={context.contextExpiresAt}>{context.contextExpiresAt}</time>
          </dd>
        </div>
      </dl>
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
