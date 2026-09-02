import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  CustomerProfileClientError,
  parseCustomerProfileView,
  unavailableCustomerProfileClient,
  type CustomerProfileClientErrorCode,
  type CustomerProfileProjectionClient,
  type CustomerProfileView,
} from "./customer-profile-pages.js";
type LoadState =
  | { readonly kind: "Loading" | CustomerProfileClientErrorCode }
  | { readonly kind: "Found"; readonly view: CustomerProfileView };
export function CustomerProfileState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading purpose-authorized Customer facts…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Customer data is unavailable for this purpose.",
      "error",
    ],
    NotFound: ["Customer not found", "No Profile is available in this Brand.", "neutral"],
    FeatureDisabled: ["Customer profiles disabled", "This capability is unavailable.", "neutral"],
    Stale: [
      "Projection stale",
      "Refresh verified Customer facts before changing the Profile.",
      "offline",
    ],
    Conflict: ["Profile changed", "Refresh Expected Version before retrying.", "offline"],
    CommandFailed: ["Command failed", "No Profile or historical transaction was changed.", "error"],
    Offline: ["Offline read-only", "Cached Customer data cannot authorize a mutation.", "offline"],
    Unavailable: [
      "Customer profiles unavailable",
      "No contact, note or proof is inferred.",
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
export function CustomerProfileList({ view }: { readonly view: CustomerProfileView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CRM-CUSTOMER-LIST · purpose logged</p>
          <h1>Customers</h1>
          <p>
            {view.brandLabel} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayManage ? (
          <button disabled={readOnly}>Create with valid purpose</button>
        ) : null}
      </header>
      {readOnly ? <CustomerProfileState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Exact authorized contact / name token
          <input disabled placeholder="Use approved search" />
        </label>
        <label>
          Status / program / tier
          <select disabled>
            <option>All authorized profiles</option>
          </select>
        </label>
        <label>
          Consent / last interaction / open case
          <select disabled>
            <option>All purpose-visible facts</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <StatePanel heading="No Customers" tone="neutral" status>
          <p>No Profile matches this scoped purpose.</p>
        </StatePanel>
      ) : (
        <div className="card-list">
          {view.rows.map((row) => (
            <article className="summary-card" key={row.customerReference}>
              <div>
                <p className="bop-eyebrow">
                  {row.relationshipStatus} · {row.lastInteractionAt ?? "No interaction"}
                </p>
                <h2>{row.displayName}</h2>
              </div>
              {view.permissions.mayViewContacts ? (
                <p>Verified contact {row.maskedContact ?? "Unavailable"}</p>
              ) : null}
              {view.permissions.mayViewLoyalty ? (
                <p>
                  Loyalty {row.loyaltyStatus ?? "Not enrolled"} · tier {row.tierCode ?? "None"}
                </p>
              ) : null}
              {view.permissions.mayViewConsent ? (
                <p>Consent {row.consentSummary ?? "Unavailable"}</p>
              ) : null}
              {view.permissions.mayViewPrivacyCases ? (
                <p>{row.openCase ? "Open case" : "No open case"}</p>
              ) : null}
              <Link to={`/app/customers/${row.customerReference}`}>View Customer</Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
export function CustomerProfileDetail({ view }: { readonly view: CustomerProfileView }) {
  const detail = view.detail;
  if (detail === null) return <CustomerProfileState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CRM-CUSTOMER-DETAIL · {detail.relationshipStatus}</p>
          <h1>{detail.displayName}</h1>
          <p>
            {view.brandLabel} · created from {detail.creationBasis} · v{detail.aggregateVersion}
          </p>
        </div>
      </header>
      {readOnly ? <CustomerProfileState state="Stale" /> : null}
      <section className="summary-card">
        <h2>Profile</h2>
        <p>
          Locale {detail.preferredLocale ?? "Not set"} · User{" "}
          {detail.userLinked ? "verified and linked" : "not linked"}
        </p>
        {view.permissions.mayViewContacts ? (
          <>
            <h3>Verified contacts</h3>
            {detail.verifiedContacts?.map((item) => (
              <p key={item.contactReference}>
                {item.contactType} · {item.maskedValue} · verified {item.verifiedAt}
              </p>
            ))}
          </>
        ) : null}
        {view.permissions.mayViewTransactions ? (
          <>
            <h3>Linked transactions</h3>
            {detail.transactionReferences?.map((item) => (
              <p key={item.transactionReference}>
                {item.transactionType} · {item.transactionReference} · linked {item.linkedAt}
              </p>
            ))}
          </>
        ) : null}
        {view.permissions.mayViewLoyalty ? (
          <p>Loyalty accounts {detail.loyaltyAccounts?.length ?? 0}</p>
        ) : null}
        {view.permissions.mayViewConsent ? (
          <p>Consent {detail.consentSummary ?? "Unavailable"}</p>
        ) : null}
        {view.permissions.mayViewCommunications ? (
          <p>Communications {detail.communicationCount ?? 0}</p>
        ) : null}
        {view.permissions.mayViewPrivacyCases ? (
          <p>Privacy / case summary {detail.privacyCaseReferences?.length ?? 0}</p>
        ) : null}
        {view.permissions.mayViewServiceNotes ? (
          <>
            <h3>Service notes</h3>
            {detail.serviceNotes?.map((item) => (
              <p key={item.noteReference}>
                {item.categoryCode} · {item.note}
              </p>
            ))}
          </>
        ) : null}
        {view.permissions.mayViewAudit ? (
          <p>Audit reference {detail.auditReference ?? "Unavailable"}</p>
        ) : null}
        <div className="card-actions">
          {view.permissions.mayManage ? (
            <>
              <button disabled={readOnly}>Update allowed profile</button>
              <button disabled={readOnly}>Attach verified contact reference</button>
              <button disabled={readOnly}>Link eligible Guest transaction with proof</button>
            </>
          ) : null}
        </div>
        <p role="note">
          Real Email/Phone stays in Identity. Linking never rewrites an Order, Reservation, Guest
          Session, participant or Audit Actor.
        </p>
      </section>
    </main>
  );
}
function CustomerProfilePage({
  screenId,
  client,
  customerReference,
}: {
  readonly screenId: CustomerProfileView["screenId"];
  readonly client: CustomerProfileProjectionClient;
  readonly customerReference?: string | undefined;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load(screenId, customerReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseCustomerProfileView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof CustomerProfileClientError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, screenId, customerReference]);
  if (state.kind !== "Found") return <CustomerProfileState state={state.kind} />;
  return screenId === "CRM-CUSTOMER-LIST" ? (
    <CustomerProfileList view={state.view} />
  ) : (
    <CustomerProfileDetail view={state.view} />
  );
}
export function CustomerListPage({
  client = unavailableCustomerProfileClient,
}: {
  readonly client?: CustomerProfileProjectionClient;
}) {
  return <CustomerProfilePage screenId="CRM-CUSTOMER-LIST" client={client} />;
}
export function CustomerDetailPage({
  client = unavailableCustomerProfileClient,
}: {
  readonly client?: CustomerProfileProjectionClient;
}) {
  const { id } = useParams();
  return (
    <CustomerProfilePage screenId="CRM-CUSTOMER-DETAIL" client={client} customerReference={id} />
  );
}
