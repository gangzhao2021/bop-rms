import { DiningAdmissionPanel, type DiningAdmissionUi } from "../dining/DiningAdmissionPanel.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CustomerCurrentOrder } from "../session/session-bootstrap.js";
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
  /**
   * WP-2423 Q10: an order this browser already placed. Starting a new visit would replace the
   * Session that can open it, so the page offers the order first and starts only when asked.
   */
  readonly currentOrder?: CustomerCurrentOrder | undefined;
  /** The Store of that order, restored with the Session. */
  readonly store?: CustomerStoreContext | undefined;
}

/** "21:30:00" → "9:30 PM" (published local time; no time zone conversion). */
export function entryClock(value: string): string {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function EntryContextPage({
  client = unavailableClient,
  onEstablished,
  diningAdmission,
  currentOrder,
  store,
}: EntryContextPageProps) {
  const [holding, setHolding] = useState(currentOrder !== undefined);
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
    if (!holding) void run("start");
    return () => {
      active = false;
      runCurrent.current = null;
    };
  }, [client, holding]);

  useEffect(() => {
    if (state.kind !== "Loading") heading.current?.focus();
  }, [state.kind]);

  const retry = (): void => {
    void runCurrent.current?.("retry");
  };

  if (holding && currentOrder)
    return (
      <CurrentOrderView
        order={currentOrder}
        store={store}
        onStartNew={client.hasEntry ? () => setHolding(false) : undefined}
      />
    );
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

/** WP-2423 Q10: the customer's order in progress, offered before any new visit starts. */
export function CurrentOrderView({
  order,
  store,
  onStartNew,
}: Readonly<{
  order: CustomerCurrentOrder;
  store?: CustomerStoreContext | undefined;
  onStartNew?: (() => void) | undefined;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <CustomerPage
      step="entry"
      store={store}
      orderReference={order.orderReference}
      className="entry-page"
      fallbackTitle="Your order"
    >
      <section className="entry-card" aria-labelledby="entry-heading">
        <div>
          <StateHeading headingRef={heading}>Your order {order.orderNumber}</StateHeading>
          <p>
            {order.orderType === "DineIn"
              ? "You ordered at a table from this phone. You can check your order and everything your table ordered."
              : "You placed a pickup order from this phone. Check its status and your pickup code."}
          </p>
          <div className="shell-actions">
            <Link className="entry-action" to={`/orders/${order.orderReference}`}>
              View order {order.orderNumber}
            </Link>
            {order.orderType === "DineIn" ? <Link to="/dine-in/session">Your table</Link> : null}
          </div>
          {onStartNew ? (
            <>
              <p>
                Starting a new order here closes this order on this phone. The store still has it.
              </p>
              <button className="entry-secondary-action" type="button" onClick={onStartNew}>
                Start a new order
              </button>
            </>
          ) : (
            <p>To start a new order, scan the QR code at your table or at the counter.</p>
          )}
        </div>
      </section>
    </CustomerPage>
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
      {/* Not under the short loading notice, where the arriving answer would push it down. */}
      {state.kind === "Loading" ? null : (
        <aside className="entry-help" aria-labelledby="entry-help-heading">
          <h2 id="entry-help-heading">Need help?</h2>
          <p>
            Ask a staff member for an accessible ordering option. Tell staff about allergies before
            ordering; the QR code does not record allergy or health information.
          </p>
        </aside>
      )}
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

  if (state.kind === "NotAccepting")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.storeDisplayName} isn’t taking orders right now
        </StateHeading>
        <p>
          {state.paused
            ? "Online ordering is paused for a short while. Try again in a few minutes, or order with a staff member."
            : "The store is closed now."}
        </p>
        <p>
          {state.todayHours.length === 0
            ? "Closed today."
            : "Today’s hours: " +
              state.todayHours
                .map(
                  (interval) =>
                    entryClock(interval.start) +
                    "–" +
                    entryClock(interval.end) +
                    (interval.endsNextDay ? " (next day)" : ""),
                )
                .join(", ")}
        </p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  if (state.kind === "RequestInvalid" || state.kind === "EntryUnavailable")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>This entry link can’t be used</StateHeading>
        <p>Scan the location QR code again or ask a staff member for help.</p>
      </div>
    );

  if (state.kind === "TableCodeRetired")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.replaced ? "This table code was replaced" : "This table code is no longer in use"}
        </StateHeading>
        <p>
          {state.replaced
            ? "This table code was replaced. Please ask a staff member."
            : "This table code is no longer in use. Please ask a staff member."}
        </p>
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
