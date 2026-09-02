import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceRecallPageError,
  parseComplianceRecallView,
  unavailableComplianceRecallClient,
  type ComplianceRecallClient,
  type ComplianceRecallPageErrorCode,
  type ComplianceRecallView,
} from "./compliance-recall-case-page.js";

type PageState =
  | { readonly kind: "Loading" | ComplianceRecallPageErrorCode }
  | { readonly kind: "Found"; readonly view: ComplianceRecallView };
export function ComplianceRecallState({
  state,
}: {
  readonly state: "Loading" | ComplianceRecallPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Recall Case", "Loading authorized Recall facts…", "neutral"],
    PermissionDenied: ["Permission denied", "Recall Lead access is required.", "error"],
    NotFound: ["Recall not found", "No authorized Recall Case exists.", "neutral"],
    FeatureDisabled: ["Recall disabled", "This Phase capability is not enabled.", "neutral"],
    Stale: ["Recall projection stale", "Refresh owner outcomes before acting.", "offline"],
    Conflict: ["Recall changed", "Refresh the immutable revision before acting.", "offline"],
    CommandFailed: [
      "Recall action failed",
      "No scope, block, notice, disposition, or closure was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Recall facts cannot authorize actions.", "offline"],
    Unavailable: ["Recall unavailable", "No owner outcome or closure is inferred.", "error"],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
const label = (value: string) => value.replace(/([a-z])([A-Z])/gu, "$1 $2");
export function ComplianceRecallCase({ view }: { readonly view: ComplianceRecallView }) {
  const item = view.recall;
  const affected = item.affectedScope;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECALL-CASE · Restricted Food Safety</p>
          <h1>{item.recallType} Case</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <section className="detail-section">
        <p className="bop-eyebrow">
          {label(item.sourceKind)} · {item.severity}
        </p>
        <h2>{label(item.status)}</h2>
        <p>
          Recall {item.recallReference} · Case {item.caseReference} · revision {item.revision}
        </p>
        <p>
          Source {item.sourceReference} · snapshot {item.sourceSnapshotDigest}
        </p>
        <p>
          Effective {item.effectiveFrom} → {item.effectiveTo ?? "Open"} · Requirement{" "}
          {item.requirementVersionReference}
        </p>
        <div className="card-actions">
          {view.permissions.mayCalculateScope && !["Closed", "Cancelled"].includes(item.status) ? (
            <button>Calculate affected scope</button>
          ) : null}
          {view.permissions.mayEnforceContainment && item.status === "Containment" ? (
            <button>Enforce owner Hard Blocks</button>
          ) : null}
          {view.permissions.mayCreateTasks &&
          affected !== null &&
          item.taskOutcomeReference === null ? (
            <button>Create Recall tasks</button>
          ) : null}
          {view.permissions.mayResolveNotice && item.status === "Notification" ? (
            <button>Approve / resolve notice</button>
          ) : null}
          {view.permissions.mayRecordDisposition &&
          ["Disposition", "Verification"].includes(item.status) ? (
            <button>Record owner disposition</button>
          ) : null}
          {view.permissions.mayVerifyClosure && item.status === "Verification" ? (
            <button>Verify Recall closure</button>
          ) : null}
        </div>
      </section>
      {affected === null ? (
        <StatePanel heading="Scope calculation required" tone="neutral" status>
          <p>No affected source scope has been inferred.</p>
        </StatePanel>
      ) : (
        <section className="detail-section" aria-label="Affected Recall scope">
          <p className="bop-eyebrow">Trace {affected.traceRunReference}</p>
          <h2>{affected.coverage} trace coverage</h2>
          <p>
            {affected.tracedNodeCount} traced + {affected.gapCount} gaps ={" "}
            {affected.expectedNodeCount} expected
          </p>
          <p>
            Suppliers {affected.supplierReferences.length} · Items{" "}
            {affected.inventoryItemReferences.length} · Lots {affected.lotReferences.length} ·
            Batches {affected.batchReferences.length}
          </p>
          <p>
            Products {affected.productReferences.length} · SKUs {affected.skuReferences.length} ·
            Stores {affected.storeReferences.length}
          </p>
          <p>
            Customer Order scope {affected.customerOrderCount} · Fulfillment scope{" "}
            {affected.fulfillmentCount}
          </p>
          {affected.coverage === "Partial" ? (
            <StatePanel heading="Trace Gaps block closure" tone="offline" status>
              <p>Missing source segments cannot be treated as a complete Recall scope.</p>
            </StatePanel>
          ) : null}
        </section>
      )}
      <section className="detail-section" aria-label="Recall owner outcomes">
        <h2>Containment and notice</h2>
        <p>
          Hard Block outcomes {item.containmentOutcomeReferences.length}/5 · Task{" "}
          {item.taskOutcomeReference ?? "Not created"}
        </p>
        <p>
          Notice {item.noticeRequirement} · decision {item.noticeDecisionReference ?? "Pending"} ·
          approval {item.noticeApprovalReference ?? "Pending"} · outcome{" "}
          {item.notificationOutcomeReference ?? "Pending"}
        </p>
      </section>
      <section className="card-list" aria-label="Recall dispositions">
        {item.dispositions.length === 0 ? (
          <StatePanel heading="No disposition recorded" tone="neutral" status>
            <p>Compliance does not infer an owner action.</p>
          </StatePanel>
        ) : (
          item.dispositions.map((entry) => (
            <article className="summary-card" key={entry.dispositionReference}>
              <p className="bop-eyebrow">
                {entry.subjectKind} · {entry.decision}
              </p>
              <h2>{entry.subjectReference}</h2>
              <p>
                Owner outcome {entry.ownerOutcomeReference} · {entry.decidedAt}
              </p>
            </article>
          ))
        )}
      </section>
      <section className="detail-section" aria-label="Recall Verification">
        <h2>Independent Verification</h2>
        <p>
          {item.verification === null
            ? "Pending"
            : `${label(item.verification.result)} · ${item.verification.verificationReference} · ${item.verification.verifiedAt}`}
        </p>
      </section>
      <p role="note">
        Recall coordinates requirements and opaque outcomes. Inventory, Catalog, Ordering,
        Procurement, Task and Notification retain their facts; historical Orders and Customer
        identities are never rewritten or exposed here.
      </p>
    </main>
  );
}
export function ComplianceRecallCasePage({
  client = unavailableComplianceRecallClient,
}: {
  readonly client?: ComplianceRecallClient;
}) {
  const [state, setState] = useState<PageState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseComplianceRecallView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceRecallPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ComplianceRecallCase view={state.view} />
  ) : (
    <ComplianceRecallState state={state.kind} />
  );
}
