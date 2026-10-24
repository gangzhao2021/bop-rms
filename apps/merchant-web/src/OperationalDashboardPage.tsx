import { t } from "./i18n/i18n.js";
import { Link } from "react-router";
import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { orderTypeLabel, sourceChannelFilterLabel } from "./order-channel.js";
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
    Loading: [t("Loading dashboard"), t("Loading authorized operational summaries…"), "neutral"],
    PermissionDenied: [
      t("Permission denied"),
      t("Operational reporting is unavailable for this scope."),
      "error",
    ],
    NotFound: [
      t("Dashboard not found"),
      t("No authorized operational projection exists."),
      "neutral",
    ],
    FeatureDisabled: [
      t("Reporting disabled"),
      t("Operational reporting is unavailable for this Store."),
      "neutral",
    ],
    Stale: [t("Projection stale"), t("Refresh before relying on operational results."), "offline"],
    Conflict: [t("Scope changed"), t("Refresh the authorized Store and filter scope."), "offline"],
    CommandFailed: [
      t("Action failed"),
      t("No saved view, export, or schedule was created."),
      "error",
    ],
    Offline: [
      t("Offline read-only"),
      t("Cached summaries cannot authorize drill-down or export."),
      "offline",
    ],
    Unavailable: [
      t("Dashboard unavailable"),
      t("No transaction facts or zero values are inferred."),
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
  return `${negative ? "-" : ""}$${padded.slice(0, -2)}.${padded.slice(-2)}`;
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
      <p className="bop-eyebrow">{t("Metric {version}", { version: version })}</p>
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
          <p className="bop-eyebrow">{t("RPT-OPS-DASHBOARD · Operational reporting")}</p>
          <h1>{t("Operational dashboard")}</h1>
          <p>
            {t("{brandLabel} · {storeLabel} · Business Date {businessDate} · {timezone}", {
              brandLabel: view.scope.brandLabel,
              storeLabel: view.scope.storeLabel,
              businessDate: view.businessDate,
              timezone: view.timezone,
            })}
          </p>
          <p role="status">
            {t("{completenessStatus} · data as of {value} · generated {generatedAt}", {
              completenessStatus: view.completenessStatus,
              value: view.dataAsOfUtc ?? t("Unavailable"),
              generatedAt: view.generatedAt,
            })}
          </p>
        </div>
        <div className="card-actions">
          {view.permissions.maySaveView ? (
            <button disabled={readOnly}>{t("Save view")}</button>
          ) : null}
          {view.permissions.mayExport ? (
            <button disabled={readOnly}>{t("Create export job")}</button>
          ) : null}
          {view.permissions.maySchedule ? (
            <button disabled={readOnly}>{t("Schedule report")}</button>
          ) : null}
        </div>
      </header>
      {readOnly ? <OperationalDashboardState state="Stale" /> : null}
      <form className="list-filters" aria-label={t("Operational dashboard filters")}>
        <label>
          {t("Authorized Store")}
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
          {t("Business Date")}
          <input type="date" value={view.businessDate} readOnly />
        </label>
        <label>
          {t("Channel")}
          <input value={sourceChannelFilterLabel(view.sourceChannel, view.orderType)} readOnly />
        </label>
        <label>
          {t("Order type")}
          <input
            value={view.orderType === "All" ? "All types" : orderTypeLabel[view.orderType]}
            readOnly
          />
        </label>
      </form>
      {noActivity ? (
        <StatePanel heading={t("No operational activity")} tone="neutral" status>
          <p>{t("No source facts match this exact authorized scope and filter snapshot.")}</p>
        </StatePanel>
      ) : null}
      <section className="overview-grid" aria-label={t("Operational metrics")}>
        <MetricCard title={t("Net captured sales")} version={view.metricVersions.sales}>
          {view.sales === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{money(view.sales.netCapturedAmountMinor)}</strong>
              <br />
              {t("Captured {capturedAmountMinor} · refunded {refundedAmountMinor}", {
                capturedAmountMinor: money(view.sales.capturedAmountMinor),
                refundedAmountMinor: money(view.sales.refundedAmountMinor),
              })}
            </p>
          )}
        </MetricCard>
        <MetricCard title={t("Orders")} version={view.metricVersions.orders}>
          {view.orders === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{view.orders.total}</strong>
              <br />
              {t(
                "Open {open} · fulfilled {fulfilled} · rejected {rejected} · cancelled {cancelled}",
                {
                  open: view.orders.open,
                  fulfilled: view.orders.fulfilled,
                  rejected: view.orders.rejected,
                  cancelled: view.orders.cancelled,
                },
              )}
            </p>
          )}
        </MetricCard>
        <MetricCard title={t("Payments")} version={view.metricVersions.payments}>
          {view.payments === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{view.payments.attempts}</strong>
              <br />
              {t(
                "Pending {pending} · Provider unknown {providerUnknown} · differences {reconciliationDifferences}",
                {
                  pending: view.payments.pending,
                  providerUnknown: view.payments.providerUnknown,
                  reconciliationDifferences: view.payments.reconciliationDifferences,
                },
              )}
            </p>
          )}
        </MetricCard>
        <MetricCard title={t("Kitchen")} version={view.metricVersions.kitchen}>
          {view.kitchen === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{view.kitchen.workItems}</strong>
              <br />
              {t(
                "Queued {queued} · in progress {inProgress} · completed {completed} · exceptions {exceptions}",
                {
                  queued: view.kitchen.queued,
                  inProgress: view.kitchen.inProgress,
                  completed: view.kitchen.completed,
                  exceptions: view.kitchen.exceptions,
                },
              )}
            </p>
          )}
        </MetricCard>
        <MetricCard title={t("Fulfillment")} version={view.metricVersions.fulfillment}>
          {view.fulfillment === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{view.fulfillment.fulfillments}</strong>
              <br />
              {t(
                "Pending {pending} · ready {ready} · in progress {inProgress} · completed {completed} · exceptions {exceptions}",
                {
                  pending: view.fulfillment.pending,
                  ready: view.fulfillment.ready,
                  inProgress: view.fulfillment.inProgress,
                  completed: view.fulfillment.completed,
                  exceptions: view.fulfillment.exceptions,
                },
              )}
            </p>
          )}
        </MetricCard>
        <MetricCard title={t("Exceptions")} version={view.metricVersions.exceptions}>
          {view.exceptions === null ? (
            <p>{t("Unavailable — not zero")}</p>
          ) : (
            <p>
              <strong>{view.exceptions.open}</strong>
              <br />
              {t("Critical {critical}", { critical: view.exceptions.critical })}
            </p>
          )}
        </MetricCard>
      </section>
      <section aria-labelledby="dashboard-lineage-heading">
        <h2 id="dashboard-lineage-heading">{t("Freshness and drill-down lineage")}</h2>
        <div className="card-list">
          {view.lineage.map((item) => (
            <article className="summary-card" key={item.sourceName}>
              <h3>{sourceLabels[item.sourceName]}</h3>
              <p>
                {t("{status} · as of {value}", {
                  status: item.status,
                  value: item.asOfUtc ?? t("Unavailable"),
                })}
              </p>
              <p>{t("Checkpoint {value}", { value: item.sourceCheckpoint ?? t("Unavailable") })}</p>
              {view.permissions.mayDrill &&
              item.drillTarget !== null &&
              item.status !== "Unavailable" ? (
                <Link className="shell-action" to={item.drillTarget}>
                  {t("Open authorized source facts")}
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <p role="note">
        {t(
          "This dashboard is a versioned, permission-trimmed projection. Drill-down opens owning fact pages; it never edits transaction truth.",
        )}
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
