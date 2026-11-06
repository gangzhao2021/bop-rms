// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): pure alert rules, deduplication, rate limiting and
// rendering for the single-store pilot operations monitor. No I/O; dependency-free so the ops
// container (PostgreSQL image + Node binary) can run it.
//
// Privacy: every message is built from this fixed catalog plus typed parameters (integers,
// durations, instants and closed service names). No free text from any source reaches a message,
// so order contact data, tokens, secrets and database contents can never be included.

export const ALERT_STATE_SCHEMA_VERSION = 1;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Plain-language names for the supervisor's closed set of services and workloads. */
const SERVICE_NAMES = Object.freeze({
  api: "Staff and ordering service",
  customer: "Customer ordering pages and staff screens",
  "business-worker": "Order processing",
  "kitchen-queue-worker": "Kitchen board updates",
  "reconciliation-worker": "Payment checks",
  "daily-settlement-worker": "Day-end settlement",
  "dining-exception-worker": "Table service follow-ups",
  "store-workers": "Background work of the other Stores",
  // On a Store's own board: its background work, however the supervisor names it.
  "store-background": "Background work",
});
const COMPONENT_NAMES = Object.freeze({
  events: "order updates",
  paymentWait: "waiting for payment results",
  inventoryRelease: "stock release",
  pickupPaymentExpiry: "unpaid pickup expiry",
  diningCheckoutExpiry: "table checkout expiry",
  tableOnlineRefund: "refunds to guests' cards from table payments",
  guestTableClose: "freeing tables guests started",
  contactRetention: "customer contact deletion",
  webhookEvidenceRetention: "old card payment message deletion",
  pickupCapacitySchedule: "pickup times",
  batchCancellation: "cancellations",
  compensation: "automatic refunds",
  kitchen: "kitchen board",
  reconciliation: "payment checks",
  dailySettlement: "day-end settlement",
  diningException: "table follow-ups",
  workload: "background work",
});
const DISK_NAMES = Object.freeze({
  runtime: "the store data folder",
  backups: "the backup folder",
  database: "the database disk",
  offsite: "the off-site backup folder",
});
const CHANNEL_KINDS = Object.freeze({ email: "Email", webhook: "Phone/webhook" });

export function describeAttention(entry) {
  if (typeof entry !== "string") return "A background task";
  const [service, component] = entry.split(":");
  const name = SERVICE_NAMES[service] ?? "A background task";
  if (component === undefined) return name;
  const part = COMPONENT_NAMES[component];
  return part === undefined ? name : `${name} (${part})`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "a while";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}
const count = (value, one, many) => (value === 1 ? `1 ${one}` : `${value} ${many}`);
const bytes = (value) => {
  const gb = value / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(0, Math.round(value / 1024 ** 2))} MB`;
};
const list = (values) => {
  const items = values.map(describeAttention);
  return items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and more`;
};
/** Store directory names, as many as fit: the Home refuses a board with a longer summary. */
const storeNames = (names) => {
  const shown = [];
  for (const name of names) {
    if ([...shown, name].join(", ").length > 70) break;
    shown.push(name);
  }
  return shown.length === names.length
    ? shown.join(", ")
    : `${shown.join(", ")} and ${names.length - shown.length} more`;
};
const STORE_ATTENTION_PARTS = Object.freeze([
  ["checksFailing", "Some checks could not run"],
  ["background", "Background work needs a person"],
  ["settlementNotRun", "Closed business days whose day-end settlement has not run"],
  ["setupEnding", "Ordering setup ending soon"],
  ["noSupportNumber", "No support number to call"],
]);
/** What BOP does about each cause: only those that apply, so the row never says what is not so. */
const CHECKS_NOT_RUNNING_STEP =
  "run the status check and find out why the checks named here are not running";
const STORE_ATTENTION_STEPS = Object.freeze([
  ["checksFailing", CHECKS_NOT_RUNNING_STEP],
  ["background", "restart the background work named here"],
  ["settlementNotRun", "check the day-end settlement worker of those Stores"],
  [
    "setupEnding",
    "renew those named as ending soon, right after the installation itself (their owners hear only in the last day)",
  ],
  [
    "noSupportNumber",
    "set the support number in the alert settings, so their owners have someone to call",
  ],
]);
const named = (p, field) => (p[field] ?? []).length > 0;

/**
 * WP-2423 item 9: what an order Workflow the resolver refuses stops on the floor. A refusal stops that
 * order type for guests and staff. A binding naming another version than the one that resolves does
 * not stop guests: they still order and pay, and what they paid for is then refused at acceptance and
 * paid release, so telling staff the phones are down would be false (the `Paid...` titles and
 * summaries). A further round is released by its own Workflow, so that one alone reaches only those
 * rounds. What staff do is the same in both, because a refusal also stops `Accept` for an order paid
 * before it began. Staff stay on paper until BOP support says so, never "until this clears": services
 * hold the binding they loaded when they started, so the row can clear before a fix has reached them.
 *
 * A paid pickup order is the one thing that does not wait. Its acceptance deadline asks no Workflow
 * (order-paid-outcome-source), so if nobody can accept it, it is refunded at the deadline. Staff
 * screens are online, so the outage hold does not apply (DEC-OUTAGE-ACCEPTANCE-HOLD decision 1). The
 * text says so; whether the hold should cover this too is an Owner decision, in WP-2423.
 *
 * The board refuses an action over 400 characters or a summary over 600 (merchant-operations-alerts,
 * OperationsAlerts): the whole board, so `pilot-alerts.test.mjs` holds these to the limits.
 */
const PAID_ALREADY = "A guest who paid: no second payment; kitchen slip with order number.";
const UNTIL_FIXED =
  "Call BOP support now; stay on paper until they say it is fixed. Then enter the paper orders; for a slip with an order number, accept that order, mark it ready, do not remake it.";
// A refunded pickup order's slip carries an order number too, but that order cannot be accepted:
// the card-machine payment taken for it is entered as a Counter order (REFUNDED), never skipped.
const UNTIL_FIXED_PICKUP =
  "Call BOP support now; stay on paper until they say it is fixed. Then enter paper orders, refunded ones too; a slip whose order is open: accept it, mark it ready, don't remake it.";
const PAUSE_ALL = `Pause all services in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New orders: paper slip, card machine. ${PAID_ALREADY} ${UNTIL_FIXED_PICKUP}`;
const PAUSE_PICKUP = `Pause pickup in Hours & ordering until closing (can resume early). New pickup orders: paper slip, card machine. ${PAID_ALREADY} An unaccepted order refunds itself. ${UNTIL_FIXED_PICKUP}`;
const PAUSE_DINE_IN = `Pause dine-in in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New rounds: paper slip, card machine. ${PAID_ALREADY} ${UNTIL_FIXED}`;
const REFUNDED =
  "A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.";
const PAUSE_TELLS =
  "A pause tells new guests to order with staff; it does not reach seated tables.";
const PAY_AT_END = "A table that pays at the end still pays at the end.";
const PICKUP_STOPS = {
  title: "Pickup orders cannot go through",
  summary: `Guests cannot order or pay for pickup on their phones, and staff may not be able to enter, accept or finish pickup orders here. A pause tells guests to order with staff. ${REFUNDED}`,
  action: PAUSE_PICKUP,
};
const TABLES_STOP = {
  title: "Table orders cannot go through",
  summary: `Guests at tables cannot order or pay on their phones, and staff may not be able to enter, accept or finish table orders here. ${PAUSE_TELLS} ${PAY_AT_END}`,
  action: PAUSE_DINE_IN,
};
const PICKUP_PAID = {
  title: "Paid pickup orders may not reach the kitchen and may be refunded automatically",
  summary: `Guests can still order pickup and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. ${REFUNDED}`,
  action: PAUSE_PICKUP,
};
const TABLES_PAID = {
  title: "Paid table orders may not reach the kitchen",
  summary: `Guests at tables can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end nobody pays per round: its rounds may not send at all, and it still pays at the end.`,
  action: PAUSE_DINE_IN,
};
/** Tells a Store that offers both order types that the other one carries on. */
const besides = (words, other) => ({ ...words, summary: `${words.summary} ${other}` });
const ORDER_WORKFLOW_WORDS = Object.freeze({
  Orders: {
    title: "New orders cannot go through",
    summary: `Guests cannot order or pay on their phones, and staff may not be able to enter, accept or finish orders here. ${PAUSE_TELLS} ${PAY_AT_END} ${REFUNDED}`,
    action: PAUSE_ALL,
  },
  Pickup: besides(PICKUP_STOPS, "Dine-in is not affected."),
  Tables: besides(TABLES_STOP, "Pickup is not affected."),
  // Some order types stopped and others still taking payment, or all still taking payment.
  PaidOrders: {
    title:
      "Paid orders may not reach the kitchen, and paid pickup orders may be refunded automatically",
    summary: `Some guests can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end, rounds may not send at all. ${REFUNDED}`,
    action: PAUSE_ALL,
  },
  PaidPickup: besides(PICKUP_PAID, "Dine-in is not affected."),
  PaidTables: besides(TABLES_PAID, "Pickup is not affected."),
  // A Store with one order type hears nothing about the type it does not sell.
  PickupStore: PICKUP_STOPS,
  TablesStore: TABLES_STOP,
  PaidPickupStore: PICKUP_PAID,
  PaidTablesStore: TABLES_PAID,
  FurtherRounds: {
    title: "Paid further rounds may not reach the kitchen",
    summary:
      "Guests at a table who pay round by round can still pay for another round on their phones, but that round may not reach the kitchen. First rounds, and tables that pay at the end, are not affected.",
    // A table keeps the timing it opened with, so this is worded by table: no Store setting can say.
    action: `Tables that pay before each round order further rounds with staff: paper slip, card machine. Tables that pay at the end carry on as usual. ${PAID_ALREADY} ${UNTIL_FIXED}`,
  },
  PickupNotOffered: {
    title: "Pickup cannot be turned on yet",
    summary:
      "This store does not offer pickup now, so guests and staff are not affected. If pickup were turned on, pickup orders would not go through.",
    action:
      "Nothing to do in the store today. Ask BOP support to fix this before you turn pickup on.",
  },
  TablesNotOffered: {
    title: "Dine-in cannot be turned on yet",
    summary:
      "This store does not offer dine-in now, so guests and staff are not affected. If dine-in were turned on, table orders would not go through.",
    action:
      "Nothing to do in the store today. Ask BOP support to fix this before you turn dine-in on.",
  },
});
const ORDER_WORKFLOW_NOT_OFFERED = Object.freeze(["PickupNotOffered", "TablesNotOffered"]);
const VERSION_MISMATCH = "ExpectedVersionChanged";

/** What the refused order bindings stop, among the order types this Store offers; null if nothing. */
function orderWorkflowState({ refusals, orderTypes }) {
  const offersPickup = orderTypes.includes("Pickup"),
    offersTables = orderTypes.includes("DineIn");
  const refused = (binding, offered) =>
    (offered && refusals.find((refusal) => refusal.binding === binding)) || null;
  const pickup = refused("Pickup", offersPickup),
    tables = refused("DineIn", offersTables),
    rounds = refused("AdditionalRelease", offersTables);
  if (pickup !== null || tables !== null) {
    const paying = (refusal) => refusal.rule === VERSION_MISMATCH;
    // Someone can still pay for what then does not reach the kitchen. A further round is stopped
    // with the first (it is submitted and paid the same way), and paid for while the first goes on.
    const stillPaying =
      (pickup !== null && paying(pickup)) || (tables !== null ? paying(tables) : rounds !== null);
    const paid = stillPaying ? "Paid" : "";
    if (!offersPickup || !offersTables) return `${paid}${offersPickup ? "Pickup" : "Tables"}Store`;
    if (pickup === null) return `${paid}Tables`;
    if (tables === null && rounds === null) return `${paid}Pickup`;
    return stillPaying ? "PaidOrders" : "Orders";
  }
  if (rounds !== null) return "FurtherRounds";
  if (refusals.some(({ binding }) => binding === "Pickup")) return "PickupNotOffered";
  return refusals.some(({ binding }) => binding !== "Pickup" && !offersTables)
    ? "TablesNotOffered"
    : null;
}
/** Which binding refused and by which rule, in fixed words, for BOP's log only. */
const refusedWords = (refusals) =>
  refusals
    .map(
      ({ binding, rule }) =>
        `${binding}:${/^[A-Za-z]{1,40}$/u.test(rule ?? "") ? rule : "Refused"}`,
    )
    .join(" ");

/**
 * The closed alert catalog. `severity` may be overridden per condition (escalation). Each entry
 * renders a title, a plain summary and what staff or the Owner should do; `runbook` names the
 * runbook anchor in docs/runbooks/single-store-pilot.md ("What each alert means"). The text is read
 * by restaurant owners, in plain words ("BOP support" runs the system). The merchant app holds its
 * Chinese by this exact English (apps/merchant-web/src/operations-alert-words.ts): change both.
 */
export const ALERT_CATALOG = Object.freeze({
  "entry.api": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Store system is not responding",
    summary: (p) =>
      `The ordering service has failed its health check for ${formatDuration(p.downMs)}. Staff screens and online ordering are probably not working.`,
    action: () =>
      "Follow the store outage procedure (pause online ordering, take paper orders). Ask BOP support to check the store system and restart it.",
    merchantAction: () =>
      "Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to check the store system.",
    runbook: "alert-store-system-down",
  },
  "entry.customer": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Customer ordering page is not loading",
    summary: (p) =>
      `The secure customer ordering page has not loaded for ${formatDuration(p.downMs)}. Guests cannot scan, order or pay online.`,
    action: () =>
      "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask BOP support to restart the store system.",
    merchantAction: () =>
      "Pause online ordering if staff screens still work. Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to restart the store system.",
    runbook: "alert-customer-entry-down",
  },
  "entry.merchant": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Staff screens are not loading",
    summary: (p) =>
      `The staff app (Orders, Kitchen, Pickup) has not loaded for ${formatDuration(p.downMs)}.`,
    action: () =>
      "Follow the store outage procedure. Ask BOP support to check the store system and restart it.",
    merchantAction: () =>
      "Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to check the store system.",
    runbook: "alert-merchant-entry-down",
  },
  "supervisor.silent": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Background services are not being watched",
    summary: (p) =>
      p.reportAgeMs === null
        ? "The part of the system that watches background work has not reported since the checks started. Background work (kitchen updates, payment checks, refunds) may have stopped."
        : `The part of the system that watches background work last reported ${formatDuration(p.reportAgeMs)} ago. Background work (kitchen updates, payment checks, refunds) may have stopped.`,
    action: () => "Ask BOP support to check the store system and restart it.",
    runbook: "alert-supervisor-silent",
  },
  "service.attention": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "A background service needs a person",
    summary: (p) =>
      `${list(p.services)} ${p.services.length === 1 ? "has" : "have"} kept failing and will not fix ${p.services.length === 1 ? "itself" : "themselves"}.`,
    action: () =>
      "Ask BOP support to find out what failed and restart the part named in this alert. Check Orders and Exceptions for work that may be waiting.",
    merchantAction: () =>
      "Some background work has stopped. Check Orders and Exceptions for waiting work; BOP support has to restart it.",
    runbook: "alert-service-attention",
  },
  // On a Store's board when only its clean-up chores keep failing. BOP's alone: the merchant can do
  // nothing about it and no order, guest or payment is affected, so it is not on their Home.
  "service.chores": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "A clean-up task keeps failing",
    summary: (p) =>
      `${list(p.services)} ${p.services.length === 1 ? "has" : "have"} kept failing and will not fix ${p.services.length === 1 ? "itself" : "themselves"}.`,
    action: () =>
      "BOP support: find out why the named task failed and restart it today. Orders, guests and payments are not affected, but customer contacts or old card payment messages are kept past their deletion date until it runs.",
    runbook: "alert-service-chores",
  },
  "payment.updates": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "Order or payment updates are stuck",
    summary: (p) =>
      `${count(p.count, "update", "updates")} (such as a payment result or an order change) could not be processed after automatic retries (oldest ${formatDuration(p.oldestAgeMs)} ago). Paid orders may look unpaid, not reach the kitchen, or not show as ready for pickup after the kitchen finished them.`,
    action: () =>
      "Do not take a second payment from guests who say they paid. Check Orders and Exceptions; ask BOP support to review the stuck updates and send them again.",
    runbook: "alert-payment-updates",
  },
  // WP-2423 (2026-10-16): early warning while events are still being retried, before any dead
  // letter (a dead letter only follows about 36-71 minutes of failures). Urgent after 30 minutes.
  "updates.retrying": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Some order updates are being retried",
    summary: (p) =>
      `${count(p.count, "order update is", "order updates are")} being retried (failing for ${formatDuration(p.oldestAgeMs)}). Ready orders may not show for pickup yet, and kitchen or payment changes may be late.`,
    action: () =>
      'Hand over ready orders in person: check the order number plus the guest\'s name or phone number. Compare the kitchen board with Orders. Ask BOP support to look into this now; if it is not fixed, this becomes "Order or payment updates are stuck".',
    runbook: "alert-updates-retrying",
  },
  // WP-2423 (2026-10-16 v15 stock leak): an Order of an earlier business day still holds stock,
  // so items made from it show sold out to guests although the stock is on the shelf.
  "orders.held_stock": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Orders from earlier days are still holding stock",
    summary: (p) =>
      `${count(p.count, "order from an earlier day still has", "orders from earlier days still have")} ingredients set aside (the oldest for ${formatDuration(p.oldestAgeMs)}). Items made from them can show as sold out to guests although the stock is on the shelf.`,
    action: () =>
      'Open Orders: these orders are listed first with today\'s. Make and hand over one the guest still wants, or cancel it (the guest is refunded and the ingredients go back into stock). For an order that is already finished, choose "Release held ingredients".',
    runbook: "alert-orders-held-stock",
  },
  // WP-2423 DEC-PICKUP-CAPACITY-SCHEDULE: pickup capacity is set up less than a day ahead (the
  // schedule is not being extended); with none left no pickup order can be taken, online or at the
  // counter, so staff take pickup orders on paper until it is fixed.
  "pickup.capacity_horizon": {
    severity: "warning",
    raiseAfterMs: 0,
    title: (p) =>
      p.coveredMs <= 0 ? "Pickup orders cannot be taken" : "Pickup times are running out",
    summary: (p) =>
      p.coveredMs <= 0
        ? "No pickup times are set up for now, so guests cannot place pickup orders online and staff cannot take them at the counter. Dine-in is not affected."
        : `Pickup times are set up only for the next ${formatDuration(p.coveredMs)}. After that, guests cannot place pickup orders online and staff cannot take them at the counter.`,
    action: (p) =>
      p.coveredMs <= 0
        ? "Take pickup orders on paper (order sheet, items, name, time) and take payment on the card machine, then enter them once this clears. Ask BOP support to check the pickup times now."
        : "Nothing changes for guests yet. Ask BOP support to check the pickup times today; if it reaches the last hour, take pickup orders on paper.",
    runbook: "alert-pickup-capacity-horizon",
  },
  // WP-2423 DEC-STORE-SETUP-PUBLICATION: the receipt template the Store's published settings
  // name cannot be used (receipts are money documents: none is issued with a guessed template).
  "receipts.template": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Receipts are not being issued",
    summary: (p) =>
      p.reason === "StoreConfigurationUnavailable"
        ? "The Store's published settings could not be read, so guests who pay now do not get a receipt yet."
        : "The receipt template chosen in Store setup cannot be used, so guests who pay now do not get a receipt. Orders, payments and the kitchen are not affected.",
    action: () =>
      "Tell guests who ask that their receipt will appear on their order page once this is fixed. Owner: in Store setup choose a receipt template that is published (step 5), then send, approve and publish the setup (step 8). Receipts for orders paid meanwhile then follow automatically; if this lasted over 30 minutes, ask BOP support to send stuck updates again.",
    runbook: "alert-receipts-template",
  },
  // WP-2423 DEC-STORE-SETUP-PUBLICATION: quotes take the tax configuration the Store's published
  // settings name; during the internal test it must be the one the test files carry evidence for,
  // otherwise no order can be priced (money: never priced with a guessed tax configuration).
  "pricing.tax_configuration": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Orders cannot be priced",
    summary: (p) =>
      p.reason === "StoreConfigurationUnavailable"
        ? "The Store's published settings could not be read, so no new order can be priced, online or at the counter. Orders already paid are not affected."
        : "The tax settings published in Store setup are not the ones this store is set up to charge, so no new order can be priced, online or at the counter. Orders already paid are not affected.",
    action: () =>
      'Take new orders on paper (items, name, table or pickup time) and take payment on the card machine, then enter them once this clears. Owner: Store setup step 8, choose "Use the live Store\'s settings" for tax, then send, approve and publish. Otherwise ask BOP support.',
    runbook: "alert-pricing-tax-configuration",
  },
  // WP-2423 item 9: an order Workflow the resolver refuses, in the words of what it stops. Worded by
  // ORDER_WORKFLOW_WORDS; a row that has cleared has no state and keeps the general title.
  "orders.workflow": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: (p) => ORDER_WORKFLOW_WORDS[p.state]?.title ?? "The store's order rules cannot be used",
    summary: (p) => (ORDER_WORKFLOW_WORDS[p.state] ?? ORDER_WORKFLOW_WORDS.Orders).summary,
    action: (p) => (ORDER_WORKFLOW_WORDS[p.state] ?? ORDER_WORKFLOW_WORDS.Orders).action,
    // The row can clear before the fix reaches the running services (they hold the binding they
    // loaded at start), so a row that sent staff to paper never clears as all clear. One that only
    // said an order type cannot be turned on yet (nothing to do in the store) clears as resolved.
    clearedTitle: (p) =>
      ORDER_WORKFLOW_NOT_OFFERED.includes(p.state)
        ? null
        : "Order rules check passes again: stay on paper until BOP support says it is fixed",
    runbook: "alert-orders-workflow",
  },
  // WP-2423 item 9: the cancellation Workflow refused. A manager's cancel and "Guests left" pass the
  // same Workflow as the automatic cancellation, so staff have no way round it on these screens,
  // and their retry answers as if the connection had dropped.
  "orders.unpaid_rounds": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Unpaid rounds are not being cancelled",
    // A round at a table that pays at the end goes to the kitchen unpaid and is never this round.
    summary: () =>
      "At tables that pay before each round, unpaid rounds are not cancelled automatically and a manager cannot cancel them. They stay open and keep their ingredients set aside, so dishes can show as sold out to other guests, and the table cannot be closed for the next party. At a table that pays at the end, only a round waiting for staff is affected: it can be sent to the kitchen but not cancelled.",
    action: () =>
      "Tables that pay before each round: one with an unpaid round cannot be closed and that round cannot be cancelled here, so trying again will not help. Seat the next party at another table and note those tables. Tables that pay at the end carry on and close once they pay. Call BOP support now: they have to fix this. Close the noted tables once they say it is fixed.",
    clearedTitle: () =>
      "Unpaid rounds check passes again: keep the noted tables until BOP support says it is fixed",
    runbook: "alert-orders-unpaid-rounds",
  },
  "reconciliation.differences": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Payment differences need checking",
    // An open reconciliation difference is either one payment or a whole business day's totals.
    summary: (p) =>
      `${count(p.count, "difference", "differences")} between the store's records and the payment provider ${p.count === 1 ? "is" : "are"} still open (oldest ${formatDuration(p.oldestAgeMs)} ago). A difference can be one payment or a business day's totals.`,
    action: () =>
      "Open Exceptions to see each difference. For a business day's totals, open Settlement and choose that day; it explains the difference and what to do.",
    runbook: "alert-reconciliation-differences",
  },
  "settlement.exceptions": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Day-end settlement has open problems",
    summary: (p) =>
      `${count(p.count, "settlement problem is", "settlement problems are")} still open (oldest ${formatDuration(p.oldestAgeMs)} ago).`,
    action: () => "Open Settlement, review the listed business day and resolve each item.",
    runbook: "alert-settlement-exceptions",
  },
  // WP-2423 (settlement-coverage): a closed business day with no day-end settlement run 6 h after it
  // ended. The merchant has nothing to change (payments are taken as usual) and BOP fixes the worker;
  // the backlog then settles every missed day by itself. Shown to the merchant and to BOP.
  "settlement.not_run": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Day-end check with the payment provider has not run",
    summary: (p) =>
      p.count === 1
        ? `1 closed business day has not been compared with the payment provider (closed ${formatDuration(p.oldestAgeMs)} ago).`
        : `${p.count} closed business days have not been compared with the payment provider (the oldest closed ${formatDuration(p.oldestAgeMs)} ago).`,
    action: () =>
      "Nothing to change in the store: online payments are taken as usual. The check runs by itself once it is fixed; BOP support can see this.",
    clearedTitle: () => "Day-end check with the payment provider has run again",
    runbook: "alert-settlement-not-run",
  },
  // DEC-PILOT-ALERTS-BACKUP correction 2 (retired by WP-2423 settlement-coverage): no longer raised,
  // every Store is covered from its own first business day. Kept so a state written before the
  // change still renders its clearing.
  "settlement.not_covered": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Day-end settlement is not set up for this Store",
    summary: () =>
      "This Store has a closed business day but no day-end settlement, so its payments are not being compared with the payment provider.",
    action: () =>
      "BOP support: record this Store's first closed business day so its day-end settlement starts.",
    runbook: "alert-settlement-not-run",
  },
  // A Store nobody is checking is urgent: its money checks are not running, and it is the one thing
  // no Store can say for itself. So it has a key of its own, and BOP hears each time it starts and
  // ends, whatever else the row below has been saying for days.
  "stores.unchecked": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "Some Stores are not being checked",
    summary: (p) => `Not being checked: ${storeNames(p.stores ?? [])}.`,
    action: () => `BOP support: ${CHECKS_NOT_RUNNING_STEP}.`,
    runbook: "alert-stores-unchecked",
  },
  // On the root board only: each Store has said its own part on a line of its own.
  "stores.attention": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Some Stores need BOP support",
    summary: (p) => {
      const sentences = STORE_ATTENTION_PARTS.filter(([field]) => named(p, field)).map(
        ([field, label]) => `${label}: ${storeNames(p[field])}.`,
      );
      // The Home refuses a whole board with a longer summary; what matters most comes first.
      while (sentences.join(" ").length > 600) sentences.pop();
      return sentences.join(" ") || "A Store needs checking.";
    },
    action: (p) => {
      const steps = STORE_ATTENTION_STEPS.filter(([field]) => named(p, field)).map(
        ([, step]) => step,
      );
      return `BOP support: ${(steps.length === 0 ? ["run the status check"] : steps).join("; ")}.`;
    },
    runbook: "alert-stores-attention",
  },
  "backup.failed": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "Last night's backup failed",
    summary: (p) =>
      `The scheduled backup failed at the ${p.stage} step. ${p.attemptsLeft > 0 ? `It will retry automatically (${count(p.attemptsLeft, "try", "tries")} left today).` : "No more automatic tries today."}`,
    action: () =>
      "Ask BOP support to run the backup by hand and check free disk space. Store operation is not affected.",
    runbook: "alert-backup-failed",
  },
  "backup.stale": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "No recent backup",
    summary: (p) =>
      p.ageMs === null
        ? "No successful backup has been recorded for this store yet."
        : `The newest successful backup is ${formatDuration(p.ageMs)} old. If the server failed now, recent orders and payments could be lost.`,
    action: () =>
      "Ask BOP support to run a backup now and check that the scheduled backup is running.",
    runbook: "alert-backup-stale",
  },
  "backup.restore_check": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "The newest backup could not be restored",
    summary: () =>
      "The automatic restore check of the newest backup failed, so it may not be usable.",
    action: () =>
      "Ask BOP support to take a new backup and test that it can be restored. Keep the previous backups.",
    runbook: "alert-backup-restore-check",
  },
  "backup.offsite": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Off-site backup copy failed",
    summary: () =>
      "The encrypted copy of the newest backup could not be written to the off-site location. The local backup is fine.",
    action: () =>
      "Ask BOP support to check the off-site folder or drive is connected and has space.",
    runbook: "alert-backup-offsite",
  },
  "certificate.expiring": {
    severity: "warning",
    raiseAfterMs: 0,
    title: (p) =>
      p.remainingMs <= 0
        ? "Secure connection certificate has expired"
        : "Secure connection certificate expires soon",
    summary: (p) =>
      p.remainingMs <= 0
        ? "Guests and staff devices will refuse to open the store pages."
        : `It expires in ${formatDuration(p.remainingMs)}. After that, guests and staff devices will refuse to open the store pages.`,
    action: () =>
      "Ask BOP support to renew the secure connection certificate and set up the new one on staff devices.",
    runbook: "alert-certificate-expiring",
  },
  // DEC-PILOT-INSTALLATION: the installation's validity window (internal-test-profile.json
  // binding.validUntil). When it ends guests can no longer order and staff lose access, so the
  // Owner hears about it two weeks ahead; renewal needs the Owner's approval.
  "installation.validity": {
    severity: "warning",
    raiseAfterMs: 0,
    title: (p) =>
      p.remainingMs <= 0
        ? "The store's ordering setup has expired"
        : "The store's ordering setup expires soon",
    summary: (p) =>
      p.remainingMs <= 0
        ? "Guests cannot order and staff cannot use the store screens until it is renewed."
        : `It expires in ${formatDuration(p.remainingMs)}. After that, guests cannot order and staff cannot use the store screens.`,
    action: () =>
      "Approve a new end date and ask BOP support to renew it during a planned update before it expires.",
    runbook: "alert-installation-validity",
  },
  // AGENTS.md "Warn before timeouts": renewing is BOP's, and for two weeks only BOP hears of it
  // (installation.validity, certificate.expiring). With a day left BOP has evidently not renewed,
  // and the people who will otherwise learn it from guests are told what is coming on their Home.
  "ordering.ending": {
    severity: "critical",
    raiseAfterMs: 0,
    title: (p) =>
      p.remainingMs <= 0
        ? "Ordering at this Store has stopped"
        : "Ordering at this Store is about to stop",
    summary: (p) =>
      p.remainingMs <= 0
        ? "Guests cannot order and staff cannot use the store screens until BOP support renews it."
        : "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.",
    action: (p) =>
      p.remainingMs <= 0
        ? "Call BOP support now. Keep taking orders on your own POS or on paper, and take payment on the card machine."
        : `Ordering at this Store stops in ${formatDuration(p.remainingMs)} unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.`,
    runbook: "alert-ordering-ending",
  },
  "disk.low": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Disk space is running low",
    summary: (p) =>
      `${p.disks.map((d) => `${DISK_NAMES[d.name]} has ${bytes(d.freeBytes)} free (${d.freePercent}%)`).join("; ")}. When it fills, orders and backups stop.`,
    action: () =>
      "Ask BOP support to free space (old system files, old backup copies) or add storage.",
    runbook: "alert-disk-low",
  },
  "monitor.source": {
    severity: "warning",
    raiseAfterMs: 5 * MINUTE,
    title: () => "Some checks could not run",
    summary: (p) =>
      `The system could not read ${p.sources.join(", ")}. Problems there would not be reported.`,
    action: () => "Ask BOP support to find out why these checks could not run.",
    runbook: "alert-monitor-source",
  },
  "channel.delivery": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Alert messages are not being delivered",
    summary: (p) =>
      `${p.channels.map((c) => CHANNEL_KINDS[c] ?? "An alert channel").join(" and ")} alerts have failed for ${formatDuration(p.failingMs)}. The Owner may not be told about problems.`,
    action: () =>
      "Check the alert account details and send a test alert. Watch this Home screen meanwhile.",
    runbook: "alert-channel-delivery",
  },
});
export const ALERT_KEYS = Object.freeze(Object.keys(ALERT_CATALOG));
const SOURCE_NAMES = Object.freeze({
  supervisor: "the service status",
  business: "payment and settlement status",
  backup: "the backup status",
  certificate: "the certificate",
  installation: "the store setup end date",
  disk: "disk space",
  receipts: "the receipt template check",
  heldStock: "the check for orders holding stock",
  pickupCapacity: "the check for pickup times",
  quoteTax: "the check that orders can be priced",
  workflow: "the check of the store's order rules",
  reconciliation: "the check for payment differences",
  settlement: "the day-end settlement check",
});

const PROBE_KEYS = Object.freeze({
  api: "entry.api",
  customer: "entry.customer",
  merchant: "entry.merchant",
});
export const DEFAULT_THRESHOLDS = Object.freeze({
  supervisorSilentMs: 2 * MINUTE,
  backupStaleMs: 26 * HOUR,
  certificateWarnMs: 7 * 24 * HOUR,
  certificateCriticalMs: 2 * 24 * HOUR,
  installationWarnMs: 14 * 24 * HOUR,
  installationCriticalMs: 3 * 24 * HOUR,
  orderingEndingWarnMs: 24 * HOUR,
  diskWarnPercent: 15,
  diskWarnBytes: 5 * 1024 ** 3,
  diskCriticalPercent: 5,
  diskCriticalBytes: 1024 ** 3,
  channelFailingMs: 30 * MINUTE,
  retryingCriticalMs: 30 * MINUTE,
  pickupHorizonWarnMs: 24 * HOUR,
  pickupHorizonCriticalMs: HOUR,
});
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

const raiserFor =
  (conditions) =>
  (key, params = {}, severity) =>
    conditions.set(key, { severity: severity ?? ALERT_CATALOG[key].severity, params });

function evaluateProbes(probes, raise) {
  for (const [name, key] of Object.entries(PROBE_KEYS)) {
    const probe = probes?.[name];
    if (probe && probe.ok === false) raise(key, { downMs: Math.max(0, probe.failingForMs ?? 0) });
  }
}

/**
 * What one Store's business signals say. On a Store's own board (`configurationUnreadable`) "the
 * published settings could not be read" is a check that could not run, not a statement that guests
 * get no receipt or that orders cannot be priced: a menu listing at any merchant can hold that read
 * for a moment. BOP hears through "Some checks could not run".
 */
export function evaluateBusinessConditions(
  business,
  { raise, unreadable, thresholds = DEFAULT_THRESHOLDS, configurationUnreadable = false },
) {
  if (business === undefined || business === "unreadable") {
    unreadable.push("business");
    return;
  }
  const pick = (value) => natural(value?.count) && value.count > 0;
  const unavailable = (value) =>
    configurationUnreadable && value?.reason === "StoreConfigurationUnavailable";
  if (pick(business.stuckUpdates))
    raise("payment.updates", {
      count: business.stuckUpdates.count,
      oldestAgeMs: business.stuckUpdates.oldestAgeMs,
    });
  if (pick(business.retryingUpdates))
    raise(
      "updates.retrying",
      {
        count: business.retryingUpdates.count,
        oldestAgeMs: business.retryingUpdates.oldestAgeMs,
      },
      business.retryingUpdates.oldestAgeMs > thresholds.retryingCriticalMs ? "critical" : "warning",
    );
  // Absent (null) when not checked; "unreadable" when the check itself failed.
  if (business.receiptTemplate === "unreadable" || unavailable(business.receiptTemplate))
    unreadable.push("receipts");
  else if (business.receiptTemplate?.ready === false)
    raise("receipts.template", {
      reason:
        business.receiptTemplate.reason === "StoreConfigurationUnavailable"
          ? "StoreConfigurationUnavailable"
          : "TemplateNotProven",
    });
  if (business.quoteTax === "unreadable" || unavailable(business.quoteTax))
    unreadable.push("quoteTax");
  else if (business.quoteTax?.ready === false)
    raise("pricing.tax_configuration", {
      reason:
        business.quoteTax.reason === "StoreConfigurationUnavailable"
          ? "StoreConfigurationUnavailable"
          : "TaxConfigurationMismatch",
    });
  if (business.workflow === "unreadable") unreadable.push("workflow");
  else if (business.workflow?.ready === false) {
    const { refusals, orderTypes } = business.workflow;
    const state = orderWorkflowState({ refusals, orderTypes });
    if (state !== null)
      raise(
        "orders.workflow",
        {
          state,
          refused: refusedWords(refusals.filter(({ binding }) => binding !== "Cancellation")),
        },
        ORDER_WORKFLOW_NOT_OFFERED.includes(state) ? "warning" : "critical",
      );
    const unpaid = refusals.filter(({ binding }) => binding === "Cancellation");
    if (unpaid.length > 0 && orderTypes.includes("DineIn"))
      raise("orders.unpaid_rounds", { refused: refusedWords(unpaid) });
  }
  if (business.heldStock === "unreadable") unreadable.push("heldStock");
  else if (pick(business.heldStock))
    raise("orders.held_stock", {
      count: business.heldStock.count,
      oldestAgeMs: business.heldStock.oldestAgeMs,
    });
  // null when not composed; "unreadable" when the check itself failed.
  if (business.pickupCapacity === "unreadable") unreadable.push("pickupCapacity");
  else if (
    Number.isSafeInteger(business.pickupCapacity?.coveredMs) &&
    business.pickupCapacity.coveredMs < thresholds.pickupHorizonWarnMs
  )
    raise(
      "pickup.capacity_horizon",
      { coveredMs: Math.max(0, business.pickupCapacity.coveredMs) },
      business.pickupCapacity.coveredMs < thresholds.pickupHorizonCriticalMs
        ? "critical"
        : "warning",
    );
  // "unreadable" only on a Store's board, where one part failing leaves the rest of the read standing.
  if (business.reconciliationDifferences === "unreadable") unreadable.push("reconciliation");
  else if (pick(business.reconciliationDifferences))
    raise(
      "reconciliation.differences",
      {
        count: business.reconciliationDifferences.count,
        oldestAgeMs: business.reconciliationDifferences.oldestAgeMs,
      },
      business.reconciliationDifferences.oldestAgeMs > 24 * HOUR ? "critical" : "warning",
    );
  if (business.settlementExceptions === "unreadable" || business.settlementNotRun === "unreadable")
    unreadable.push("settlement");
  else {
    if (pick(business.settlementExceptions))
      raise("settlement.exceptions", {
        count: business.settlementExceptions.count,
        oldestAgeMs: business.settlementExceptions.oldestAgeMs,
      });
    if (pick(business.settlementNotRun))
      raise("settlement.not_run", {
        count: business.settlementNotRun.count,
        oldestAgeMs: business.settlementNotRun.oldestAgeMs,
      });
  }
}

function evaluateInstallationValidity(installation, now, { raise, unreadable, thresholds }) {
  // Absent (undefined) for monitors without an installation observation (older callers).
  if (installation === "unreadable") unreadable.push("installation");
  else if (installation !== undefined && installation !== null) {
    const remaining = Date.parse(installation.validUntil) - now;
    if (!Number.isFinite(remaining)) unreadable.push("installation");
    else if (remaining <= thresholds.installationWarnMs)
      raise(
        "installation.validity",
        { remainingMs: remaining },
        remaining <= thresholds.installationCriticalMs ? "critical" : "warning",
      );
  }
}

/**
 * Turns one cycle's observations into the set of currently true conditions (key → {severity,
 * params}). Missing observation groups are reported as unreadable sources, never as healthy.
 */
export function evaluateAlertConditions(observations, thresholds = DEFAULT_THRESHOLDS) {
  const now = observations.now;
  const conditions = new Map();
  const unreadable = [];
  const raise = raiserFor(conditions);

  evaluateProbes(observations.probes, raise);
  const supervisor = observations.supervisor;
  if (supervisor === undefined || supervisor === "unreadable") unreadable.push("supervisor");
  else if (supervisor === null || supervisor.reportAgeMs > thresholds.supervisorSilentMs)
    raise("supervisor.silent", { reportAgeMs: supervisor?.reportAgeMs ?? null });
  else {
    // DEC-PILOT-ALERTS-BACKUP correction 2: a Store's own work is on its own board, and BOP hears it
    // once from there, by name. Saying it here too, nameless, would also spend the messages kept for
    // the installation's own alerts. The process the Stores share stays (`store-workers`).
    const own =
      observations.stores === undefined
        ? supervisor.attention
        : supervisor.attention.filter((entry) => !String(entry).startsWith("stores/"));
    if (own.length > 0) raise("service.attention", { services: [...own].sort() });
  }

  evaluateBusinessConditions(observations.business, { raise, unreadable, thresholds });

  const backup = observations.backup;
  if (backup === undefined || backup === "unreadable") unreadable.push("backup");
  else {
    const lastSuccess = backup?.lastSuccessAt ? Date.parse(backup.lastSuccessAt) : null;
    const age = lastSuccess === null ? null : now - lastSuccess;
    if (age === null || age > thresholds.backupStaleMs) raise("backup.stale", { ageMs: age });
    if (backup?.lastAttempt?.result === "Failed")
      raise("backup.failed", {
        stage: ["dump", "restore check", "off-site copy", "retention"].includes(
          backup.lastAttempt.stage,
        )
          ? backup.lastAttempt.stage
          : "backup",
        attemptsLeft: natural(backup.lastAttempt.attemptsLeft)
          ? backup.lastAttempt.attemptsLeft
          : 0,
      });
    if (backup?.restoreCheck?.result === "Failed") raise("backup.restore_check");
    if (backup?.offsite?.result === "Failed") raise("backup.offsite");
  }

  const certificate = observations.certificate;
  if (certificate === undefined || certificate === "unreadable") unreadable.push("certificate");
  else if (certificate !== null) {
    const remaining = Date.parse(certificate.validTo) - now;
    if (remaining <= thresholds.certificateWarnMs)
      raise(
        "certificate.expiring",
        { remainingMs: remaining },
        remaining <= thresholds.certificateCriticalMs ? "critical" : "warning",
      );
  }

  evaluateInstallationValidity(observations.installation, now, { raise, unreadable, thresholds });

  const disks = observations.disks;
  if (disks === undefined || disks === "unreadable") unreadable.push("disk");
  else {
    const low = [];
    let critical = false;
    for (const disk of disks) {
      if (!DISK_NAMES[disk.name] || !(disk.totalBytes > 0)) continue;
      const percent = Math.floor((disk.freeBytes / disk.totalBytes) * 100);
      if (disk.freeBytes < thresholds.diskWarnBytes || percent < thresholds.diskWarnPercent) {
        low.push({ name: disk.name, freeBytes: disk.freeBytes, freePercent: percent });
        if (
          disk.freeBytes < thresholds.diskCriticalBytes ||
          percent < thresholds.diskCriticalPercent
        )
          critical = true;
      }
    }
    if (low.length > 0) raise("disk.low", { disks: low }, critical ? "critical" : "warning");
  }

  const failing = (observations.channels ?? []).filter(
    (channel) =>
      channel.failingSince !== null &&
      now - Date.parse(channel.failingSince) >= thresholds.channelFailingMs,
  );
  if (failing.length > 0)
    raise("channel.delivery", {
      channels: [...new Set(failing.map((channel) => channel.kind))].sort(),
      failingMs: Math.max(...failing.map((channel) => now - Date.parse(channel.failingSince))),
    });
  // DEC-PILOT-ALERTS-BACKUP correction 2: the other Stores' problems only BOP can act on, on the
  // one board BOP reads.
  const stores = observations.stores;
  if ((stores?.unchecked ?? []).length > 0) raise("stores.unchecked", { stores: stores.unchecked });
  if (stores !== undefined && STORE_ATTENTION_PARTS.some(([field]) => named(stores, field)))
    raise(
      "stores.attention",
      Object.fromEntries(STORE_ATTENTION_PARTS.map(([field]) => [field, stores[field] ?? []])),
    );
  evaluateOrderingEnding(observations, raise, thresholds);
  if (unreadable.length > 0)
    raise("monitor.source", { sources: unreadable.map((name) => SOURCE_NAMES[name]) });
  return conditions;
}

/**
 * Rows whose check did not run this cycle. Absent from the conditions, they are neither raised nor
 * cleared: a database read that times out must not read as "the check passes again" (item 9).
 */
export function uncheckedAlertKeys(observations) {
  const business = observations.business;
  return business === undefined || business === "unreadable" || business.workflow === "unreadable"
    ? ["orders.workflow", "orders.unpaid_rounds"]
    : [];
}

/** A raised alert stays while the read behind it cannot run: no read is not an all-clear. */
const HELD_WHILE_UNREADABLE = Object.freeze({
  supervisor: ["service.attention", "service.chores"],
  business: [
    "payment.updates",
    "updates.retrying",
    "receipts.template",
    "pricing.tax_configuration",
    "orders.workflow",
    "orders.unpaid_rounds",
    "orders.held_stock",
    "pickup.capacity_horizon",
    "reconciliation.differences",
    "settlement.exceptions",
    "settlement.not_run",
  ],
  receipts: ["receipts.template"],
  quoteTax: ["pricing.tax_configuration"],
  workflow: ["orders.workflow", "orders.unpaid_rounds"],
  heldStock: ["orders.held_stock"],
  pickupCapacity: ["pickup.capacity_horizon"],
  reconciliation: ["reconciliation.differences"],
  settlement: ["settlement.exceptions", "settlement.not_run"],
});

/** The name a Store's own background work goes by on its board. */
const STORE_BACKGROUND = "store-background";
/**
 * This Store's part of the supervisor's report: `stores/<name>:<service>[:<workload>]`, the whole
 * Store (`stores/<name>`: refused for connections, or the shared process it runs in needs a
 * person), and the process it shares with the other Stores (`store-workers`). When only the shared
 * process is at fault, `sharedHost` says so: the root board has already told BOP.
 */
function storeAttention(attention, store) {
  const own = `stores/${store}`;
  const services = new Set();
  let shared = false,
    whole = false;
  for (const entry of attention) {
    if (entry === "store-workers") shared = true;
    else if (entry === own) whole = true;
    else if (typeof entry === "string" && entry.startsWith(`${own}:`))
      services.add(entry.slice(own.length + 1));
  }
  const sharedHost = shared && services.size === 0;
  if (shared || whole) services.add(STORE_BACKGROUND);
  return services.size === 0 ? null : { services: [...services].sort(), sharedHost };
}
/**
 * Clean-up chores no guest, cook or server notices while they fail, and the owner cannot fix. When
 * they are all that fails they are "service.chores": BOP hears them by name and the root names the
 * Store, but they are not on the restaurant's Home, where an owner who searched Orders for nothing
 * and called BOP at lunch would learn to ignore the next background row.
 */
const STORE_CHORES = new Set(["contactRetention", "webhookEvidenceRetention"]);
const onlyChores = (services) =>
  services.every((service) => STORE_CHORES.has(String(service).split(":")[1]));

/**
 * The last day before ordering at this Store would stop: its own validity or the installation's
 * certificate, whichever ends first. One row: its readers care that it stops, not which. A read
 * that could not run leaves what it last said, counting down: no read is not an all-clear.
 */
function evaluateOrderingEnding(observations, raise, thresholds) {
  const { installation, certificate, now, previous } = observations;
  const ends = [installation?.validUntil, certificate?.validTo];
  if (installation === "unreadable" || certificate === "unreadable")
    ends.push(previous?.alerts?.["ordering.ending"]?.params?.endsAt);
  const soonest = Math.min(...ends.map((at) => Date.parse(at)).filter(Number.isFinite));
  if (soonest - now <= thresholds.orderingEndingWarnMs)
    raise("ordering.ending", {
      endsAt: new Date(soonest).toISOString(),
      remainingMs: soonest - now,
    });
}

/**
 * One Store's conditions on its own board: the outages that stop its guests or staff (the entry
 * probes are the installation's), its own background work, its own business signals and its own
 * validity. `previous` is its alert state, so an alert already raised is not cleared by a read that
 * could not run. Backups, certificate, disks and channels stay on the root board; the certificate
 * reaches a Store only in its last day, as "ordering.ending".
 */
export function evaluateStoreConditions(observations, thresholds = DEFAULT_THRESHOLDS) {
  const conditions = new Map();
  const unreadable = [];
  const raise = raiserFor(conditions);
  evaluateProbes(observations.probes, raise);
  const supervisor = observations.supervisor;
  const noReport =
    supervisor === undefined ||
    supervisor === null ||
    supervisor === "unreadable" ||
    supervisor.reportAgeMs > thresholds.supervisorSilentMs;
  // The supervisor stops with the rest during a planned update; that is no failed check.
  if (noReport && observations.plannedUpdate !== true) unreadable.push("supervisor");
  if (!noReport) {
    const attention = storeAttention(supervisor.attention, observations.store);
    if (attention !== null)
      raise(onlyChores(attention.services) ? "service.chores" : "service.attention", attention);
  }
  const business = observations.business;
  evaluateBusinessConditions(business, {
    raise,
    unreadable,
    thresholds,
    configurationUnreadable: true,
  });
  evaluateInstallationValidity(observations.installation, observations.now, {
    raise,
    unreadable,
    thresholds,
  });
  evaluateOrderingEnding(observations, raise, thresholds);
  const previous = observations.previous?.alerts ?? {};
  for (const source of noReport ? [...unreadable, "supervisor"] : unreadable)
    for (const key of HELD_WHILE_UNREADABLE[source] ?? []) {
      const entry = previous[key];
      if (entry?.raisedAt && !conditions.has(key)) raise(key, entry.params, entry.severity);
    }
  if (unreadable.length > 0)
    raise("monitor.source", { sources: unreadable.map((name) => SOURCE_NAMES[name]) });
  return conditions;
}

/**
 * What a Store's board sends to BOP's channels: only that Store's own facts. The entry probes, the
 * shared process and the supervisor's report are one outage however many Stores it touches, and the
 * root board has already said so; each Store repeating it is a flood when BOP needs one message.
 */
const STORE_OUTBOUND_KEYS = new Set([
  "service.attention",
  "service.chores",
  "payment.updates",
  "updates.retrying",
  "receipts.template",
  "pricing.tax_configuration",
  "orders.workflow",
  "orders.unpaid_rounds",
  "orders.held_stock",
  "pickup.capacity_horizon",
  "reconciliation.differences",
  "settlement.exceptions",
  "settlement.not_run",
  "installation.validity",
  "monitor.source",
]);
export function storeOutboundNotifications(notifications, store) {
  return notifications
    .filter(
      (item) =>
        STORE_OUTBOUND_KEYS.has(item.key) &&
        item.params?.sharedHost !== true &&
        !(
          item.key === "monitor.source" &&
          item.params?.sources?.every((source) => source === SOURCE_NAMES.supervisor)
        ),
    )
    .map((item) => ({ ...item, store }));
}

/**
 * What the root cycle itself sends. BOP has had the end of ordering from "installation.validity" and
 * "certificate.expiring" for days, so "ordering.ending" stays for the Store's own staff. The roll-up
 * repeats what each Store has already said on a line of its own: a second message about one Store's
 * one change.
 */
const ROOT_BOARD_ONLY_KEYS = new Set(["ordering.ending", "stores.attention"]);
export function rootOutboundNotifications(notifications) {
  return notifications.filter((item) => !ROOT_BOARD_ONLY_KEYS.has(item.key));
}

/**
 * How long a condition must hold on a Store's board before it is raised, where that differs from the
 * catalog. The supervisor's flag on one Store's work often lasts seconds and clears by itself (v15:
 * three in two and a half hours, none over 21 s, cleared with nobody acting). "Has kept failing and
 * will not fix itself" must be true on a restaurant's Home: one sample of a minute is not "kept", and
 * an Urgent row that fixes itself teaches an owner to ignore Urgent. A sample without it starts the
 * wait again. The root board is read by BOP and raises at once, as it always did.
 */
export const STORE_RAISE_AFTER_MS = Object.freeze({
  "service.attention": 5 * MINUTE,
  "service.chores": 5 * MINUTE,
});

export const DEFAULT_POLICY = Object.freeze({
  clearAfterMs: 2 * MINUTE,
  remindAfterMs: Object.freeze({ critical: 3 * HOUR, warning: 24 * HOUR }),
  maxMessagesPerHour: 6,
  // The rest of the hour's messages wait for an alert of the installation's own.
  maxStoreMessagesPerHour: 4,
  clearedVisibleMs: 24 * HOUR,
  pendingMaxAgeMs: 24 * HOUR,
});
const SEVERITY_RANK = Object.freeze({ warning: 1, critical: 2 });

export function emptyAlertState() {
  return { schemaVersion: ALERT_STATE_SCHEMA_VERSION, alerts: {}, cleared: [], sequence: 0 };
}

/**
 * Advances the persisted alert state by one cycle. Returns the next state and the notifications
 * this cycle produced (raised, escalated, reminder, cleared). Deduplication: a key raises once,
 * after it has held for its catalog `raiseAfterMs`; it is repeated only on escalation or after the
 * reminder interval, and clears only after being absent for `clearAfterMs` (no flapping spam).
 */
/**
 * WP-2423 (2026-10-18): the alerts a planned update (the deploy's maintenance marker) holds back:
 * the store entries, the supervisor's report and the supervised services all stop while the pilot
 * container is recreated. Payment, settlement, backup, certificate and disk alerts never wait.
 */
export const PLANNED_MAINTENANCE_HELD_KEYS = Object.freeze([
  "entry.api",
  "entry.customer",
  "entry.merchant",
  "supervisor.silent",
  "service.attention",
  "service.chores",
]);

export function advanceAlertState(
  previous,
  conditions,
  now,
  policy = DEFAULT_POLICY,
  { held = [], unchecked = [], plannedUpdate = false, raiseAfterMs = {} } = {},
) {
  const holding = new Set(held);
  const notChecked = new Set(unchecked);
  const state = globalThis.structuredClone(previous ?? emptyAlertState());
  const notifications = [];
  const stamp = new Date(now).toISOString();
  const notify = (kind, key, entry) =>
    notifications.push({
      id: `${now.toString(36)}-${(++state.sequence).toString(36)}`,
      kind,
      key,
      severity: entry.severity,
      params: entry.params,
      at: stamp,
    });
  for (const [key, condition] of conditions) {
    const catalog = ALERT_CATALOG[key];
    if (!catalog) continue;
    const entry = state.alerts[key] ?? {
      firstSeenAt: stamp,
      raisedAt: null,
      notifiedAt: null,
      notifiedSeverity: null,
    };
    // Since when it has held without a break: a raised alert that went away and came back before
    // it cleared is still the same alert, but it did not hold in between.
    if (entry.heldSince === undefined || (entry.absentSince ?? null) !== null)
      entry.heldSince = stamp;
    entry.severity = condition.severity;
    entry.params = condition.params;
    entry.lastSeenAt = stamp;
    entry.absentSince = null;
    state.alerts[key] = entry;
    if (entry.raisedAt === null) {
      // Held during a planned update: still tracked from its first sighting, so a failure that
      // outlasts the update is raised in the first cycle after the window ends.
      if (holding.has(key)) continue;
      if (now - Date.parse(entry.firstSeenAt) >= (raiseAfterMs[key] ?? catalog.raiseAfterMs)) {
        entry.raisedAt = stamp;
        entry.notifiedAt = stamp;
        entry.notifiedSeverity = entry.severity;
        notify("raised", key, entry);
        // Raised again: its "passes again, wait for BOP support" line is no longer true.
        state.cleared = state.cleared.filter((item) => item.key !== key || !waitsForSupport(item));
      }
    } else if (SEVERITY_RANK[entry.severity] > SEVERITY_RANK[entry.notifiedSeverity]) {
      entry.notifiedAt = stamp;
      entry.notifiedSeverity = entry.severity;
      notify("escalated", key, entry);
    } else if (now - Date.parse(entry.notifiedAt) >= policy.remindAfterMs[entry.severity]) {
      entry.notifiedAt = stamp;
      entry.notifiedSeverity = entry.severity;
      notify("reminder", key, entry);
    }
  }
  const removed = new Set();
  for (const [key, entry] of Object.entries(state.alerts)) {
    if (conditions.has(key)) continue;
    // Not checked is not absent: it stays as it was until a check runs again.
    if (notChecked.has(key)) {
      entry.absentSince = null;
      continue;
    }
    entry.absentSince ??= stamp;
    if (entry.raisedAt === null) {
      removed.add(key);
      continue;
    }
    if (now - Date.parse(entry.absentSince) >= policy.clearAfterMs) {
      notify("cleared", key, entry);
      state.cleared.push({
        key,
        severity: entry.severity,
        raisedAt: entry.raisedAt,
        clearedAt: stamp,
        // What the row said at the end decides how its clearing reads (never the BOP-only rule).
        ...(typeof entry.params?.state === "string"
          ? { params: { state: entry.params.state } }
          : {}),
      });
      removed.add(key);
    }
  }
  state.alerts = Object.fromEntries(
    Object.entries(state.alerts).filter(([key]) => !removed.has(key)),
  );
  // A "wait for BOP support" line ends with the planned update BOP fixes it in (the runbook starts
  // one for these rows): seen during an update, it goes once that update ends. Home also ends it
  // with the store's business day.
  state.cleared = state.cleared.filter((entry) => {
    if (now - Date.parse(entry.clearedAt) >= policy.clearedVisibleMs) return false;
    if (!waitsForSupport(entry)) return true;
    if (plannedUpdate) entry.updateSeenAt ??= stamp;
    return plannedUpdate || entry.updateSeenAt === undefined;
  });
  return { state, notifications };
}

/** The installation's own, not about one Store: one Store's trouble cannot spend these messages. */
const isInstallationItem = (item) => item.store === undefined && item.key !== "stores.unchecked";

/**
 * Per-channel outbound queue with an hourly cap. All pending notifications for a channel are sent
 * as one message; when the cap is reached they wait (and are merged) until a slot frees up, so a
 * flapping host can never send more than `maxMessagesPerHour` messages per channel. The Stores'
 * own items stop at `maxStoreMessagesPerHour`: the last slots go only to an item of the
 * installation's own, so no merchant's routine alerts can hold back the message that says the whole
 * site is down. That message still takes everything waiting.
 */
export function planChannelDelivery(channel, notifications, now, policy = DEFAULT_POLICY) {
  const next = globalThis.structuredClone(
    channel ?? { pending: [], sentAt: [], consecutiveFailures: 0, failingSince: null },
  );
  next.pending.push(...notifications);
  next.pending = next.pending.filter((item) => now - Date.parse(item.at) < policy.pendingMaxAgeMs);
  next.sentAt = next.sentAt.filter((at) => now - Date.parse(at) < HOUR);
  const limit = next.pending.some(isInstallationItem)
    ? policy.maxMessagesPerHour
    : policy.maxStoreMessagesPerHour;
  const due = next.pending.length > 0 && next.sentAt.length < limit;
  return { channel: next, batch: due ? [...next.pending] : [] };
}
/** Every attempt counts toward the hourly cap: a provider that half-delivers (one SMS recipient of
 * two) and then fails must not be retried into a flood of duplicates. */
export function recordChannelDelivery(channel, delivered, now) {
  const next = globalThis.structuredClone(channel);
  const stamp = new Date(now).toISOString();
  next.sentAt.push(stamp);
  if (delivered) {
    next.pending = [];
    next.consecutiveFailures = 0;
    next.failingSince = null;
    next.lastDeliveredAt = stamp;
  } else {
    next.consecutiveFailures += 1;
    next.failingSince ??= stamp;
  }
  return next;
}

const KIND_LABEL = Object.freeze({
  raised: "Problem",
  escalated: "Getting worse",
  reminder: "Still a problem",
  cleared: "Resolved",
  test: "Test",
});
/**
 * What a cleared row is called. A key whose clearing does not mean the store can go back to normal
 * (orders.workflow: services keep what they loaded until restarted) says what staff still wait for.
 */
export function clearedAlertTitle(key, params = {}) {
  const catalog = ALERT_CATALOG[key];
  return catalog.clearedTitle?.(params) ?? catalog.title({ remainingMs: 1, ...params });
}
function waitsForSupport(item) {
  const title = ALERT_CATALOG[item.key]?.clearedTitle?.(item.params ?? {});
  return typeof title === "string";
}
export function renderAlert(key, params, { audience = "Installation" } = {}) {
  const catalog = ALERT_CATALOG[key];
  // A merchant's own board says what they can do themselves, in place of BOP's procedure.
  const action =
    audience === "Merchant" ? (catalog.merchantAction ?? catalog.action) : catalog.action;
  return {
    title: catalog.title(params),
    summary: catalog.summary(params),
    action: action(params),
    runbook: catalog.runbook,
  };
}
const runbookLink = (base, anchor) => `${base}#${anchor}`;

/**
 * One outbound message for a batch. `siteLabel` and `runbookBase` come from the Owner's alert
 * configuration (validated plain text and an https URL or repository path).
 */
const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export function renderMessage(batch, { siteLabel, runbookBase, homeUrl = null }) {
  // DEC-PILOT-ALERTS-BACKUP correction 2: one message for a cycle, each line naming its Store.
  const where = (item) =>
    typeof item.store === "string" && STORE_NAME.test(item.store) ? item.store : null;
  // A text message or Pushover keeps only its first 1000 or so characters, and each line is about
  // 500: at equal severity the whole site being down comes first, then the rest of the
  // installation's own, then the Stores'.
  const place = (item) =>
    item.key?.startsWith("entry.") === true ? 0 : isInstallationItem(item) ? 1 : 2;
  const ordered = [...batch].sort(
    (a, b) =>
      (a.kind === "cleared") - (b.kind === "cleared") ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      place(a) - place(b),
  );
  const open = ordered.filter((item) => item.kind !== "cleared" && item.kind !== "test");
  const top = ordered[0];
  const lines = ordered.map((item) => {
    if (item.kind === "test") return "Test alert: this channel works. No action is needed.";
    const text = renderAlert(item.key, item.params);
    const store = where(item) === null ? "" : `${where(item)} - `;
    if (item.kind === "cleared")
      return waitsForSupport(item)
        ? `${store}${clearedAlertTitle(item.key, item.params)}.`
        : `${store}${KIND_LABEL.cleared}: ${text.title}.`;
    return `${store}${KIND_LABEL[item.kind]} (${item.severity === "critical" ? "urgent" : "today"}): ${text.title}. ${text.summary} What to do: ${text.action} Runbook: ${runbookLink(runbookBase, text.runbook)}`;
  });
  let subject;
  if (top.kind === "test") subject = `${siteLabel}: test alert`;
  else if (ordered.length === 1)
    subject =
      top.kind === "cleared" && waitsForSupport(top)
        ? `${siteLabel}${where(top) === null ? "" : ` · ${where(top)}`}: ${clearedAlertTitle(top.key, top.params)}`
        : `${siteLabel}${where(top) === null ? "" : ` · ${where(top)}`}: ${top.kind === "cleared" ? "Resolved - " : top.severity === "critical" ? "URGENT - " : ""}${renderAlert(top.key, top.params).title}`;
  else
    subject = `${siteLabel}: ${open.length > 0 ? `${count(open.length, "problem", "problems")}${open.some((item) => item.severity === "critical") ? " (urgent)" : ""}` : ordered.some(waitsForSupport) ? "checks pass again, wait for BOP support before going back to normal" : "problems resolved"}`;
  const text = [...lines, ...(homeUrl ? [`Store Home: ${homeUrl}`] : [])].join("\n\n");
  return {
    subject,
    text,
    severity: open.some((item) => item.severity === "critical")
      ? "critical"
      : top.kind === "test"
        ? "test"
        : open.length > 0
          ? "warning"
          : "resolved",
  };
}

/**
 * The always-on local projection read by the merchant Home (owner read). Only catalog keys,
 * severities, instants and rendered catalog text.
 */
export function buildAlertBoard(
  state,
  { observedAt, channels, backup, maintenance = null, audience = "Installation", support = null },
) {
  // At the root BOP reads the end of ordering in its own two rows; the instant below is for the
  // Store's staff, on their own screens.
  const shown = (key) => audience === "Merchant" || key !== "ordering.ending";
  const ending = state.alerts["ordering.ending"];
  const incomplete = state.alerts["monitor.source"];
  const active = Object.entries(state.alerts)
    .filter(([key, entry]) => entry.raisedAt !== null && shown(key))
    .map(([key, entry]) => ({
      key,
      severity: entry.severity,
      raisedAt: entry.raisedAt,
      lastSeenAt: entry.lastSeenAt,
      ...renderAlert(key, entry.params, { audience }),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.raisedAt.localeCompare(b.raisedAt),
    );
  return {
    schemaVersion: 1,
    observedAt,
    active,
    recentlyCleared: state.cleared
      .filter((entry) => shown(entry.key))
      .map((entry) => ({
        key: entry.key,
        title: clearedAlertTitle(entry.key, entry.params),
        clearedAt: entry.clearedAt,
      }))
      .slice(-10),
    outboundChannels: channels,
    lastSuccessfulBackupAt: backup?.lastSuccessAt ?? null,
    // WP-2423 (2026-10-18): a planned update in progress (its window only, never its note).
    maintenance:
      maintenance === null
        ? null
        : { startedAt: maintenance.startedAt, expiresAt: maintenance.expiresAt },
    // Who staff call: only when the operator configured it.
    ...(support === null ? {} : { support: { phone: support.phone, testOnly: support.testOnly } }),
    // AGENTS.md "Warn before timeouts": when ordering stops, only in its last day. Any of the Store's
    // staff read this one fact on the screen they work in, never the rest of this board.
    ...(typeof ending?.raisedAt === "string" && typeof ending.params?.endsAt === "string"
      ? { orderingEndsAt: ending.params.endsAt }
      : {}),
    // When some checks last stopped running, not when that was raised minutes later: a merchant's
    // Home dates "last checked" and the rows found before it by this. A state written before this
    // was recorded gives its first sighting.
    ...(typeof incomplete?.raisedAt === "string"
      ? { checksIncompleteSince: incomplete.heldSince ?? incomplete.firstSeenAt }
      : {}),
  };
}
