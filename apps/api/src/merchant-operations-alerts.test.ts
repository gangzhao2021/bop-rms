import { describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({
  allowed: true,
  storeReference: "0190ed90-0000-7000-8000-000000000003",
  calls: [] as unknown[][],
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async (tx: unknown, cookie: unknown, permission: string) => {
    scope.calls.push([tx, cookie, permission]);
    return {
      allowed: async () => scope.allowed,
      store: { storeReference: scope.storeReference },
    };
  },
}));
import {
  createPersistentMerchantOperationsAlerts,
  merchantOperationsAlertKeys,
  operationsAlertKeys,
  projectOperationsAlertBoard,
} from "./merchant-operations-alerts.js";

const board = () => ({
  schemaVersion: 1,
  observedAt: "2026-10-15T08:00:00.000Z",
  active: [
    {
      key: "backup.stale",
      severity: "critical",
      raisedAt: "2026-10-15T07:00:00.000Z",
      lastSeenAt: "2026-10-15T08:00:00.000Z",
      title: "No recent backup",
      summary: "The newest successful backup is 30 hours old.",
      action: "Ask the pilot operator to run a backup now.",
      runbook: "alert-backup-stale",
    },
  ],
  recentlyCleared: [
    {
      key: "entry.api",
      title: "Store system is not responding",
      clearedAt: "2026-10-15T06:00:00.000Z",
    },
  ],
  outboundChannels: { email: true, webhooks: 1, heartbeat: false },
  lastSuccessfulBackupAt: "2026-10-14T02:00:00.000Z",
});

describe("WP-2423 item 9: the rows about a Store's own orders", () => {
  /**
   * A row that says guests are stuck is useless if the Owner's Home drops it. Once each Store has
   * its own board (fix-store-monitors), a merchant's Home shows only `merchantOperationsAlertKeys`,
   * a list this branch does not have: when the two meet, this fails until both keys are on it.
   */
  it("stay on the Home of the merchant they are about", async () => {
    const module = (await import("./merchant-operations-alerts.js")) as unknown as {
      readonly merchantOperationsAlertKeys?: ReadonlySet<string>;
    };
    const merchant = module.merchantOperationsAlertKeys ?? new Set(operationsAlertKeys);
    for (const key of ["orders.workflow", "orders.unpaid_rounds"])
      expect(merchant.has(key), `${key} on a merchant's Home`).toBe(true);
  });
});

describe("WP-2423 item 9: the words of the Workflow rows", () => {
  /** The monitor's own catalog: one over-long wording would make the whole board unreadable. */
  const catalogFile = new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url)
    .href;
  it("every one fits what the board accepts", async () => {
    const { renderAlert } = (await import(/* @vite-ignore */ catalogFile)) as {
      readonly renderAlert: (
        key: string,
        params: unknown,
      ) => { title: string; summary: string; action: string; runbook: string };
    };
    const workflow = [
      "Orders",
      "Pickup",
      "Tables",
      "PaidOrders",
      "PaidPickup",
      "PaidTables",
      "PickupStore",
      "TablesStore",
      "PaidPickupStore",
      "PaidTablesStore",
      "FurtherRounds",
      "PickupNotOffered",
      "TablesNotOffered",
    ].map((state) => ["orders.workflow", { state }] as const);
    for (const [key, params] of [...workflow, ["orders.unpaid_rounds", {}] as const]) {
      const { title, summary, action, runbook } = renderAlert(key, params);
      const seen = board();
      const view = projectOperationsAlertBoard(
        {
          ...seen,
          active: [{ ...seen.active[0], key, title, summary, action, runbook }],
        },
        "2026-10-15T08:02:00.000Z",
      );
      expect(view.active.map((alert) => alert.key)).toEqual([key]);
    }
  });
});

describe("WP-2423 Q13 operations alert board projection", () => {
  it("projects the closed board and reports a fresh monitor", () => {
    const view = projectOperationsAlertBoard(board(), "2026-10-15T08:02:00.000Z");
    expect(view).toEqual({
      audience: "Installation",
      monitor: "Reporting",
      observedAt: "2026-10-15T08:00:00.000Z",
      active: [
        {
          key: "backup.stale",
          severity: "critical",
          title: "No recent backup",
          summary: "The newest successful backup is 30 hours old.",
          action: "Ask the pilot operator to run a backup now.",
          raisedAt: "2026-10-15T07:00:00.000Z",
        },
      ],
      recentlyCleared: [
        {
          key: "entry.api",
          title: "Store system is not responding",
          clearedAt: "2026-10-15T06:00:00.000Z",
        },
      ],
      outbound: { email: true, webhooks: 1, heartbeat: false },
      lastSuccessfulBackupAt: "2026-10-14T02:00:00.000Z",
      plannedUpdate: null,
      checksIncomplete: false,
      support: null,
    });
  });
  it("WP-2423 (2026-10-18): passes a planned update window while it is in force, only its instants", () => {
    const value = {
      ...board(),
      maintenance: { startedAt: "2026-10-15T07:58:00.000Z", expiresAt: "2026-10-15T08:13:00.000Z" },
    };
    expect(projectOperationsAlertBoard(value, "2026-10-15T08:02:00.000Z").plannedUpdate).toEqual({
      startedAt: "2026-10-15T07:58:00.000Z",
      expiresAt: "2026-10-15T08:13:00.000Z",
    });
    // Past its end (the board can be a minute old) or with a silent monitor it is not shown.
    expect(projectOperationsAlertBoard(value, "2026-10-15T08:13:00.000Z").plannedUpdate).toBe(null);
    expect(
      projectOperationsAlertBoard(
        { ...value, maintenance: { ...value.maintenance, expiresAt: "2026-10-15T08:20:00.000Z" } },
        "2026-10-15T08:06:00.000Z",
      ),
    ).toMatchObject({ monitor: "Silent", plannedUpdate: null });
    expect(
      projectOperationsAlertBoard({ ...board(), maintenance: null }, "2026-10-15T08:02:00.000Z")
        .plannedUpdate,
    ).toBe(null);
    for (const maintenance of [
      { ...value.maintenance, reason: "deploy" },
      { startedAt: "2026-10-15T07:58:00.000Z" },
      { startedAt: "2026-10-15T08:13:00.000Z", expiresAt: "2026-10-15T07:58:00.000Z" },
      "soon",
    ])
      expect(() =>
        projectOperationsAlertBoard({ ...board(), maintenance }, "2026-10-15T08:02:00.000Z"),
      ).toThrow("MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE");
  });
  it("reports a monitor that stopped writing and one that never ran", () => {
    expect(projectOperationsAlertBoard(board(), "2026-10-15T08:05:01.000Z").monitor).toBe("Silent");
    expect(projectOperationsAlertBoard(null, "2026-10-15T08:00:00.000Z")).toMatchObject({
      monitor: "NotRunning",
      active: [],
    });
  });
  it("refuses unknown keys, extra fields, markup and control characters", () => {
    type Board = ReturnType<typeof board>;
    const first = (b: Board) => b.active[0] as Board["active"][number];
    const cases = [
      (b: Board) => ((first(b) as { key: string }).key = "orders.contact"),
      (b: Board) => Object.assign(first(b), { phone: "555-0100" }),
      (b: Board) => (first(b).summary = "<img src=x>"),
      (b: Board) => (first(b).title = "line\nbreak"),
      (b: Board) => (first(b).severity = "info"),
      (b: Board) => (b.schemaVersion = 2),
      (b: Board) => (b.outboundChannels.webhooks = -1),
      (b: Board) => b.active.push({ ...first(b) }),
    ];
    for (const change of cases) {
      const value = board();
      change(value);
      expect(() => projectOperationsAlertBoard(value, "2026-10-15T08:00:00.000Z")).toThrow(
        "MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE",
      );
    }
  });
});

// DEC-PILOT-ALERTS-BACKUP correction 2: a restaurant reads about its own Store.
describe("a merchant's projection of its own board", () => {
  const entry = (key: string, severity = "warning") => ({
    key,
    severity,
    raisedAt: "2026-10-15T07:00:00.000Z",
    lastSeenAt: "2026-10-15T08:00:00.000Z",
    title: "Title",
    summary: "Summary.",
    action: "Action.",
    runbook: "alert-x",
  });
  const everything = () => ({
    ...board(),
    active: operationsAlertKeys.map((key) => entry(key)),
    recentlyCleared: [
      { key: "backup.stale", title: "No recent backup", clearedAt: "2026-10-15T06:00:00.000Z" },
      { key: "monitor.source", title: "Some checks", clearedAt: "2026-10-15T06:00:00.000Z" },
      { key: "payment.updates", title: "Stuck", clearedAt: "2026-10-15T06:00:00.000Z" },
    ],
    maintenance: { startedAt: "2026-10-15T07:58:00.000Z", expiresAt: "2026-10-15T08:13:00.000Z" },
  });
  const at = "2026-10-15T08:02:00.000Z";
  it("keeps its own Store's problems and the outages that stop its guests or staff, and nothing else", () => {
    const view = projectOperationsAlertBoard(everything(), at, { audience: "Merchant" });
    expect(view.audience).toBe("Merchant");
    expect(view.active.map((item) => item.key)).toEqual(
      operationsAlertKeys.filter((key) => merchantOperationsAlertKeys.has(key)),
    );
    for (const dropped of [
      "backup.failed",
      "backup.stale",
      "backup.restore_check",
      "backup.offsite",
      "certificate.expiring",
      "disk.low",
      "monitor.source",
      "channel.delivery",
      "supervisor.silent",
      // Each is BOP's to renew or set up, by a tool, before any guest notices.
      "installation.validity",
      "settlement.not_covered",
      "stores.attention",
    ])
      expect(view.active.map((item) => item.key)).not.toContain(dropped);
    expect(view.recentlyCleared.map((item) => item.key)).toEqual(["payment.updates"]);
    expect(view.outbound).toEqual({ email: false, webhooks: 0, heartbeat: false });
    expect(view.lastSuccessfulBackupAt).toBe(null);
    // A planned update stops their guests and staff too: the calm notice stays.
    expect(view.plannedUpdate).toEqual({
      startedAt: "2026-10-15T07:58:00.000Z",
      expiresAt: "2026-10-15T08:13:00.000Z",
    });
  });
  it("says when some of its checks could not run, without naming them", () => {
    const incomplete = { ...board(), active: [entry("monitor.source")] };
    const view = projectOperationsAlertBoard(incomplete, at, { audience: "Merchant" });
    expect(view.active).toEqual([]);
    expect(view.checksIncomplete).toBe(true);
    expect(
      projectOperationsAlertBoard({ ...board(), active: [] }, at, { audience: "Merchant" })
        .checksIncomplete,
    ).toBe(false);
    // The board that says it in words keeps saying it.
    const installation = projectOperationsAlertBoard(incomplete, at);
    expect(installation.active.map((item) => item.key)).toEqual(["monitor.source"]);
    expect(installation.checksIncomplete).toBe(false);
  });
  it("a merchant reads of the end of its ordering only in the last day, from the monitor's own catalog", async () => {
    const catalog = (await import(
      /* @vite-ignore */ new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url)
        .href
    )) as {
      advanceAlertState(state: unknown, conditions: unknown, now: number): { state: unknown };
      buildAlertBoard(state: unknown, options: unknown): unknown;
      emptyAlertState(): unknown;
      evaluateStoreConditions(observations: unknown): unknown;
    };
    const now = Date.parse(at);
    const home = (hoursLeft: number) => {
      const observations = {
        now,
        store: "tea",
        probes: {},
        supervisor: { maintenance: false, reportAgeMs: 0, attention: [] },
        business: {
          stuckUpdates: { count: 0, oldestAgeMs: 0 },
          retryingUpdates: { count: 0, oldestAgeMs: 0 },
          reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
          settlementExceptions: { count: 0, oldestAgeMs: 0 },
        },
        installation: { validUntil: new Date(now + hoursLeft * 3600_000).toISOString() },
      };
      const { state } = catalog.advanceAlertState(
        catalog.emptyAlertState(),
        catalog.evaluateStoreConditions(observations),
        now,
      );
      return projectOperationsAlertBoard(
        catalog.buildAlertBoard(state, {
          observedAt: at,
          channels: { email: false, webhooks: 0, heartbeat: false },
          backup: null,
          audience: "Merchant",
        }),
        at,
        { audience: "Merchant" },
      );
    };
    // BOP has the renewal in hand, as far as anyone can tell: nothing to alarm a restaurant with.
    expect(home(25).active).toEqual([]);
    expect(home(24 * 13).active).toEqual([]);
    const [row, ...others] = home(23).active;
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      key: "ordering.ending",
      severity: "critical",
      title: "Ordering at this Store is about to stop",
      action:
        "Ordering at this Store stops in 23 hours unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
    });
  });
  it("still refuses a board that is not one, whatever the audience", () => {
    const value = everything();
    Object.assign(value.active[0] as object, { phone: "555-0100" });
    expect(() => projectOperationsAlertBoard(value, at, { audience: "Merchant" })).toThrow(
      "MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE",
    );
  });
  it("is unchanged for the installation, apart from saying who it is for", () => {
    const value = everything();
    const { audience, checksIncomplete, support, ...view } = projectOperationsAlertBoard(value, at);
    expect([audience, checksIncomplete, support]).toEqual(["Installation", false, null]);
    expect(view.active).toHaveLength(operationsAlertKeys.length);
    expect(view.recentlyCleared).toHaveLength(3);
    expect(view.outbound).toEqual(value.outboundChannels);
    expect(view.lastSuccessfulBackupAt).toBe(value.lastSuccessfulBackupAt);
  });
  it("carries the support contact to both, and refuses one that is not a phone number", () => {
    const support = { phone: "+14165550100", testOnly: true };
    for (const audience of ["Installation", "Merchant"] as const)
      expect(
        projectOperationsAlertBoard({ ...board(), support }, at, { audience }).support,
      ).toEqual(support);
    expect(projectOperationsAlertBoard(board(), at).support).toBe(null);
    expect(projectOperationsAlertBoard({ ...board(), support: null }, at).support).toBe(null);
    for (const bad of [
      { phone: "call us", testOnly: false },
      { phone: "+14165550100" },
      { phone: "+14165550100", testOnly: "no" },
      { phone: "+14165550100", testOnly: false, name: "x" },
    ])
      expect(() => projectOperationsAlertBoard({ ...board(), support: bad }, at)).toThrow(
        "MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE",
      );
  });
  it("a board that has never been written reads as not running, for the audience asking", () => {
    expect(projectOperationsAlertBoard(null, at, { audience: "Merchant" })).toMatchObject({
      audience: "Merchant",
      monitor: "NotRunning",
      active: [],
    });
  });
});

describe("WP-2423 Q13 persistent operations alerts read", () => {
  const persistence = {
    now: () => "2026-10-15T08:01:00.000Z",
    transactions: { run: async <T>(work: (tx: unknown) => Promise<T>) => work({ tx: 1 }) },
  } as never;
  it("authorizes the exception permission for the installation's Store before reading", async () => {
    scope.allowed = true;
    const readBoard = vi.fn(async () => board());
    const read = createPersistentMerchantOperationsAlerts({
      persistence,
      storeReference: scope.storeReference,
      readBoard,
    });
    expect(await read({ sessionCookie: "cookie" })).toMatchObject({
      audience: "Installation",
      active: [{}],
    });
    expect(scope.calls.at(-1)?.slice(1)).toEqual(["cookie", "operations.order-exception.manage"]);
  });
  it("answers a Store below stores/ as a merchant, as its composition says", async () => {
    scope.allowed = true;
    const read = createPersistentMerchantOperationsAlerts({
      persistence,
      storeReference: scope.storeReference,
      readBoard: async () => board(),
      audience: "Merchant",
    });
    // The only row on this board is about backups: not this reader's to act on.
    expect(await read({ sessionCookie: "cookie" })).toMatchObject({
      audience: "Merchant",
      active: [],
      lastSuccessfulBackupAt: null,
    });
  });
  it("answers 'not permitted' to other roles and refuses another Store, without reading the board", async () => {
    const readBoard = vi.fn(async () => board());
    scope.allowed = false;
    const read = createPersistentMerchantOperationsAlerts({
      persistence,
      storeReference: scope.storeReference,
      readBoard,
    });
    // WP-2423: an ordinary answer for Front of House, not a refusal the browser logs.
    expect(await read({ sessionCookie: "cookie" })).toEqual({ permitted: false });
    scope.allowed = true;
    const other = createPersistentMerchantOperationsAlerts({
      persistence,
      storeReference: "0190ed90-0000-7000-8000-000000000009",
      readBoard,
    });
    await expect(other({ sessionCookie: "cookie" })).rejects.toThrow(
      "MERCHANT_OPERATIONS_ALERTS_UNAVAILABLE",
    );
    expect(readBoard).not.toHaveBeenCalled();
  });
});
