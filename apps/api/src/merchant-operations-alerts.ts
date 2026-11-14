import { parseCanonicalInstant } from "@bop/tenant";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { keepingCause } from "./merchant-failure.js";

/**
 * WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the operations alert read for the merchant Home.
 *
 * The pilot operations monitor owns alert state (it must keep working while the database is down)
 * and publishes one alert board per served Store. This read authorizes the caller for this
 * composition's Store under the exception-handling permission (Owner and Store Manager), then
 * projects the board through a closed contract: catalog keys, severities, instants and bounded
 * catalog text. Anything else in the file is refused rather than shown.
 */
export const operationsAlertKeys = Object.freeze([
  "entry.api",
  "entry.customer",
  "entry.merchant",
  "supervisor.silent",
  "service.attention",
  "service.chores",
  "service.not_running",
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
  "backup.failed",
  "backup.stale",
  "backup.restore_check",
  "backup.offsite",
  "certificate.expiring",
  "installation.validity",
  "ordering.ending",
  "disk.low",
  "monitor.source",
  "channel.delivery",
  "settlement.not_covered",
  "stores.unchecked",
  "stores.attention",
] as const);
export type OperationsAlertKey = (typeof operationsAlertKeys)[number];

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2: who reads this Store's Home. Installation: whoever runs the
 * installation, who is told everything about it. Merchant: a restaurant on the installation, who is
 * told their own Store's problems and the outages that stop their guests or staff, and nothing they
 * cannot act on (the monitor, backups, the certificate, disks, channels, renewal: BOP's to fix),
 * until ordering is a day from stopping because BOP has not renewed: then they must not learn it
 * from guests.
 */
export type OperationsAlertAudience = "Installation" | "Merchant";
export const merchantOperationsAlertKeys: ReadonlySet<OperationsAlertKey> = new Set([
  "entry.api",
  "entry.customer",
  "entry.merchant",
  "service.attention",
  // DEC-WORKER-HEALTH-TRUTH: a background job of the Store that is not running; staff check by hand.
  "service.not_running",
  "payment.updates",
  "updates.retrying",
  "receipts.template",
  "pricing.tax_configuration",
  // WP-2423 item 9: the Store's own order rules; its staff pause services and go on paper.
  "orders.workflow",
  "orders.unpaid_rounds",
  "orders.held_stock",
  "pickup.capacity_horizon",
  "reconciliation.differences",
  "settlement.exceptions",
  // WP-2423 (settlement-coverage): a closed day not compared with the payment provider yet; the
  // merchant must not read "all good" while it is so.
  "settlement.not_run",
  "ordering.ending",
]);

export interface OperationsAlertView {
  readonly audience: OperationsAlertAudience;
  /** Reporting: the monitor wrote within the last five minutes; Silent: it stopped; NotRunning: never. */
  readonly monitor: "Reporting" | "Silent" | "NotRunning";
  readonly observedAt: string | null;
  readonly active: readonly {
    readonly key: OperationsAlertKey;
    readonly severity: "critical" | "warning";
    readonly title: string;
    readonly summary: string;
    readonly action: string;
    readonly raisedAt: string;
  }[];
  readonly recentlyCleared: readonly {
    readonly key: OperationsAlertKey;
    readonly title: string;
    readonly clearedAt: string;
  }[];
  readonly outbound: {
    readonly email: boolean;
    readonly webhooks: number;
    readonly heartbeat: boolean;
  };
  readonly lastSuccessfulBackupAt: string | null;
  /**
   * WP-2423 (2026-10-18): a planned update in progress. Store-down alerts wait during it (at most
   * 15 minutes); the Home shows a calm notice instead. Null when none is in force.
   */
  readonly plannedUpdate: { readonly startedAt: string; readonly expiresAt: string } | null;
  /**
   * Merchant: some of this Store's checks could not run since this instant (BOP has been told). The
   * Home must not say all is good, or quote `observedAt`: the board is rewritten every minute whether
   * or not a read worked. Always null for Installation, whose board names them.
   */
  readonly checksIncompleteSince: string | null;
  /** Who staff call when a row says "Ask BOP support"; null until the operator configures it. */
  readonly support: { readonly phone: string; readonly testOnly: boolean } | null;
}

export const operationsAlertMonitorSilentMs = 5 * 60_000;
const unavailable = (): never => {
  throw new Error("MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE");
};
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return unavailable();
  return value as Record<string, unknown>;
};
const instant = (value: unknown): string => {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return unavailable();
  }
};
// Catalog text: printable, no markup, bounded.
const text = (value: unknown, max: number): string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[^\p{Cc}<>]+$/u.test(value)
    ? value
    : unavailable();
const key = (value: unknown): OperationsAlertKey =>
  (operationsAlertKeys as readonly unknown[]).includes(value)
    ? (value as OperationsAlertKey)
    : unavailable();

const noOutbound = Object.freeze({ email: false, webhooks: 0, heartbeat: false });
const supportOf = (value: unknown): OperationsAlertView["support"] => {
  if (value === undefined || value === null) return null;
  const support = record(value, ["phone", "testOnly"]);
  return typeof support.phone === "string" &&
    /^\+[1-9][0-9]{6,14}$/u.test(support.phone) &&
    typeof support.testOnly === "boolean"
    ? Object.freeze({ phone: support.phone, testOnly: support.testOnly })
    : unavailable();
};

/** Strict projection of the monitor's alert board (null when the monitor never ran). */
export function projectOperationsAlertBoard(
  value: unknown,
  now: string,
  { audience = "Installation" }: { readonly audience?: OperationsAlertAudience } = {},
): OperationsAlertView {
  const at = instant(now);
  if (value === null)
    return Object.freeze({
      audience,
      monitor: "NotRunning",
      observedAt: null,
      active: Object.freeze([]),
      recentlyCleared: Object.freeze([]),
      outbound: noOutbound,
      lastSuccessfulBackupAt: null,
      plannedUpdate: null,
      checksIncompleteSince: null,
      support: null,
    });
  const boardKeys = [
    "schemaVersion",
    "observedAt",
    "active",
    "recentlyCleared",
    "outboundChannels",
    "lastSuccessfulBackupAt",
  ];
  // A board written before planned updates existed has no `maintenance` entry; one with no support
  // contact configured has no `support` entry; `orderingEndsAt` is only there in ordering's last day,
  // for the staff's own read below; `checksIncompleteSince` only while some checks cannot run.
  const board = record(value, [
    ...boardKeys,
    ...["maintenance", "support", "orderingEndsAt", "checksIncompleteSince"].filter(
      (optional) => value !== null && typeof value === "object" && Object.hasOwn(value, optional),
    ),
  ]);
  if (board.schemaVersion !== 1) return unavailable();
  const observedAt = instant(board.observedAt);
  if (board.orderingEndsAt !== undefined) instant(board.orderingEndsAt);
  const incompleteSince =
    board.checksIncompleteSince === undefined ? undefined : instant(board.checksIncompleteSince);
  if (!Array.isArray(board.active) || board.active.length > operationsAlertKeys.length)
    return unavailable();
  if (!Array.isArray(board.recentlyCleared) || board.recentlyCleared.length > 10)
    return unavailable();
  const active = board.active.map((item: unknown) => {
    const entry = record(item, [
      "key",
      "severity",
      "raisedAt",
      "lastSeenAt",
      "title",
      "summary",
      "action",
      "runbook",
    ]);
    if (entry.severity !== "critical" && entry.severity !== "warning") return unavailable();
    instant(entry.lastSeenAt);
    text(entry.runbook, 80);
    return Object.freeze({
      key: key(entry.key),
      severity: entry.severity,
      title: text(entry.title, 120),
      summary: text(entry.summary, 600),
      action: text(entry.action, 400),
      raisedAt: instant(entry.raisedAt),
    });
  });
  if (new Set(active.map((entry) => entry.key)).size !== active.length) return unavailable();
  const recentlyCleared = board.recentlyCleared.map((item: unknown) => {
    const entry = record(item, ["key", "title", "clearedAt"]);
    return Object.freeze({
      key: key(entry.key),
      title: text(entry.title, 120),
      clearedAt: instant(entry.clearedAt),
    });
  });
  const channels = record(board.outboundChannels, ["email", "webhooks", "heartbeat"]);
  if (
    typeof channels.email !== "boolean" ||
    typeof channels.heartbeat !== "boolean" ||
    !Number.isSafeInteger(channels.webhooks) ||
    (channels.webhooks as number) < 0 ||
    (channels.webhooks as number) > 10
  )
    return unavailable();
  let plannedUpdate: OperationsAlertView["plannedUpdate"] = null;
  if (board.maintenance !== undefined && board.maintenance !== null) {
    const window = record(board.maintenance, ["startedAt", "expiresAt"]);
    const startedAt = instant(window.startedAt),
      expiresAt = instant(window.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(startedAt)) return unavailable();
    // Shown only while it is in force: the board may be up to a minute old.
    if (Date.parse(at) < Date.parse(expiresAt))
      plannedUpdate = Object.freeze({ startedAt, expiresAt });
  }
  const silent = Date.parse(at) - Date.parse(observedAt) > operationsAlertMonitorSilentMs;
  const lastSuccessfulBackupAt =
    board.lastSuccessfulBackupAt === null ? null : instant(board.lastSuccessfulBackupAt);
  const support = supportOf(board.support);
  // The whole board is checked above whichever the audience; a misplaced file shows no platform
  // alert here either.
  const merchant = audience === "Merchant";
  const shown = <T extends { readonly key: OperationsAlertKey }>(items: readonly T[]) =>
    Object.freeze(
      merchant ? items.filter((item) => merchantOperationsAlertKeys.has(item.key)) : items,
    );
  return Object.freeze({
    audience,
    monitor: silent ? "Silent" : "Reporting",
    observedAt,
    active: shown(active),
    recentlyCleared: shown(recentlyCleared),
    outbound: merchant
      ? noOutbound
      : Object.freeze({
          email: channels.email,
          webhooks: channels.webhooks as number,
          heartbeat: channels.heartbeat,
        }),
    lastSuccessfulBackupAt: merchant ? null : lastSuccessfulBackupAt,
    plannedUpdate: silent ? null : plannedUpdate,
    // When the checks last stopped running (after the raise, when they ran again in between and
    // stopped again before it cleared); a board written before it said so gives the raise.
    checksIncompleteSince: merchant
      ? (() => {
          const raised = active.find((item) => item.key === "monitor.source")?.raisedAt;
          if (raised === undefined) return null;
          return incompleteSince !== undefined &&
            Date.parse(incompleteSince) <= Date.parse(observedAt)
            ? incompleteSince
            : raised;
        })()
      : null,
    support,
  });
}

/**
 * AGENTS.md "Warn before timeouts": what any of this Store's staff read on the screen they work in,
 * in ordering's last day. That instant and who to call, and nothing else of the board: the rest stays
 * with the permission above. The monitor writes it only in the last day.
 */
export interface OrderingEndingNotice {
  readonly endsAt: string | null;
  readonly support: OperationsAlertView["support"];
}
const noOrderingEnding: OrderingEndingNotice = Object.freeze({ endsAt: null, support: null });

/**
 * `at` is now. A board the monitor has not rewritten for longer than the Home calls Silent says
 * nothing about ordering ending: BOP may have renewed since, and "Ordering at this Store has
 * stopped" would send staff to paper while guests can still order. The Home already says the
 * checks have gone quiet, to those who handle them.
 */
export function projectOrderingEndingNotice(value: unknown, at: string): OrderingEndingNotice {
  if (value === null) return noOrderingEnding;
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const board = value as Record<string, unknown>;
  if (board.schemaVersion !== 1) return unavailable();
  if (board.orderingEndsAt === undefined) return noOrderingEnding;
  const observedAt = instant(board.observedAt),
    endsAt = instant(board.orderingEndsAt);
  if (Date.parse(instant(at)) - Date.parse(observedAt) > operationsAlertMonitorSilentMs)
    return noOrderingEnding;
  return Object.freeze({
    endsAt,
    support: supportOf(board.support),
  });
}

/** The answer for a signed-in staff member whose role does not handle store system alerts. */
export interface OperationsAlertsNotPermitted {
  readonly permitted: false;
}
export const operationsAlertsNotPermitted: OperationsAlertsNotPermitted = Object.freeze({
  permitted: false,
});

/**
 * WP-2423 (settlement-coverage): whether BOP's support channels carry this alert of the Store's
 * board now: the monitor is reporting, the alert is raised, an outbound channel is set up and none
 * is failing. Anything unreadable is false, so no screen claims BOP was told when it was not.
 */
export function isOperationsAlertSentToSupport(
  board: unknown,
  now: string,
  alertKey: OperationsAlertKey,
): boolean {
  try {
    const view = projectOperationsAlertBoard(board, now);
    const raised = new Set(view.active.map((item) => item.key));
    return (
      view.monitor === "Reporting" &&
      raised.has(alertKey) &&
      !raised.has("channel.delivery") &&
      (view.outbound.email || view.outbound.webhooks > 0)
    );
  } catch {
    return false;
  }
}

/**
 * The persistent read: the caller's Session, selected Store and permission are resolved in one
 * transaction; only this composition's own Store is answered. The board is read after the
 * authorization and never written here.
 */
export function createPersistentMerchantOperationsAlerts(options: {
  readonly persistence: PersistentMerchantBffOptions;
  /** The Store this composition serves; the monitor writes it a board of its own. */
  readonly storeReference: string;
  /** The monitor's published board for that Store, or null when it has never written one. */
  readBoard(): Promise<unknown>;
  /** Decided by the composition from where the Store lives, never from the signed-in person. */
  readonly audience?: OperationsAlertAudience;
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (input: {
    readonly sessionCookie: unknown;
  }): Promise<OperationsAlertView | OperationsAlertsNotPermitted> => {
    const permitted = await persistence.transactions.run(async (tx) => {
      const value = await resolve(tx, input.sessionCookie, "operations.order-exception.manage");
      if (String(value.store.storeReference) !== options.storeReference) return unavailable();
      return (await value.allowed()) === true;
    });
    // WP-2423: a role that does not handle store system alerts (Front of House, Cashier) is told
    // so in an ordinary answer: the Home hides the card, and no refusal shows in the browser.
    if (!permitted) return operationsAlertsNotPermitted;
    let board: unknown;
    try {
      board = await options.readBoard();
    } catch (cause) {
      return keepingCause(unavailable)(cause);
    }
    return projectOperationsAlertBoard(
      board,
      persistence.now(),
      options.audience === undefined ? {} : { audience: options.audience },
    );
  };
}

/**
 * The read behind that notice, for anyone who may enter this Store's workspace. A refusal throws
 * what any such refusal throws. A board that cannot be read is no refusal (the route answers 503),
 * and the screen keeps what it last knew.
 */
export function createPersistentMerchantOrderingEnding(options: {
  readonly persistence: PersistentMerchantBffOptions;
  /** The Store this composition serves. */
  readonly storeReference: string;
  /** The monitor's published board for that Store, or null when it has never written one. */
  readBoard(): Promise<unknown>;
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (input: { readonly sessionCookie: unknown }): Promise<OrderingEndingNotice> => {
    const permitted = await persistence.transactions.run(async (tx) => {
      const value = await resolve(tx, input.sessionCookie, "merchant.access");
      return (
        String(value.store.storeReference) === options.storeReference &&
        (await value.allowed()) === true
      );
    });
    if (!permitted) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    let board: unknown;
    try {
      board = await options.readBoard();
    } catch (error) {
      return keepingCause(unavailable)(error);
    }
    return projectOrderingEndingNotice(board, persistence.now());
  };
}
