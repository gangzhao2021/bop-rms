// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): the pilot operations monitor (compose service `ops`).
//
//   pilot-ops.mjs run <runtime>                 monitor loop: probes, alerts, channels, backups
//   pilot-ops.mjs test-alert <runtime>          send a test alert to every configured channel
//   pilot-ops.mjs backup-now <runtime>          ask the running monitor to back up now
//   pilot-ops.mjs status <runtime>              current alerts (keys and severities only)
//   pilot-ops.mjs maintenance start <runtime> --reason <text> [--minutes 1-15] [--by <name>]
//   pilot-ops.mjs maintenance end <runtime>     planned update window (deploys; see the runbook)
//   pilot-ops.mjs generate-offsite-key <runtime>
//   pilot-ops.mjs decrypt-backup <runtime> <encrypted file> <output file>
//
// Runs in its own container next to the supervisor so that a stopped supervisor, API or HTTPS
// entry is still noticed. Output never contains secrets, addresses, contact data or tokens.
import console from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  PLANNED_MAINTENANCE_HELD_KEYS,
  advanceAlertState,
  buildAlertBoard,
  emptyAlertState,
  evaluateAlertConditions,
  planChannelDelivery,
  recordChannelDelivery,
  renderMessage,
} from "./pilot-alerts.mjs";
import {
  createAlertLog,
  createHeartbeat,
  createOutboundChannels,
} from "./pilot-alert-channels.mjs";
import { loadPilotOpsConfig, parsePilotOpsConfig } from "./pilot-ops-config.mjs";
import {
  ALERT_BOARD_FILE,
  ALERT_LOG_FILE,
  ALERT_STATE_FILE,
  BACKUP_REQUEST_FILE,
  BACKUP_STATUS_FILE,
  ensureOpsDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./pilot-ops-files.mjs";
import {
  createBusinessObserver,
  observeBackup,
  observeCertificate,
  observeDisks,
  observeProbes,
  observeSupervisor,
} from "./pilot-ops-observe.mjs";
import {
  PLANNED_MAINTENANCE_MAX_MINUTES,
  activePlannedMaintenance,
  endPlannedMaintenance,
  readPlannedMaintenance,
  startPlannedMaintenance,
} from "./pilot-ops-maintenance.mjs";
import {
  decideBackupRun,
  decryptFile,
  emptyBackupStatus,
  generateOffsiteKey,
  readOffsiteKey,
  runBackupCycle,
} from "./pilot-ops-backup.mjs";

export const MONITOR_INTERVAL_MS = 60_000;
/** `--name value` pairs from a closed set; anything else (or a repeat) is refused. */
const parseOptions = (args, allowed) => {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (!allowed.includes(name) || value === undefined || Object.hasOwn(options, name))
      throw Error("PILOT_OPS_ARGUMENT_INVALID");
    options[name] = value;
  }
  return options;
};
const RUNTIME = /^\.local\/[a-z0-9][a-z0-9_-]{0,63}$/u;
const runtimeArgument = (value) => {
  if (typeof value !== "string" || !RUNTIME.test(value)) throw Error("PILOT_OPS_ARGUMENT_INVALID");
  return value;
};

/** Delivers this cycle's notifications per channel, within each channel's hourly cap. */
export async function deliver({ channels, channelState, notifications, now, config, log }) {
  const next = { ...channelState };
  for (const channel of channels) {
    const planned = planChannelDelivery(next[channel.id], notifications, now);
    next[channel.id] = planned.channel;
    if (planned.batch.length === 0) continue;
    const message = renderMessage(planned.batch, config);
    try {
      await channel.send(message);
      next[channel.id] = recordChannelDelivery(planned.channel, true, now);
      await log({ event: "alert_delivered", channel: channel.id, items: planned.batch.length });
    } catch (error) {
      next[channel.id] = recordChannelDelivery(planned.channel, false, now);
      await log({
        event: "alert_delivery_failed",
        channel: channel.id,
        code: /^PILOT_[A-Z_]+$/u.test(error?.message ?? "")
          ? error.message
          : "PILOT_ALERT_DELIVERY_FAILED",
      });
    }
  }
  // Channels removed from the configuration stop being tracked.
  return Object.fromEntries(
    Object.entries(next).filter(([id]) => channels.some((channel) => channel.id === id)),
  );
}

/** One monitor cycle; returns the next persisted state. All I/O comes through `io`. */
export async function runMonitorCycle({ now, state, config, io }) {
  const probes = await io.observeProbes(state.probes, now);
  const observations = {
    now,
    probes: probes.probes,
    supervisor: await io.observeSupervisor(now),
    business: await io.observeBusiness(now),
    backup: await io.observeBackup(config.backup !== null),
    certificate: await io.observeCertificate(probes.liveCertificateValidTo),
    disks: await io.observeDisks(config),
    channels: io.channels.map((channel) => ({
      kind: channel.kind,
      failingSince: state.channels[channel.id]?.failingSince ?? null,
    })),
  };
  const conditions = evaluateAlertConditions(observations);
  // WP-2423 (2026-10-18): a planned update holds the "store system down" alerts for its window.
  const marker = io.observeMaintenance ? await io.observeMaintenance() : null;
  const maintenance = activePlannedMaintenance(marker === "unreadable" ? null : marker, now);
  const previousMaintenance = state.maintenance ?? null;
  if (marker === "unreadable") await io.log({ event: "maintenance_marker_unreadable" });
  if (maintenance !== null && maintenance.startedAt !== previousMaintenance?.startedAt)
    await io.log({ event: "maintenance_active", expiresAt: maintenance.expiresAt });
  else if (maintenance === null && previousMaintenance !== null)
    await io.log({
      event:
        now >= Date.parse(previousMaintenance.expiresAt)
          ? "maintenance_expired"
          : "maintenance_ended",
    });
  const advanced = advanceAlertState(state.alert, conditions, now, undefined, {
    held: maintenance === null ? [] : PLANNED_MAINTENANCE_HELD_KEYS,
  });
  for (const item of advanced.notifications)
    await io.log({ event: `alert_${item.kind}`, key: item.key, severity: item.severity });
  const channels = await deliver({
    channels: io.channels,
    channelState: state.channels,
    notifications: advanced.notifications,
    now,
    config,
    log: io.log,
  });
  const next = {
    schemaVersion: 1,
    alert: advanced.state,
    probes: probes.failingSince,
    channels,
    maintenance,
  };
  await io.writeState(next);
  await io.writeBoard(
    buildAlertBoard(advanced.state, {
      observedAt: new Date(now).toISOString(),
      channels: {
        email: config.email !== null,
        webhooks: config.webhooks.length,
        heartbeat: config.heartbeat !== null,
      },
      backup: observations.backup === "unreadable" ? null : observations.backup,
      maintenance,
    }),
  );
  return next;
}

function createIo(runtimeDirectory, opsDirectory, config, log) {
  const absolute = path.resolve(runtimeDirectory);
  return {
    observeProbes: async (previous, now) => {
      let ca = null;
      try {
        ca = await fs.readFile(path.join(absolute, "customer-tls-cert.pem"));
      } catch {
        /* Without the certificate the HTTPS probes fail and are reported. */
      }
      return observeProbes(previous, now, { ca });
    },
    observeSupervisor: (now) => observeSupervisor(absolute, now),
    observeMaintenance: () => readPlannedMaintenance(absolute),
    observeBackup: (configured) => observeBackup(absolute, configured),
    observeCertificate: (live) => observeCertificate(absolute, live),
    observeDisks: async (current) =>
      observeDisks({
        runtime: absolute,
        backups: current.backup ? path.resolve(current.backup.directory) : null,
        database: (await fs.stat("/pilot-data").catch(() => null)) ? "/pilot-data" : null,
        offsite: current.backup?.offsite?.path ?? null,
      }),
    log,
    writeState: (value) => writePrivateJson(path.join(opsDirectory, ALERT_STATE_FILE), value),
    writeBoard: (value) => writePrivateJson(path.join(opsDirectory, ALERT_BOARD_FILE), value),
  };
}

async function loadBusiness(runtimeDirectory) {
  // Loaded lazily: these modules need the workspace TypeScript loader and the database.
  const [
    { loadPilotInstallation },
    { createConfiguredPilotResources },
    reconciliation,
    status,
    receipt,
    heldStock,
    pickupCapacity,
    quote,
    pricing,
  ] = await Promise.all([
    import("./pilot-installation.mjs"),
    import("./pilot-configured-resources.mjs"),
    import("./pilot-reconciliation-exceptions.mjs"),
    import("./pilot-ops-settlement.mjs"),
    import("./pilot-receipt.mjs"),
    import("./pilot-held-stock.mjs"),
    import("./pilot-pickup-capacity-schedule.mjs"),
    import("./pilot-configured-quote.mjs"),
    import("./pilot-pricing-policy.mjs"),
  ]);
  const directory = path.resolve(runtimeDirectory);
  const installation = await loadPilotInstallation(directory);
  const resources = await createConfiguredPilotResources(directory);
  return {
    resources,
    installation,
    dependencies: {
      createReconciliationExceptions: reconciliation.createInternalReconciliationExceptions,
      readSettlementStatus: status.readPilotSettlementProblems,
      readReceiptTemplate: receipt.readInternalReceiptTemplateReadiness,
      readHeldStockOrders: heldStock.readInternalHeldStockOrders,
      readPickupCapacityHorizon: pickupCapacity.readInternalPickupCapacityHorizon,
      readQuoteTaxConfiguration: (current) =>
        quote.readInternalQuoteTaxReadiness(current, () =>
          pricing.createInternalPricingPolicy({
            loadProfile: installation.loadProfile,
            loadMenu: installation.loadMenu,
            expectedDatabaseName: installation.database,
          }),
        ),
    },
  };
}

async function loadConfig(runtimeDirectory, previous, log) {
  try {
    return await loadPilotOpsConfig(runtimeDirectory);
  } catch (error) {
    await log({ event: "ops_config_invalid", reason: String(error?.reason ?? "unreadable") });
    return previous ?? parsePilotOpsConfig(null, runtimeDirectory);
  }
}

export async function runPilotOps({ runtimeDirectory, signal }) {
  const opsDirectory = await ensureOpsDirectory(runtimeDirectory);
  const lock = path.join(opsDirectory, "monitor.lock");
  const handle = await fs.open(lock, "wx", 0o600).catch(() => {
    throw Error("PILOT_OPS_ALREADY_RUNNING");
  });
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  const log = createAlertLog(path.join(opsDirectory, ALERT_LOG_FILE));
  const statusFile = path.join(opsDirectory, BACKUP_STATUS_FILE);
  const requestFile = path.join(opsDirectory, BACKUP_REQUEST_FILE);
  const business = createBusinessObserver({ runtimeDirectory, load: loadBusiness });
  let config = null;
  let state = (await readPrivateJson(path.join(opsDirectory, ALERT_STATE_FILE)).catch(
    () => null,
  )) ?? {
    schemaVersion: 1,
    alert: emptyAlertState(),
    probes: {},
    channels: {},
  };
  let backupRun = null;
  let installation = null;
  let heartbeat = null,
    heartbeatKey = null;
  await log({ event: "monitor_started" });
  try {
    while (!signal.aborted) {
      const now = Date.now();
      config = await loadConfig(runtimeDirectory, config, log);
      const io = {
        ...createIo(runtimeDirectory, opsDirectory, config, log),
        observeBusiness: business,
        channels: createOutboundChannels(config, runtimeDirectory),
      };
      try {
        state = await runMonitorCycle({ now, state, config, io });
      } catch {
        await log({ event: "monitor_cycle_failed" });
      }
      try {
        // One heartbeat per configuration, so its interval survives between cycles.
        const key = JSON.stringify(config.heartbeat);
        if (key !== heartbeatKey) {
          heartbeat = createHeartbeat(config, runtimeDirectory);
          heartbeatKey = key;
        }
        await heartbeat?.beat(now);
      } catch {
        await log({ event: "heartbeat_failed" });
      }
      // Backups run beside the loop, one at a time, so probes keep running during a long dump.
      if (config.backup !== null && backupRun === null) {
        const requested = await fs
          .rm(requestFile)
          .then(() => true)
          .catch(() => false);
        const status = (await readPrivateJson(statusFile).catch(() => null)) ?? emptyBackupStatus();
        const decision = decideBackupRun({ now, backup: config.backup, status, requested });
        if (decision.run) {
          await log({ event: "backup_started", reason: decision.reason });
          const backup = config.backup;
          backupRun = (async () => {
            installation ??= JSON.parse(
              await fs.readFile(path.join(runtimeDirectory, "installation.json"), "utf8"),
            );
            const next = await runBackupCycle({
              now,
              runtimeDirectory,
              installation: { port: installation.port, database: installation.database },
              backup,
              status,
              log,
            });
            await writePrivateJson(statusFile, next);
          })()
            .catch(() => log({ event: "backup_failed", stage: "monitor" }))
            .finally(() => {
              backupRun = null;
            });
        }
      }
      try {
        await delay(MONITOR_INTERVAL_MS, undefined, { signal });
      } catch {
        break;
      }
    }
    await backupRun;
  } finally {
    await log({ event: "monitor_stopped" });
    await fs.rm(lock, { force: true });
  }
}

/** Sends one test message to each configured outbound channel and reports each result. */
export async function sendTestAlert(runtimeDirectory, { channels } = {}) {
  const config = await loadPilotOpsConfig(runtimeDirectory);
  const opsDirectory = await ensureOpsDirectory(runtimeDirectory);
  const log = createAlertLog(path.join(opsDirectory, ALERT_LOG_FILE));
  const outbound = channels ?? createOutboundChannels(config, runtimeDirectory);
  const message = renderMessage(
    [{ kind: "test", key: null, severity: "warning", params: {}, at: new Date().toISOString() }],
    config,
  );
  const results = [];
  for (const channel of outbound) {
    try {
      await channel.send(message);
      results.push({ channel: channel.id, result: "Delivered" });
    } catch (error) {
      results.push({
        channel: channel.id,
        result: "Failed",
        code: /^PILOT_[A-Z_]+$/u.test(error?.message ?? "")
          ? error.message
          : "PILOT_ALERT_DELIVERY_FAILED",
      });
    }
  }
  await log({ event: "test_alert", results });
  return {
    channels: results,
    localBoard: "Always on",
    note: outbound.length === 0 ? "NoOutboundChannels" : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  // `maintenance start|end <runtime> ...` names its action before the runtime directory.
  const [command, runtime, ...rest] =
    argv[0] === "maintenance" ? [`maintenance ${argv[1]}`, ...argv.slice(2)] : argv;
  const controller = new globalThis.AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const runtimeDirectory = runtimeArgument(runtime);
    if (command === "run" && rest.length === 0)
      await runPilotOps({ runtimeDirectory, signal: controller.signal });
    else if (command === "test-alert" && rest.length === 0)
      console.log(JSON.stringify(await sendTestAlert(runtimeDirectory)));
    else if (command === "backup-now" && rest.length === 0) {
      const ops = await ensureOpsDirectory(runtimeDirectory);
      await fs.writeFile(path.join(ops, BACKUP_REQUEST_FILE), "", { mode: 0o600 });
      console.log("PILOT_BACKUP_REQUESTED (the monitor starts it within a minute)");
    } else if (command === "status" && rest.length === 0) {
      const board = await readPrivateJson(path.join(runtimeDirectory, "ops", ALERT_BOARD_FILE));
      const marker = await readPlannedMaintenance(runtimeDirectory);
      const plannedUpdate =
        marker === null || marker === "unreadable"
          ? marker
          : { ...marker, inForce: activePlannedMaintenance(marker, Date.now()) !== null };
      console.log(
        JSON.stringify(
          board === null
            ? { monitor: "NotRunning", plannedUpdate }
            : {
                observedAt: board.observedAt,
                active: board.active.map((item) => ({
                  key: item.key,
                  severity: item.severity,
                  raisedAt: item.raisedAt,
                })),
                lastSuccessfulBackupAt: board.lastSuccessfulBackupAt,
                plannedUpdate,
              },
        ),
      );
    } else if (command === "maintenance start") {
      const options = parseOptions(rest, ["--reason", "--minutes", "--by"]);
      if (options["--reason"] === undefined) throw Error("PILOT_MAINTENANCE_REASON_INVALID");
      const marker = await startPlannedMaintenance(runtimeDirectory, {
        reason: options["--reason"],
        ...(options["--by"] === undefined ? {} : { startedBy: options["--by"] }),
        minutes:
          options["--minutes"] === undefined
            ? PLANNED_MAINTENANCE_MAX_MINUTES
            : /^\d{1,2}$/u.test(options["--minutes"])
              ? Number(options["--minutes"])
              : NaN,
      });
      const ops = await ensureOpsDirectory(runtimeDirectory);
      await createAlertLog(path.join(ops, ALERT_LOG_FILE))({
        event: "maintenance_started",
        expiresAt: marker.expiresAt,
      });
      console.log(
        `PILOT_MAINTENANCE_STARTED until ${marker.expiresAt} (store-down alerts wait until then; end it when the pages load)`,
      );
    } else if (command === "maintenance end" && rest.length === 0) {
      const removed = await endPlannedMaintenance(runtimeDirectory);
      if (removed) {
        const ops = await ensureOpsDirectory(runtimeDirectory);
        await createAlertLog(path.join(ops, ALERT_LOG_FILE))({ event: "maintenance_stopped" });
      }
      console.log(
        removed
          ? "PILOT_MAINTENANCE_ENDED (alerts are back to normal from the next check)"
          : "PILOT_MAINTENANCE_NOT_ACTIVE",
      );
    } else if (command === "generate-offsite-key" && rest.length === 0) {
      const config = await loadPilotOpsConfig(runtimeDirectory);
      if (!config.backup?.offsite) throw Error("PILOT_OFFSITE_NOT_CONFIGURED");
      await generateOffsiteKey(runtimeDirectory, config.backup.offsite.keyFile);
      console.log("PILOT_OFFSITE_KEY_CREATED (store a copy away from this host; see the runbook)");
    } else if (command === "decrypt-backup" && rest.length === 2) {
      const config = await loadPilotOpsConfig(runtimeDirectory);
      if (!config.backup?.offsite) throw Error("PILOT_OFFSITE_NOT_CONFIGURED");
      const [source, target] = rest;
      const name = path.basename(source).replace(/\.enc$/u, "");
      if (name === path.basename(source)) throw Error("PILOT_OFFSITE_FILE_INVALID");
      await decryptFile(
        source,
        target,
        await readOffsiteKey(runtimeDirectory, config.backup.offsite.keyFile),
        name,
      );
      console.log(`PILOT_OFFSITE_DECRYPTED ${name}`);
    } else throw Error("PILOT_OPS_ARGUMENT_INVALID");
  } catch (error) {
    console.error(
      /^PILOT_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "PILOT_OPS_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}
