import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  OperationsAlertsCard,
  createOperationsAlertsClient,
  parseOperationsAlertView,
  type OperationsAlertView,
} from "./OperationsAlerts.js";

const view = (change: Partial<OperationsAlertView> = {}): OperationsAlertView => ({
  monitor: "Reporting",
  observedAt: "2026-10-15T12:00:00.000Z",
  active: [],
  recentlyCleared: [],
  outbound: { email: false, webhooks: 0, heartbeat: false },
  lastSuccessfulBackupAt: "2026-10-15T08:30:00.000Z",
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
const render = (read: Parameters<typeof OperationsAlertsCard>[0]["read"]) =>
  renderToStaticMarkup(<OperationsAlertsCard read={read} timeZone="America/Toronto" />);

describe("WP-2423 Q13 store system alerts on the Home", () => {
  it("says everything is working, when the last backup ran and that no outbound alerts exist", () => {
    const html = render({ kind: "Ready", value: view() });
    expect(html).toContain("Everything is working.");
    expect(html).toContain("Last backup Oct 15, 2026, 4:30 AM");
    expect(html).toContain("no email or phone alerts are set up yet");
    expect(html).not.toContain("overview-card--alerts-critical");
  });
  it("lists each problem with urgency, what to do and when it started in Store time", () => {
    const html = render({
      kind: "Ready",
      value: view({
        active: [
          critical,
          { ...critical, key: "disk.low", severity: "warning", title: "Disk space is running low" },
        ],
        outbound: { email: true, webhooks: 1, heartbeat: true },
      }),
    });
    expect(html).toContain("overview-card--alerts-critical");
    expect(html).toContain("Urgent");
    expect(html).toContain("Today");
    expect(html).toContain("What to do: </span>Pause online ordering");
    expect(html).toContain("Since Oct 15, 2026, 7:56 AM");
    expect(html).toContain("alerted by email and phone or message alerts");
  });
  it("warns that nothing is being checked when the monitor is silent or not running", () => {
    expect(render({ kind: "Ready", value: view({ monitor: "Silent" }) })).toContain(
      "The alert monitor stopped reporting at Oct 15, 2026, 8:00 AM",
    );
    expect(
      render({ kind: "Ready", value: view({ monitor: "NotRunning", observedAt: null }) }),
    ).toContain("The alert monitor is not running");
    expect(render({ kind: "Unavailable" })).toContain("System alerts could not be read");
    expect(render({ kind: "Loading" })).toContain("Checking the store system");
  });
  it("shows recently resolved problems, newest first", () => {
    const html = render({
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
  it("refuses a view with unknown fields or severities", () => {
    expect(() => parseOperationsAlertView({ ...view(), extra: 1 })).toThrow();
    expect(() =>
      parseOperationsAlertView(view({ active: [{ ...critical, severity: "info" as never }] })),
    ).toThrow();
    expect(parseOperationsAlertView(view({ active: [critical] })).active).toHaveLength(1);
  });
  it("reads without caching and treats any refusal as unavailable", async () => {
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
      "OPERATIONS_ALERTS_UNAVAILABLE",
    );
  });
});
