import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALERT_KEYS,
  advanceAlertState,
  buildAlertBoard,
  emptyAlertState,
  evaluateAlertConditions,
  planChannelDelivery,
  recordChannelDelivery,
  renderAlert,
  renderMessage,
} from "./pilot-alerts.mjs";

const T0 = Date.parse("2026-10-15T03:00:00.000Z");
const MIN = 60_000;
const healthy = (now = T0) => ({
  now,
  probes: { api: { ok: true }, customer: { ok: true }, merchant: { ok: true } },
  supervisor: { maintenance: false, reportAgeMs: 5000, attention: [] },
  business: {
    stuckUpdates: { count: 0, oldestAgeMs: 0 },
    retryingUpdates: { count: 0, oldestAgeMs: 0 },
    reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
    settlementExceptions: { count: 0, oldestAgeMs: 0 },
  },
  backup: { lastSuccessAt: new Date(now - 3 * 3600_000).toISOString() },
  certificate: { validTo: new Date(now + 30 * 86400_000).toISOString() },
  disks: [{ name: "runtime", freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }],
  channels: [],
});
const keys = (conditions) => [...conditions.keys()].sort();

describe("WP-2423 Q13 alert rules", () => {
  it("raises nothing when every source is healthy", () => {
    expect(keys(evaluateAlertConditions(healthy()))).toEqual([]);
  });
  it("maps each source to its alert, with escalation by age or size", () => {
    const o = healthy();
    o.probes.customer = { ok: false, failingForMs: 3 * MIN };
    o.supervisor = {
      maintenance: false,
      reportAgeMs: 1000,
      attention: ["business-worker:paymentWait"],
    };
    o.business.stuckUpdates = { count: 2, oldestAgeMs: 10 * MIN };
    o.business.reconciliationDifferences = { count: 1, oldestAgeMs: 30 * 3600_000 };
    o.business.settlementExceptions = { count: 1, oldestAgeMs: 8 * 3600_000 };
    o.backup = {
      lastSuccessAt: new Date(T0 - 27 * 3600_000).toISOString(),
      lastAttempt: { result: "Failed", stage: "dump", attemptsLeft: 2 },
      restoreCheck: { result: "Failed" },
      offsite: { result: "Failed" },
    };
    o.certificate = { validTo: new Date(T0 + 36 * 3600_000).toISOString() };
    o.disks = [{ name: "database", freeBytes: 512 * 1024 ** 2, totalBytes: 60 * 1024 ** 3 }];
    o.channels = [{ kind: "email", failingSince: new Date(T0 - 40 * MIN).toISOString() }];
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(
      [
        "backup.failed",
        "backup.offsite",
        "backup.restore_check",
        "backup.stale",
        "certificate.expiring",
        "channel.delivery",
        "disk.low",
        "entry.customer",
        "payment.updates",
        "reconciliation.differences",
        "service.attention",
        "settlement.exceptions",
      ].sort(),
    );
    expect(c.get("reconciliation.differences").severity).toBe("critical");
    expect(c.get("certificate.expiring").severity).toBe("critical");
    expect(c.get("disk.low").severity).toBe("critical");
  });
  it("DEC-PILOT-INSTALLATION: warns two weeks before the installation's validity ends, urgent in the last 3 days", () => {
    const at = (days) => {
      const o = healthy();
      o.installation = { validUntil: new Date(T0 + days * 86400_000).toISOString() };
      return evaluateAlertConditions(o);
    };
    expect(keys(at(30))).toEqual([]);
    expect(keys(at(15))).toEqual([]);
    expect(at(13).get("installation.validity").severity).toBe("warning");
    expect(at(2).get("installation.validity").severity).toBe("critical");
    expect(at(-1).get("installation.validity").severity).toBe("critical");
    const soon = renderAlert("installation.validity", at(13).get("installation.validity").params);
    expect(soon.title).toBe("The store's ordering setup expires soon");
    expect(soon.summary).toContain("It expires in 13 days");
    expect(soon.action).toContain("Approve a new end date");
    expect(
      renderAlert("installation.validity", at(-1).get("installation.validity").params).title,
    ).toBe("The store's ordering setup has expired");
    const o = healthy();
    o.installation = "unreadable";
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the store setup end date",
    ]);
  });
  it("treats an unreadable source as an alert, never as healthy; a missing supervisor report too", () => {
    const o = healthy();
    o.business = "unreadable";
    o.disks = "unreadable";
    o.supervisor = null;
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["monitor.source", "supervisor.silent"]);
    expect(c.get("monitor.source").params.sources).toEqual([
      "payment and settlement status",
      "disk space",
    ]);
  });
  it("WP-2423: warns while order updates are still being retried, urgent after 30 minutes, and clears once processed", () => {
    const o = healthy();
    o.business.retryingUpdates = { count: 1, oldestAgeMs: 2 * MIN };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["updates.retrying"]);
    expect(c.get("updates.retrying").severity).toBe("warning");
    const text = renderAlert("updates.retrying", c.get("updates.retrying").params);
    expect(text.title).toBe("Some order updates are being retried");
    expect(text.summary).toContain("1 order update is being retried (failing for 2 minutes)");
    expect(text.summary).toContain("Ready orders may not show for pickup yet");
    expect(text.action).toContain("name or phone number");
    expect(text.runbook).toBe("alert-updates-retrying");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    // Raised on the first cycle it is seen (no wait), escalated after 30 minutes.
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "updates.retrying"]]);
    o.business.retryingUpdates = { count: 2, oldestAgeMs: 31 * MIN };
    ({ state, notifications } = advanceAlertState(
      state,
      evaluateAlertConditions(o),
      T0 + 29 * MIN,
    ));
    expect(notifications.map((n) => [n.kind, n.severity])).toEqual([["escalated", "critical"]]);
    // Processed: the condition is gone and the alert clears after the quiet period.
    o.business.retryingUpdates = { count: 0, oldestAgeMs: 0 };
    ({ state, notifications } = advanceAlertState(
      state,
      evaluateAlertConditions(o),
      T0 + 30 * MIN,
    ));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 32 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "updates.retrying"]]);
  });
  it("WP-2423: says receipts are not issued after 2 minutes when the Store's receipt template cannot be used", () => {
    const o = healthy();
    o.business.receiptTemplate = { ready: true };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.receiptTemplate = { ready: false, reason: "TemplateNotProven" };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["receipts.template"]);
    expect(c.get("receipts.template").severity).toBe("critical");
    const text = renderAlert("receipts.template", c.get("receipts.template").params);
    expect(text.title).toBe("Receipts are not being issued");
    expect(text.summary).toContain("The receipt template chosen in Store setup cannot be used");
    expect(text.action).toContain("step 5");
    expect(text.runbook).toBe("alert-receipts-template");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    // A brief failure is not raised; one lasting 2 minutes is, and it clears once receipts work.
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, c, T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "receipts.template"]]);
    o.business.receiptTemplate = { ready: false, reason: "StoreConfigurationUnavailable" };
    expect(
      renderAlert("receipts.template", evaluateAlertConditions(o).get("receipts.template").params)
        .summary,
    ).toContain("published settings could not be read");
    o.business.receiptTemplate = { ready: true };
    ({ state, notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 3 * MIN));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 6 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "receipts.template"]]);
    // A check that could not run is reported as such, never as fine.
    o.business.receiptTemplate = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the receipt template check",
    ]);
  });
  it("WP-2423: says orders cannot be priced after 2 minutes when the published tax settings are not the pilot's", () => {
    const o = healthy();
    o.business.quoteTax = { ready: true };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.quoteTax = { ready: false, reason: "TaxConfigurationMismatch" };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["pricing.tax_configuration"]);
    expect(c.get("pricing.tax_configuration").severity).toBe("critical");
    const text = renderAlert(
      "pricing.tax_configuration",
      c.get("pricing.tax_configuration").params,
    );
    expect(text.title).toBe("Orders cannot be priced");
    expect(text.summary).toContain("tax settings published in Store setup");
    expect(text.action).toContain("on paper");
    expect(text.action).toContain("step 8");
    expect(text.runbook).toBe("alert-pricing-tax-configuration");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, c, T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([
      ["raised", "pricing.tax_configuration"],
    ]);
    o.business.quoteTax = { ready: false, reason: "StoreConfigurationUnavailable" };
    expect(
      renderAlert(
        "pricing.tax_configuration",
        evaluateAlertConditions(o).get("pricing.tax_configuration").params,
      ).summary,
    ).toContain("published settings could not be read");
    o.business.quoteTax = { ready: true };
    ({ state, notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 3 * MIN));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 6 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([
      ["cleared", "pricing.tax_configuration"],
    ]);
    o.business.quoteTax = "unreadable";
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the check that orders can be priced",
    ]);
  });
  it("says no backup exists until the first one, and nothing about the supervisor during maintenance", () => {
    const o = healthy();
    o.backup = { lastSuccessAt: null };
    o.supervisor = { maintenance: true, reportAgeMs: 0, attention: [] };
    expect(keys(evaluateAlertConditions(o))).toEqual(["backup.stale"]);
  });
});

describe("WP-2423 Q13 deduplication, reminders and clearing", () => {
  const down = (now) => {
    const o = healthy(now);
    o.probes.api = { ok: false, failingForMs: now - T0 };
    return evaluateAlertConditions(o);
  };
  it("raises a probe failure only after it lasts two minutes, once, then reminds after three hours", () => {
    let { state, notifications } = advanceAlertState(emptyAlertState(), down(T0), T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, down(T0 + MIN), T0 + MIN));
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, down(T0 + 2 * MIN), T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "entry.api"]]);
    for (let m = 3; m < 180; m += 7) {
      ({ state, notifications } = advanceAlertState(state, down(T0 + m * MIN), T0 + m * MIN));
      expect(notifications).toEqual([]);
    }
    ({ notifications } = advanceAlertState(state, down(T0 + 183 * MIN), T0 + 183 * MIN));
    expect(notifications.map((n) => n.kind)).toEqual(["reminder"]);
  });
  it("drops a blip that never reached the raise delay and clears only after two quiet minutes", () => {
    let { state } = advanceAlertState(emptyAlertState(), down(T0), T0);
    let result = advanceAlertState(state, new Map(), T0 + MIN);
    expect(result.state.alerts).toEqual({});
    expect(result.notifications).toEqual([]);
    state = emptyAlertState();
    for (const m of [0, 2, 3])
      state = advanceAlertState(state, down(T0 + m * MIN), T0 + m * MIN).state;
    result = advanceAlertState(state, new Map(), T0 + 4 * MIN);
    expect(result.notifications).toEqual([]);
    // Flapping back within the clear window neither clears nor raises again.
    result = advanceAlertState(result.state, down(T0 + 5 * MIN), T0 + 5 * MIN);
    expect(result.notifications).toEqual([]);
    result = advanceAlertState(result.state, new Map(), T0 + 6 * MIN);
    result = advanceAlertState(result.state, new Map(), T0 + 8 * MIN);
    expect(result.notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "entry.api"]]);
    expect(result.state.cleared.map((c) => c.key)).toEqual(["entry.api"]);
  });
  it("notifies again when a warning becomes critical", () => {
    const disk = (free) =>
      evaluateAlertConditions({
        ...healthy(),
        disks: [{ name: "runtime", freeBytes: free, totalBytes: 50 * 1024 ** 3 }],
      });
    let r = advanceAlertState(emptyAlertState(), disk(4 * 1024 ** 3), T0);
    expect(r.notifications.map((n) => [n.kind, n.severity])).toEqual([["raised", "warning"]]);
    r = advanceAlertState(r.state, disk(0.5 * 1024 ** 3), T0 + MIN);
    expect(r.notifications.map((n) => [n.kind, n.severity])).toEqual([["escalated", "critical"]]);
  });
  it("persisted state survives a restart without repeating a raised alert", () => {
    let { state } = advanceAlertState(emptyAlertState(), down(T0), T0);
    state = advanceAlertState(state, down(T0 + 2 * MIN), T0 + 2 * MIN).state;
    const restored = JSON.parse(JSON.stringify(state));
    expect(advanceAlertState(restored, down(T0 + 10 * MIN), T0 + 10 * MIN).notifications).toEqual(
      [],
    );
  });
});

describe("WP-2423 Q13 rate limiting per channel", () => {
  const item = (n) => ({
    id: String(n),
    kind: "raised",
    key: "disk.low",
    severity: "warning",
    params: { disks: [] },
    at: new Date(T0 + n * MIN).toISOString(),
  });
  it("sends at most six messages an hour, merging what waits into the next message", () => {
    let channel;
    let sent = 0;
    for (let n = 0; n < 20; n++) {
      const plan = planChannelDelivery(channel, [item(n)], T0 + n * MIN);
      channel = plan.channel;
      if (plan.batch.length > 0) {
        sent += 1;
        channel = recordChannelDelivery(channel, true, T0 + n * MIN);
      }
    }
    expect(sent).toBe(6);
    expect(channel.pending).toHaveLength(14);
    const later = planChannelDelivery(channel, [], T0 + 61 * MIN);
    expect(later.batch).toHaveLength(14);
  });
  it("keeps pending items after a failed delivery and records since when the channel fails", () => {
    const plan = planChannelDelivery(undefined, [item(0)], T0);
    const failed = recordChannelDelivery(plan.channel, false, T0);
    expect(failed.pending).toHaveLength(1);
    expect(failed.failingSince).toBe(new Date(T0).toISOString());
    expect(recordChannelDelivery(failed, true, T0 + MIN).failingSince).toBeNull();
  });
});

describe("WP-2423 Q13 messages are plain language and carry no private data", () => {
  it("never echoes source text: only catalog text and typed values reach a message or the board", () => {
    const secret = "guest@example.com 416-555-0199 tok_live_abc postgres://user:pw@db";
    const o = healthy();
    // Hostile values where a careless rule might interpolate them.
    o.supervisor = { maintenance: false, reportAgeMs: 0, attention: [secret, `api:${secret}`] };
    o.business.stuckUpdates = { count: 3, oldestAgeMs: 5 * MIN, detail: secret };
    o.backup = {
      lastSuccessAt: null,
      lastAttempt: { result: "Failed", stage: secret, attemptsLeft: 0 },
    };
    o.disks = [{ name: secret, freeBytes: 1, totalBytes: 100 }];
    const conditions = evaluateAlertConditions(o);
    const { state, notifications } = advanceAlertState(emptyAlertState(), conditions, T0);
    const message = renderMessage(notifications, {
      siteLabel: "Main St",
      runbookBase: "docs/runbooks/single-store-pilot.md",
    });
    const board = buildAlertBoard(state, {
      observedAt: new Date(T0).toISOString(),
      channels: { email: false, webhooks: 0, heartbeat: false },
      backup: null,
    });
    for (const text of [message.subject, message.text, JSON.stringify(board)]) {
      expect(text).not.toMatch(/@|555|tok_|postgres:|pw/u);
    }
    expect(message.subject).toBe("Main St: 4 problems (urgent)");
    expect(message.text).toContain("What to do:");
    expect(message.text).toContain("Runbook: docs/runbooks/single-store-pilot.md#alert-");
  });
  it("says a payment difference is one payment or a day's totals, and where staff resolve each (v15)", () => {
    const one = renderAlert("reconciliation.differences", { count: 1, oldestAgeMs: 2 * 3600_000 });
    expect(one.title).toBe("Payment differences need checking");
    expect(one.summary).toBe(
      "1 difference between the store's records and the payment provider is still open (oldest 2 hours ago). A difference can be one payment or a business day's totals.",
    );
    expect(one.action).toBe(
      "Open Exceptions to see each difference. For a business day's totals, open Settlement and choose that day; it explains the difference and what to do.",
    );
    const many = renderAlert("reconciliation.differences", { count: 3, oldestAgeMs: 5 * MIN });
    expect(many.summary).toMatch(/^3 differences between .* are still open/u);
    // No screen that does not exist in the staff navigation, and no identifiers.
    for (const text of [one.title, one.summary, one.action, many.summary])
      expect(text).not.toMatch(/Payment reconciliation|payment does not match|[0-9a-f]{8}-/u);
    expect(renderAlert("settlement.exceptions", { count: 1, oldestAgeMs: MIN }).action).toContain(
      "Open Settlement",
    );
  });
  it("names the problem in the subject of a single alert, and resolution plainly", () => {
    const o = healthy();
    o.backup = { lastSuccessAt: null };
    const { state, notifications } = advanceAlertState(
      emptyAlertState(),
      evaluateAlertConditions(o),
      T0,
    );
    expect(renderMessage(notifications, { siteLabel: "Main St", runbookBase: "x" }).subject).toBe(
      "Main St: URGENT - No recent backup",
    );
    let cleared = advanceAlertState(state, new Map(), T0 + MIN);
    cleared = advanceAlertState(cleared.state, new Map(), T0 + 3 * MIN);
    const done = renderMessage(cleared.notifications, { siteLabel: "Main St", runbookBase: "x" });
    expect(done.subject).toBe("Main St: Resolved - No recent backup");
    expect(done.severity).toBe("resolved");
  });
  it("WP-2423: warns when orders from earlier days still hold stock, in staff words", () => {
    const o = healthy();
    o.business.heldStock = { count: 0, openCount: 0, oldestAgeMs: 0 };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.heldStock = { count: 11, openCount: 10, oldestAgeMs: 6 * 24 * 60 * MIN };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["orders.held_stock"]);
    expect(c.get("orders.held_stock").severity).toBe("warning");
    const text = renderAlert("orders.held_stock", c.get("orders.held_stock").params);
    expect(text.title).toBe("Orders from earlier days are still holding stock");
    expect(text.summary).toContain("11 orders from earlier days still have ingredients set aside");
    expect(text.action).toContain("cancel it");
    expect(text.runbook).toBe("alert-orders-held-stock");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    o.business.heldStock = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
  });
  it("DEC-PICKUP-CAPACITY-SCHEDULE: warns a day before pickup times run out, urgent in the last hour", () => {
    const o = healthy();
    o.business.pickupCapacity = { coveredMs: 14 * 24 * 60 * MIN };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.pickupCapacity = { coveredMs: 20 * 60 * MIN };
    let c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["pickup.capacity_horizon"]);
    expect(c.get("pickup.capacity_horizon").severity).toBe("warning");
    let text = renderAlert("pickup.capacity_horizon", c.get("pickup.capacity_horizon").params);
    expect(text.title).toBe("Pickup times are running out");
    expect(text.summary).toContain("only for the next 20 hours");
    expect(text.runbook).toBe("alert-pickup-capacity-horizon");
    o.business.pickupCapacity = { coveredMs: 0 };
    c = evaluateAlertConditions(o);
    expect(c.get("pickup.capacity_horizon").severity).toBe("critical");
    text = renderAlert("pickup.capacity_horizon", c.get("pickup.capacity_horizon").params);
    expect(text.title).toBe("Pickup orders cannot be taken");
    expect(text.action).toContain("on paper");
    for (const value of [text.title, text.summary, text.action])
      expect(value).not.toMatch(/[A-Z]{2,}_[A-Z]|slot|capacity/iu);
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    o.business.pickupCapacity = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
  });
  it("uses the same closed key list as the merchant Home read", () => {
    const api = readFileSync(
      new URL("../../apps/api/src/merchant-operations-alerts.ts", import.meta.url),
      "utf8",
    );
    const listed = [
      ...api
        .slice(api.indexOf("operationsAlertKeys"), api.indexOf("] as const"))
        .matchAll(/"([a-z]+\.[a-z_]+)"/gu),
    ].map((m) => m[1]);
    expect(listed.sort()).toEqual([...ALERT_KEYS].sort());
  });
});
