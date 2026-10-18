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

describe("WP-2423 Q13 operations alert board projection", () => {
  it("projects the closed board and reports a fresh monitor", () => {
    const view = projectOperationsAlertBoard(board(), "2026-10-15T08:02:00.000Z");
    expect(view).toEqual({
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
    });
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
    expect(await read({ sessionCookie: "cookie" })).toMatchObject({ active: [{}] });
    expect(scope.calls.at(-1)?.slice(1)).toEqual(["cookie", "operations.order-exception.manage"]);
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
