import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parseSupplierView,
  SupplierClientError,
  unavailableSupplierClient,
  type SupplierClientErrorCode,
  type SupplierProjectionClient,
  type SupplierView,
} from "./supplier-pages.js";
type LoadState =
  | { readonly kind: "Loading" | SupplierClientErrorCode }
  | { readonly kind: "Found"; readonly view: SupplierView };
export function SupplierState({ state }: { readonly state: Exclude<LoadState["kind"], "Found"> }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Supplier facts…", "neutral"],
    Empty: ["No suppliers", "No Supplier matches this Brand and filter.", "neutral"],
    PermissionDenied: ["Permission denied", "This Supplier view is unavailable.", "error"],
    NotFound: ["Supplier not found", "The Supplier is unavailable in this Brand.", "neutral"],
    FeatureDisabled: ["Supplier management disabled", "This capability is unavailable.", "neutral"],
    Stale: [
      "Projection stale",
      "Refresh Supplier source facts before lifecycle or qualification actions.",
      "offline",
    ],
    Conflict: ["Supplier changed", "Refresh the Supplier version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve the highlighted identity or qualification fields.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Supplier, Offering or Purchase Order result was inferred.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached Supplier facts cannot authorize an operation.",
      "offline",
    ],
    Unavailable: [
      "Supplier view unavailable",
      "No restricted field or lifecycle result is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function SupplierList({ view }: { readonly view: SupplierView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">SUP-SUPPLIER-LIST · Procurement Manager / Compliance</p>
          <h1>Suppliers</h1>
          <p>
            {view.brandLabel} · {view.freshness} · {view.asOfUtc}
          </p>
        </div>
        {view.permissions.manageSupplier ? (
          <button disabled={readOnly}>Create Supplier draft</button>
        ) : null}
      </header>
      {readOnly ? <SupplierState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Name / Code / approved Contact ref
          <input disabled placeholder="Exact or prefix; Contact ref exact only" />
        </label>
        <label>
          Status / Type / Qualification
          <select disabled>
            <option>All authorized suppliers</option>
          </select>
        </label>
        <label>
          Performance / Open PO
          <select disabled>
            <option>All visible summaries</option>
          </select>
        </label>
      </div>
      {view.rows.length === 0 ? (
        <SupplierState state="Empty" />
      ) : (
        <div className="card-list">
          {view.rows.map((supplier) => (
            <article className="summary-card" key={supplier.supplierReference}>
              <div>
                <p className="bop-eyebrow">
                  {supplier.status} · {supplier.supplierType} · v{supplier.supplierVersion}
                </p>
                <h2>{supplier.displayName}</h2>
                <p>
                  {supplier.supplierCode} · {supplier.legalName}
                </p>
              </div>
              <p>
                Qualification {supplier.qualificationStatus} · expiry{" "}
                {supplier.nextQualificationExpiry ?? "Not available"}
              </p>
              <p>
                Offerings {supplier.offeringCount ?? "Partial"} · open POs{" "}
                {supplier.openPurchaseOrderCount ?? "Partial"}
              </p>
              {view.permissions.performance ? (
                <p>Performance {supplier.performanceSummary ?? "Partial"}</p>
              ) : null}
              <div className="card-actions">
                <Link to={`/app/supply/suppliers/${supplier.supplierReference}`}>
                  View Supplier
                </Link>
                {view.permissions.manageSupplier ? (
                  <button disabled={readOnly || supplier.status !== "Active"}>
                    Suspend with reason
                  </button>
                ) : null}
                {view.permissions.manageSupplier ? (
                  <button disabled={readOnly || supplier.status !== "Suspended"}>
                    Reactivate with approval
                  </button>
                ) : null}
                {view.permissions.manageSupplier ? (
                  <button disabled={readOnly || supplier.status !== "Inactive"}>
                    Archive (no physical delete)
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
export function SupplierDetail({ view }: { readonly view: SupplierView }) {
  const supplier = view.rows[0];
  const detail = view.detail;
  if (!supplier || !detail) return <SupplierState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">SUP-SUPPLIER-DETAIL · {supplier.status}</p>
          <h1>{supplier.displayName}</h1>
          <p>
            {supplier.supplierCode} · {supplier.legalName} · v{supplier.supplierVersion}
          </p>
        </div>
      </header>
      {readOnly ? <SupplierState state="Stale" /> : null}
      <section className="detail-section">
        <h2>Identity and restricted fields</h2>
        <p>Tax registration {detail.taxRegistrationReference ?? "Restricted"}</p>
        {detail.contacts.map((contact) => (
          <p key={contact.contactReference}>
            {contact.roleCode} · {contact.displayName ?? "Restricted"} ·{" "}
            {contact.email ?? "Restricted"} · {contact.phone ?? "Restricted"}
          </p>
        ))}
        {detail.addresses.map((address) => (
          <p key={address.addressReference}>
            {address.addressType} · {address.addressSummary ?? "Restricted"} · {address.regionCode},{" "}
            {address.countryCode}
          </p>
        ))}
      </section>
      <section className="detail-section">
        <h2>Qualifications and evidence</h2>
        {detail.qualifications.map((item) => (
          <article key={item.qualificationReference}>
            <p>
              {item.qualificationType} · {item.jurisdiction} · {item.status}
            </p>
            <p>
              {item.effectiveFrom} → {item.effectiveUntil ?? "No expiry"}
            </p>
            <p>
              Certificate {item.certificateNumber ?? "Restricted"} · Issuer{" "}
              {item.issuer ?? "Restricted"} · Evidence {item.documentReference ?? "Restricted"}
            </p>
            {view.permissions.reviewQualification ? (
              <button disabled={readOnly || item.status !== "Pending"}>Review qualification</button>
            ) : null}
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>Authorized summaries</h2>
        <p>
          Offerings {detail.offeringCount ?? "Partial"} · open POs{" "}
          {detail.openPurchaseOrderCount ?? "Restricted / partial"}
        </p>
        <p>
          Performance {detail.performanceSummary ?? "Restricted / partial"} · history{" "}
          {detail.historyCount} · Audit {detail.auditAvailable ? "Available" : "Restricted"}
        </p>
      </section>
      <div className="card-actions">
        {view.permissions.manageSupplier ? (
          <button disabled={readOnly || supplier.status === "Archived"}>Edit Supplier</button>
        ) : null}
        {view.permissions.manageSupplier ? (
          <button disabled={readOnly || supplier.status !== "Active"}>Suspend with reason</button>
        ) : null}
        <button disabled>Open Offerings</button>
        <button disabled>Open Purchase Orders</button>
        <button disabled>Open Discrepancies</button>
      </div>
      <p role="note">
        Suspension never changes an existing Purchase Order. Physical delete is unavailable.
      </p>
    </main>
  );
}
function SupplierPageLoader({
  client,
  supplierReference,
}: {
  readonly client: SupplierProjectionClient;
  readonly supplierReference: string | null;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load({ supplierReference })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseSupplierView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof SupplierClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, supplierReference]);
  return state.kind === "Found" ? (
    supplierReference === null ? (
      <SupplierList view={state.view} />
    ) : (
      <SupplierDetail view={state.view} />
    )
  ) : (
    <SupplierState state={state.kind} />
  );
}
export function SupplierListPage({
  client = unavailableSupplierClient,
}: {
  readonly client?: SupplierProjectionClient;
}) {
  return <SupplierPageLoader client={client} supplierReference={null} />;
}
export function SupplierDetailPage({
  client = unavailableSupplierClient,
}: {
  readonly client?: SupplierProjectionClient;
}) {
  const { id = "" } = useParams();
  return <SupplierPageLoader client={client} supplierReference={id} />;
}
