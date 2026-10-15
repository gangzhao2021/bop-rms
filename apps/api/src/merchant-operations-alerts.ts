import { parseCanonicalInstant } from "@bop/tenant";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the operations alert read for the merchant Home.
 *
 * The pilot operations monitor owns alert state (it must keep working while the database is down)
 * and publishes one alert board per installation. This read authorizes the caller for the
 * installation's Store under the exception-handling permission (Owner and Store Manager), then
 * projects the board through a closed contract: catalog keys, severities, instants and bounded
 * catalog text. Anything else in the file is refused rather than shown.
 */
export const operationsAlertKeys = Object.freeze([
  "entry.api",
  "entry.customer",
  "entry.merchant",
  "supervisor.silent",
  "service.attention",
  "payment.updates",
  "reconciliation.differences",
  "settlement.exceptions",
  "backup.failed",
  "backup.stale",
  "backup.restore_check",
  "backup.offsite",
  "certificate.expiring",
  "disk.low",
  "monitor.source",
  "channel.delivery",
] as const);
export type OperationsAlertKey = (typeof operationsAlertKeys)[number];

export interface OperationsAlertView {
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

/** Strict projection of the monitor's alert board (null when the monitor never ran). */
export function projectOperationsAlertBoard(value: unknown, now: string): OperationsAlertView {
  const at = instant(now);
  if (value === null)
    return Object.freeze({
      monitor: "NotRunning",
      observedAt: null,
      active: Object.freeze([]),
      recentlyCleared: Object.freeze([]),
      outbound: Object.freeze({ email: false, webhooks: 0, heartbeat: false }),
      lastSuccessfulBackupAt: null,
    });
  const board = record(value, [
    "schemaVersion",
    "observedAt",
    "active",
    "recentlyCleared",
    "outboundChannels",
    "lastSuccessfulBackupAt",
  ]);
  if (board.schemaVersion !== 1) return unavailable();
  const observedAt = instant(board.observedAt);
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
  const silent = Date.parse(at) - Date.parse(observedAt) > operationsAlertMonitorSilentMs;
  return Object.freeze({
    monitor: silent ? "Silent" : "Reporting",
    observedAt,
    active: Object.freeze(active),
    recentlyCleared: Object.freeze(recentlyCleared),
    outbound: Object.freeze({
      email: channels.email,
      webhooks: channels.webhooks as number,
      heartbeat: channels.heartbeat,
    }),
    lastSuccessfulBackupAt:
      board.lastSuccessfulBackupAt === null ? null : instant(board.lastSuccessfulBackupAt),
  });
}

/**
 * The persistent read: the caller's Session, selected Store and permission are resolved in one
 * transaction; only the installation's own Store is answered. The board is read after the
 * authorization and never written here.
 */
export function createPersistentMerchantOperationsAlerts(options: {
  readonly persistence: PersistentMerchantBffOptions;
  /** The single Store this installation (and its monitor) serves. */
  readonly storeReference: string;
  /** The monitor's published board, or null when it has never written one. */
  readBoard(): Promise<unknown>;
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  return async (input: { readonly sessionCookie: unknown }): Promise<OperationsAlertView> => {
    await persistence.transactions.run(async (tx) => {
      const value = await resolve(tx, input.sessionCookie, "operations.order-exception.manage");
      if (!(await value.allowed()) || String(value.store.storeReference) !== options.storeReference)
        return unavailable();
    });
    let board: unknown;
    try {
      board = await options.readBoard();
    } catch {
      return unavailable();
    }
    return projectOperationsAlertBoard(board, persistence.now());
  };
}
