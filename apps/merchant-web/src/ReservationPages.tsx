import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parseReservationView,
  ReservationClientError,
  unavailableReservationProjectionClient,
  type ReservationClientErrorCode,
  type ReservationProjectionClient,
  type ReservationScreenId,
  type ReservationView,
} from "./reservation-pages.js";
type State =
  | { readonly kind: "Loading" | ReservationClientErrorCode }
  | { readonly kind: "Found"; readonly view: ReservationView };
export function ReservationState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Reservation projection…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Reservation access is not authorized for this Store.",
      "error",
    ],
    NotFound: [
      "Reservation unavailable",
      "The Reservation was not found in the authorized Store.",
      "neutral",
    ],
    FeatureDisabled: [
      "Reservations disabled",
      "Reservation capability is disabled for this Store.",
      "neutral",
    ],
    Stale: [
      "Reservation data is stale",
      "Refresh capacity and Reservation evidence before acting.",
      "offline",
    ],
    Conflict: ["Reservation changed", "Reload the latest revision before retrying.", "offline"],
    CommandFailed: ["Command failed", "No Reservation, Payment or Dining fact changed.", "error"],
    Offline: [
      "Offline read-only",
      "Cached Reservation evidence may be stale; commands are disabled.",
      "offline",
    ],
    Unavailable: [
      "Reservations unavailable",
      "The authorized Reservation BFF is unavailable.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/reservations">Return to Reservations</Link>
    </StatePanel>
  );
}
const metadata: Record<ReservationScreenId, readonly [string, string, string]> = {
  "RES-CALENDAR": [
    "Reservation Calendar",
    "Day / week capacity and arrivals",
    "query.res_calendar · reservation_calendar_v1",
  ],
  "RES-LIST": [
    "Reservations",
    "Reservation lifecycle and guarantees",
    "query.res_list · reservation_list_v1",
  ],
  "RES-DETAIL": [
    "Reservation Detail",
    "Original facts, revisions and handoffs",
    "query.res_detail · reservation_detail_v1",
  ],
  "RES-CREATE-EDIT": [
    "Create / Revise Reservation",
    "Capacity-first booking wizard",
    "query.res_create_edit · reservation_create_edit_v1",
  ],
};
export function ReservationScreen({ view }: { readonly view: ReservationView }) {
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState("All");
  const [partySize, setPartySize] = useState("All");
  const [source, setSource] = useState("All");
  const [deposit, setDeposit] = useState("All");
  const [late, setLate] = useState("All");
  const meta = metadata[view.screenId];
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return view.items.filter(
      (item) =>
        (!query ||
          item.reservationReference.includes(query) ||
          item.customerDisplayName.toLocaleLowerCase().includes(query) ||
          item.contactSummary.toLocaleLowerCase().includes(query)) &&
        (!date || item.startAt.startsWith(date)) &&
        (status === "All" || item.status === status) &&
        (partySize === "All" ||
          (partySize === "1–2"
            ? item.partySize <= 2
            : partySize === "3–4"
              ? item.partySize >= 3 && item.partySize <= 4
              : item.partySize >= 5)) &&
        (source === "All" || item.source === source) &&
        (deposit === "All" || item.depositOutcome === deposit) &&
        (late === "All" || item.lateOrNoShow === (late === "Late / no-show")),
    );
  }, [date, deposit, late, partySize, search, source, status, view.items]);
  return (
    <AppFrame title={meta[0]} description={`${view.screenId} · ${meta[2]}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store-scoped Reservation operations</p>
          <h2>{meta[1]}</h2>
          <p className="bop-muted">
            As of {view.asOfUtc} · {view.freshness}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Create Reservation</button>
          <button disabled>Hold capacity</button>
        </div>
      </header>
      {view.freshness === "Stale" ? (
        <StatePanel heading="Projection is stale" tone="offline" status>
          <p>Refresh before confirming, revising, checking in or releasing a Capacity Hold.</p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="reservation-filters">
        <h3 id="reservation-filters">Reservation / contact and exact scenario filters</h3>
        <div className="list-filters">
          <label>
            Reference / customer-safe name / contact exact
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          <label>
            Date
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
          </label>
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
              {[
                "All",
                "Pending",
                "Confirmed",
                "CheckedIn",
                "Seated",
                "Cancelled",
                "NoShow",
                "Expired",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Party size
            <select value={partySize} onChange={(event) => setPartySize(event.currentTarget.value)}>
              {["All", "1–2", "3–4", "5+"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Source / channel
            <select value={source} onChange={(event) => setSource(event.currentTarget.value)}>
              {["All", "Staff", "Customer"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Deposit / guarantee
            <select value={deposit} onChange={(event) => setDeposit(event.currentTarget.value)}>
              {["All", "NotRequired", "Pending", "Satisfied", "Failed", "Indeterminate"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Late / no-show
            <select value={late} onChange={(event) => setLate(event.currentTarget.value)}>
              {["All", "Late / no-show", "On time"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="detail-section">
        <h3>Day / week capacity bands, holds and closures</h3>
        <p>
          Table / area hints: {view.tableAreaHints.join(", ") || "Unavailable"} · Waitlist:{" "}
          {view.waitlistCount}
        </p>
        <ul>
          {view.capacityBands.map((band) => (
            <li key={`${band.areaCode}:${band.startAt}`}>
              {band.areaCode} · {band.startAt}–{band.endAt} · available {band.availableCapacity} ·
              held {band.heldCapacity} · closure {band.closureCode ?? "None"}
            </li>
          ))}
        </ul>
      </section>
      {view.screenId === "RES-CREATE-EDIT" ? (
        <section className="detail-section">
          <h3>Create / Revision steps</h3>
          <ol>
            <li>Date / time and expected duration</li>
            <li>Party size, channel and minimum contact</li>
            <li>Accessibility / controlled request</li>
            <li>Availability lookup and Capacity Hold</li>
            <li>Deposit policy and Payment collaboration</li>
            <li>Confirmation or release on expiry</li>
          </ol>
          <div className="card-actions">
            <button disabled>Save request</button>
            <button disabled>Collect deposit through Payment</button>
            <button disabled>Confirm</button>
            <button disabled>Release Hold</button>
          </div>
        </section>
      ) : null}
      {visible.length === 0 ? (
        <StatePanel heading="No Reservations" status>
          <p>No Reservation matches the authorized Store scope and active filters.</p>
        </StatePanel>
      ) : (
        <div className="store-grid">
          {visible.map((item) => (
            <article className="store-card" key={item.reservationReference}>
              <div className="card-heading">
                <div>
                  <p className="bop-eyebrow">
                    {item.status} · Revision {item.revisionNumber}
                  </p>
                  <h3>{item.customerDisplayName}</h3>
                </div>
                <span>{item.lateOrNoShow ? "Late / no-show attention" : item.source}</span>
              </div>
              <dl>
                <div>
                  <dt>Reference / date / time</dt>
                  <dd>
                    {item.reservationReference} · {item.startAt}–{item.expectedEndAt}
                  </dd>
                </div>
                <div>
                  <dt>Party / contact</dt>
                  <dd>
                    {item.partySize} · {item.contactSummary}
                  </dd>
                </div>
                <div>
                  <dt>Capacity Hold</dt>
                  <dd>
                    {item.capacityHoldReference} · expires {item.capacityHoldExpiresAt}
                  </dd>
                </div>
                <div>
                  <dt>Deposit / guarantee</dt>
                  <dd>
                    {item.depositOutcome} · {item.guaranteeStatus}
                  </dd>
                </div>
                <div>
                  <dt>Accessibility / controlled need</dt>
                  <dd>
                    {item.accessibilityRequestCodes.join(", ") || "None"} ·{" "}
                    {item.specialRequestCode ?? "None"}
                  </dd>
                </div>
                <div>
                  <dt>Notifications / seating handoff</dt>
                  <dd>
                    {item.notificationSummary} · {item.diningSessionReference ?? "Not seated"}
                  </dd>
                </div>
              </dl>
              <div className="card-actions">
                <button disabled>Open</button>
                <button disabled>Check in</button>
                <button disabled>Revise atomically</button>
                <button disabled>Cancel</button>
                <button disabled>Mark no-show</button>
                <button disabled>Seat by Dining command</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="bop-muted">
        Pricing owns amounts, Payment owns financial finality, Dining owns actual seating and
        Notification owns delivery. Contact values require field permission and never enter URLs,
        logs or analytics.
      </p>
    </AppFrame>
  );
}
function useReservation(
  client: ReservationProjectionClient,
  screenId: ReservationScreenId,
  reference?: string,
) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const load = useCallback(
    async () => parseReservationView(await client.load(screenId, reference), screenId),
    [client, reference, screenId],
  );
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({ kind: error instanceof ReservationClientError ? error.code : "Unavailable" }),
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state;
}
function Page({
  client = unavailableReservationProjectionClient,
  screenId,
  reference,
}: {
  readonly client?: ReservationProjectionClient | undefined;
  readonly screenId: ReservationScreenId;
  readonly reference?: string | undefined;
}) {
  const state = useReservation(client, screenId, reference);
  return state.kind === "Found" ? (
    <ReservationScreen view={state.view} />
  ) : (
    <ReservationState state={state.kind} />
  );
}
export const ReservationCalendarPage = ({
  client,
}: {
  readonly client?: ReservationProjectionClient | undefined;
}) => <Page client={client} screenId="RES-CALENDAR" />;
export const ReservationListPage = ({
  client,
}: {
  readonly client?: ReservationProjectionClient | undefined;
}) => <Page client={client} screenId="RES-LIST" />;
export function ReservationDetailPage({
  client,
}: {
  readonly client?: ReservationProjectionClient | undefined;
}) {
  const { id } = useParams();
  return <Page client={client} screenId="RES-DETAIL" reference={id} />;
}
export const ReservationCreateEditPage = ({
  client,
}: {
  readonly client?: ReservationProjectionClient | undefined;
}) => <Page client={client} screenId="RES-CREATE-EDIT" />;
