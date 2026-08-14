import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import {
  DiningClientError,
  parseDiningFloorView,
  parseDiningTableListView,
  unavailableDiningProjectionClient,
  type DiningClientErrorCode,
  type DiningFloorView,
  type DiningProjectionClient,
  type DiningTableListView,
} from "./dining-pages.js";

type PageState<T> =
  | { readonly kind: "Loading" | DiningClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };

export function DiningState({ state }: { readonly state: "Loading" | DiningClientErrorCode }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Dining projection…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "This Store-scoped Dining view is not authorized.",
      "error",
    ],
    NotFound: [
      "Dining view unavailable",
      "No Dining view exists for the current Store.",
      "neutral",
    ],
    FeatureDisabled: ["Dining disabled", "Dining is disabled for the current Store.", "neutral"],
    Stale: ["Dining data is stale", "Refresh before making an operational decision.", "offline"],
    Conflict: ["Dining state changed", "Reload the current Table and Session versions.", "offline"],
    CommandFailed: ["Command failed", "No Table or Session fact changed.", "error"],
    Offline: [
      "Offline read-only",
      "Cached Dining data may be stale; commands remain disabled.",
      "offline",
    ],
    Unavailable: [
      "Dining unavailable",
      "The authorized Dining BFF is unavailable. No Table or Session fact changed.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/app">Return to workspace</Link>
    </StatePanel>
  );
}

export function DiningFloorScreen({ view }: { readonly view: DiningFloorView }) {
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("All");
  const [state, setState] = useState("All");
  const [owner, setOwner] = useState("All");
  const [attention, setAttention] = useState("All");
  const areas = useMemo(
    () => [...new Set(view.items.map((item) => item.areaCode))].sort(),
    [view.items],
  );
  const owners = useMemo(
    () => [...new Set(view.items.map((item) => item.ownerSummary))].sort(),
    [view.items],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return view.items.filter(
      (item) =>
        (!query ||
          item.stableLabel.toLocaleLowerCase().includes(query) ||
          item.diningSessionReference?.includes(query) ||
          item.reservationHandoffReference?.includes(query) ||
          item.waitlistHandoffReference?.includes(query)) &&
        (area === "All" || item.areaCode === area) &&
        (state === "All" || item.tableState === state) &&
        (owner === "All" || item.ownerSummary === owner) &&
        (attention === "All" || item.attention === attention),
    );
  }, [area, attention, owner, search, state, view.items]);
  return (
    <AppFrame
      title="Dining Floor Board"
      description="DIN-FLOOR-BOARD · query.din_floor_board · dining_floor_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store-scoped Dining operations</p>
          <h2>Tables, Sessions and handoffs</h2>
          <p className="bop-muted">
            As of {view.asOfUtc} · {view.freshness}
          </p>
        </div>
        <div className="card-actions">
          <button disabled title="A command-capable Dining BFF is not connected">
            Start Staff Dining Session
          </button>
          <button disabled>Seat eligible party</button>
          <button disabled>Mark Table unavailable</button>
        </div>
      </header>
      {view.freshness === "Stale" ? (
        <StatePanel heading="Projection is stale" tone="offline" status>
          <p>Realtime is only a requery hint. Reload before moving or closing a Session.</p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="dining-floor-filters">
        <h3 id="dining-floor-filters">Table / Session / reservation filters</h3>
        <div className="list-filters">
          <label>
            Table / Session / handoff
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          {[
            ["Area", area, setArea, ["All", ...areas]],
            [
              "State",
              state,
              setState,
              ["All", "Available", "Occupied", "Closing", "TemporarilyBlocked"],
            ],
            ["Server / owner", owner, setOwner, ["All", ...owners]],
            ["Attention", attention, setAttention, ["All", "None", "Warning", "Urgent"]],
          ].map(([title, value, setter, options]) => (
            <label key={title as string}>
              {title as string}
              <select
                value={value as string}
                onChange={(event) => (setter as (next: string) => void)(event.currentTarget.value)}
              >
                {(options as string[]).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
      {visible.length === 0 ? (
        <StatePanel heading="No Dining Tables" status>
          <p>No Table or Session matches the authorized Store scope and active filters.</p>
        </StatePanel>
      ) : (
        <div className="store-grid">
          {visible.map((item) => (
            <article className="store-card" key={item.tableReference}>
              <div className="card-heading">
                <div>
                  <p className="bop-eyebrow">{item.areaCode}</p>
                  <h3>{item.stableLabel}</h3>
                </div>
                <span>
                  {item.attention === "None" ? item.tableState : `${item.attention} attention`}
                </span>
              </div>
              <dl>
                <div>
                  <dt>Capacity / party</dt>
                  <dd>
                    {item.capacity} / {item.partySize ?? "No active party"}
                  </dd>
                </div>
                <div>
                  <dt>Session / elapsed</dt>
                  <dd>
                    {item.diningSessionReference ?? "None"} ·{" "}
                    {item.elapsedSeconds === null ? "—" : `${item.elapsedSeconds}s`}
                  </dd>
                </div>
                <div>
                  <dt>Order / payment</dt>
                  <dd>
                    {item.orderSummary} · {item.paymentSummary}
                  </dd>
                </div>
                <div>
                  <dt>Reservation / waitlist</dt>
                  <dd>
                    {item.reservationHandoffReference ?? "None"} ·{" "}
                    {item.waitlistHandoffReference ?? "None"}
                  </dd>
                </div>
                <div>
                  <dt>Server / owner</dt>
                  <dd>{item.ownerSummary}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <button disabled>Open Session</button>
                <button disabled>Move Table</button>
                <button disabled>Begin Closing</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="bop-muted">
        Reservation, Waitlist, Ordering and Payment remain source-owned. Commands require
        permission, idempotency, expected version and audit evidence from an authorized BFF.
      </p>
    </AppFrame>
  );
}

export function DiningTableListScreen({ view }: { readonly view: DiningTableListView }) {
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("All");
  const [capacity, setCapacity] = useState("All");
  const [state, setState] = useState("All");
  const [qr, setQr] = useState("All");
  const areas = useMemo(
    () => [...new Set(view.items.map((item) => item.areaCode))].sort(),
    [view.items],
  );
  const visible = useMemo(
    () =>
      view.items.filter(
        (item) =>
          (!search.trim() ||
            item.stableLabel.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) &&
          (area === "All" || item.areaCode === area) &&
          (capacity === "All" ||
            (capacity === "1–2"
              ? item.capacity <= 2
              : capacity === "3–4"
                ? item.capacity >= 3 && item.capacity <= 4
                : item.capacity >= 5)) &&
          (state === "All" || item.operationalState === state || item.lifecycle === state) &&
          (qr === "All" || item.qrStatus === qr),
      ),
    [area, capacity, qr, search, state, view.items],
  );
  return (
    <AppFrame
      title="Dining Tables"
      description="DIN-TABLE-LIST · query.din_table_list · dining_table_admin_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store Manager configuration</p>
          <h2>Stable Table and QR lifecycle</h2>
          <p className="bop-muted">
            As of {view.asOfUtc} · {view.freshness}
          </p>
        </div>
        <button disabled title="A command-capable Dining BFF is not connected">
          Create Table draft
        </button>
      </header>
      <section className="detail-section" aria-labelledby="dining-table-filters">
        <h3 id="dining-table-filters">Table filters</h3>
        <div className="list-filters">
          <label>
            Label
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          <label>
            Area
            <select value={area} onChange={(event) => setArea(event.currentTarget.value)}>
              <option>All</option>
              {areas.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Capacity
            <select value={capacity} onChange={(event) => setCapacity(event.currentTarget.value)}>
              {["All", "1–2", "3–4", "5+"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            State
            <select value={state} onChange={(event) => setState(event.currentTarget.value)}>
              {["All", "Draft", "Published", "Available", "TemporarilyBlocked"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            QR active / replacement
            <select value={qr} onChange={(event) => setQr(event.currentTarget.value)}>
              {["All", "Inactive", "Active", "Revoked"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {visible.length === 0 ? (
        <StatePanel heading="No Tables" status>
          <p>No Table matches the active filters.</p>
        </StatePanel>
      ) : (
        <div className="store-grid">
          {visible.map((item) => (
            <article className="store-card" key={item.tableReference}>
              <div className="card-heading">
                <div>
                  <p className="bop-eyebrow">
                    {item.areaCode} · {item.lifecycle}
                  </p>
                  <h3>{item.stableLabel}</h3>
                </div>
                <span>{item.operationalState}</span>
              </div>
              <dl>
                <div>
                  <dt>Capacity / accessibility</dt>
                  <dd>
                    {item.capacity} · {item.accessibilityAttributes.join(", ") || "None declared"}
                  </dd>
                </div>
                <div>
                  <dt>QR state / version</dt>
                  <dd>
                    {item.qrStatus} · v{item.qrVersion}
                  </dd>
                </div>
                <div>
                  <dt>Current Session</dt>
                  <dd>{item.currentDiningSessionReference ?? "None"}</dd>
                </div>
                <div>
                  <dt>Aggregate version</dt>
                  <dd>{item.aggregateVersion}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <button disabled>Edit configuration draft</button>
                <button disabled>
                  {item.qrStatus === "Active" ? "Revoke QR" : "Issue / replace QR"}
                </button>
                <button disabled>Temporary block</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="bop-muted">
        Stable Table identity is never physically deleted. QR values and credentials are never
        rendered, logged or placed in URLs.
      </p>
    </AppFrame>
  );
}

function useDiningView<T>(
  load: () => Promise<unknown>,
  parse: (value: unknown) => T,
): PageState<T> {
  const [state, setState] = useState<PageState<T>>({ kind: "Loading" });
  const refresh = useCallback(async () => parse(await load()), [load, parse]);
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void refresh()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({ kind: error instanceof DiningClientError ? error.code : "Unavailable" }),
      );
    return () => {
      active = false;
    };
  }, [refresh]);
  return state;
}

export function DiningFloorPage({
  client = unavailableDiningProjectionClient,
}: {
  readonly client?: DiningProjectionClient;
}) {
  const load = useCallback(() => client.loadFloor(), [client]);
  const state = useDiningView(load, parseDiningFloorView);
  return state.kind === "Found" ? (
    <DiningFloorScreen view={state.view} />
  ) : (
    <DiningState state={state.kind} />
  );
}

export function DiningTableListPage({
  client = unavailableDiningProjectionClient,
}: {
  readonly client?: DiningProjectionClient;
}) {
  const load = useCallback(() => client.loadTables(), [client]);
  const state = useDiningView(load, parseDiningTableListView);
  return state.kind === "Found" ? (
    <DiningTableListScreen view={state.view} />
  ) : (
    <DiningState state={state.kind} />
  );
}
