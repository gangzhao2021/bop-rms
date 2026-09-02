import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  GoodsReceiptClientError,
  parseGoodsReceiptView,
  unavailableGoodsReceiptClient,
  type GoodsReceiptClientErrorCode,
  type GoodsReceiptProjectionClient,
  type GoodsReceiptView,
} from "./goods-receipt-page.js";
type LoadState =
  | { readonly kind: "Loading" | GoodsReceiptClientErrorCode }
  | { readonly kind: "Found"; readonly view: GoodsReceiptView };
export function GoodsReceiptState({
  state,
}: {
  readonly state: Exclude<LoadState["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Purchase Order receiving facts…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Receiving is unavailable for this Stock Site.",
      "error",
    ],
    NotFound: ["Purchase Order not found", "Select an issued PO for this Stock Site.", "neutral"],
    FeatureDisabled: ["Receiving disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh the issued PO snapshot before posting.", "offline"],
    Conflict: ["Receipt changed", "Refresh Expected Version before retrying.", "offline"],
    ValidationFailed: [
      "Validation required",
      "Resolve quantities, lot, location, quality or tolerance blockers.",
      "error",
    ],
    CommandFailed: ["Submit failed", "No Receipt or Stock Movement was committed.", "error"],
    Offline: [
      "Offline read-only",
      "Cached facts cannot authorize an immutable receipt.",
      "offline",
    ],
    Unavailable: [
      "Receiving unavailable",
      "No receipt, movement, cost or evidence is inferred.",
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
export function GoodsReceiptWizard({ view }: { readonly view: GoodsReceiptView }) {
  const draft = view.draft;
  const readOnly = view.freshness !== "Current" || view.partial;
  if (!draft) return <GoodsReceiptState state="NotFound" />;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">INV-GOODS-RECEIPT · Immutable Stock Ledger posting</p>
          <h1>Receive Purchase Order</h1>
          <p>
            {view.brandLabel} · {view.stockSiteLabel} · {view.freshness}
          </p>
        </div>
      </header>
      {readOnly ? <GoodsReceiptState state="Stale" /> : null}
      <section className="detail-section">
        <h2>1. Select and verify issued PO</h2>
        <label>
          PO / Supplier / Item / barcode
          <input disabled value={draft.purchaseOrderReference} readOnly />
        </label>
        <p>
          {draft.supplierSummary} · Revision {draft.purchaseOrderRevisionNumber} · issued snapshot{" "}
          {draft.issuedSnapshotReference}
        </p>
      </section>
      <section className="detail-section">
        <h2>2. Record actual delivery and quality</h2>
        {draft.lines.map((line) => (
          <article key={line.receiptLineReference}>
            <h3>{line.itemSummary}</h3>
            <p>
              PO line {line.purchaseOrderLineReference} · ordered {line.orderedQuantity} ·
              previously accepted {line.priorAcceptedQuantity} {line.purchaseUnit}
            </p>
            <p>
              Delivered {line.deliveredQuantity} · accepted {line.acceptedQuantity} · rejected{" "}
              {line.rejectedQuantity} · damaged {line.damagedQuantity}
            </p>
            <p>
              Conversion {line.conversionMultiplier} {line.baseUnit} / {line.purchaseUnit} · lot{" "}
              {line.lotCode ?? "Not tracked"} · expiry {line.expiryDate ?? "Not tracked"} ·{" "}
              {line.locationSummary}
            </p>
            <p>
              Quality {line.qualityDisposition} · tolerance {line.overReceiptPolicy} /{" "}
              {line.toleranceQuantity}
              {line.overrideReasonCode ? ` · override ${line.overrideReasonCode}` : ""}
            </p>
            {view.permissions.mayViewTemperature ? (
              <p>
                Temperature {line.temperatureReading ?? "Not captured"} {line.temperatureUnit ?? ""}
              </p>
            ) : null}
            {view.permissions.mayViewEvidence ? (
              <p>Evidence attachments {line.evidenceCount ?? 0}</p>
            ) : null}
            {view.permissions.mayViewCost ? (
              <p>Unit cost {line.unitCost ?? "Unavailable"}</p>
            ) : null}
            {line.discrepancyRequired ? (
              <p role="alert">
                Discrepancy required · shortage, overage, rejection, damage or quarantine is
                explicit.
              </p>
            ) : null}
          </article>
        ))}
      </section>
      <section className="detail-section">
        <h2>3. Review immutable posting</h2>
        <p>
          Rejected and damaged quantities do not enter accepted Stock. Corrections append Adjustment
          or Void movements; the original remains immutable.
        </p>
        <label>
          <input type="checkbox" disabled={readOnly || !view.permissions.mayReceive} /> Confirm
          actual quantities, evidence and Stock Site
        </label>
        <div className="card-actions">
          {view.permissions.mayReceive ? (
            <button disabled={readOnly}>Submit Receipt and Stock Movements atomically</button>
          ) : null}
          {view.permissions.mayOverride ? (
            <button disabled={readOnly}>Request independent manager override</button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
export function GoodsReceiptPage({
  client = unavailableGoodsReceiptClient,
}: {
  readonly client?: GoodsReceiptProjectionClient;
}) {
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseGoodsReceiptView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof GoodsReceiptClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <GoodsReceiptWizard view={state.view} />
  ) : (
    <GoodsReceiptState state={state.kind} />
  );
}
