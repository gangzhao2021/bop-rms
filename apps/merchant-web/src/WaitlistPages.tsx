import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import {
  parseWaitlistView,
  unavailableWaitlistProjectionClient,
  WaitlistClientError,
  type WaitlistClientErrorCode,
  type WaitlistProjectionClient,
  type WaitlistScreenId,
  type WaitlistView,
} from "./waitlist-pages.js";

type State =
  | { readonly kind: "Loading" | WaitlistClientErrorCode }
  | { readonly kind: "Found"; readonly view: WaitlistView };
export function WaitlistState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading the authorized Waitlist projection…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Waitlist access is not authorized for this Store.",
      "error",
    ],
    NotFound: ["Entry unavailable", "The Waitlist Entry was not found in this Store.", "neutral"],
    FeatureDisabled: [
      "Waitlist disabled",
      "Waitlist capability is disabled for this Store.",
      "neutral",
    ],
    Stale: [
      "Waitlist data is stale",
      "Refresh before changing a party or seating handoff.",
      "offline",
    ],
    Conflict: ["Entry changed", "Reload the current Entry version before retrying.", "offline"],
    CommandFailed: ["Command failed", "No Waitlist, Notification or Dining fact changed.", "error"],
    Offline: [
      "Offline read-only",
      "Cached order and ETA may be stale; commands are disabled.",
      "offline",
    ],
    Unavailable: ["Waitlist unavailable", "The authorized Waitlist BFF is unavailable.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/waitlist">Return to Waitlist</Link>
    </StatePanel>
  );
}
const metadata: Record<WaitlistScreenId, readonly [string, string, string]> = {
  "WAIT-BOARD": [
    "Waitlist Board",
    "Dynamic compatibility order and readiness",
    "query.wait_board · waitlist_board_v1",
  ],
  "WAIT-ENTRY": [
    "Waitlist Entry",
    "Controlled details, estimates and timeline",
    "query.wait_entry · waitlist_entry_v1",
  ],
};
export function WaitlistScreen({ view }: { readonly view: WaitlistView }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [party, setParty] = useState("All");
  const [area, setArea] = useState("All");
  const [priority, setPriority] = useState("All");
  const [overdue, setOverdue] = useState("All");
  const areas = useMemo(
    () =>
      [
        ...new Set(view.entries.map((entry) => entry.areaPreferenceCode).filter(Boolean)),
      ] as string[],
    [view.entries],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return view.entries.filter(
      (entry) =>
        (!query ||
          entry.waitlistEntryReference.includes(query) ||
          entry.customerDisplayName.toLocaleLowerCase().includes(query)) &&
        (status === "All" || entry.status === status) &&
        (party === "All" ||
          (party === "1–2"
            ? entry.partySize <= 2
            : party === "3–4"
              ? entry.partySize >= 3 && entry.partySize <= 4
              : entry.partySize >= 5)) &&
        (area === "All" || entry.areaPreferenceCode === area) &&
        (priority === "All" || entry.priorityKind === priority) &&
        (overdue === "All" || entry.overdue === (overdue === "Overdue")),
    );
  }, [area, overdue, party, priority, search, status, view.entries]);
  const meta = metadata[view.screenId];
  return (
    <AppFrame title={meta[0]} description={`${view.screenId} · ${meta[2]}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store-scoped Reservation &amp; Waiting</p>
          <h2>{meta[1]}</h2>
          <p className="bop-muted">
            As of {view.asOfUtc} · {view.freshness}
          </p>
        </div>
        <div className="card-actions">
          <button disabled>Add Waitlist Entry</button>
          <button disabled>Recalculate ETA ranges</button>
        </div>
      </header>
      {view.freshness === "Stale" ? (
        <StatePanel heading="Projection is stale" tone="offline" status>
          <p>Queue order, compatibility and ETA are read-only until refreshed.</p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="waitlist-filters">
        <h3 id="waitlist-filters">Dynamic queue filters</h3>
        <div className="list-filters">
          <label>
            Customer-safe name / reference
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
              {[
                "All",
                "Waiting",
                "CheckedIn",
                "Called",
                "Ready",
                "Seated",
                "Missed",
                "Cancelled",
                "Expired",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Party size
            <select value={party} onChange={(event) => setParty(event.currentTarget.value)}>
              {["All", "1–2", "3–4", "5+"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Area
            <select value={area} onChange={(event) => setArea(event.currentTarget.value)}>
              {["All", ...areas].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(event) => setPriority(event.currentTarget.value)}>
              {["All", "Default", "Policy", "ManagerOverride"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Overdue
            <select value={overdue} onChange={(event) => setOverdue(event.currentTarget.value)}>
              {["All", "Overdue", "On time"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {visible.length === 0 ? (
        <StatePanel heading="No Waitlist Entries" status>
          <p>No Entry matches the current authorized Store scope and filters.</p>
        </StatePanel>
      ) : (
        <div className="store-grid">
          {visible.map((entry) => (
            <article className="store-card" key={entry.waitlistEntryReference}>
              <div className="card-heading">
                <div>
                  <p className="bop-eyebrow">
                    Dynamic position {entry.dynamicPosition} · {entry.status}
                  </p>
                  <h3>{entry.customerDisplayName}</h3>
                </div>
                <span>{entry.overdue ? "Overdue" : entry.seatingEligibility}</span>
              </div>
              <dl>
                <div>
                  <dt>Reference / contact state</dt>
                  <dd>
                    {entry.waitlistEntryReference} · {entry.contactState} · {entry.contactSummary}
                  </dd>
                </div>
                <div>
                  <dt>Party / preferences</dt>
                  <dd>
                    {entry.partySize} · {entry.joinMode} · {entry.areaPreferenceCode ?? "Any area"}{" "}
                    · {entry.seatingConstraintCodes.join(", ") || "No constraints"}
                  </dd>
                </div>
                <div>
                  <dt>Arrival / wait metrics</dt>
                  <dd>
                    Joined {entry.joinedAt} · Check-in {entry.checkedInAt ?? "Pending"}
                  </dd>
                </div>
                <div>
                  <dt>Quoted / current ETA range</dt>
                  <dd>
                    {entry.quotedMinimumMinutes}–{entry.quotedMaximumMinutes} min quoted ·{" "}
                    {entry.currentMinimumMinutes}–{entry.currentMaximumMinutes} min current ·
                    calculated {entry.estimateCalculatedAt} ({entry.estimateCalculationVersion}) ·
                    estimate, not guarantee
                  </dd>
                </div>
                <div>
                  <dt>Priority reason</dt>
                  <dd>
                    {entry.priorityKind} · {entry.priorityReasonCode ?? "Original Joined At"}
                  </dd>
                </div>
                <div>
                  <dt>Contact / ready expiry / notification</dt>
                  <dd>
                    Response {entry.responseDeadline ?? "Not called"} · Ready{" "}
                    {entry.readyExpiresAt ?? "Not ready"} · extension{" "}
                    {entry.readyExtensionUsed ? "Used" : "Available"} · {entry.notificationStatus}
                  </dd>
                </div>
                <div>
                  <dt>Seating eligibility / Dining handoff</dt>
                  <dd>
                    {entry.seatingEligibility} ·{" "}
                    {entry.diningSessionReference ?? "No Dining Session"}
                  </dd>
                </div>
                <div>
                  <dt>Revision / timeline</dt>
                  <dd>
                    Revision {entry.revisionNumber} ·{" "}
                    {entry.timeline
                      .map((item) => `${item.actionCode} ${item.occurredAt} ${item.actorSummary}`)
                      .join(" · ") || "No timeline"}
                  </dd>
                </div>
              </dl>
              <div className="card-actions">
                <button disabled>Edit controlled details</button>
                <button disabled>Update estimate</button>
                <button disabled>Notify ready</button>
                <button disabled>Mark Ready</button>
                <button disabled>Extend once by policy</button>
                <button disabled>Hold / remove with reason</button>
                <button disabled>Seat through Dining handoff</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="bop-muted">
        Position is a dynamic compatibility result, never an immutable promise. Dining owns actual
        Table assignment and Session creation; Notification failure does not roll back Waitlist
        state.
      </p>
    </AppFrame>
  );
}
function useWaitlist(
  client: WaitlistProjectionClient,
  screenId: WaitlistScreenId,
  reference?: string,
) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const load = useCallback(
    async () => parseWaitlistView(await client.load(screenId, reference), screenId),
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
          setState({ kind: error instanceof WaitlistClientError ? error.code : "Unavailable" }),
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state;
}
function Page({
  client = unavailableWaitlistProjectionClient,
  screenId,
  reference,
}: {
  readonly client?: WaitlistProjectionClient | undefined;
  readonly screenId: WaitlistScreenId;
  readonly reference?: string | undefined;
}) {
  const state = useWaitlist(client, screenId, reference);
  return state.kind === "Found" ? (
    <WaitlistScreen view={state.view} />
  ) : (
    <WaitlistState state={state.kind} />
  );
}
export const WaitlistBoardPage = ({
  client,
}: {
  readonly client?: WaitlistProjectionClient | undefined;
}) => <Page client={client} screenId="WAIT-BOARD" />;
export const WaitlistEntryPage = ({
  client,
  reference,
}: {
  readonly client?: WaitlistProjectionClient | undefined;
  readonly reference?: string | undefined;
}) => <Page client={client} screenId="WAIT-ENTRY" reference={reference} />;
