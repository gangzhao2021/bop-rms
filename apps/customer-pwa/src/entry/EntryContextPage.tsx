import { listSeparator, t } from "../i18n/i18n.js";
import { DiningAdmissionPanel, type DiningAdmissionUi } from "../dining/DiningAdmissionPanel.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CustomerCurrentOrder } from "../session/session-bootstrap.js";
import { getLastSettledTable, SettledTableReceiptView } from "../dining/SettledTableReceipt.js";
import {
  createStoreProfileClient,
  type StoreProfileLoader,
} from "../store/store-profile-client.js";
import { StoreIdentityCard } from "../store/StoreIdentity.js";
import { nextOpeningText } from "../store/store-hours-text.js";
import { endSentence } from "../journey/format.js";
import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
} from "./types.js";

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
  /** The Store's hours and address once the visit starts; null shows none (previews). */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
}

const browserStoreProfile: StoreProfileLoader = createStoreProfileClient();

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
  storeProfile,
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
      storeProfile={storeProfile === undefined ? browserStoreProfile : storeProfile}
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
      fallbackTitle={t("Your order")}
    >
      <section className="entry-card" aria-labelledby="entry-heading">
        <div>
          <StateHeading headingRef={heading}>
            {t("Your order")} {order.orderNumber}
          </StateHeading>
          <p>
            {order.orderType === "DineIn"
              ? t(
                  "You ordered at a table from this phone. You can check your order and everything your table ordered.",
                )
              : t(
                  "You placed a pickup order from this phone. Check its status and your pickup code.",
                )}
          </p>
          <div className="shell-actions">
            <Link className="entry-action" to={`/orders/${order.orderReference}`}>
              {t("View order")} {order.orderNumber}
            </Link>
            {order.orderType === "DineIn" ? (
              <Link to="/dine-in/session">{t("Your table")}</Link>
            ) : null}
          </div>
          {onStartNew ? (
            <>
              <p>
                {t(
                  "Starting a new order here closes this order on this phone. The store still has it.",
                )}
              </p>
              <button className="entry-secondary-action" type="button" onClick={onStartNew}>
                {t("Start a new order")}
              </button>
            </>
          ) : (
            <p>{t("To start a new order, scan the QR code at your table or at the counter.")}</p>
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
  /** Shown under a started visit: the Store's hours, address and phone. */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
}

export function EntryContextView({
  diningAdmission,
  headingRef,
  onContinue,
  onRetry,
  state,
  storeProfile = null,
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
      fallbackTitle={t("Start your order")}
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
      {/* Below the started visit, so its arrival moves nothing the guest is reading. */}
      {established ? <StoreIdentityCard load={storeProfile} /> : null}
      {/* Not under the short loading notice, where the arriving answer would push it down. */}
      {state.kind === "Loading" ? null : (
        <aside className="entry-help" aria-labelledby="entry-help-heading">
          <h2 id="entry-help-heading">{t("Need help?")}</h2>
          <p>
            {t(
              "Ask a staff member for an accessible ordering option. Tell staff about allergies before ordering; the QR code does not record allergy or health information.",
            )}
          </p>
        </aside>
      )}
    </CustomerPage>
  );
}

/**
 * WP-2423 item 8 ⑤ (v3: one primary action): at a table, joining it is the next step and the menu
 * is there to browse; once joined, going to the menu is.
 */
function EntryNextSteps({
  joining,
  context,
  diningAdmission,
  onContinue,
}: {
  readonly joining: boolean;
  readonly context: object;
  readonly diningAdmission: DiningAdmissionUi | undefined;
  readonly onContinue: () => void;
}) {
  const [joined, setJoined] = useState(false);
  // Joining is the next step only where it can happen here.
  const first = joining && diningAdmission !== undefined && !joined;
  return (
    <>
      {joining ? (
        <DiningAdmissionPanel
          contextEpoch={context}
          service={diningAdmission}
          onStateChange={(state) => setJoined(state === "Bound" || state === "Unavailable")}
        />
      ) : null}
      <button
        className={first ? "entry-secondary-action" : "entry-action"}
        type="button"
        onClick={onContinue}
      >
        {first ? t("Look at the menu first") : t("Continue to menu")}
      </button>
    </>
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
      {t("Try again")}
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
      <StateHeading headingRef={headingRef}>{t("Please wait before trying again")}</StateHeading>
      <p>{t("No order was submitted. You can ask a staff member for help.")}</p>
      <p aria-live="off">
        {remaining > 0
          ? t("Try again in ") + remaining + t(" seconds.")
          : t("You can try again now.")}
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
        <StateHeading headingRef={headingRef}>{t("Checking this location")}</StateHeading>
        <p>{t("Confirming the latest public ordering options…")}</p>
      </div>
    );

  if (state.kind === "Missing")
    return (
      <div role="status">
        <StateHeading headingRef={headingRef}>{t("Scan the location QR code")}</StateHeading>
        <p>
          {t(
            "This page needs the QR code at the table or pickup location. No store search is shown.",
          )}
        </p>
      </div>
    );

  if (state.kind === "NotAccepting")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.storeDisplayName} {t("isn’t taking orders right now")}
        </StateHeading>
        <p>
          {state.paused
            ? t(
                "Online ordering is paused for a short while. Try again in a few minutes, or order with a staff member.",
              )
            : state.todayKind === "Holiday" && state.todayHours.length === 0
              ? t("The store is closed today for a holiday.")
              : state.todayKind !== null && state.todayHours.length === 0
                ? t("The store is closed today.")
                : t("The store is closed now.")}
        </p>
        {state.paused || state.nextOpening === null ? null : (
          <p className="entry-state__next">
            {endSentence(nextOpeningText(state.nextOpening, state.localDate))}
          </p>
        )}
        {state.todayKind !== null && state.todayHours.length === 0 ? null : (
          <p>
            {state.todayHours.length === 0
              ? t("Closed today.")
              : t("Today’s hours: ") +
                state.todayHours
                  .map(
                    (interval) =>
                      entryClock(interval.start) +
                      "–" +
                      entryClock(interval.end) +
                      (interval.endsNextDay ? t(" (next day)") : ""),
                  )
                  .join(listSeparator())}
          </p>
        )}
        <RetryAction onRetry={onRetry} />
      </div>
    );

  if (state.kind === "RequestInvalid" || state.kind === "EntryUnavailable")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>{t("This entry link can’t be used")}</StateHeading>
        <p>{t("Scan the location QR code again or ask a staff member for help.")}</p>
      </div>
    );

  if (state.kind === "PickupNotOffered")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {t("{store} takes dine-in orders only", { store: state.storeDisplayName })}
        </StateHeading>
        <p>
          {t(
            "Pickup orders aren’t taken here. To eat in, scan the QR code on your table or ask a staff member for a table.",
          )}
        </p>
      </div>
    );

  if (state.kind === "TableCodeRetired")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.replaced
            ? t("This table code was replaced")
            : t("This table code is no longer in use")}
        </StateHeading>
        <p>
          {state.replaced
            ? t("This table code was replaced. Please ask a staff member.")
            : t("This table code is no longer in use. Please ask a staff member.")}
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
        <StateHeading headingRef={headingRef}>{t("You’re offline")}</StateHeading>
        <p>{t("No request or order was submitted. Reconnect, then try again.")}</p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  if (state.kind === "ServiceUnavailable" || state.kind === "CommandFailed")
    return (
      <div className="entry-state entry-state--error" role="alert">
        <StateHeading headingRef={headingRef}>{t("Ordering is unavailable")}</StateHeading>
        <p>{t("No order was submitted. Try again or ask a staff member for help.")}</p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  const { context } = state;
  const locationOpen = context.operatingState === "Open";
  // Coordinator 2026-10-30: staff seat a party before its phones can join and order.
  const notSeated = context.channel === "DineIn" && context.tableOpen === false;
  if (locationOpen && notSeated) {
    // A guest whose table was just settled (this device's visit ended with it) scanning again
    // before staff seat a new party: thanked, with that table's receipt, read before this scan.
    const settled = getLastSettledTable();
    return (
      <div>
        {settled === null ? (
          <>
            <StateHeading headingRef={headingRef}>{t("This table isn’t open yet")}</StateHeading>
            <p className="entry-context">{t("Ask staff to seat you, then scan again.")}</p>
          </>
        ) : (
          <>
            <StateHeading headingRef={headingRef}>
              {t("This table is settled. Thank you for dining with us.")}
            </StateHeading>
            <p className="entry-context">
              {t("Table {table} has paid and closed.", { table: settled.tableLabel })}
            </p>
            {settled.receipt === null ? null : (
              <SettledTableReceiptView receipt={settled.receipt} />
            )}
            <p>{t("New party? Ask staff to seat you, then scan again.")}</p>
          </>
        )}
        {onContinue ? (
          <button className="entry-action" type="button" onClick={onContinue}>
            {t("Look at the menu first")}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <StateHeading headingRef={headingRef}>{t("Ready to order")}</StateHeading>
      <p className="entry-context">
        {context.channel === "DineIn"
          ? t("Your table at {storeDisplayName} is confirmed for dine-in.", {
              storeDisplayName: context.storeDisplayName,
            })
          : t("Pickup from {storeDisplayName} is selected.", {
              storeDisplayName: context.storeDisplayName,
            })}
      </p>
      {/* Open now, today's hours and the address are stated once, in the store card below. */}
      {locationOpen ? (
        onContinue ? (
          <EntryNextSteps
            joining={
              context.channel === "DineIn" &&
              context.publicTableReference !== null &&
              context.availableServiceModes.includes("DineIn")
            }
            context={context}
            diningAdmission={diningAdmission}
            onContinue={onContinue}
          />
        ) : (
          <p role="status">
            {t("Menu navigation is unavailable. Scan the location QR code again.")}
          </p>
        )
      ) : (
        <p className="entry-closed" role="status">
          {t(
            "This location is not accepting orders. Ask staff about current hours or alternatives.",
          )}
        </p>
      )}
    </div>
  );
}
