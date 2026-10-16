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
});
const COMPONENT_NAMES = Object.freeze({
  events: "order updates",
  paymentWait: "waiting for payment results",
  inventoryRelease: "stock release",
  pickupPaymentExpiry: "unpaid pickup expiry",
  diningCheckoutExpiry: "table checkout expiry",
  contactRetention: "customer contact deletion",
  batchCancellation: "cancellations",
  compensation: "automatic refunds",
  kitchen: "kitchen board",
  reconciliation: "payment checks",
  dailySettlement: "day-end settlement",
  diningException: "table follow-ups",
  workload: "background work",
});
const DISK_NAMES = Object.freeze({
  runtime: "the pilot data folder",
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

/**
 * The closed alert catalog. `severity` may be overridden per condition (escalation). Each entry
 * renders a title, a plain summary and what staff or the Owner should do; `runbook` names the
 * runbook anchor in docs/runbooks/single-store-pilot.md ("What each alert means").
 */
export const ALERT_CATALOG = Object.freeze({
  "entry.api": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Store system is not responding",
    summary: (p) =>
      `The ordering service has failed its health check for ${formatDuration(p.downMs)}. Staff screens and online ordering are probably not working.`,
    action: () =>
      "Follow the store outage procedure (pause online ordering, take paper orders). Ask the pilot operator to check the host and restart the pilot.",
    runbook: "alert-store-system-down",
  },
  "entry.customer": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Customer ordering page is not loading",
    summary: (p) =>
      `The secure customer ordering page has not loaded for ${formatDuration(p.downMs)}. Guests cannot scan, order or pay online.`,
    action: () =>
      "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask the pilot operator to restart the pilot.",
    runbook: "alert-customer-entry-down",
  },
  "entry.merchant": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Staff screens are not loading",
    summary: (p) =>
      `The staff app (Orders, Kitchen, Pickup) has not loaded for ${formatDuration(p.downMs)}.`,
    action: () =>
      "Follow the store outage procedure. Ask the pilot operator to check the host and restart the pilot.",
    runbook: "alert-merchant-entry-down",
  },
  "supervisor.silent": {
    severity: "critical",
    raiseAfterMs: 2 * MINUTE,
    title: () => "Background services are not being watched",
    summary: (p) =>
      p.reportAgeMs === null
        ? "The pilot supervisor has not reported since the monitor started. Background work (kitchen updates, payment checks, refunds) may have stopped."
        : `The pilot supervisor last reported ${formatDuration(p.reportAgeMs)} ago. Background work (kitchen updates, payment checks, refunds) may have stopped.`,
    action: () => "Ask the pilot operator to check the pilot container and restart it.",
    runbook: "alert-supervisor-silent",
  },
  "service.attention": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "A background service needs a person",
    summary: (p) =>
      `${list(p.services)} ${p.services.length === 1 ? "has" : "have"} kept failing and will not fix ${p.services.length === 1 ? "itself" : "themselves"}.`,
    action: () =>
      "Ask the pilot operator to read the service log and restart the named service. Check Orders and Exceptions for work that may be waiting.",
    runbook: "alert-service-attention",
  },
  "payment.updates": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "Order or payment updates are stuck",
    summary: (p) =>
      `${count(p.count, "update", "updates")} (such as a payment result or an order change) could not be processed after automatic retries (oldest ${formatDuration(p.oldestAgeMs)} ago). Paid orders may look unpaid, not reach the kitchen, or not show as ready for pickup after the kitchen finished them.`,
    action: () =>
      "Do not take a second payment from guests who say they paid. Check Orders and Exceptions; ask the pilot operator to review the stuck updates (dead-letter list) and retry them.",
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
      'Hand over ready orders in person: check the order number plus the guest\'s name or phone number. Compare the kitchen board with Orders. Ask the pilot operator to read the order processing log now; if it is not fixed, this becomes "Order or payment updates are stuck".',
    runbook: "alert-updates-retrying",
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
      "Tell guests who ask that their receipt will appear on their order page once this is fixed. Owner: in Store setup choose a receipt template that is published (step 5), then send, approve and publish the setup (step 8). Receipts for orders paid meanwhile then follow automatically; if this lasted over 30 minutes, ask the pilot operator to retry stuck updates.",
    runbook: "alert-receipts-template",
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
  "backup.failed": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "Last night's backup failed",
    summary: (p) =>
      `The scheduled backup failed at the ${p.stage} step. ${p.attemptsLeft > 0 ? `It will retry automatically (${count(p.attemptsLeft, "try", "tries")} left today).` : "No more automatic tries today."}`,
    action: () =>
      "Ask the pilot operator to run the backup by hand and check free disk space. Store operation is not affected.",
    runbook: "alert-backup-failed",
  },
  "backup.stale": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "No recent backup",
    summary: (p) =>
      p.ageMs === null
        ? "No successful backup has been recorded for this store yet."
        : `The newest successful backup is ${formatDuration(p.ageMs)} old. If the host failed now, recent orders and payments could be lost.`,
    action: () =>
      "Ask the pilot operator to run a backup now and check that the scheduled backup is running.",
    runbook: "alert-backup-stale",
  },
  "backup.restore_check": {
    severity: "critical",
    raiseAfterMs: 0,
    title: () => "The newest backup could not be restored",
    summary: () =>
      "The automatic restore check of the newest backup failed, so it may not be usable.",
    action: () =>
      "Ask the pilot operator to take a new backup and run the restore check by hand. Keep the previous backups.",
    runbook: "alert-backup-restore-check",
  },
  "backup.offsite": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Off-site backup copy failed",
    summary: () =>
      "The encrypted copy of the newest backup could not be written to the off-site location. The local backup is fine.",
    action: () =>
      "Ask the pilot operator to check the off-site folder or drive is connected and has space.",
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
      "Ask the pilot operator to renew the secure connection certificate and trust the new one on staff devices.",
    runbook: "alert-certificate-expiring",
  },
  "disk.low": {
    severity: "warning",
    raiseAfterMs: 0,
    title: () => "Disk space is running low",
    summary: (p) =>
      `${p.disks.map((d) => `${DISK_NAMES[d.name]} has ${bytes(d.freeBytes)} free (${d.freePercent}%)`).join("; ")}. When it fills, orders and backups stop.`,
    action: () =>
      "Ask the pilot operator to free space (old logs, old backup copies) or add storage.",
    runbook: "alert-disk-low",
  },
  "monitor.source": {
    severity: "warning",
    raiseAfterMs: 5 * MINUTE,
    title: () => "Some checks could not run",
    summary: (p) =>
      `The monitor could not read ${p.sources.join(", ")}. Problems there would not be reported.`,
    action: () => "Ask the pilot operator to check the monitor log.",
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
  disk: "disk space",
  receipts: "the receipt template check",
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
  diskWarnPercent: 15,
  diskWarnBytes: 5 * 1024 ** 3,
  diskCriticalPercent: 5,
  diskCriticalBytes: 1024 ** 3,
  channelFailingMs: 30 * MINUTE,
  retryingCriticalMs: 30 * MINUTE,
});
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Turns one cycle's observations into the set of currently true conditions (key → {severity,
 * params}). Missing observation groups are reported as unreadable sources, never as healthy.
 */
export function evaluateAlertConditions(observations, thresholds = DEFAULT_THRESHOLDS) {
  const now = observations.now;
  const conditions = new Map();
  const unreadable = [];
  const raise = (key, params = {}, severity = ALERT_CATALOG[key].severity) =>
    conditions.set(key, { severity, params });

  for (const [name, key] of Object.entries(PROBE_KEYS)) {
    const probe = observations.probes?.[name];
    if (probe && probe.ok === false) raise(key, { downMs: Math.max(0, probe.failingForMs ?? 0) });
  }
  const supervisor = observations.supervisor;
  if (supervisor === undefined || supervisor === "unreadable") unreadable.push("supervisor");
  else if (supervisor === null || supervisor.reportAgeMs > thresholds.supervisorSilentMs)
    raise("supervisor.silent", { reportAgeMs: supervisor?.reportAgeMs ?? null });
  else if (supervisor.attention.length > 0)
    raise("service.attention", { services: [...supervisor.attention].sort() });

  const business = observations.business;
  if (business === undefined || business === "unreadable") unreadable.push("business");
  else {
    const pick = (value) => natural(value?.count) && value.count > 0;
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
        business.retryingUpdates.oldestAgeMs > thresholds.retryingCriticalMs
          ? "critical"
          : "warning",
      );
    // Absent (null) when not checked; "unreadable" when the check itself failed.
    if (business.receiptTemplate === "unreadable") unreadable.push("receipts");
    else if (business.receiptTemplate?.ready === false)
      raise("receipts.template", {
        reason:
          business.receiptTemplate.reason === "StoreConfigurationUnavailable"
            ? "StoreConfigurationUnavailable"
            : "TemplateNotProven",
      });
    if (pick(business.reconciliationDifferences))
      raise(
        "reconciliation.differences",
        {
          count: business.reconciliationDifferences.count,
          oldestAgeMs: business.reconciliationDifferences.oldestAgeMs,
        },
        business.reconciliationDifferences.oldestAgeMs > 24 * HOUR ? "critical" : "warning",
      );
    if (pick(business.settlementExceptions))
      raise("settlement.exceptions", {
        count: business.settlementExceptions.count,
        oldestAgeMs: business.settlementExceptions.oldestAgeMs,
      });
  }

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
  if (unreadable.length > 0)
    raise("monitor.source", { sources: unreadable.map((name) => SOURCE_NAMES[name]) });
  return conditions;
}

export const DEFAULT_POLICY = Object.freeze({
  clearAfterMs: 2 * MINUTE,
  remindAfterMs: Object.freeze({ critical: 3 * HOUR, warning: 24 * HOUR }),
  maxMessagesPerHour: 6,
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
export function advanceAlertState(previous, conditions, now, policy = DEFAULT_POLICY) {
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
    entry.severity = condition.severity;
    entry.params = condition.params;
    entry.lastSeenAt = stamp;
    entry.absentSince = null;
    state.alerts[key] = entry;
    if (entry.raisedAt === null) {
      if (now - Date.parse(entry.firstSeenAt) >= catalog.raiseAfterMs) {
        entry.raisedAt = stamp;
        entry.notifiedAt = stamp;
        entry.notifiedSeverity = entry.severity;
        notify("raised", key, entry);
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
      });
      removed.add(key);
    }
  }
  state.alerts = Object.fromEntries(
    Object.entries(state.alerts).filter(([key]) => !removed.has(key)),
  );
  state.cleared = state.cleared.filter(
    (entry) => now - Date.parse(entry.clearedAt) < policy.clearedVisibleMs,
  );
  return { state, notifications };
}

/**
 * Per-channel outbound queue with an hourly cap. All pending notifications for a channel are sent
 * as one message; when the cap is reached they wait (and are merged) until a slot frees up, so a
 * flapping host can never send more than `maxMessagesPerHour` messages per channel.
 */
export function planChannelDelivery(channel, notifications, now, policy = DEFAULT_POLICY) {
  const next = globalThis.structuredClone(
    channel ?? { pending: [], sentAt: [], consecutiveFailures: 0, failingSince: null },
  );
  next.pending.push(...notifications);
  next.pending = next.pending.filter((item) => now - Date.parse(item.at) < policy.pendingMaxAgeMs);
  next.sentAt = next.sentAt.filter((at) => now - Date.parse(at) < HOUR);
  const due = next.pending.length > 0 && next.sentAt.length < policy.maxMessagesPerHour;
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
export function renderAlert(key, params) {
  const catalog = ALERT_CATALOG[key];
  return {
    title: catalog.title(params),
    summary: catalog.summary(params),
    action: catalog.action(params),
    runbook: catalog.runbook,
  };
}
const runbookLink = (base, anchor) => `${base}#${anchor}`;

/**
 * One outbound message for a batch. `siteLabel` and `runbookBase` come from the Owner's alert
 * configuration (validated plain text and an https URL or repository path).
 */
export function renderMessage(batch, { siteLabel, runbookBase, homeUrl = null }) {
  const ordered = [...batch].sort(
    (a, b) =>
      (a.kind === "cleared") - (b.kind === "cleared") ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const open = ordered.filter((item) => item.kind !== "cleared" && item.kind !== "test");
  const top = ordered[0];
  const lines = ordered.map((item) => {
    if (item.kind === "test") return "Test alert: this channel works. No action is needed.";
    const text = renderAlert(item.key, item.params);
    if (item.kind === "cleared") return `${KIND_LABEL.cleared}: ${text.title}.`;
    return `${KIND_LABEL[item.kind]} (${item.severity === "critical" ? "urgent" : "today"}): ${text.title}. ${text.summary} What to do: ${text.action} Runbook: ${runbookLink(runbookBase, text.runbook)}`;
  });
  let subject;
  if (top.kind === "test") subject = `${siteLabel}: test alert`;
  else if (ordered.length === 1)
    subject = `${siteLabel}: ${top.kind === "cleared" ? "Resolved - " : top.severity === "critical" ? "URGENT - " : ""}${renderAlert(top.key, top.params).title}`;
  else
    subject = `${siteLabel}: ${open.length > 0 ? `${count(open.length, "problem", "problems")}${open.some((item) => item.severity === "critical") ? " (urgent)" : ""}` : "problems resolved"}`;
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
export function buildAlertBoard(state, { observedAt, channels, backup }) {
  const active = Object.entries(state.alerts)
    .filter(([, entry]) => entry.raisedAt !== null)
    .map(([key, entry]) => ({
      key,
      severity: entry.severity,
      raisedAt: entry.raisedAt,
      lastSeenAt: entry.lastSeenAt,
      ...renderAlert(key, entry.params),
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
      .map((entry) => ({
        key: entry.key,
        title: ALERT_CATALOG[entry.key].title({ remainingMs: 1 }),
        clearedAt: entry.clearedAt,
      }))
      .slice(-10),
    outboundChannels: channels,
    lastSuccessfulBackupAt: backup?.lastSuccessAt ?? null,
  };
}
