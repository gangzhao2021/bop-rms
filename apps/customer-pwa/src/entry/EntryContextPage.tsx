import { listSeparator, t, saidTable } from "../i18n/i18n.js";
import {
  admissionStateForFailure,
  DiningAdmissionPanel,
  type DiningAdmissionUi,
} from "../dining/DiningAdmissionPanel.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CustomerCurrentOrder } from "../session/session-bootstrap.js";
import { SettledTableReceiptPanel } from "../dining/SettledTableReceipt.js";
import {
  getSettledTableLabel,
  setGuestTableQuestion,
  setGuestTableJoiner,
  setGuestTableStarter,
  setNewPartyJoin,
  type GuestTableStartAnswer,
} from "../session/customer-transaction-context.js";
import {
  createStoreProfileClient,
  type StoreProfileLoader,
} from "../store/store-profile-client.js";
import { StoreIdentityCard, useStoreProfile } from "../store/StoreIdentity.js";
import { nextOpeningText } from "../store/store-hours-text.js";
import { endSentence, formatClockTime, formatStoreLocalTime } from "../journey/format.js";
import { unpaidPickup } from "../order-status/OrderStatusPage.js";
import { createHttpOrderStatusClient } from "../order-status/order-status-client.js";
import type { CustomerOrderStatusClient } from "../order-status/order-status-controller.js";
import type { OrderStatusView } from "../order-status/types.js";
import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryIntent,
  CustomerEntryScreenState,
} from "./types.js";
import { watchTableOpening } from "./table-open-recheck.js";
import type { MenuClosedStore } from "../menu/types.js";
import { createMenuTableJoiner } from "./menu-table-joiner.js";

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
  /** The public context the menu needs (also after a scan of a table not open yet). */
  readonly onEstablished?:
    | ((
        context: Pick<
          CustomerEntryEstablishedContext,
          "publicStoreReference" | "channel" | "locale" | "brandDisplayName" | "storeDisplayName"
        > & {
          /** M116: the Store isn't taking orders now; its menu is only to look at. */
          readonly closed?: MenuClosedStore | undefined;
        },
      ) => void)
    | undefined;
  /**
   * WP-2423 Q10: an order this browser already placed. Starting a new visit would replace the
   * Session that can open it, so the page offers the order first and starts only when asked.
   */
  readonly currentOrder?: CustomerCurrentOrder | undefined;
  /** The Store of that order, restored with the Session. */
  readonly store?: CustomerStoreContext | undefined;
  /** The Store's hours and address once the visit starts; null shows none (previews). */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
  /** M105 (B.3): the Store of the visit this phone restored, before this scan. */
  readonly restoredStore?:
    { readonly publicStoreReference: string; readonly storeDisplayName: string } | undefined;
  /** The kept pickup order's status read (default: the HTTP read). */
  readonly orderStatusClient?: CustomerOrderStatusClient | undefined;
}

/** How long the kept order's payment read may hold the scanned place back before it is shown. */
const keptOrderReadMs = 5000;

const browserStoreProfile: StoreProfileLoader = createStoreProfileClient();

/**
 * "21:30:00" → "9:30 p.m." / "21:30" (published local time; no time zone conversion), in the
 * guest's language (WP-2423 M122: Chinese reads 24-hour time).
 */
export function entryClock(value: string): string {
  return formatStoreLocalTime(value);
}

export function EntryContextPage({
  client = unavailableClient,
  onEstablished,
  diningAdmission,
  currentOrder,
  store,
  storeProfile,
  restoredStore,
  orderStatusClient,
}: EntryContextPageProps) {
  // M105 (B.3): another Store's code, or a table's, opens that place at once when the pickup order
  // this phone has elsewhere is settled (paid, collected, cancelled); it is kept and named below the
  // new visit. M18: one still to be paid, or one whose payment can't be read, is shown first, with
  // its time to pay, while its own visit can still pay for it (the scan starts nothing until then).
  const leaving = currentOrder !== undefined && client.leavesPickupVisit === true;
  const [checkingKept, setCheckingKept] = useState(leaving && currentOrder.orderType === "Pickup");
  const [keptPayment, setKeptPayment] = useState<CurrentOrderPayment | undefined>(undefined);
  const [holding, setHolding] = useState(currentOrder !== undefined && !leaving);
  const [keptStatusClient] = useState(() => orderStatusClient ?? createHttpOrderStatusClient());
  // M105 (B.3): a pickup order at another Store stays on this phone; its own code comes back to it.
  const [keptElsewhere] = useState(() =>
    currentOrder?.orderType === "Pickup" && restoredStore !== undefined ? restoredStore : null,
  );
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
  // M02: "Start a new order" starts at the restored visit's own Store, never a default one.
  const startingNew = useRef(false);
  // WP-2423 DEC-DINING-GUEST-TABLE-START: what the guest answered, so joining needs no second tap.
  const [answered, setAnswered] = useState<CustomerEntryIntent | null>(null);
  // The kept visit's order was shown and the guest chose to order more there.
  const [orderingMore, setOrderingMore] = useState<CustomerEntryScreenState | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  const admissionRef = useRef(diningAdmission);
  admissionRef.current = diningAdmission;

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
        const fresh = action === "start" && startingNew.current && client.startNew !== undefined;
        startingNew.current = false;
        const next = await (fresh && client.startNew ? client.startNew() : client[action]());
        if (!active) return;
        setResult({ client, state: next });
        // M104: "Order more" at a pickup visit goes straight back to its menu and cart.
        if (fresh && next.kind === "Resumed" && next.context.channel === "Pickup") {
          established.current?.(next.context);
          void navigate("/menu");
          return;
        }
        if (
          next.kind === "Established" ||
          next.kind === "Resumed" ||
          next.kind === "TableNotOpen" ||
          next.kind === "TableMayStart" ||
          next.kind === "TableBeingCleaned" ||
          next.kind === "TableAskNewParty"
        )
          established.current?.(next.context);
      } catch {
        if (active) setResult({ client, state: Object.freeze({ kind: "ServiceUnavailable" }) });
      } finally {
        busy = false;
      }
    }
    runCurrent.current = run;
    if (!holding && !checkingKept) void run("start");
    return () => {
      active = false;
      runCurrent.current = null;
    };
  }, [client, holding, checkingKept]);

  // M18: the kept pickup order's payment, read before another code's visit starts.
  const keptReference = checkingKept ? currentOrder?.orderReference : undefined;
  useEffect(() => {
    if (keptReference === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unread = new Promise<"unread">((resolve) => {
      timer = setTimeout(() => resolve("unread"), keptOrderReadMs);
    });
    void Promise.race([keptStatusClient.load(keptReference).then(currentOrderPayment), unread])
      .catch(() => "unread" as const)
      .then((payment) => {
        if (stopped) return;
        // Settled: the scanned place opens. Due, or not known: the order comes first.
        if (payment === "unread" || payment?.kind === "due") {
          setKeptPayment(payment === "unread" ? undefined : payment);
          setHolding(true);
        }
        setCheckingKept(false);
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [keptReference, keptStatusClient]);

  useEffect(() => {
    if (state.kind !== "Loading") heading.current?.focus();
  }, [state.kind]);

  // The guest looks at the menu first: their tap on Add starts and joins this table, and the dish
  // they configured goes in. A scan or a link preview never gets here.
  useEffect(() => {
    if (state.kind === "Loading") return;
    setGuestTableQuestion(state.kind === "TableAskNewParty");
    // M115: only an open table's page offers the menu's join; any other answer clears it.
    if (state.kind !== "Established" && state.kind !== "Resumed") setGuestTableJoiner(null);
    if (state.kind !== "TableMayStart") {
      setGuestTableStarter(null);
      return;
    }
    const enter = clientRef.current.enter;
    const admission = admissionRef.current;
    if (enter === undefined || admission === undefined) return;
    // Joining the table this phone was just let into. Refused (the table's joins or starts are
    // spent for a few minutes): the guest's next tap on Add tries the join again, never the server's
    // "ask staff to seat you", because nobody seats anyone at these tables.
    const join = async (): Promise<GuestTableStartAnswer> => {
      try {
        await admission.journey.start({
          operationReference: admission.generateOperationReference(),
          joinCredential: null,
        });
      } catch (error) {
        setGuestTableStarter(join);
        return admissionStateForFailure(error) === "TableInUse" ? "InUse" : "Refused";
      }
      setGuestTableStarter(null);
      return "Started";
    };
    setGuestTableStarter(async (): Promise<GuestTableStartAnswer> => {
      const next = await enter("Start");
      // Someone else sat down first: the start page asks this phone whether it's with them.
      if (next.kind === "TableAskNewParty") return "InUse";
      if (next.kind !== "Established") return "Refused";
      // A new visit clears the starter; the join below puts one back if it's refused.
      established.current?.(next.context);
      return join();
    });
  }, [state.kind]);

  // M02: while a table isn't open, the page checks again by itself (rarely, only in front) and
  // when the guest says they're seated, and continues as soon as staff open it. A guest whose own
  // table was just settled is not moved into the next party's visit.
  const [recheckNow, setRecheckNow] = useState<(() => void) | null>(null);
  const waitingAtTable = state.kind === "TableNotOpen" && getSettledTableLabel() === null;
  useEffect(() => {
    if (!waitingAtTable || typeof document === "undefined") return;
    const owner = client;
    const watcher = watchTableOpening({
      check: async () => {
        const next = await owner.retry();
        if (clientRef.current !== owner) return false;
        // Still waiting, or a passing failure: keep the page as it is and ask again later.
        if (
          next.kind === "TableNotOpen" ||
          next.kind === "CommandFailed" ||
          next.kind === "Offline" ||
          next.kind === "ServiceUnavailable"
        )
          return true;
        setResult({ client: owner, state: next });
        if (
          next.kind === "Established" ||
          next.kind === "TableMayStart" ||
          next.kind === "TableBeingCleaned" ||
          next.kind === "TableAskNewParty"
        )
          established.current?.(next.context);
        return false;
      },
      visible: () => document.visibilityState === "visible",
      onVisible: (listener) => {
        const handler = () => {
          if (document.visibilityState === "visible") listener();
        };
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
      now: () => performance.now(),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    setRecheckNow(() => watcher.checkNow);
    return () => {
      watcher.stop();
      setRecheckNow(null);
    };
  }, [waitingAtTable, client]);

  const retry = (): void => {
    void runCurrent.current?.("retry");
  };
  // WP-2423 (rush-logging-and-entry): while the store answers busy the scan is asked again by
  // itself; the page says busy (with Try again, which asks at once), never "scan the code".
  const [busyClient, setBusyClient] = useState<CustomerEntryClient | null>(null);
  useEffect(() => {
    const stop = client.onBusy?.((busy) => setBusyClient(busy ? client : null));
    return () => {
      stop?.();
      setBusyClient(null);
    };
  }, [client]);
  const entryBusy = busyClient === client && state.kind === "Loading";
  const answer = (intent: CustomerEntryIntent): void => {
    const enter = client.enter;
    if (enter === undefined) return;
    setAnswered(intent);
    setResult({ client, state: Object.freeze({ kind: "Loading" }) });
    void enter(intent)
      .catch(() => Object.freeze({ kind: "ServiceUnavailable" }) as CustomerEntryScreenState)
      .then((next) => {
        // The next QR join says this phone isn't with the people at the table.
        setNewPartyJoin(intent === "NewParty" && next.kind === "Established");
        setResult({ client, state: next });
        if (next.kind === "Established") established.current?.(next.context);
      });
  };

  // M105 (B.3): this Store's code brought back the pickup visit this phone kept, with its order.
  const keptOrder =
    state.kind === "Established" && state.currentOrder !== undefined && orderingMore !== state
      ? state.currentOrder
      : undefined;
  if (keptOrder !== undefined && state.kind === "Established")
    return (
      <CurrentOrderView
        order={keptOrder}
        store={{
          storeName: state.context.storeDisplayName,
          brandName: state.context.brandDisplayName,
          serviceMode: state.context.channel,
        }}
        onStartNew={() => {
          setOrderingMore(state);
          void navigate("/menu");
        }}
      />
    );
  if (holding && currentOrder && leaving)
    return (
      <CurrentOrderView
        order={currentOrder}
        store={store}
        orderStatusClient={keptStatusClient}
        payment={keptPayment}
        onLeave={() => setHolding(false)}
      />
    );
  if (holding && currentOrder)
    return (
      <CurrentOrderView
        order={currentOrder}
        store={store}
        onStartNew={
          client.hasEntry && client.startsNewVisit !== false
            ? () => {
                startingNew.current = true;
                setHolding(false);
              }
            : undefined
        }
      />
    );
  // M116: a Store closed now (or paused): the guest looks at its menu, with nothing to order.
  const browse =
    state.kind === "NotAccepting" && state.browse !== undefined
      ? (() => {
          const context = state.browse;
          const closed: MenuClosedStore = Object.freeze({
            paused: state.paused,
            nextOpening: state.nextOpening,
            localDate: state.localDate,
          });
          return () => {
            established.current?.(Object.freeze({ ...context, closed }));
            void navigate("/menu");
          };
        })()
      : undefined;
  return (
    <EntryContextView
      diningAdmission={diningAdmission}
      headingRef={heading}
      onContinue={browse ?? (() => navigate("/menu"))}
      onRetry={retry}
      busy={entryBusy}
      onRetryNow={() => void client.retry()}
      onAnswer={client.enter === undefined ? undefined : answer}
      onSeated={recheckNow ?? undefined}
      autoJoin={answered !== null}
      starting={answered === "Start" || answered === "NewParty"}
      state={state}
      storeProfile={storeProfile === undefined ? browserStoreProfile : storeProfile}
      keptElsewhere={
        keptElsewhere !== null && keptPayment?.kind === "due"
          ? { ...keptElsewhere, payBy: keptPayment.payBy }
          : keptElsewhere
      }
    />
  );
}

/** WP-2423 M18: whether a pickup order on this phone still has to be paid, or was cancelled unpaid. */
export type CurrentOrderPayment =
  { readonly kind: "due"; readonly payBy: string } | { readonly kind: "cancelledUnpaid" } | null;
export function currentOrderPayment(view: unknown): CurrentOrderPayment {
  if (view === null || typeof view !== "object" || !("order" in view)) return null;
  const status = view as OrderStatusView;
  if (status.order.orderType !== "Pickup") return null;
  if (status.sources?.unpaidCancellation?.cancelledAt) return { kind: "cancelledUnpaid" };
  const due = unpaidPickup(status);
  return due === null || due.ended ? null : { kind: "due", payBy: due.payBy };
}

/** WP-2423 Q10: the customer's order in progress, offered before any new visit starts. */
export function CurrentOrderView({
  order,
  store,
  onStartNew,
  onLeave,
  orderStatusClient,
  payment: shownPayment,
}: Readonly<{
  order: CustomerCurrentOrder;
  store?: CustomerStoreContext | undefined;
  onStartNew?: (() => void) | undefined;
  /**
   * M105/M18: the guest scanned another code while this pickup order is still to be paid (or its
   * payment couldn't be read). They can pay here first, or go on to the code they scanned.
   */
  onLeave?: (() => void) | undefined;
  /** WP-2423 M18: the order status read used to tell an unpaid pickup (default: the HTTP read). */
  orderStatusClient?: CustomerOrderStatusClient;
  /** The payment state already known; otherwise (absent or undefined) it is read once. */
  payment?: CurrentOrderPayment | undefined;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const [readPayment, setReadPayment] = useState<CurrentOrderPayment>(null);
  const [statusClient] = useState(() => orderStatusClient ?? createHttpOrderStatusClient());
  useEffect(() => {
    if (shownPayment !== undefined || order.orderType !== "Pickup") return;
    let stopped = false;
    // A failed read keeps the ordinary wording: it never guesses that the order is unpaid.
    void statusClient
      .load(order.orderReference)
      .then((view) => {
        if (!stopped) setReadPayment(currentOrderPayment(view));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [statusClient, order.orderReference, order.orderType, shownPayment]);
  const payment = shownPayment ?? readPayment;
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
            {payment?.kind === "due"
              ? t("Not paid yet. Pay by {time}, or it is cancelled and you won’t be charged.", {
                  time: formatClockTime(payment.payBy),
                })
              : payment?.kind === "cancelledUnpaid"
                ? t("This order was cancelled because it wasn’t paid in time. You weren’t charged.")
                : order.orderType === "DineIn"
                  ? t(
                      "You ordered at a table from this phone. You can check your order and everything your table ordered.",
                    )
                  : t(
                      "You placed a pickup order from this phone. Check its status and your pickup code.",
                    )}
          </p>
          <div className="shell-actions">
            <Link
              className={payment?.kind === "cancelledUnpaid" ? undefined : "entry-action"}
              to={`/orders/${order.orderReference}`}
            >
              {payment?.kind === "due"
                ? t("Finish paying")
                : t("View order") + " " + order.orderNumber}
            </Link>
            {order.orderType === "DineIn" ? (
              <Link to="/dine-in/session">{t("Your table")}</Link>
            ) : null}
          </div>
          {/* M104 (B.2): every order of this visit stays reachable from here, newest first. */}
          {order.earlier === undefined || order.earlier.length === 0 ? null : (
            <section className="entry-orders" aria-labelledby="entry-orders-heading">
              <h3 id="entry-orders-heading">{t("Orders on this phone")}</h3>
              <ul>
                {[order, ...order.earlier].map((entry) => (
                  <li key={entry.orderReference}>
                    <span>
                      {t("Order {orderNumber}", { orderNumber: entry.orderNumber })} ·{" "}
                      {entry.orderType === "DineIn" ? t("Dine in") : t("Pickup")}
                    </span>
                    <Link to={`/orders/${entry.orderReference}`}>{t("Status")}</Link>
                    <Link to={`/orders/${entry.orderReference}/receipt`}>{t("Receipt")}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {onLeave ? (
            <>
              <p>
                {t(
                  "This order stays on this phone. Scan this store’s pickup code again to come back to it.",
                )}
              </p>
              <button className="entry-secondary-action" type="button" onClick={onLeave}>
                {t("Order from the QR code you just scanned")}
              </button>
            </>
          ) : onStartNew ? (
            <>
              {/* M104: said as it works. Order more goes on with this pickup visit, and this
                  Store's pickup code scanned again comes back to it. A new order from another code
                  starts a new visit; this one is then reached only from its own order or receipt
                  link, so the guest is told to open it first. */}
              <p>
                {order.orderType === "Pickup"
                  ? t(
                      "This order stays on this phone. Scan this store’s pickup code again to come back to it.",
                    )
                  : t(
                      "Starting a new order here closes this order on this phone. The store still has it. To keep the receipt, open the order first.",
                    )}
              </p>
              <button
                className={
                  payment?.kind === "cancelledUnpaid" ? "entry-action" : "entry-secondary-action"
                }
                type="button"
                onClick={onStartNew}
              >
                {order.orderType === "Pickup" ? t("Order more") : t("Start a new order")}
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
  /** WP-2423 DEC-DINING-GUEST-TABLE-START: the guest's answer to a table's choice. */
  readonly onAnswer?: ((intent: CustomerEntryIntent) => void) | undefined;
  /** M02: at a table not open yet, the guest says staff seated them (checks again now). */
  readonly onSeated?: (() => void) | undefined;
  /** The guest already answered; the join follows with no second tap. */
  readonly autoJoin?: boolean | undefined;
  /** They answered that they came to start this table. */
  readonly starting?: boolean | undefined;
  readonly state: CustomerEntryScreenState;
  /**
   * WP-2423 (rush-logging-and-entry): the store answered busy and the scan is asked again by
   * itself (Loading only); `onRetryNow` asks at once.
   */
  readonly busy?: boolean | undefined;
  readonly onRetryNow?: (() => void) | undefined;
  /** Shown under a started visit: the Store's hours, address and phone. */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
  /** M105 (B.3): the Store where this phone still has a pickup order (null: none). */
  readonly keptElsewhere?:
    | {
        readonly publicStoreReference: string;
        readonly storeDisplayName: string;
        /** M18: that order is still to be paid by then. */
        readonly payBy?: string | undefined;
      }
    | null
    | undefined;
}

export function EntryContextView({
  diningAdmission,
  headingRef,
  onContinue,
  onRetry,
  onAnswer,
  onSeated,
  autoJoin,
  starting,
  state,
  busy = false,
  onRetryNow,
  storeProfile = null,
  keptElsewhere = null,
}: EntryContextViewProps) {
  const established =
    state.kind === "Established" || state.kind === "Resumed" ? state.context : null;
  // WP-2423 DEC-DINING-GUEST-TABLE-START: a guest deciding at a table sees where they are, not a
  // line telling them to scan the code they just scanned.
  const at =
    established ??
    (state.kind === "TableMayStart" ||
    state.kind === "TableBeingCleaned" ||
    state.kind === "TableAskNewParty"
      ? state.context
      : state.kind === "NotAccepting"
        ? (state.browse ?? null)
        : null);
  // M109: "call them" only beside the number the store card shows; a store with no published
  // phone (or one not read) is told at the counter.
  const profile = useStoreProfile(
    established !== null && established.channel === "Pickup" ? storeProfile : null,
  );
  const callable = established?.channel === "Pickup" && profile !== null && profile.phone !== null;
  return (
    <CustomerPage
      step="entry"
      store={
        at
          ? {
              storeName: at.storeDisplayName,
              brandName: at.brandDisplayName,
              serviceMode: at.channel,
            }
          : undefined
      }
      className="entry-page"
      fallbackTitle={t("Start your order")}
      // WP-2423 (rush-logging-and-entry): a page still checking the code it was opened with (or
      // waiting out a busy store) never asks the guest to scan one.
      askToScan={state.kind !== "Loading"}
      // M116: no visit was started, so there is no cart or order to go to.
      browseOnly={state.kind === "NotAccepting"}
    >
      <section className="entry-card" aria-live="polite" aria-busy={state.kind === "Loading"}>
        <EntryState
          diningAdmission={diningAdmission}
          headingRef={headingRef}
          onContinue={onContinue}
          onRetry={onRetry}
          onAnswer={onAnswer}
          onSeated={onSeated}
          autoJoin={autoJoin}
          starting={starting}
          state={state}
          busy={busy}
          onRetryNow={onRetryNow}
        />
      </section>
      {/* M105 (B.3): a notice, not a block: the order at the other Store is still on this phone. */}
      {/* Also at a table of the same Store: the pickup order is not this table's. */}
      {at !== null &&
      keptElsewhere !== null &&
      (keptElsewhere.publicStoreReference !== at.publicStoreReference ||
        at.channel !== "Pickup") ? (
        <p className="entry-context entry-kept-elsewhere" role="note">
          {keptElsewhere.payBy === undefined
            ? t(
                "Your order at {storeDisplayName} is kept on this phone. Scan {storeDisplayName}’s pickup QR code again to go back to it.",
                { storeDisplayName: keptElsewhere.storeDisplayName },
              )
            : t(
                "Your order at {storeDisplayName} isn’t paid yet. Pay by {time}, or it is cancelled and you won’t be charged. Scan {storeDisplayName}’s pickup QR code again to pay for it.",
                {
                  storeDisplayName: keptElsewhere.storeDisplayName,
                  time: formatClockTime(keptElsewhere.payBy),
                },
              )}
        </p>
      ) : null}
      {/* Below the started visit, so its arrival moves nothing the guest is reading. */}
      {established ? <StoreIdentityCard load={storeProfile} /> : null}
      {/* Not under the short loading notice, where the arriving answer would push it down. */}
      {state.kind === "Loading" ? null : (
        <aside className="entry-help" aria-labelledby="entry-help-heading">
          <h2 id="entry-help-heading">{t("Need help?")}</h2>
          <p>
            {/* M109: a pickup guest ordering from elsewhere has no staff member beside them. */}
            {at?.channel === "Pickup"
              ? callable
                ? t(
                    "To tell the store about an allergy, call them or ask at the counter before you order. The QR code does not record allergy or health information.",
                  )
                : t(
                    "To tell the store about an allergy, ask at the counter before you order. The QR code does not record allergy or health information.",
                  )
              : t(
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
  autoJoin,
  starting,
}: {
  readonly joining: boolean;
  readonly context: object;
  readonly diningAdmission: DiningAdmissionUi | undefined;
  readonly onContinue: () => void;
  readonly autoJoin?: boolean | undefined;
  readonly starting?: boolean | undefined;
}) {
  const [joined, setJoined] = useState(false);
  // Joining is the next step only where it can happen here.
  const first = joining && diningAdmission !== undefined && !joined;
  const opened = useRef(false);
  // WP-2423 M115: the guest may look at the menu first; their tap on Add there joins this table
  // by its QR code (the same join as the panel's) and the dish they configured goes in. Cleared
  // once joined, or for another table.
  useEffect(() => {
    if (!first || diningAdmission === undefined || starting === true) {
      setGuestTableJoiner(null);
      return;
    }
    const join = createMenuTableJoiner(diningAdmission, () => setGuestTableJoiner(null));
    setGuestTableJoiner(join);
  }, [first, diningAdmission, context, starting]);
  return (
    <>
      {joining ? (
        <DiningAdmissionPanel
          contextEpoch={context}
          service={diningAdmission}
          autoJoin={autoJoin === true}
          starting={starting === true}
          onStateChange={(state) => {
            setJoined(state === "Bound" || state === "Unavailable");
            // Answered once: a refusal goes back to asking, and doesn't repeat the new party.
            if (state !== "Joining" && state !== "Ready" && state !== "Unknown")
              setNewPartyJoin(false);
            // Owner 2026-11-03 walkthrough: the guest came to order; joined, the menu opens.
            if (state === "Bound" && !opened.current) {
              opened.current = true;
              onContinue();
            }
          }}
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
  secondary = false,
  label,
}: Readonly<{
  onRetry?: (() => void) | undefined;
  disabled?: boolean;
  secondary?: boolean;
  label?: string | undefined;
}>) {
  return onRetry ? (
    <button
      className={secondary ? "entry-secondary-action" : "entry-action"}
      type="button"
      onClick={onRetry}
      disabled={disabled}
    >
      {label ?? t("Try again")}
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

/**
 * WP-2423 (rush-logging-and-entry, v15 2026-11-13): a new phone opening the pickup link in a rush
 * was told to scan the location QR code for about 8 s while the store answered busy and the scan
 * was asked again. It is told the store is busy and that nothing was ordered, with Try again (asks
 * at once; a busy answer started nothing, so a second visit is never started).
 */
function EntryBusy({
  headingRef,
  onRetryNow,
}: Readonly<{
  headingRef?: React.RefObject<HTMLHeadingElement | null> | undefined;
  onRetryNow?: (() => void) | undefined;
}>) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 1500);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <div className="entry-state entry-state--warning" role="status">
      <StateHeading headingRef={headingRef}>{t("The store’s system is busy")}</StateHeading>
      <p>{t("Nothing has been ordered. This page asks again by itself in a few seconds.")}</p>
      {onRetryNow ? (
        <button
          className="entry-action"
          type="button"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            onRetryNow();
          }}
        >
          {asking ? t("Trying again…") : t("Try again")}
        </button>
      ) : null}
    </div>
  );
}

function EntryState({
  diningAdmission,
  headingRef,
  onContinue,
  onRetry,
  onAnswer,
  onSeated,
  autoJoin,
  starting,
  state,
  busy = false,
  onRetryNow,
}: Readonly<EntryContextViewProps>) {
  if (state.kind === "Loading" && busy)
    return <EntryBusy headingRef={headingRef} onRetryNow={onRetryNow} />;
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

  // WP-2423 item 11: this Store isn't ready yet, so hours and a next opening would mislead.
  if (state.kind === "NotAccepting" && state.notReady === true)
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.storeDisplayName} {t("isn’t taking orders yet")}
        </StateHeading>
        <p>
          {t("This store is still getting ready. Please ask a staff member, or try again later.")}
        </p>
        <RetryAction onRetry={onRetry} />
      </div>
    );

  // WP-2423 item 13 ② (Owner 2026-11-05): the restaurant isn't taking new guests for now. There
  // is no time to wait for, so no hours; staff can tell the guest more.
  if (state.kind === "NotAccepting" && state.newGuestsPaused === true)
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>
          {state.storeDisplayName} {t("isn’t taking new orders right now")}
        </StateHeading>
        <p>{t("Please ask a staff member for help.")}</p>
        <RetryAction onRetry={onRetry} />
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
        {/* M116: the menu to look at first; asking again whether it's open comes second. */}
        {state.browse !== undefined && onContinue ? (
          <>
            <button className="entry-action" type="button" onClick={onContinue}>
              {t("Look at the menu first")}
            </button>
            <RetryAction onRetry={onRetry} secondary label={t("Check again")} />
          </>
        ) : (
          <RetryAction onRetry={onRetry} />
        )}
      </div>
    );

  if (state.kind === "RequestInvalid" || state.kind === "EntryUnavailable")
    return (
      <div className="entry-state entry-state--warning" role="alert">
        <StateHeading headingRef={headingRef}>{t("This entry link can’t be used")}</StateHeading>
        <p>{t("Scan the location QR code again or ask a staff member for help.")}</p>
      </div>
    );

  // Coordinator 2026-10-30: no party is seated at this table, so no visit was started. A guest
  // whose table was just settled (this browser's earlier visit, still in place) is thanked with
  // its receipt; anyone else is asked to have staff seat them.
  if (state.kind === "TableNotOpen") {
    const settled = getSettledTableLabel();
    return (
      <div>
        {settled === null ? (
          <>
            {/* WP-2423 live minor 27: which restaurant's table, as the entry answer names it; and
                which table (guest-table-open-and-busy-reads), so a card on the wrong table shows. */}
            <StateHeading headingRef={headingRef}>
              {state.tableLabel === undefined
                ? t("This table at {storeDisplayName} isn’t open yet", {
                    storeDisplayName: state.context.storeDisplayName,
                  })
                : t("Table {table} at {storeDisplayName} isn’t open yet", {
                    table: saidTable(state.tableLabel),
                    storeDisplayName: state.context.storeDisplayName,
                  })}
            </StateHeading>
            <p className="entry-context">
              {t("Ask staff to seat you. This page continues by itself once the table is open.")}
            </p>
            {state.tableLabel === undefined ? null : (
              <p className="entry-context">
                {t(
                  "Not sitting at table {table}? Tell staff, so they can give you the code for your table.",
                  {
                    table: saidTable(state.tableLabel),
                  },
                )}
              </p>
            )}
          </>
        ) : (
          <>
            <StateHeading headingRef={headingRef}>
              {t("Thank you for dining with us.")}
            </StateHeading>
            <p className="entry-context">
              {t("Your meal at table {table} has ended.", { table: saidTable(settled) })}
            </p>
            <SettledTableReceiptPanel />
            <p>{t("New party? Ask staff to seat you, then scan again.")}</p>
          </>
        )}
        {onContinue ? (
          <button className="entry-action" type="button" onClick={onContinue}>
            {t("Look at the menu first")}
          </button>
        ) : null}
        {settled === null && onSeated ? (
          <button className="entry-secondary-action" type="button" onClick={onSeated}>
            {t("We’ve been seated")}
          </button>
        ) : null}
      </div>
    );
  }

  // M02 (v15 07b7a1b7): this phone's own visit, restored after a reload, a home-screen launch or
  // the same code scanned again: the same Store, table and cart, and nothing new started.
  if (state.kind === "Resumed") {
    const { context } = state;
    return (
      <div>
        <StateHeading headingRef={headingRef}>
          {context.alreadyAtTable === true
            ? t("You’re already at this table.")
            : context.channel === "DineIn"
              ? t("Welcome to {storeDisplayName}", { storeDisplayName: context.storeDisplayName })
              : t("Ready to order")}
        </StateHeading>
        {context.channel === "DineIn" ? null : (
          <p className="entry-context">
            {t("Pickup from {storeDisplayName} is selected.", {
              storeDisplayName: context.storeDisplayName,
            })}
          </p>
        )}
        {onContinue === undefined ? null : context.channel === "DineIn" && !context.joined ? (
          <EntryNextSteps
            joining
            context={context}
            diningAdmission={diningAdmission}
            onContinue={onContinue}
          />
        ) : (
          <button className="entry-action" type="button" onClick={onContinue}>
            {t("Continue ordering")}
          </button>
        )}
      </div>
    );
  }

  // WP-2423 DEC-DINING-GUEST-TABLE-START: a scan starts nothing; the guest's tap does. A guest whose
  // visit just ended here sees their receipt first, and is told starting again ends it on this phone.
  if (state.kind === "TableMayStart") {
    const settled = getSettledTableLabel();
    return (
      <div>
        {settled === null ? null : (
          <>
            <StateHeading headingRef={headingRef}>
              {t("Thank you for dining with us.")}
            </StateHeading>
            <p className="entry-context">
              {t("Your meal at table {table} has ended.", { table: saidTable(settled) })}
            </p>
            <SettledTableReceiptPanel />
          </>
        )}
        {settled === null ? (
          <StateHeading headingRef={headingRef}>{t("Order at this table")}</StateHeading>
        ) : (
          <h3>{t("Order at this table")}</h3>
        )}
        <p className="entry-context">
          {t("You pay on your phone each time you order. No account needed.")}
        </p>
        {settled === null ? null : (
          <p>{t("After you start, this receipt won’t open on this phone.")}</p>
        )}
        <button className="entry-action" type="button" onClick={() => onAnswer?.("Start")}>
          {t("Start ordering")}
        </button>
        {onContinue ? (
          <button className="entry-secondary-action" type="button" onClick={onContinue}>
            {t("Look at the menu first")}
          </button>
        ) : null}
      </div>
    );
  }

  if (state.kind === "TableBeingCleaned")
    return (
      <div>
        <StateHeading headingRef={headingRef}>
          {t("This table is being cleaned. Pick another table or ask staff.")}
        </StateHeading>
        {onContinue ? (
          <button className="entry-action" type="button" onClick={onContinue}>
            {t("Look at the menu first")}
          </button>
        ) : null}
      </div>
    );

  // Saying they aren't with these people ends that party's table, so it is the quieter of the two
  // and well apart. A guest whose own visit just ended sees their receipt first, as above.
  if (state.kind === "TableAskNewParty") {
    const settled = getSettledTableLabel();
    return (
      <div>
        {settled === null ? null : (
          <>
            <StateHeading headingRef={headingRef}>
              {t("Thank you for dining with us.")}
            </StateHeading>
            <p className="entry-context">
              {t("Your meal at table {table} has ended.", { table: saidTable(settled) })}
            </p>
            <SettledTableReceiptPanel />
            <p>{t("After you answer, this receipt won’t open on this phone.")}</p>
          </>
        )}
        {settled === null ? (
          <StateHeading headingRef={headingRef}>
            {t("Are you with the people already at this table?")}
          </StateHeading>
        ) : (
          <h3>{t("Are you with the people already at this table?")}</h3>
        )}
        <div className="entry-question">
          <button className="entry-action" type="button" onClick={() => onAnswer?.("Join")}>
            {t("Yes, join them")}
          </button>
          <button
            className="entry-secondary-action"
            type="button"
            onClick={() => onAnswer?.("NewParty")}
          >
            {t("No, we just sat down")}
          </button>
        </div>
      </div>
    );
  }

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
            ? t("This table QR code was replaced")
            : t("This table QR code is no longer in use")}
        </StateHeading>
        <p>
          {state.replaced
            ? t("This table QR code was replaced. Please ask a staff member.")
            : t("This table QR code is no longer in use. Please ask a staff member.")}
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
  return (
    <div>
      <StateHeading headingRef={headingRef}>
        {context.channel === "DineIn"
          ? t("Welcome to {storeDisplayName}", { storeDisplayName: context.storeDisplayName })
          : t("Ready to order")}
      </StateHeading>
      {context.channel === "DineIn" ? null : (
        <p className="entry-context">
          {t("Pickup from {storeDisplayName} is selected.", {
            storeDisplayName: context.storeDisplayName,
          })}
        </p>
      )}
      {/* M104/M105: said by its real reason; never that nothing was ordered. */}
      {context.previousVisit === undefined ? null : (
        <p className="entry-context" role="status">
          {context.previousVisit === "EndedReceiptsKept"
            ? t(
                "Your earlier cart here has ended, so this is a new cart. The store still has the orders you placed; ask the store if you need a receipt.",
              )
            : t("Your earlier cart here has ended, so this is a new cart.")}
        </p>
      )}
      {/* Open now, today's hours and the address are stated once, in the store card below. */}
      {context.resumed === true && !locationOpen && onContinue ? (
        // M104 (Owner 2026-11-05): a visit already under way finishes as usual.
        <>
          <p className="entry-closed" role="status">
            {t("The store isn’t taking new orders right now. Your cart and orders are still here.")}
          </p>
          <button className="entry-action" type="button" onClick={onContinue}>
            {t("Continue")}
          </button>
        </>
      ) : locationOpen ? (
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
            autoJoin={autoJoin}
            starting={starting}
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
