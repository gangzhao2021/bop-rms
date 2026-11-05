import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  OPERATIONS_ALERTS_NOT_PERMITTED,
  StoreSystemLine,
  createOperationsAlertsClient,
  parseOperationsAlertView,
  systemAttentionItems,
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
  audience: "Installation",
  monitor: "Reporting",
  observedAt: "2026-10-15T12:00:00.000Z",
  active: [],
  recentlyCleared: [],
  outbound: { email: false, webhooks: 0, heartbeat: false },
  lastSuccessfulBackupAt: "2026-10-15T08:30:00.000Z",
  plannedUpdate: null,
  checksIncompleteSince: null,
  support: null,
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
  it("WP-2423 item 9: a cleared order-rules row says to wait for BOP support in Needs attention, never resolved", async () => {
    const { clearedAlertTitle } = (await import(/* @vite-ignore */ catalogFile)) as {
      readonly clearedAlertTitle: (key: string, params?: unknown) => string;
    };
    const clearedAt = "2026-10-15T08:31:00.000Z";
    const wait = clearedAlertTitle("orders.workflow", { state: "Pickup" });
    const value = view({
      recentlyCleared: [{ key: "orders.workflow", title: wait, clearedAt }],
    });
    expect(wait).toBe(
      "Order rules check passes again: stay on paper until BOP support says it is fixed",
    );
    const html = rows({ kind: "Ready", value });
    expect(html).toContain(wait);
    expect(html).toContain("overview-attention__state--warning");
    expect(html).toContain("Wait for BOP support");
    // The line at the foot of Home sends staff up to it, and never calls it resolved.
    expect(line({ kind: "Ready", value })).not.toContain("stay on paper");
    expect(line({ kind: "Ready", value })).not.toContain("Resolved recently");
    expect(line({ kind: "Ready", value })).toContain("needs attention, see the list above");
    setLanguageForTest("zh-Hans");
    try {
      const zh = rows({ kind: "Ready", value });
      expect(zh).toContain("门店订单规则的检查又通过了");
      expect(zh).toContain("等 BOP 技术支持确认");
      expect(zh).not.toContain("Check passed");
      expect(line({ kind: "Ready", value })).not.toContain("最近已解决");
    } finally {
      setLanguageForTest("en");
    }
  });
  it("WP-2423 item 9: the wait line is not shown beside the same row raised again, nor after the business day", () => {
    const wait = {
      key: "orders.workflow",
      title: "Order rules check passes again: stay on paper until BOP support says it is fixed",
      clearedAt: "2026-10-15T08:31:00.000Z",
    };
    const raisedAgain = {
      ...critical,
      key: "orders.workflow",
      title: "Paid pickup orders may not reach the kitchen and may be refunded automatically",
      raisedAt: "2026-10-15T08:45:00.000Z",
    };
    const both = rows({
      kind: "Ready",
      value: view({ active: [raisedAgain], recentlyCleared: [wait] }),
    });
    expect(both).toContain("Paid pickup orders may not reach the kitchen");
    expect(both).not.toContain("passes again");
    const value = view({ recentlyCleared: [wait] });
    const markup = (dayStartsAt: string) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <NeedsAttention
            state={initialOverviewState}
            system={{ kind: "Ready", value }}
            timeZone="America/Toronto"
            dayStartsAt={dayStartsAt}
          />
        </MemoryRouter>,
      );
    expect(markup("2026-10-15T08:00:00.000Z")).toContain("passes again");
    expect(markup("2026-10-16T08:00:00.000Z")).not.toContain("passes again");
    expect(
      renderToStaticMarkup(
        <StoreSystemLine
          read={{ kind: "Ready", value }}
          timeZone="America/Toronto"
          dayStartsAt="2026-10-16T08:00:00.000Z"
        />,
      ),
    ).toContain("Store system: all good");
  });
  it("WP-2423 item 9: a cleared 'cannot be turned on yet' row is an ordinary resolved line", async () => {
    const { clearedAlertTitle } = (await import(/* @vite-ignore */ catalogFile)) as {
      readonly clearedAlertTitle: (key: string, params?: unknown) => string;
    };
    const title = clearedAlertTitle("orders.workflow", { state: "PickupNotOffered" });
    expect(title).toBe("Pickup cannot be turned on yet");
    const value = view({
      recentlyCleared: [{ key: "orders.workflow", title, clearedAt: "2026-10-15T08:31:00.000Z" }],
    });
    expect(rows({ kind: "Ready", value })).not.toContain("Pickup cannot be turned on yet");
    const html = line({ kind: "Ready", value });
    expect(html).toContain("Resolved recently: Pickup cannot be turned on yet");
    expect(html).toContain("Store system: all good");
    expect(html).not.toContain("paper");
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

// DEC-PILOT-ALERTS-BACKUP correction 2: a restaurant on the installation reads about its own Store.
describe("a merchant's own Store on the Home", () => {
  const merchant = (change: Partial<OperationsAlertView> = {}) =>
    ({
      kind: "Ready",
      value: view({ audience: "Merchant", lastSuccessfulBackupAt: null, ...change }),
    }) as const;
  const stuck = {
    key: "payment.updates",
    severity: "critical" as const,
    title: "Order or payment updates are stuck",
    summary: "1 update could not be processed after automatic retries (oldest 3 minutes ago).",
    action: "Do not take a second payment from guests who say they paid.",
    raisedAt: "2026-10-15T11:56:00.000Z",
  };
  it("a merchant's Home raises nothing urgent about the monitor", () => {
    expect(
      systemAttentionItems(
        merchant({ monitor: "NotRunning", observedAt: null }),
        "America/Toronto",
      ),
    ).toEqual({ urgent: [], later: [] });
    expect(systemAttentionItems(merchant({ monitor: "Silent" }), "America/Toronto")).toEqual({
      urgent: [],
      later: [],
    });
    const home = rows(merchant({ monitor: "NotRunning", observedAt: null }));
    expect(home).not.toContain("Store system problems are not being checked");
    expect(home).not.toContain("BOP support");
    expect(home).not.toContain("Urgent");
    // The installation's own Home still says it: BOP has to hear that the monitor stopped.
    expect(
      rows({ kind: "Ready", value: view({ monitor: "NotRunning", observedAt: null }) }),
    ).toContain("Store system problems are not being checked");
  });
  it("keeps the last problems in view, as of when they were last checked, when the monitor goes quiet", () => {
    const { urgent } = systemAttentionItems(
      merchant({ monitor: "Silent", active: [stuck] }),
      "America/Toronto",
    );
    expect(urgent.map((item) => item.title)).toEqual(["Order or payment updates are stuck"]);
    expect(urgent[0]?.since).toBe("Since Oct 15, 2026, 7:56 AM · as of Oct 15, 2026, 8:00 AM");
    const home = rows(merchant({ monitor: "Silent", active: [stuck] }));
    expect(home).toContain("Do not take a second payment");
    expect(home).not.toContain("The alert monitor stopped");
    // Nothing was ever read: nothing to show.
    expect(
      systemAttentionItems(
        merchant({ monitor: "NotRunning", observedAt: null, active: [] }),
        "America/Toronto",
      ).urgent,
    ).toEqual([]);
  });
  it("says what it knows in the quiet line, without backups or alert channels", () => {
    const fine = line(merchant());
    expect(fine).toContain("Store system: all good");
    expect(fine).not.toContain("backup");
    expect(fine).not.toContain("no email or phone alerts");
    expect(line(merchant({ monitor: "NotRunning", observedAt: null }))).toContain(
      "Store system: not checked yet",
    );
    const quiet = line(merchant({ monitor: "Silent" }));
    expect(quiet).toContain("Store system: last checked Oct 15, 2026, 8:00 AM");
    expect(quiet).not.toContain("all good");
    // Some of its checks could not run: not "all good", and nothing to alarm the owner about. The
    // time is when they stopped, not the board's: that moves every minute whether a read worked.
    const since = "2026-10-15T09:05:00.000Z";
    const partial = line(merchant({ checksIncompleteSince: since }));
    expect(partial).toContain("Store system: last checked Oct 15, 2026, 5:05 AM");
    expect(partial).not.toContain("8:00");
    expect(partial).not.toContain("all good");
    // The monitor stopping later does not make the checks more recent than they were.
    expect(line(merchant({ monitor: "Silent", checksIncompleteSince: since }))).toContain(
      "Store system: last checked Oct 15, 2026, 5:05 AM",
    );
    // With a row to show the line points at it, and still does not vouch for a minute ago.
    const both = line(merchant({ active: [stuck], checksIncompleteSince: since }));
    expect(both).toContain("Store system: needs attention");
    expect(both).toContain("Last checked Oct 15, 2026, 5:05 AM");
    expect(both).not.toContain("08:00");
    expect(line(merchant({ active: [stuck] }))).toContain("Store system: needs attention");
    expect(line(merchant({ monitor: "Silent", active: [stuck] }))).toContain(
      "Store system: needs attention",
    );
    expect(
      line(
        merchant({
          plannedUpdate: {
            startedAt: "2026-10-15T11:58:00.000Z",
            expiresAt: "2026-10-15T12:13:00.000Z",
          },
        }),
      ),
    ).toContain("Store system: update in progress");
  });
  it("offers a call to BOP support on rows that name it, and marks a test number", () => {
    const naming = {
      ...stuck,
      action: "Check Orders; ask BOP support to review the stuck updates.",
    };
    const named = { ...critical, action: "Ask BOP support to restart the store system." };
    const support = { phone: "+14165550100", testOnly: true };
    const home = rows(merchant({ active: [stuck, named], support }));
    expect(home).toContain('href="tel:+14165550100"');
    expect(home).toContain("Call BOP support: (416) 555-0100");
    expect(home).toContain("(test number)");
    // Only the row that names BOP support.
    expect(home.match(/href="tel:/gu)).toHaveLength(1);
    expect(
      rows(merchant({ active: [naming], support: { ...support, testOnly: false } })),
    ).not.toContain("(test number)");
    // Not configured: no link and no placeholder.
    expect(rows(merchant({ active: [naming] }))).not.toContain("tel:");
    // A number that is not one is refused rather than linked.
    expect(() =>
      parseOperationsAlertView({ ...view(), support: { phone: "javascript:x", testOnly: false } }),
    ).toThrow("OPERATIONS_ALERTS_UNAVAILABLE");
  });
  it("says ordering is about to stop with how long, how to keep serving and who to call", () => {
    const home = rows(
      merchant({
        active: [
          {
            key: "ordering.ending",
            severity: "critical",
            title: "Ordering at this Store is about to stop",
            summary:
              "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.",
            action:
              "Ordering at this Store stops in 23 hours unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
            raisedAt: "2026-10-15T11:56:00.000Z",
          },
        ],
        support: { phone: "+14165550100", testOnly: false },
      }),
    );
    expect(home).toContain("Urgent");
    expect(home).toContain("stops in 23 hours");
    expect(home).toContain("on your own POS or on paper");
    expect(home).toContain('href="tel:+14165550100"');
  });
  it("links a row to the page that settles it", () => {
    const home = rows(
      merchant({
        active: [
          stuck,
          { ...stuck, key: "orders.held_stock", severity: "warning" },
          { ...stuck, key: "reconciliation.differences", severity: "warning" },
          { ...stuck, key: "settlement.exceptions", severity: "warning" },
          { ...stuck, key: "entry.api", severity: "warning" },
        ],
      }),
    );
    expect(home.match(/href="\/operations\/orders"/gu)).toHaveLength(2);
    expect(home).toContain('href="/operations/order-exceptions"');
    expect(home).toContain('href="/app/operations/payment-reconciliation"');
  });
  it("reads what an older server sends, and refuses what it does not know", () => {
    const older: Record<string, unknown> = { ...view() };
    delete older.audience;
    delete older.checksIncompleteSince;
    delete older.support;
    expect(parseOperationsAlertView(older)).toMatchObject({
      audience: "Installation",
      checksIncompleteSince: null,
      support: null,
    });
    expect(parseOperationsAlertView(view({ audience: "Merchant" })).audience).toBe("Merchant");
    expect(() => parseOperationsAlertView({ ...view(), audience: "Guest" })).toThrow(
      "OPERATIONS_ALERTS_UNAVAILABLE",
    );
    expect(() => parseOperationsAlertView({ ...view(), checksIncompleteSince: "yes" })).toThrow(
      "OPERATIONS_ALERTS_UNAVAILABLE",
    );
  });
});
