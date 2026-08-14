import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import {
  CapacityPolicyClientError,
  parseCapacityPolicyView,
  unavailableCapacityPolicyProjectionClient,
  type CapacityPolicyClientErrorCode,
  type CapacityPolicyProjectionClient,
  type CapacityPolicyView,
} from "./capacity-policy-pages.js";

type State =
  | { readonly kind: "Loading" | CapacityPolicyClientErrorCode }
  | { readonly kind: "Found"; readonly view: CapacityPolicyView };

export function CapacityPolicyState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Capacity Policy projection…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Capacity configuration is not authorized for this Store.",
      "error",
    ],
    NotFound: ["Policy unavailable", "No Capacity Policy exists in this Store scope.", "neutral"],
    FeatureDisabled: [
      "Capacity configuration disabled",
      "Reservation Capacity is disabled for this Store.",
      "neutral",
    ],
    Stale: [
      "Capacity projection is stale",
      "Refresh Dining, Store, Reservation and Pricing evidence before simulation or publication.",
      "offline",
    ],
    Conflict: [
      "Policy changed",
      "Compare the latest version and recover compatible draft input before retrying.",
      "offline",
    ],
    CommandFailed: [
      "Command failed",
      "No Capacity Policy, Reservation, Dining or Pricing fact changed.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached policy data may be stale; simulation and mutations are disabled.",
      "offline",
    ],
    Unavailable: [
      "Capacity configuration unavailable",
      "The authorized Reservation Capacity BFF is unavailable.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/app">Return to Merchant Home</Link>
    </StatePanel>
  );
}

const minute = (value: number) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;

export function CapacityPolicyScreen({ view }: { readonly view: CapacityPolicyView }) {
  const [date, setDate] = useState(view.effectiveFrom.slice(0, 10));
  const [area, setArea] = useState(view.areaReference);
  const [service, setService] = useState(view.serviceCode);
  const filteredBuckets = useMemo(
    () =>
      area === view.areaReference &&
      service === view.serviceCode &&
      date >= view.effectiveFrom.slice(0, 10) &&
      (view.effectiveUntil === null || date < view.effectiveUntil.slice(0, 10))
        ? view.buckets
        : ([] as const),
    [
      area,
      date,
      service,
      view.areaReference,
      view.buckets,
      view.effectiveFrom,
      view.effectiveUntil,
      view.serviceCode,
    ],
  );
  const blocking = view.issues.filter((issue) => issue.severity === "Blocking");
  return (
    <AppFrame
      title="Reservation Capacity"
      description="RES-CAPACITY-CONFIG · query.res_capacity_config · reservation_capacity_policy_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store-scoped Reservation &amp; Waiting configuration</p>
          <h2>Capacity, closures and policy references</h2>
          <p className="bop-muted">
            Version {view.policyVersion} · {view.lifecycle} · as of {view.asOfUtc} ·{" "}
            {view.freshness} · projection {view.projectionVersion}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Save draft</button>
          <button disabled>Simulate demand / conflicts</button>
          <button disabled>Publish now</button>
          <button disabled>Schedule</button>
        </div>
      </header>

      {view.freshness === "Stale" || view.partial ? (
        <StatePanel
          heading={view.partial ? "Partial dependency evidence" : "Projection is stale"}
          tone="offline"
          status
        >
          <p>
            Publication is blocked until current Dining, Store, Reservation / Hold and
            Pricing-policy evidence is available.
          </p>
        </StatePanel>
      ) : null}

      <section className="detail-section" aria-labelledby="capacity-scenario-filters">
        <h3 id="capacity-scenario-filters">Date / area / service scenario</h3>
        <div className="list-filters">
          <label>
            Effective date
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
          </label>
          <label>
            Dining area
            <select value={area} onChange={(event) => setArea(event.currentTarget.value)}>
              <option value={view.areaReference}>{view.areaReference}</option>
              <option value="NO_MATCH">Another authorized area</option>
            </select>
          </label>
          <label>
            Service
            <select value={service} onChange={(event) => setService(event.currentTarget.value)}>
              <option value={view.serviceCode}>{view.serviceCode}</option>
              <option value="NO_MATCH">Another service</option>
            </select>
          </label>
        </div>
      </section>

      <div className="detail-grid">
        <section className="detail-section" aria-labelledby="capacity-policy-summary">
          <h3 id="capacity-policy-summary">Scope and effective version</h3>
          <dl>
            <div>
              <dt>Store / area / service</dt>
              <dd>
                {view.storeReference} · {view.areaReference} · {view.serviceCode}
              </dd>
            </div>
            <div>
              <dt>Effective period</dt>
              <dd>
                {view.effectiveFrom} → {view.effectiveUntil ?? "Open-ended"} · {view.timeZone}
              </dd>
            </div>
            <div>
              <dt>Expected Version</dt>
              <dd>
                Aggregate {view.aggregateVersion} · Version ref {view.versionReference}
              </dd>
            </div>
          </dl>
        </section>

        <section className="detail-section" aria-labelledby="capacity-policy-refs">
          <h3 id="capacity-policy-refs">Pricing-owned policy references</h3>
          <dl>
            <div>
              <dt>Deposit</dt>
              <dd>
                {view.depositPolicyReference === null
                  ? "Not required"
                  : `${view.depositPolicyReference} · version ${view.depositPolicyVersion}`}
              </dd>
            </div>
            <div>
              <dt>Cancellation</dt>
              <dd>
                {view.cancellationPolicyReference === null
                  ? "Not required"
                  : `${view.cancellationPolicyReference} · version ${view.cancellationPolicyVersion}`}
              </dd>
            </div>
            <div>
              <dt>No-show</dt>
              <dd>
                {view.noShowPolicyReference === null
                  ? "Not required"
                  : `${view.noShowPolicyReference} · version ${view.noShowPolicyVersion}`}
              </dd>
            </div>
          </dl>
          <p className="bop-muted">
            Reservation references approved snapshots only. Pricing owns amounts and terms; Payment
            owns all money movement.
          </p>
        </section>
      </div>

      <section className="detail-section" aria-labelledby="capacity-time-buckets">
        <h3 id="capacity-time-buckets">Capacity time buckets</h3>
        {filteredBuckets.length === 0 ? (
          <StatePanel heading="No matching buckets" status>
            <p>No configured bucket matches the current date / area / service filter.</p>
          </StatePanel>
        ) : (
          <div className="store-grid">
            {filteredBuckets.map((bucket) => (
              <article className="store-card" key={bucket.bucketReference}>
                <div className="card-heading">
                  <div>
                    <p className="bop-eyebrow">Day {bucket.dayOfWeek}</p>
                    <h3>
                      {minute(bucket.startMinute)}–{minute(bucket.endMinute)}
                    </h3>
                  </div>
                  <span>{bucket.overbookMode}</span>
                </div>
                <dl>
                  <div>
                    <dt>Capacity / online allocation</dt>
                    <dd>
                      {bucket.capacitySeats} seats · {bucket.onlineAllocationSeats} online
                    </dd>
                  </div>
                  <div>
                    <dt>Overbook policy</dt>
                    <dd>
                      {bucket.overbookMode} · +{bucket.overbookAllowanceSeats} seats only with
                      explicit Manager evidence
                    </dd>
                  </div>
                  <div>
                    <dt>Standard turn time</dt>
                    <dd>{bucket.turnTimeMinutes} minutes</dd>
                  </div>
                </dl>
                <button disabled>Edit bucket draft</button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="detail-section" aria-labelledby="capacity-closures">
        <h3 id="capacity-closures">Closures and manual capacity adjustments</h3>
        {view.closures.length === 0 ? (
          <p>No closure is configured for this version.</p>
        ) : (
          <ul>
            {view.closures.map((closure) => (
              <li key={closure.closureReference}>
                {closure.startsAt} → {closure.endsAt} · {closure.reasonCode}
              </li>
            ))}
          </ul>
        )}
        <button disabled>Add closure to draft</button>
      </section>

      <section className="detail-section" aria-labelledby="capacity-validation">
        <h3 id="capacity-validation">Validation and dependency conflicts</h3>
        {view.issues.length === 0 ? (
          <p>No blocking or warning issue is recorded for this projection.</p>
        ) : (
          <ul>
            {view.issues.map((issue) => (
              <li key={`${issue.severity}-${issue.code}`}>
                <strong>{issue.severity}</strong> · {issue.code} · {issue.sourceSummary}
              </li>
            ))}
          </ul>
        )}
        <p className="bop-muted">
          {blocking.length} blocking issue(s). Disabled commands also remain explained here.
        </p>
      </section>

      <section className="detail-section" aria-labelledby="capacity-simulation">
        <h3 id="capacity-simulation">Demand / conflict simulation</h3>
        {view.simulation === null ? (
          <p>No explicit scenario has been simulated.</p>
        ) : (
          <dl>
            <div>
              <dt>Scenario / calculation</dt>
              <dd>
                {view.simulation.scenarioReference} · {view.simulation.calculatedAt} ·{" "}
                {view.simulation.calculationVersion}
              </dd>
            </div>
            <div>
              <dt>Capacity before / after request</dt>
              <dd>
                Effective {view.simulation.effectiveCapacitySeats} · available{" "}
                {view.simulation.availableSeatsBeforeRequest} →{" "}
                {view.simulation.availableSeatsAfterRequest}
              </dd>
            </div>
            <div>
              <dt>Blocking / warnings</dt>
              <dd>
                {view.simulation.blockingCodes.join(", ") || "None"} ·{" "}
                {view.simulation.warningCodes.join(", ") || "None"}
              </dd>
            </div>
          </dl>
        )}
        <p className="bop-muted">
          Simulation is deterministic evidence, not a Capacity Hold, Reservation, Table promise or
          fee calculation.
        </p>
      </section>

      <section className="detail-section" aria-labelledby="capacity-history">
        <h3 id="capacity-history">Version history and Audit</h3>
        <ul>
          {view.history.map((item) => (
            <li key={item.versionReference}>
              Version {item.policyVersion} · {item.lifecycle} · effective {item.effectiveFrom} ·{" "}
              {item.actorSummary}
            </li>
          ))}
        </ul>
      </section>
    </AppFrame>
  );
}

function useCapacityPolicy(client: CapacityPolicyProjectionClient) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const load = useCallback(async () => parseCapacityPolicyView(await client.load()), [client]);
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({
            kind: error instanceof CapacityPolicyClientError ? error.code : "Unavailable",
          }),
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state;
}

export function CapacityPolicyPage({
  client = unavailableCapacityPolicyProjectionClient,
}: {
  readonly client?: CapacityPolicyProjectionClient | undefined;
}) {
  const state = useCapacityPolicy(client);
  return state.kind === "Found" ? (
    <CapacityPolicyScreen view={state.view} />
  ) : (
    <CapacityPolicyState state={state.kind} />
  );
}
