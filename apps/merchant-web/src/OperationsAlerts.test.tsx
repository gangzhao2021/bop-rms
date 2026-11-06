import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  OPERATIONS_ALERTS_NOT_PERMITTED,
  StoreSystemLine,
  createOperationsAlertsClient,
  parseOperationsAlertView,
  type OperationsAlertsRead,
  type OperationsAlertView,
} from "./OperationsAlerts.js";
import { NeedsAttention, initialOverviewState } from "./StoreOverview.js";

/** The monitor's own catalog: what a merchant reads is what it writes. */
const catalogFile = new URL("../../../tooling/environment/pilot-alerts.mjs", import.meta.url).href;
const { renderAlert } = (await import(/* @vite-ignore */ catalogFile)) as {
  readonly renderAlert: (
    key: string,
    params: unknown,
  ) => {
    readonly title: string;
    readonly summary: string;
    readonly action: string;
    readonly runbook: string;
  };
};

const view = (change: Partial<OperationsAlertView> = {}): OperationsAlertView => ({
  monitor: "Reporting",
  observedAt: "2026-10-15T12:00:00.000Z",
  active: [],
  recentlyCleared: [],
  outbound: { email: false, webhooks: 0, heartbeat: false },
  lastSuccessfulBackupAt: "2026-10-15T08:30:00.000Z",
  plannedUpdate: null,
  ...change,
});
const critical = {
  key: "entry.customer",
  severity: "critical" as const,
  title: "Customer ordering page is not loading",
  summary: "The secure customer ordering page has not loaded for 4 minutes.",
  action: "Pause online ordering if staff screens still work.",
  raisedAt: "2026-10-15T11:56:00.000Z",
};
/** Home's two places for the board: the rows in "Needs attention" and the line at the bottom. */
const rows = (read: OperationsAlertsRead) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <NeedsAttention
        state={initialOverviewState}
        system={read}
        timeZone="America/Toronto"
        onCheckSystem={() => undefined}
      />
    </MemoryRouter>,
  );
const line = (read: OperationsAlertsRead) =>
  renderToStaticMarkup(<StoreSystemLine read={read} timeZone="America/Toronto" />);

describe("WP-2423 Q13 store system alerts on the Home", () => {
  it("says all is good in one line, when the last backup ran and that no outbound alerts exist", () => {
    const read = { kind: "Ready", value: view() } as const;
    const html = line(read);
    expect(html).toContain("Store system: all good");
    expect(html).toContain("Last backup Oct 15, 2026, 4:30 AM");
    expect(html).toContain("no email or phone alerts are set up yet");
    expect(rows(read)).not.toContain("overview-attention__state");
  });
  it("lists each problem in Needs attention with urgency, what to do and when it started in Store time", () => {
    const read = {
      kind: "Ready",
      value: view({
        active: [
          { ...critical, key: "disk.low", severity: "warning", title: "Disk space is running low" },
          critical,
        ],
        outbound: { email: true, webhooks: 1, heartbeat: true },
      }),
    } as const;
    const html = rows(read);
    expect(html).toContain("overview-attention__state--danger");
    expect(html).toContain("Urgent");
    expect(html).toContain("Today");
    expect(html).toContain("What to do: </span>Pause online ordering");
    expect(html).toContain("Since Oct 15, 2026, 7:56 AM");
    expect(html).toContain("The secure customer ordering page has not loaded for 4 minutes.");
    // The urgent one leads the list, whatever order the monitor sent them in.
    expect(html.indexOf("Customer ordering page")).toBeLessThan(html.indexOf("Disk space"));
    // The line never says all is good while a problem is listed, and the rest stays reachable.
    const quiet = line(read);
    expect(quiet).toContain("Store system: needs attention");
    expect(quiet).not.toContain("all good");
    expect(quiet).toContain("alerted by email and phone or message alerts");
  });
  it("WP-2423 item 9: every wording of these rows fits the board, or Home would lose the whole board", () => {
    const rows = [
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
    for (const [key, params] of [...rows, ["orders.unpaid_rounds", {}] as const]) {
      const { title, summary, action } = renderAlert(key, params);
      const active = [
        { key, severity: "critical" as const, title, summary, action, raisedAt: critical.raisedAt },
      ];
      expect(parseOperationsAlertView(view({ active })).active).toHaveLength(1);
    }
  });
  it("WP-2423 item 9: puts what a refused order Workflow stops, and what to do, at the top of Home", () => {
    const alert = (key: string, params: unknown, severity: "critical" | "warning") => {
      const { title, summary, action } = renderAlert(key, params);
      return { key, severity, title, summary, action, raisedAt: "2026-10-15T11:56:00.000Z" };
    };
    const read = {
      kind: "Ready",
      value: parseOperationsAlertView(
        view({
          active: [
            alert("orders.workflow", { state: "PickupNotOffered" }, "warning"),
            alert("orders.unpaid_rounds", {}, "critical"),
          ],
        }),
      ),
    } as const;
    const html = rows(read);
    expect(html.indexOf("Unpaid rounds are not being cancelled")).toBeLessThan(
      html.indexOf("Pickup cannot be turned on yet"),
    );
    expect(html).toContain("trying again will not help");
    expect(html).toContain("Urgent");
    expect(html).toContain("Today");
    expect(line(read)).not.toContain("all good");
    setLanguageForTest("zh-Hans");
    try {
      const chinese = rows(read);
      expect(chinese).toContain("未付款的轮次取消不了");
      expect(chinese).toContain("暂时不能开启自取");
      expect(chinese).toContain("重试没有用");
    } finally {
      setLanguageForTest("en");
    }
  });
  it("warns in Needs attention that nothing is being checked when the monitor is silent or not running", () => {
    const silent = { kind: "Ready", value: view({ monitor: "Silent" }) } as const;
    expect(rows(silent)).toContain("The alert monitor stopped reporting at Oct 15, 2026, 8:00 AM");
    expect(rows(silent)).toContain(">Urgent<");
    expect(line(silent)).toContain("Store system: problems are not being checked");
    expect(line(silent)).not.toContain("all good");
    const stopped = {
      kind: "Ready",
      value: view({ monitor: "NotRunning", observedAt: null }),
    } as const;
    expect(rows(stopped)).toContain("The alert monitor is not running");
    expect(rows({ kind: "Unavailable" })).toContain("System alerts could not be read");
    expect(line({ kind: "Unavailable" })).toContain("Store system: could not be checked");
    expect(line({ kind: "Unavailable" })).not.toContain("all good");
    expect(line({ kind: "Loading" })).toContain("Checking the store system");
  });
  it("shows recently resolved problems, newest first", () => {
    const html = line({
      kind: "Ready",
      value: view({
        recentlyCleared: [
          {
            key: "entry.api",
            title: "Store system is not responding",
            clearedAt: "2026-10-15T03:00:00.000Z",
          },
          { key: "backup.stale", title: "No recent backup", clearedAt: "2026-10-15T08:31:00.000Z" },
        ],
      }),
    });
    expect(html.indexOf("No recent backup")).toBeLessThan(html.indexOf("Store system is not"));
  });
  it("WP-2423 item 9: a cleared order-rules row says to wait for BOP support, in view, never resolved", async () => {
    const { clearedAlertTitle } = (await import(/* @vite-ignore */ catalogFile)) as {
      readonly clearedAlertTitle: (key: string) => string;
    };
    const clearedAt = "2026-10-15T08:31:00.000Z";
    const value = view({
      recentlyCleared: [
        { key: "orders.workflow", title: clearedAlertTitle("orders.workflow"), clearedAt },
      ],
    });
    const html = line({ kind: "Ready", value });
    expect(html).toContain(
      "Order rules check passes again: stay on paper until BOP support says it is fixed",
    );
    expect(html).not.toContain("Resolved recently");
    // Not folded away under System details.
    expect(html.indexOf("stay on paper")).toBeLessThan(
      html.indexOf("<details") === -1 ? Infinity : html.indexOf("<details"),
    );
    setLanguageForTest("zh-Hans");
    try {
      const zh = line({ kind: "Ready", value });
      expect(zh).toContain("门店订单规则的检查又通过了");
      expect(zh).not.toContain("最近已解决");
    } finally {
      setLanguageForTest("en");
    }
  });
  it("WP-2423 (2026-10-18): a planned update shows a calm notice, not an outage", () => {
    const plannedUpdate = {
      startedAt: "2026-10-15T11:58:00.000Z",
      expiresAt: "2026-10-15T12:13:00.000Z",
    };
    const read = { kind: "Ready", value: view({ plannedUpdate }) } as const;
    const html = rows(read);
    expect(html).toContain("System update in progress — ordering may pause for a few minutes.");
    expect(html).toContain("Started Oct 15, 2026, 7:58 AM.");
    expect(html).toContain("after Oct 15, 2026, 8:13 AM, this page shows an urgent alert");
    expect(html).toContain("overview-attention__state--progress");
    expect(html).not.toContain("overview-attention__state--danger");
    expect(html).not.toContain("overview-attention__state--warning");
    expect(html).not.toContain("Urgent");
    expect(line(read)).toContain("Store system: update in progress");
    expect(line(read)).not.toContain("all good");
    // A real problem raised meanwhile (or before the update) still shows with its urgency.
    const both = rows({ kind: "Ready", value: view({ plannedUpdate, active: [critical] }) });
    expect(both).toContain("System update in progress");
    expect(both).toContain("overview-attention__state--danger");
    expect(both).toContain("Customer ordering page is not loading");
    // Older servers send no planned-update entry; a malformed one is refused.
    const older: Record<string, unknown> = { ...view() };
    delete older.plannedUpdate;
    expect(parseOperationsAlertView(older).plannedUpdate).toBe(null);
    expect(parseOperationsAlertView(view({ plannedUpdate })).plannedUpdate).toEqual(plannedUpdate);
    expect(() =>
      parseOperationsAlertView({ ...view(), plannedUpdate: { startedAt: "soon" } }),
    ).toThrow("OPERATIONS_ALERTS_UNAVAILABLE");
  });
  it("refuses a view with unknown fields or severities", () => {
    expect(() => parseOperationsAlertView({ ...view(), extra: 1 })).toThrow();
    expect(() =>
      parseOperationsAlertView(view({ active: [{ ...critical, severity: "info" as never }] })),
    ).toThrow();
    expect(parseOperationsAlertView(view({ active: [critical] })).active).toHaveLength(1);
  });
  it("reads without caching; a 403 means not permitted, any other refusal is unavailable", async () => {
    const ok = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify(view()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    expect((await createOperationsAlertsClient(ok as never).load()).monitor).toBe("Reporting");
    expect(ok.mock.calls[0]?.[0]).toBe("/merchant/operations-alerts");
    const denied = vi.fn(async () => new Response("{}", { status: 403 }));
    await expect(createOperationsAlertsClient(denied as never).load()).rejects.toThrow(
      OPERATIONS_ALERTS_NOT_PERMITTED,
    );
    // WP-2423: the current server's ordinary answer for Front of House (no 403 in the browser).
    const notPermitted = vi.fn(
      async () =>
        new Response(JSON.stringify({ permitted: false }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    await expect(createOperationsAlertsClient(notPermitted as never).load()).rejects.toThrow(
      OPERATIONS_ALERTS_NOT_PERMITTED,
    );
    for (const status of [401, 500, 503]) {
      const failed = vi.fn(async () => new Response("{}", { status }));
      await expect(createOperationsAlertsClient(failed as never).load()).rejects.toThrow(
        "OPERATIONS_ALERTS_UNAVAILABLE",
      );
    }
  });
  it("renders nothing at all for a role the server does not permit", () => {
    expect(line({ kind: "NotPermitted" })).toBe("");
    expect(rows({ kind: "NotPermitted" })).not.toContain("Store system");
  });
});
