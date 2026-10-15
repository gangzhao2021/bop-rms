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
        ...(url.protocol === "https:" ? { ca, rejectUnauthorized: true } : {}),
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

export async function observeCertificate(runtimeDirectory, liveValidTo) {
  if (liveValidTo) return { validTo: liveValidTo };
  try {
    const pem = await fs.readFile(path.join(runtimeDirectory, "customer-tls-cert.pem"));
    return { validTo: new Date(new X509Certificate(pem).validTo).toISOString() };
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

const DEAD_LETTER_SUMMARY =
  "SELECT count(*)::int AS count, min(opened_at) AS oldest FROM platform_eventing.dead_letter_item WHERE status IN ('open','retry_scheduled')";
const settlementMissingGraceMs = 6 * 60 * 60_000;

/**
 * Payment and settlement signals for the installation's Store, through the api role and its
 * Brand/Store row security. Stuck updates: dead-lettered events (Store rows and Brand-wide rows);
 * reconciliation differences: owner exception source items not yet closed by a refund; settlement:
 * the daily settlement status (days with differences, and closed days still missing after 6 h).
 */
export async function readBusinessSignals({
  resources,
  installation,
  now,
  dependencies,
  settlementExceptions = null,
}) {
  const age = (instant) => (instant === null ? 0 : Math.max(0, now - Date.parse(instant)));
  const iso = (value) =>
    value === null || value === undefined ? null : new Date(value).toISOString();
  const store = await resources.transactions.run((tx) => tx.query(DEAD_LETTER_SUMMARY, []));
  const brand = await resources.database
    .transactions({ brandId: resources.scope.brandReference })
    .run((tx) => tx.query(DEAD_LETTER_SUMMARY, []));
  const deadRows = [...store.rows, ...brand.rows];
  const deadOldest =
    deadRows
      .map((row) => iso(row.oldest))
      .filter((value) => value !== null)
      .sort()[0] ?? null;
  const stuckUpdates = {
    count: deadRows.reduce((sum, row) => sum + Number(row.count), 0),
    oldestAgeMs: age(deadOldest),
  };

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

  // WP-2423: a recent clean settlement answer may be reused (see createBusinessObserver).
  if (settlementExceptions !== null)
    return {
      stuckUpdates,
      reconciliationDifferences: { count: open, oldestAgeMs: age(oldest) },
      settlementExceptions,
    };
  const settlement = await dependencies.readSettlementStatus({ resources, installation });
  const problems = settlement.days.filter(
    (day) =>
      (day.state === "Recorded" && day.outcome !== "Matched") ||
      (day.state === "Missing" && now - Date.parse(day.endsAt) > settlementMissingGraceMs),
  );
  const settlementOldest = problems.map((day) => day.endsAt).sort()[0] ?? null;
  return {
    stuckUpdates,
    reconciliationDifferences: { count: open, oldestAgeMs: age(oldest) },
    settlementExceptions: { count: problems.length, oldestAgeMs: age(settlementOldest) },
  };
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
}) {
  let state = null;
  let last = undefined;
  let lastAt = 0;
  let settlement = null;
  let settlementAt = 0;
  return async (now) => {
    if (last !== undefined && last !== "unreadable" && now - lastAt < intervalMs) return last;
    try {
      state ??= await load(runtimeDirectory);
      const reuse =
        settlement !== null && settlement.count === 0 && now - settlementAt < settlementIntervalMs
          ? settlement
          : null;
      last = await readBusinessSignals({ ...state, now, settlementExceptions: reuse });
      if (reuse === null) {
        settlement = last.settlementExceptions;
        settlementAt = now;
      }
      lastAt = now;
    } catch {
      await state?.resources?.close?.().catch(() => undefined);
      state = null;
      settlement = null;
      last = "unreadable";
    }
    return last;
  };
}
