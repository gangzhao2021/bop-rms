import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  OfferingClientError,
  parseOfferingView,
  unavailableOfferingClient,
  type OfferingClientErrorCode,
  type OfferingProjectionClient,
  type OfferingView,
} from "./offering-pages.js";
type LoadState =
  | { readonly kind: "Loading" | OfferingClientErrorCode }
  | { readonly kind: "Found"; readonly view: OfferingView };
export function OfferingState({ state }: { readonly state: Exclude<LoadState["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Offering facts…", "neutral"],
    Empty: ["No offerings", "No Offering matches this Brand and filter.", "neutral"],
    PermissionDenied: ["Permission denied", "This Offering view is unavailable.", "error"],
    NotFound: ["Offering not found", "The Offering is unavailable in this Brand.", "neutral"],
    FeatureDisabled: ["Offering management disabled", "This capability is unavailable.", "neutral"],
    Stale: [
      "Projection stale",
      "Refresh Supplier, Item, qualification and price facts before an action.",
      "offline",
    ],
    Conflict: ["Offering changed", "Refresh the Offering version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve conversion, qualification or price blockers.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Offering, Price or Purchase Order result was inferred.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached Offering facts cannot authorize an operation.",
      "offline",
    ],
    Unavailable: [
      "Offering view unavailable",
      "No cost, qualification or history fact is inferred.",
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
export function OfferingList({ view }: { readonly view: OfferingView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">SUP-OFFERING-LIST · Buyer / Procurement Manager</p>
          <h1>Supplier Offerings</h1>
          <p>
            {view.brandLabel} · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        {view.permissions.manage ? (
          <button disabled={readOnly}>Create Offering draft</button>
        ) : null}
      </header>
      {readOnly ? <OfferingState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Supplier / Item / Code
          <input disabled placeholder="Exact or approved prefix" />
        </label>
        <label>
          Status / Currency
          <select disabled>
            <option>All authorized Offerings</option>
          </select>
        </label>
        <label>
          Store / expiry / qualification
          <select disabled>
            <option>All visible coverage</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <OfferingState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((row) => (
            <article className="summary-card" key={row.offeringReference}>
              <div>
                <p className="bop-eyebrow">
                  {row.lifecycle} · v{row.aggregateVersion}
                </p>
                <h2>{row.inventoryItemName}</h2>
                <p>
                  {row.supplierName} · {row.supplierItemCode}
                </p>
              </div>
              <p>
                {row.packSummary} · MOQ {row.minimumOrderQuantity} · multiple {row.orderMultiple} ·
                lead {row.leadTimeDays}d
              </p>
              <p>
                Price {row.unitCost ?? "Restricted / unavailable"} {row.currency ?? ""} ·
                Qualification {row.qualificationStatus}
              </p>
              <div className="card-actions">
                <Link to={`/app/supply/offerings/${row.offeringReference}`}>Open editor</Link>
                {view.permissions.manage ? (
                  <button
                    disabled={readOnly || !["Published", "Suspended"].includes(row.lifecycle)}
                  >
                    {row.lifecycle === "Published"
                      ? "Suspend with reason"
                      : "Create draft revision"}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      {view.nextCursor ? <button disabled>Load next page</button> : null}
    </main>
  );
}
export function OfferingEditor({ view }: { readonly view: OfferingView }) {
  const row = view.rows[0];
  const detail = view.detail;
  if (!row || !detail) return <OfferingState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  const blocked = detail.validationIssues.some((issue) => issue.severity === "Blocking");
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">SUP-OFFERING-EDITOR · {row.lifecycle}</p>
          <h1>{row.inventoryItemName}</h1>
          <p>
            {row.supplierName} · {row.supplierItemCode} · aggregate v{row.aggregateVersion}
          </p>
        </div>
      </header>
      {readOnly ? <OfferingState state="Stale" /> : null}
      <section className="detail-section">
        <h2>Stable mapping and purchasing versions</h2>
        <p>
          Supplier {row.supplierReference} · Item {row.inventoryItemReference}
        </p>
        {detail.configVersions.map((version) => (
          <article key={version.versionReference}>
            <p>
              Version {version.version} · {version.packQuantity} {version.purchaseUnit} ={" "}
              {version.baseQuantity} {version.baseUnit}
            </p>
            <p>
              MOQ {version.minimumOrderQuantity} · multiple {version.orderMultiple} · lead{" "}
              {version.leadTimeDays} days
            </p>
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Price records</h2>
        {detail.priceRecords.map((price) => (
          <article key={price.priceVersionReference}>
            <p>
              {price.source} · {price.scope} · {price.unitCost ?? "Restricted"}{" "}
              {price.currency ?? ""} / {price.priceUnit}
            </p>
            <p>
              {price.effectiveFrom} → {price.effectiveUntil ?? "No expiry"}
            </p>
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Validation and qualification</h2>
        {detail.validationIssues.length ? (
          detail.validationIssues.map((issue) => (
            <p role={issue.severity === "Blocking" ? "alert" : "note"} key={issue.code}>
              {issue.severity}: {issue.message}
            </p>
          ))
        ) : (
          <p>No blocking issue in the authorized projection.</p>
        )}
        <p>
          Qualification evidence {detail.qualificationReferences?.length ?? "Restricted"} · history{" "}
          {detail.historyReferences?.length ?? "Restricted"}
        </p>
      </section>
      <div className="card-actions">
        {view.permissions.manage ? (
          <button disabled={readOnly || row.lifecycle !== "Draft"}>Save draft version</button>
        ) : null}
        {view.permissions.manage ? (
          <button disabled={readOnly || blocked || row.lifecycle !== "Draft"}>
            Submit for approval
          </button>
        ) : null}
        {view.permissions.approve ? (
          <button disabled={readOnly || blocked || row.lifecycle !== "Submitted"}>
            Approve as distinct Actor
          </button>
        ) : null}
        {view.permissions.publish ? (
          <button disabled={readOnly || blocked || row.lifecycle !== "Approved"}>
            Publish validated Offering
          </button>
        ) : null}
      </div>
      <p role="note">
        Published Purchase Orders retain their Offering Version and Price Record snapshots.
        Arbitrary line price override is unavailable.
      </p>
    </main>
  );
}
function OfferingPageLoader({
  client,
  offeringReference,
}: {
  readonly client: OfferingProjectionClient;
  readonly offeringReference: string | null;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load({ offeringReference })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseOfferingView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OfferingClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, offeringReference]);
  return state.kind === "Found" ? (
    offeringReference === null ? (
      <OfferingList view={state.view} />
    ) : (
      <OfferingEditor view={state.view} />
    )
  ) : (
    <OfferingState state={state.kind} />
  );
}
export function OfferingListPage({
  client = unavailableOfferingClient,
}: {
  readonly client?: OfferingProjectionClient;
}) {
  return <OfferingPageLoader client={client} offeringReference={null} />;
}
export function OfferingEditorPage({
  client = unavailableOfferingClient,
}: {
  readonly client?: OfferingProjectionClient;
}) {
  const { id } = useParams();
  return <OfferingPageLoader client={client} offeringReference={id ?? null} />;
}
