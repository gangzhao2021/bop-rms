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
