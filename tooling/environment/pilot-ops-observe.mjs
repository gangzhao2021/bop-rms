// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): what the operations monitor observes each cycle. Every
// collector returns counts, ages, states or instants only; any failure becomes "unreadable" (the
// monitor alerts on that too) and never a guess that things are fine.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import {
  BACKUP_STATUS_FILE,
  OPS_DIRECTORY,
  SUPERVISOR_HEALTH_FILE,
  readPrivateJson,
} from "./pilot-ops-files.mjs";

/**
 * External-style probes through the same published path as staff and guests (the loopback proxy
 * ports in the pilot network namespace): API readiness, the customer HTTPS entry and the merchant
 * app, with the pilot certificate as the only trusted root.
 */
export const DEFAULT_PROBE_TARGETS = Object.freeze({
  api: { url: "http://127.0.0.1:14300/ready" },
  customer: { url: "https://127.0.0.1:14443/", host: "127.0.0.1:4443" },
  merchant: { url: "https://127.0.0.1:14443/app", host: "127.0.0.1:4443" },
});
/**
 * DEC-PILOT-MAINTENANCE-PAGE: with a hosted customer origin the probes still go through the
 * published port, but ask for the Store's host name. When the front serves the hosting's public
 * certificate (`tls.mode: front`) it is checked against the public trust store for that name
 * (`systemTrust`); otherwise the local entry's certificate stays the only trusted root.
 */
export function probeTargetsFor(hosting) {
  if (!hosting?.configured) return { targets: DEFAULT_PROBE_TARGETS, systemTrust: false };
  const front = hosting.tls.mode === "front";
  const entry = (url) => ({
    url,
    host: hosting.host,
    ...(front ? { servername: hosting.hostname } : {}),
  });
  return {
    targets: {
      api: DEFAULT_PROBE_TARGETS.api,
      customer: entry("https://127.0.0.1:14443/"),
      merchant: entry("https://127.0.0.1:14443/app"),
    },
    systemTrust: front,
  };
}
export function probeEntry(target, { ca = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(target.url);
    const client = url.protocol === "https:" ? https : http;
    let certificate = null;
    const request = client.request(
      url,
      {
        method: "GET",
        headers: {
          ...(target.host ? { host: target.host } : {}),
          "user-agent": "bop-rms-pilot-monitor",
        },
        timeout: timeoutMs,
        ...(url.protocol === "https:"
          ? {
              ...(ca === null ? {} : { ca }),
              ...(target.servername ? { servername: target.servername } : {}),
              rejectUnauthorized: true,
            }
          : {}),
      },
      (response) => {
        const peer = response.socket.getPeerCertificate?.();
        if (peer && peer.valid_to) certificate = new Date(peer.valid_to).toISOString();
        response.resume();
        response.on("end", () => resolve({ ok: response.statusCode === 200, certificate }));
      },
    );
    request.on("timeout", () => request.destroy(Error("timeout")));
    request.on("error", () => resolve({ ok: false, certificate }));
    request.end();
  });
}

/** Tracks how long each probe has been failing (kept in the persisted monitor state). */
export async function observeProbes(
  previous,
  now,
  { probe = probeEntry, targets = DEFAULT_PROBE_TARGETS, ca },
) {
  const results = {};
  const since = { ...(previous ?? {}) };
  let certificate = null;
  for (const [name, target] of Object.entries(targets)) {
    const result = await probe(target, { ca });
    if (result.certificate) certificate = result.certificate;
    if (!result.ok) since[name] ??= new Date(now).toISOString();
    else since[name] = null;
    results[name] = result.ok
      ? { ok: true }
      : { ok: false, failingForMs: now - Date.parse(since[name]) };
  }
  return {
    probes: results,
    failingSince: Object.fromEntries(Object.entries(since).filter(([, value]) => value !== null)),
    liveCertificateValidTo: certificate,
  };
}

/** The supervisor's last sweep: services needing a person and how old the report is. */
export async function observeSupervisor(runtimeDirectory, now, read = readPrivateJson) {
  try {
    try {
      await fs.lstat(path.join(runtimeDirectory, "maintenance.lock"));
      return { maintenance: true, reportAgeMs: 0, attention: [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const health = await read(path.join(runtimeDirectory, SUPERVISOR_HEALTH_FILE));
    if (health === null) return null;
    const observed = Date.parse(health.observedAt);
    if (health.schemaVersion !== 1 || !Number.isFinite(observed) || !Array.isArray(health.services))
      return "unreadable";
    const attention = health.services
      .flatMap((entry) => [
        ...(entry.state === "attention_required" ? [String(entry.service)] : []),
        ...(Array.isArray(entry.attention)
          ? entry.attention.map((component) => `${entry.service}:${component}`)
          : []),
      ])
      .sort();
    return { maintenance: false, reportAgeMs: Math.max(0, now - observed), attention };
  } catch {
    return "unreadable";
  }
}

export async function observeBackup(runtimeDirectory, configured, read = readPrivateJson) {
  try {
    const status = await read(path.join(runtimeDirectory, OPS_DIRECTORY, BACKUP_STATUS_FILE));
    // No scheduled backup configured or none run yet: "no successful backup recorded".
    if (status === null) return { lastSuccessAt: null, configured };
    return { ...status, configured };
  } catch {
    return "unreadable";
  }
}

export async function observeCertificate(
  runtimeDirectory,
  liveValidTo,
  file = path.join(runtimeDirectory, "customer-tls-cert.pem"),
) {
  if (liveValidTo) return { validTo: liveValidTo };
  try {
    const pem = await fs.readFile(file);
    return { validTo: new Date(new X509Certificate(pem).validTo).toISOString() };
  } catch {
    return "unreadable";
  }
}

/**
 * DEC-PILOT-INSTALLATION: the end of the installation's validity window (the profile's
 * `binding.validUntil`), read as a plain file so the monitor needs neither the database nor the
 * workspace loader. Only the instant is returned; nothing else in the file is used.
 */
export async function observeInstallationValidity(
  runtimeDirectory,
  read = (file) => fs.readFile(file, "utf8"),
) {
  try {
    const profile = JSON.parse(
      await read(path.join(runtimeDirectory, "internal-test-profile.json")),
    );
    const validUntil = profile?.binding?.validUntil;
    if (
      typeof validUntil !== "string" ||
      !Number.isFinite(Date.parse(validUntil)) ||
      new Date(Date.parse(validUntil)).toISOString() !== validUntil
    )
      return "unreadable";
    return { validUntil };
  } catch {
    return "unreadable";
  }
}

export async function observeDisks(paths, statfs = fs.statfs) {
  try {
    const disks = [];
    for (const [name, target] of Object.entries(paths)) {
      if (!target) continue;
      const stat = await statfs(target);
      disks.push({
        name,
        freeBytes: Number(stat.bavail) * Number(stat.bsize),
        totalBytes: Number(stat.blocks) * Number(stat.bsize),
      });
    }
    return disks;
  } catch {
    return "unreadable";
  }
}

export const DEAD_LETTER_SUMMARY =
  "SELECT count(*)::int AS count, min(opened_at) AS oldest FROM platform_eventing.dead_letter_item WHERE status IN ('open','retry_scheduled')";
/**
 * WP-2423 (2026-10-16): early warning before a dead letter. Under the eventing retry policy a
 * failing event is dead-lettered only after 8 tries (about 36-71 minutes), so the stuck-updates
 * alert came 43 minutes after the kitchen finished an order. These read work that is still being
 * retried: a consumer retry not yet completed or dead-lettered that has failed 4 times (the first
 * try plus 3 retries) or began failing at least 10 minutes ago, and an unpublished, not dead-
 * lettered outbox event that has been tried 4 times or has been due for 10 minutes (including
 * events held behind an earlier one of the same order). Counts and instants only.
 *
 * Retry rows carry no first-failure instant; their deadline is that instant plus the policy's
 * 24-hour horizon (`retryPolicy.maximumHorizonMs`), so `deadline_at <= $1` with $1 = now - 10 min
 * + 24 h selects work failing for 10 minutes or more. Retry rows are Store- or Brand-scoped like
 * dead letters (row security shows one scope per transaction); outbox rows of the Brand are also
 * visible in the Store transaction, so the outbox is read there only.
 */
export const RETRYING_UPDATE_ATTEMPTS = 4;
export const RETRYING_UPDATE_AGE_MS = 10 * 60_000;
export const RETRY_HORIZON_MS = 24 * 60 * 60_000;
export const CONSUMER_RETRYING_SUMMARY =
  "SELECT count(*)::int AS count, min(deadline_at) AS oldest_deadline FROM platform_eventing.consumer_retry_schedule WHERE state IN ('scheduled','claimed') AND (attempt_count >= $1 OR deadline_at <= $2)";
export const OUTBOX_RETRYING_SUMMARY =
  "SELECT count(*)::int AS count, min(recorded_at) AS oldest FROM platform_eventing.outbox_event WHERE published_at IS NULL AND last_error_code IS NULL AND (attempt_count >= $1 OR available_at <= $2)";
const settlementMissingGraceMs = 6 * 60 * 60_000;

/**
 * Payment and settlement signals for one Store, through the api role and its Brand/Store row
 * security. Stuck updates: dead-lettered events (Store rows and Brand-wide rows);
 * retrying updates: events still being retried for a while (see above); reconciliation
 * differences: owner exception source items not yet closed by a refund; settlement: the daily
 * settlement status (days with differences, and closed days still missing after 6 h).
 */
const WORKFLOW_BINDINGS = Object.freeze(["Pickup", "DineIn", "AdditionalRelease", "Cancellation"]);
/** Only the closed shape goes on; anything else is unreadable, never a guess that all is well. */
function closedWorkflowReadiness(readiness) {
  if (readiness === null) return null;
  if (readiness?.ready === true) return { ready: true };
  if (
    readiness?.ready !== false ||
    !Array.isArray(readiness.refusals) ||
    readiness.refusals.length === 0 ||
    readiness.refusals.some(({ binding }) => !WORKFLOW_BINDINGS.includes(binding)) ||
    !Array.isArray(readiness.orderTypes)
  )
    throw Error("PILOT_WORKFLOW_READINESS_INVALID");
  return {
    ready: false,
    refusals: readiness.refusals.map(({ binding, rule }) => ({ binding, rule: String(rule) })),
    orderTypes: readiness.orderTypes.map(String),
  };
}

export async function readBusinessSignals({
  resources,
  installation,
  now,
  dependencies,
  settlementExceptions = null,
  // DEC-PILOT-ALERTS-BACKUP correction 2: a Store's owner hears nothing of a check that could not
  // run, so BOP must be able to find out why. Not composed for the installation's own Store.
  reportCheck: reportOnStoreBoard = null,
}) {
  const reportCheck = reportOnStoreBoard ?? (() => undefined);
  /** An answer rather than a failure: the Store's published settings could not be read. */
  const reportSettingsUnread = (check, readiness) => {
    if (readiness?.reason === "StoreConfigurationUnavailable")
      reportCheck(check, readiness.cause ?? Error("STORE_CONFIGURATION_UNAVAILABLE"));
  };
  /**
   * On a Store's board one part failing leaves the rest of the read standing: stuck updates must
   * still say "Do not take a second payment" while the settlement scan cannot run. At the root it
   * fails the read as a whole, as it always did.
   */
  const part = async (check, read) => {
    if (reportOnStoreBoard === null) return read();
    try {
      return await read();
    } catch (error) {
      reportCheck(check, error);
      return "unreadable";
    }
  };
  const age = (instant) => (instant === null ? 0 : Math.max(0, now - Date.parse(instant)));
  const iso = (value) =>
    value === null || value === undefined ? null : new Date(value).toISOString();
  const consumerParameters = [
    RETRYING_UPDATE_ATTEMPTS,
    new Date(now - RETRYING_UPDATE_AGE_MS + RETRY_HORIZON_MS).toISOString(),
  ];
  const store = await resources.transactions.run(async (tx) => ({
    dead: await tx.query(DEAD_LETTER_SUMMARY, []),
    consumer: await tx.query(CONSUMER_RETRYING_SUMMARY, consumerParameters),
    outbox: await tx.query(OUTBOX_RETRYING_SUMMARY, [
      RETRYING_UPDATE_ATTEMPTS,
      new Date(now - RETRYING_UPDATE_AGE_MS).toISOString(),
    ]),
  }));
  const brand = await resources.database
    .transactions({ brandId: resources.scope.brandReference })
    .run(async (tx) => ({
      dead: await tx.query(DEAD_LETTER_SUMMARY, []),
      consumer: await tx.query(CONSUMER_RETRYING_SUMMARY, consumerParameters),
    }));
  const deadRows = [...store.dead.rows, ...brand.dead.rows];
  const deadOldest =
    deadRows
      .map((row) => iso(row.oldest))
      .filter((value) => value !== null)
      .sort()[0] ?? null;
  const stuckUpdates = {
    count: deadRows.reduce((sum, row) => sum + Number(row.count), 0),
    oldestAgeMs: age(deadOldest),
  };
  const consumerRows = [...store.consumer.rows, ...brand.consumer.rows];
  const retryingOldest =
    [
      ...consumerRows
        .map((row) => iso(row.oldest_deadline))
        .filter((value) => value !== null)
        .map((value) => new Date(Date.parse(value) - RETRY_HORIZON_MS).toISOString()),
      ...store.outbox.rows.map((row) => iso(row.oldest)).filter((value) => value !== null),
    ].sort()[0] ?? null;
  const retryingUpdates = {
    count: [...consumerRows, ...store.outbox.rows].reduce((sum, row) => sum + Number(row.count), 0),
    oldestAgeMs: age(retryingOldest),
  };

  const reconciliationDifferences = await part("reconciliation", async () => {
    const page = dependencies.createReconciliationExceptions(resources);
    let after = null,
      open = 0,
      oldest = null;
    for (let n = 0; n < 50; n++) {
      const result = await page({ afterExceptionReference: after, limit: 100 });
      for (const item of result.items)
        if (item.state === "Open") {
          open += 1;
          if (oldest === null || item.openedAt < oldest) oldest = item.openedAt;
        }
      after = result.nextAfterExceptionReference;
      if (after === null) break;
    }
    return { count: open, oldestAgeMs: age(oldest) };
  });

  // DEC-PILOT-ALERTS-BACKUP correction 2: before a Store's Owner has published their own setup no
  // guest can be affected and the opening list is the right place, so these readiness checks wait.
  // Not composed for the installation's own Store, which always runs them.
  let opened = true;
  if (typeof dependencies.readOwnerPublishedSetup === "function")
    try {
      opened = (await dependencies.readOwnerPublishedSetup(resources)) === true;
    } catch (error) {
      reportCheck("openingSetup", error);
      opened = "unreadable";
    }
  const beforeOpening = opened === "unreadable" ? "unreadable" : null;

  // WP-2423 DEC-STORE-SETUP-PUBLICATION: can a receipt be issued with the template the Store's
  // published settings name (read only; ready/reason only)? null when not composed.
  let receiptTemplate = beforeOpening;
  if (opened === true && typeof dependencies.readReceiptTemplate === "function")
    try {
      const readiness = await dependencies.readReceiptTemplate(resources);
      reportSettingsUnread("receipts", readiness);
      receiptTemplate =
        readiness?.ready === true
          ? { ready: true }
          : { ready: false, reason: String(readiness?.reason ?? "TemplateNotProven") };
    } catch (error) {
      reportCheck("receipts", error);
      receiptTemplate = "unreadable";
    }

  // WP-2423 DEC-STORE-SETUP-PUBLICATION: can an order be priced with the tax configuration the
  // Store's published settings name (read only; ready/reason only)? null when not composed.
  let quoteTax = beforeOpening;
  if (opened === true && typeof dependencies.readQuoteTaxConfiguration === "function")
    try {
      const readiness = await dependencies.readQuoteTaxConfiguration(resources);
      reportSettingsUnread("quoteTax", readiness);
      quoteTax =
        readiness?.ready === true
          ? { ready: true }
          : { ready: false, reason: String(readiness?.reason ?? "TaxConfigurationMismatch") };
    } catch (error) {
      reportCheck("quoteTax", error);
      quoteTax = "unreadable";
    }

  // WP-2423 item 9: can orders still move through this Store's Workflows (read only; which binding
  // refused, the rule and the Store's order types only)? null when not composed or not installed yet.
  let workflow = null;
  if (typeof dependencies.readWorkflowReadiness === "function")
    try {
      workflow = closedWorkflowReadiness(await dependencies.readWorkflowReadiness(resources));
    } catch {
      workflow = "unreadable";
    }

  // WP-2423 (2026-10-16 v15 stock leak): Orders of earlier business days still holding stock.
  // null when not composed; "unreadable" when the check itself failed.
  let heldStock = null;
  if (typeof dependencies.readHeldStockOrders === "function")
    try {
      const held = await dependencies.readHeldStockOrders(resources);
      heldStock = {
        count: Number(held.openCount) + Number(held.endedCount),
        openCount: Number(held.openCount),
        oldestAgeMs: age(held.oldestAt ?? null),
      };
    } catch (error) {
      reportCheck("heldStock", error);
      heldStock = "unreadable";
    }

  // DEC-PICKUP-CAPACITY-SCHEDULE: how far ahead pickup capacity is set up without a gap.
  // null when not composed or when the Store does not offer pickup; "unreadable" when the check
  // itself failed.
  let pickupCapacity = beforeOpening;
  if (opened === true && typeof dependencies.readPickupCapacityHorizon === "function")
    try {
      const horizon = await dependencies.readPickupCapacityHorizon(resources);
      if (horizon !== null) {
        if (!Number.isSafeInteger(horizon?.coveredMs)) throw Error("PICKUP_CAPACITY_UNREADABLE");
        pickupCapacity = { coveredMs: Math.max(0, horizon.coveredMs) };
      }
    } catch (error) {
      reportCheck("pickupCapacity", error);
      pickupCapacity = "unreadable";
    }

  const signals = {
    stuckUpdates,
    retryingUpdates,
    receiptTemplate,
    quoteTax,
    workflow,
    heldStock,
    pickupCapacity,
    reconciliationDifferences,
  };
  // WP-2423: a recent clean settlement answer may be reused (see createBusinessObserver).
  if (settlementExceptions !== null) return { ...signals, settlementExceptions };
  const settlement = await part("settlement", async () => {
    // DEC-PILOT-ALERTS-BACKUP correction 2: a Store whose first closed day is not recorded yet has
    // no settlement to read: not checked, never "all settled", and BOP is told once a day has
    // closed. Not composed for the installation's own Store, where a missing file stays unreadable.
    if (
      typeof dependencies.isSettlementCovered === "function" &&
      (await dependencies.isSettlementCovered()) === false
    ) {
      // A closed day that could not be read is not "none yet": "unreadable" keeps what it said.
      const closed =
        opened === true
          ? await part(
              "closedDay",
              async () => (await dependencies.readClosedBusinessDay(resources)) === true,
            )
          : opened;
      return {
        settlementExceptions: null,
        settlementCovered: false,
        closedBusinessDay: closed === true || closed === "unreadable" ? closed : false,
      };
    }
    const status = await dependencies.readSettlementStatus({ resources, installation });
    const problems = status.days.filter(
      (day) =>
        (day.state === "Recorded" && day.outcome !== "Matched") ||
        (day.state === "Missing" && now - Date.parse(day.endsAt) > settlementMissingGraceMs),
    );
    const settlementOldest = problems.map((day) => day.endsAt).sort()[0] ?? null;
    return {
      settlementExceptions: { count: problems.length, oldestAgeMs: age(settlementOldest) },
    };
  });
  return settlement === "unreadable"
    ? { ...signals, settlementExceptions: "unreadable" }
    : { ...signals, ...settlement };
}

/**
 * How often business signals are read. WP-2423 (2026-10-15): a payment problem staff resolve
 * should leave the Home within about 3 minutes (one read plus the 2 quiet minutes), so stuck
 * updates and open payment differences — a few indexed queries — are read every minute. The
 * day-end settlement scan (up to 31 closed days, each a Store business-day read and its
 * settlement runs) is reread every minute only while it reports a problem, so a resolved day
 * clears just as fast; while every day is settled it is reread every 5 minutes.
 */
export const BUSINESS_SIGNAL_INTERVAL_MS = 60_000;
export const SETTLEMENT_SCAN_INTERVAL_MS = 5 * 60_000;
/** Reads business signals every `intervalMs`, keeping one api-role resource set while it works. */
export function createBusinessObserver({
  runtimeDirectory,
  intervalMs = BUSINESS_SIGNAL_INTERVAL_MS,
  settlementIntervalMs = SETTLEMENT_SCAN_INTERVAL_MS,
  load,
  report = () => undefined,
  reportCheck = null,
}) {
  let state = null;
  let last = undefined;
  let lastAt = 0;
  let settlement = null;
  let settlementAt = 0;
  // A check is reported when it turns unreadable, not every minute that it stays so.
  const reportedChecks = new Set();
  const observe = async (now) => {
    if (last !== undefined && last !== "unreadable" && now - lastAt < intervalMs) return last;
    try {
      state ??= await load(runtimeDirectory);
      // A scan that could not run waits like a clean one: it is the costliest read here, and
      // running it every minute only to fail again gains nothing. What it last said stays raised.
      const reuse =
        settlement !== null &&
        (settlement === "unreadable" || settlement.count === 0) &&
        now - settlementAt < settlementIntervalMs
          ? settlement
          : null;
      const failing = new Set(reuse === "unreadable" ? ["settlement"] : []);
      last = await readBusinessSignals({
        ...state,
        now,
        settlementExceptions: reuse,
        ...(reportCheck === null
          ? {}
          : {
              reportCheck: (check, error) => {
                failing.add(check);
                if (!reportedChecks.has(check)) reportCheck(check, error);
                reportedChecks.add(check);
              },
            }),
      });
      for (const check of reportedChecks) if (!failing.has(check)) reportedChecks.delete(check);
      if (reuse === null) {
        settlement = last.settlementExceptions;
        settlementAt = now;
      }
      lastAt = now;
    } catch (error) {
      report(error);
      await state?.resources?.close?.().catch(() => undefined);
      state = null;
      settlement = null;
      last = "unreadable";
    }
    return last;
  };
  /** Ends this observer's share of the connections (a Store that is no longer served). */
  observe.close = async () => {
    const current = state;
    state = null;
    await current?.resources?.close?.().catch(() => undefined);
  };
  return observe;
}
