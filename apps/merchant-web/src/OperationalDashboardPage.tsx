import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  OperationalDashboardClientError,
  parseOperationalDashboardView,
  unavailableOperationalDashboardClient,
  type OperationalDashboardClient,
  type OperationalDashboardClientErrorCode,
  type OperationalDashboardView,
} from "./operational-dashboard-page.js";

type LoadState =
  | { readonly kind: "Loading" | OperationalDashboardClientErrorCode }
  | { readonly kind: "Found"; readonly view: OperationalDashboardView };

const sourceLabels = {
  merchant_order_queue_v1: "Orders",
  payment_operations_v1: "Payments",
  kitchen_operations_v1: "Kitchen",
  fulfillment_operations_v1: "Fulfillment",
  merchant_order_exception_v1: "Exceptions",
} as const;

export function OperationalDashboardState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading dashboard", "Loading authorized operational summaries…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Operational reporting is unavailable for this scope.",
      "error",
    ],
    NotFound: ["Dashboard not found", "No authorized operational projection exists.", "neutral"],
    FeatureDisabled: [
      "Reporting disabled",
      "Operational reporting is unavailable for this Store.",
      "neutral",
    ],
    Stale: ["Projection stale", "Refresh before relying on operational results.", "offline"],
    Conflict: ["Scope changed", "Refresh the authorized Store and filter scope.", "offline"],
    CommandFailed: ["Action failed", "No saved view, export, or schedule was created.", "error"],
    Offline: [
      "Offline read-only",
      "Cached summaries cannot authorize drill-down or export.",
      "offline",
    ],
    Unavailable: [
      "Dashboard unavailable",
      "No transaction facts or zero values are inferred.",
      "error",
    ],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}

const money = (minor: string) => {
  const negative = minor.startsWith("-");
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, "0");
  return `${negative ? "-" : ""}CAD ${padded.slice(0, -2)}.${padded.slice(-2)}`;
};

function MetricCard({
  title,
  version,
  children,
}: {
  readonly title: string;
  readonly version: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="summary-card">
      <p className="bop-eyebrow">Metric {version}</p>
      <h2>{title}</h2>
      {children}
    </article>
  );
}

export function OperationalDashboard({ view }: { readonly view: OperationalDashboardView }) {
  const readOnly = view.completenessStatus !== "Complete";
  const noActivity =
    view.orders?.total === 0 &&
    view.payments?.attempts === 0 &&
    view.kitchen?.workItems === 0 &&
    view.fulfillment?.fulfillments === 0 &&
    view.exceptions?.open === 0;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RPT-OPS-DASHBOARD · Operational reporting</p>
          <h1>Operational dashboard</h1>
          <p>
            {view.scope.brandLabel} · {view.scope.storeLabel} · Business Date {view.businessDate} ·{" "}
            {view.timezone}
          </p>
          <p role="status">
            {view.completenessStatus} · data as of {view.dataAsOfUtc ?? "Unavailable"} · generated{" "}
            {view.generatedAt}
          </p>
        </div>
        <div className="card-actions">
          {view.permissions.maySaveView ? <button disabled={readOnly}>Save view</button> : null}
          {view.permissions.mayExport ? (
            <button disabled={readOnly}>Create export job</button>
          ) : null}
          {view.permissions.maySchedule ? (
            <button disabled={readOnly}>Schedule report</button>
          ) : null}
        </div>
      </header>
      {readOnly ? <OperationalDashboardState state="Stale" /> : null}
      <form className="list-filters" aria-label="Operational dashboard filters">
        <label>
          Authorized Store
          <select
            disabled={!view.permissions.mayChangeScope}
            value={view.scope.storeReference}
            onChange={() => undefined}
          >
            {view.authorizedScopes.map((scope) => (
              <option key={scope.storeReference} value={scope.storeReference}>
                {scope.brandLabel} · {scope.storeLabel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Business Date
          <input type="date" value={view.businessDate} readOnly />
        </label>
        <label>
          Channel
          <input value={view.sourceChannel} readOnly />
        </label>
        <label>
          Order type
          <input value={view.orderType} readOnly />
        </label>
      </form>
      {noActivity ? (
        <StatePanel heading="No operational activity" tone="neutral" status>
          <p>No source facts match this exact authorized scope and filter snapshot.</p>
        </StatePanel>
      ) : null}
      <section className="overview-grid" aria-label="Operational metrics">
        <MetricCard title="Net captured sales" version={view.metricVersions.sales}>
          {view.sales === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{money(view.sales.netCapturedAmountMinor)}</strong>
              <br />
              Captured {money(view.sales.capturedAmountMinor)} · refunded{" "}
              {money(view.sales.refundedAmountMinor)}
            </p>
          )}
        </MetricCard>
        <MetricCard title="Orders" version={view.metricVersions.orders}>
          {view.orders === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{view.orders.total}</strong>
              <br />
              Open {view.orders.open} · fulfilled {view.orders.fulfilled} · rejected{" "}
              {view.orders.rejected} · cancelled {view.orders.cancelled}
            </p>
          )}
        </MetricCard>
        <MetricCard title="Payments" version={view.metricVersions.payments}>
          {view.payments === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{view.payments.attempts}</strong>
              <br />
              Pending {view.payments.pending} · Provider unknown {view.payments.providerUnknown} ·
              differences {view.payments.reconciliationDifferences}
            </p>
          )}
        </MetricCard>
        <MetricCard title="Kitchen" version={view.metricVersions.kitchen}>
          {view.kitchen === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{view.kitchen.workItems}</strong>
              <br />
              Queued {view.kitchen.queued} · in progress {view.kitchen.inProgress} · completed{" "}
              {view.kitchen.completed} · exceptions {view.kitchen.exceptions}
            </p>
          )}
        </MetricCard>
        <MetricCard title="Fulfillment" version={view.metricVersions.fulfillment}>
          {view.fulfillment === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{view.fulfillment.fulfillments}</strong>
              <br />
              Pending {view.fulfillment.pending} · ready {view.fulfillment.ready} · in progress{" "}
              {view.fulfillment.inProgress} · completed {view.fulfillment.completed} · exceptions{" "}
              {view.fulfillment.exceptions}
            </p>
          )}
        </MetricCard>
        <MetricCard title="Exceptions" version={view.metricVersions.exceptions}>
          {view.exceptions === null ? (
            <p>Unavailable — not zero</p>
          ) : (
            <p>
              <strong>{view.exceptions.open}</strong>
              <br />
              Critical {view.exceptions.critical}
            </p>
          )}
        </MetricCard>
      </section>
      <section aria-labelledby="dashboard-lineage-heading">
        <h2 id="dashboard-lineage-heading">Freshness and drill-down lineage</h2>
        <div className="card-list">
          {view.lineage.map((item) => (
            <article className="summary-card" key={item.sourceName}>
              <h3>{sourceLabels[item.sourceName]}</h3>
              <p>
                {item.status} · as of {item.asOfUtc ?? "Unavailable"}
              </p>
              <p>Checkpoint {item.sourceCheckpoint ?? "Unavailable"}</p>
              {view.permissions.mayDrill &&
              item.drillTarget !== null &&
              item.status !== "Unavailable" ? (
                <a className="shell-action" href={item.drillTarget}>
                  Open authorized source facts
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <p role="note">
        This dashboard is a versioned, permission-trimmed projection. Drill-down opens owning fact
        pages; it never edits transaction truth.
      </p>
    </main>
  );
}

export function OperationalDashboardPage({
  client = unavailableOperationalDashboardClient,
}: {
  readonly client?: OperationalDashboardClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseOperationalDashboardView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof OperationalDashboardClientError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <OperationalDashboard view={state.view} />
  ) : (
    <OperationalDashboardState state={state.kind} />
  );
}
