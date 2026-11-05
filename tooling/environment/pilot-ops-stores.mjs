// DEC-PILOT-ALERTS-BACKUP correction 2: one alert board per served Store, written by the one
// operations monitor. Each cycle, for each Store in `stores.json` order: read that Store's own alert
// state and business signals, advance its alerts and write `stores/<name>/ops/alert-state.json` and
// `alert-board.json` (private files, as at the runtime root). One Store failing is logged and never
// stops the others; a new Store joins within a minute and a retired one stops being written.
//
// Outbound messages stay with the root cycle: its one channel state, its hourly cap. A Store only
// queues what is its own (`unsent`, kept in its state file so a restart loses nothing); the root
// cycle sends it and acknowledges it.
import { setTimeout as startTimer, clearTimeout } from "node:timers";
import path from "node:path";
import {
  DEFAULT_POLICY,
  PLANNED_MAINTENANCE_HELD_KEYS,
  STORE_RAISE_AFTER_MS,
  advanceAlertState,
  buildAlertBoard,
  emptyAlertState,
  evaluateStoreConditions,
  storeOutboundNotifications,
  uncheckedAlertKeys,
} from "./pilot-alerts.mjs";
import {
  ALERT_BOARD_FILE,
  ALERT_STATE_FILE,
  OPS_DIRECTORY,
  ensureOpsDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./pilot-ops-files.mjs";
import { createBusinessObserver, observeInstallationValidity } from "./pilot-ops-observe.mjs";
import { loadServedStoreDirectories } from "./pilot-served-stores.mjs";
import { reportUnexpected } from "./pilot-unexpected.mjs";

/** The same age at which the merchant Home calls a board silent. */
export const STORE_BOARD_STALE_MS = 5 * 60_000;
/** One Store's reads are bounded so a slow one only makes that Store's own board less current. */
export const STORE_READ_LIMIT_MS = 45_000;
const NO_CHANNELS = Object.freeze({ email: false, webhooks: 0, heartbeat: false });
const nameOf = (relative) => relative.slice("stores/".length);

const emptyStoreState = () => ({ schemaVersion: 1, alert: emptyAlertState(), unsent: [] });

async function readStoreState(file, log, store) {
  try {
    const state = await readPrivateJson(file);
    if (state === null) return emptyStoreState();
    if (state.schemaVersion !== 1 || typeof state.alert?.alerts !== "object")
      throw Error("PILOT_OPS_FILE_INVALID");
    return state;
  } catch {
    // As at the root: a damaged state starts again; the worst outcome is a repeated message.
    await log({ event: "store_state_unreadable", store });
    return emptyStoreState();
  }
}

export function createStoreMonitors({
  runtimeDirectory,
  load,
  log,
  listStores = () => loadServedStoreDirectories(runtimeDirectory),
  observeValidity = observeInstallationValidity,
  readLimitMs = STORE_READ_LIMIT_MS,
  report = reportUnexpected,
  clock = Date.now,
}) {
  const monitors = new Map();
  const monitorOf = (relative, now) => {
    const name = nameOf(relative);
    let monitor = monitors.get(name);
    if (monitor === undefined) {
      monitor = {
        relative,
        directory: path.join(runtimeDirectory, relative),
        firstSeenAt: now,
        lastWrittenAt: null,
        reading: null,
        raised: new Set(),
        unsent: [],
        acknowledged: new Set(),
        observe: createBusinessObserver({
          runtimeDirectory: path.join(runtimeDirectory, relative),
          load,
          report: (error) => {
            report("PILOT_OPS_STORE_READ_UNAVAILABLE", error, { store: relative });
            void log({ event: "store_monitor_failed", store: name, stage: "read" });
          },
          // The merchant is told nothing of a check that could not run: BOP must find out why.
          reportCheck: (check, error) => {
            report("PILOT_OPS_STORE_READ_UNAVAILABLE", error, { store: relative, step: check });
            void log({ event: "store_check_failed", store: name, check });
          },
        }),
      };
      monitors.set(name, monitor);
    }
    return monitor;
  };
  /** Its business signals, or "unreadable" if they take too long or the last read is still going. */
  const observeWithinLimit = (monitor, now) => {
    if (monitor.reading !== null) return "unreadable";
    const reading = monitor
      .observe(now)
      .catch(() => "unreadable")
      .finally(() => {
        monitor.reading = null;
      });
    monitor.reading = reading;
    let timer;
    return Promise.race([
      reading,
      new Promise((resolve) => {
        timer = startTimer(() => {
          void log({
            event: "store_monitor_failed",
            store: nameOf(monitor.relative),
            stage: "timeout",
          });
          resolve("unreadable");
        }, readLimitMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  async function runStore(
    name,
    monitor,
    { now, probes, supervisor, certificate, maintenance, config },
  ) {
    const ops = await ensureOpsDirectory(monitor.directory);
    const stateFile = path.join(ops, ALERT_STATE_FILE);
    const previous = await readStoreState(stateFile, log, name);
    const observations = {
      now,
      store: name,
      probes,
      supervisor,
      certificate,
      business: await observeWithinLimit(monitor, now),
      installation: await observeValidity(monitor.directory),
      previous: previous.alert,
      plannedUpdate: maintenance !== null,
    };
    const advanced = advanceAlertState(
      previous.alert,
      evaluateStoreConditions(observations),
      now,
      undefined,
      {
        held: maintenance === null ? [] : PLANNED_MAINTENANCE_HELD_KEYS,
        // A read that timed out is not "the order rules check passes again" (WP-2423 item 9).
        unchecked: uncheckedAlertKeys(observations),
        raiseAfterMs: STORE_RAISE_AFTER_MS,
      },
    );
    for (const item of advanced.notifications) {
      await log({
        event: `alert_${item.kind}`,
        store: name,
        key: item.key,
        severity: item.severity,
        // Which Workflow refused and by which rule (fixed words): for BOP's log only.
        ...(typeof item.params?.refused === "string" ? { refused: item.params.refused } : {}),
      });
      if (item.kind === "raised" && item.key === "settlement.not_covered")
        await log({ event: "store_settlement_not_covered", store: name });
    }
    const unsent = [
      ...(previous.unsent ?? []).filter(
        (item) =>
          !monitor.acknowledged.has(item.id) &&
          now - Date.parse(item.at) < DEFAULT_POLICY.pendingMaxAgeMs,
      ),
      ...storeOutboundNotifications(advanced.notifications, name),
    ];
    await writePrivateJson(stateFile, {
      schemaVersion: 1,
      alert: advanced.state,
      unsent,
    });
    await writePrivateJson(
      path.join(ops, ALERT_BOARD_FILE),
      buildAlertBoard(advanced.state, {
        observedAt: new Date(now).toISOString(),
        channels: NO_CHANNELS,
        backup: null,
        maintenance,
        audience: "Merchant",
        support: config?.support ?? null,
      }),
    );
    monitor.unsent = unsent.filter((item) => !monitor.acknowledged.has(item.id));
    // What the state file no longer holds needs no remembering.
    monitor.acknowledged = new Set(
      [...monitor.acknowledged].filter((id) => unsent.some((item) => item.id === id)),
    );
    monitor.lastWrittenAt = now;
    monitor.raised = new Set(
      Object.entries(advanced.state.alerts)
        // The process the Stores share is the root's to say, once; not each Store's.
        .filter(([, entry]) => entry.raisedAt !== null && entry.params?.sharedHost !== true)
        .map(([key]) => key),
    );
  }
  return Object.freeze({
    /** One pass over the Stores; `cycle` is what the root cycle observed for the installation. */
    async run(cycle) {
      const startedAt = clock();
      let relatives;
      try {
        relatives = await listStores();
      } catch {
        // The Stores known so far go stale and the root board names them.
        await log({ event: "store_monitors_list_unreadable" });
        return;
      }
      const served = new Set(relatives.map(nameOf));
      for (const [name, monitor] of monitors)
        if (!served.has(name)) {
          monitors.delete(name);
          await monitor.observe.close?.();
          await log({ event: "store_monitor_retired", store: name });
        }
      for (const relative of relatives) {
        const name = nameOf(relative);
        // Each board says when it was really written, however long the Stores before it took.
        const now = cycle.now + (clock() - startedAt);
        try {
          await runStore(name, monitorOf(relative, now), { ...cycle, now });
        } catch (error) {
          await log({
            event: "store_monitor_failed",
            store: name,
            code: /^PILOT_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "UNAVAILABLE",
          });
        }
      }
    },
    /** What the Stores want sent; the root cycle delivers it within its channels' hourly cap. */
    pending: () => [...monitors.values()].flatMap((monitor) => monitor.unsent),
    acknowledge(items) {
      for (const item of items) {
        const monitor = monitors.get(item.store);
        if (monitor === undefined) continue;
        monitor.acknowledged.add(item.id);
        monitor.unsent = monitor.unsent.filter((entry) => entry.id !== item.id);
      }
    },
    /** For the root board: the Stores needing something only BOP can do, by name. */
    summary(now, { support = null } = {}) {
      const summary = {
        unchecked: [],
        checksFailing: [],
        background: [],
        settlementNotCovered: [],
        setupEnding: [],
        noSupportNumber: [],
      };
      for (const [name, monitor] of monitors) {
        if (now - (monitor.lastWrittenAt ?? monitor.firstSeenAt) > STORE_BOARD_STALE_MS)
          summary.unchecked.push(name);
        if (monitor.raised.has("monitor.source")) summary.checksFailing.push(name);
        if (monitor.raised.has("service.attention")) summary.background.push(name);
        if (monitor.raised.has("settlement.not_covered")) summary.settlementNotCovered.push(name);
        if (monitor.raised.has("installation.validity")) summary.setupEnding.push(name);
        // Their screens say "Call BOP support": BOP finds out before a merchant does.
        if (support === null) summary.noSupportNumber.push(name);
      }
      return summary;
    },
  });
}

/** `pilot-ops.mjs status`: each served Store's keys, severities and instants only. */
export async function readStoresStatus(
  runtimeDirectory,
  listStores = () => loadServedStoreDirectories(runtimeDirectory),
) {
  const stores = {};
  for (const relative of await listStores()) {
    const board = await readPrivateJson(
      path.join(runtimeDirectory, relative, OPS_DIRECTORY, ALERT_BOARD_FILE),
    ).catch(() => "unreadable");
    stores[nameOf(relative)] =
      board === null || board === "unreadable"
        ? { monitor: board === null ? "NotRunning" : "Unreadable" }
        : {
            observedAt: board.observedAt,
            active: board.active.map((item) => ({
              key: item.key,
              severity: item.severity,
              raisedAt: item.raisedAt,
            })),
          };
  }
  return stores;
}
