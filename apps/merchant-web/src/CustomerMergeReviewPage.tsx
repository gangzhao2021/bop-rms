import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  CustomerMergeReviewClientError,
  parseCustomerMergeReviewView,
  unavailableCustomerMergeReviewClient,
  type CustomerMergeReviewClient,
  type CustomerMergeReviewClientErrorCode,
  type CustomerMergeReviewView,
} from "./customer-merge-review.js";
type State =
  | { readonly kind: "Loading" | CustomerMergeReviewClientErrorCode }
  | { readonly kind: "Found"; readonly view: CustomerMergeReviewView };
export function CustomerMergeReviewState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading purpose-authorized merge evidence…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Privacy-authorized review access is required.",
      "error",
    ],
    NotFound: ["Review not found", "No merge review is available in this Brand.", "neutral"],
    FeatureDisabled: ["Merge review disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh evidence before deciding.", "offline"],
    Conflict: ["Review changed", "Refresh Expected Version before retrying.", "offline"],
    CommandFailed: [
      "Decision failed",
      "No Profile association or source fact was changed.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached evidence cannot authorize a merge.", "offline"],
    Unavailable: ["Review unavailable", "No duplicate or identity match is inferred.", "error"],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}
export function CustomerMergeReview({ view }: { readonly view: CustomerMergeReviewView }) {
  const review = view.review;
  if (!review) return <CustomerMergeReviewState state="NotFound" />;
  const readOnly =
    view.freshness !== "Current" || view.partial || review.status !== "PendingApproval";
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CRM-MERGE-REVIEW · contextual · purpose logged</p>
          <h1>Customer duplicate evidence review</h1>
          <p>
            {view.brandLabel} · {review.status} · v{review.aggregateVersion}
          </p>
        </div>
      </header>
      {view.freshness !== "Current" || view.partial ? (
        <CustomerMergeReviewState state="Stale" />
      ) : null}
      <section className="summary-card">
        <h2>Candidate identities</h2>
        <p>Canonical {review.canonicalProfileReference}</p>
        <p>Candidate retained {review.candidateProfileReference}</p>
        <p>
          Compared versions {review.canonicalProfileVersion} / {review.candidateProfileVersion}
        </p>
        {view.permissions.mayViewEvidence ? (
          <>
            <h3>Verified evidence</h3>
            {review.evidence?.map((item) => (
              <p key={item.evidenceReference}>
                {item.kind} · {item.evidenceReference} · {item.verifiedAt}
              </p>
            ))}
            <p>Consent evidence {review.consentEvidenceReferences?.length ?? 0}</p>
          </>
        ) : null}
        <h3>Conflicting fields</h3>
        {review.conflicts.map((item) => (
          <p key={item.fieldCode}>
            {item.fieldCode} · {item.resolution}
          </p>
        ))}
        <h3>Impact</h3>
        <p>
          Linked accounts {review.linkedAccountReferences.length} · linked transactions{" "}
          {review.linkedTransactionReferences.length}
        </p>
        <p>Impact reference {review.impactReference}</p>
        <p>Rollback reference {review.rollbackReference}</p>
        {review.decisionEvidenceReference ? (
          <p>Decision evidence {review.decisionEvidenceReference}</p>
        ) : null}
        <div className="card-actions">
          {view.permissions.mayReview ? (
            <button disabled={readOnly}>Reject candidate</button>
          ) : null}
          {view.permissions.mayApprove ? (
            <button disabled={readOnly}>Approve verified merge</button>
          ) : null}
        </div>
        <p role="note">
          Exact contact/reference evidence only. A merge retains both Profile IDs and never rewrites
          Order, Reservation, Payment, Audit Actor or other historical facts.
        </p>
      </section>
    </main>
  );
}
export function CustomerMergeReviewPage({
  client = unavailableCustomerMergeReviewClient,
}: {
  readonly client?: CustomerMergeReviewClient;
}) {
  const { reviewId } = useParams();
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load(reviewId)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseCustomerMergeReviewView(value) });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          kind:
            error instanceof CustomerMergeReviewClientError
              ? error.code
              : navigator.onLine
                ? "Unavailable"
                : "Offline",
        });
      });
    return () => {
      active = false;
    };
  }, [client, reviewId]);
  return state.kind === "Found" ? (
    <CustomerMergeReview view={state.view} />
  ) : (
    <CustomerMergeReviewState state={state.kind} />
  );
}
