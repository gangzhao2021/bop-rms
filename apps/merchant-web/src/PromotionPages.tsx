import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parsePromotionEditorView,
  parsePromotionListView,
  parsePromotionRouteReference,
  PromotionClientError,
  unavailablePromotionClient,
  type PromotionClient,
  type PromotionClientErrorCode,
  type PromotionEditorView,
  type PromotionListView,
} from "./promotion-pages.js";
type LoadState<T> =
  | { readonly kind: "Loading" | PromotionClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };
function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PromotionClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}
export function PromotionState({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Promotion projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your Promotion scope does not allow this view.",
        "error",
      ],
      NotFound: [
        "Promotion unavailable",
        "The Promotion is unavailable in the authorized Brand scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Promotions disabled",
        "This phase capability is disabled for the current Brand.",
        "neutral",
      ],
      Stale: ["Promotion data is stale", "Refresh before simulating or publishing.", "offline"],
      Conflict: [
        "Promotion changed",
        "Reload the authoritative Expected Version before retrying.",
        "offline",
      ],
      CommandFailed: [
        "Command failed",
        "No Pricing fact changed. Retry with the same idempotency reference.",
        "error",
      ],
      Offline: [
        "Offline read-only",
        "Cached Promotion facts may be viewed, but commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Pricing service unavailable",
        "The Promotion BFF is unavailable. No Pricing fact changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
      <Link to="/app/commerce/promotions">Return to Promotions</Link>
    </StatePanel>
  );
}
export function PromotionListScreen({ view }: { readonly view: PromotionListView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [scope, setScope] = useState("");
  const [type, setType] = useState("All");
  const [conflict, setConflict] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const items = view.items.filter(
    (item) =>
      (status === "All" || item.lifecycle === status) &&
      (scope.trim() === "" ||
        item.scopeSummary
          .toLocaleLowerCase("en-CA")
          .includes(scope.trim().toLocaleLowerCase("en-CA"))) &&
      (type === "All" || item.promotionType === type) &&
      (conflict === "All" ||
        (conflict === "Conflict" && item.conflictCount > 0) ||
        (conflict === "Scheduled" && item.scheduleStatus === "Scheduled")) &&
      (needle === "" ||
        [item.name, item.stableCode].some((value) =>
          value.toLocaleLowerCase("en-CA").includes(needle),
        )),
  );
  return (
    <AppFrame
      title="Promotions"
      description="PROMO-LIST · query.promo_list · pricing_promotion_admin_v1"
    >
      <header className="screen-heading">
        <div>
          <h2>Promotion management</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Pricing BFF is not connected">
          Create
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Name or code
          <input value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            {["All", "Draft", "Published", "Paused", "Archived"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Store / channel
          <input value={scope} onChange={(e) => setScope(e.currentTarget.value)} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.currentTarget.value)}>
            <option>All</option>
            {[...new Set(view.items.map((i) => i.promotionType))].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Schedule / conflict
          <select value={conflict} onChange={(e) => setConflict(e.currentTarget.value)}>
            <option>All</option>
            <option>Scheduled</option>
            <option>Conflict</option>
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Promotions" status>
          <p>Change filters or create an authorized Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <article className="store-card" key={item.promotionReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">
                    {item.stableCode} · {item.promotionType}
                  </p>
                  <h3>{item.name}</h3>
                </div>
                <strong>{item.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Scope / eligibility</dt>
                  <dd>
                    {item.scopeSummary} · {item.eligibilitySummary}
                  </dd>
                </div>
                <div>
                  <dt>Benefit / stacking</dt>
                  <dd>
                    {item.benefitSummary} · {item.stacking}
                  </dd>
                </div>
                <div>
                  <dt>Budget / usage</dt>
                  <dd>
                    {item.usageMinor} / {item.budgetMinor} CAD minor units
                  </dd>
                </div>
                <div>
                  <dt>Effective / conflicts</dt>
                  <dd>
                    {item.effectivePeriod} · {item.scheduleStatus} · {item.conflictCount}
                  </dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/commerce/promotions/${item.promotionReference}/edit`}>Edit</Link>
                {["Duplicate", "Simulate", "Submit / approve", "Pause", "Archive"].map((action) => (
                  <button
                    key={action}
                    disabled
                    title="A command-capable Pricing BFF is not connected"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </AppFrame>
  );
}
export function PromotionEditorScreen({ view }: { readonly view: PromotionEditorView }) {
  return (
    <AppFrame
      title={view.name}
      description={`PROMO-EDITOR · ${view.lifecycle} · Expected Version ${view.aggregateVersion}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {view.stableCode} · {view.promotionType}
          </p>
          <h2>Promotion editor</h2>
          <p>{view.customerCopy}</p>
        </div>
        <Link className="shell-action" to="/app/commerce/promotions">
          All Promotions
        </Link>
      </header>
      <div className="store-card-grid">
        {(
          [
            ["Audience / basket condition", view.audienceSummary],
            ["Eligible items", view.eligibleItemsSummary],
            ["Benefit", view.benefitSummary],
            ["Limits / budget", `${view.limitsSummary} · ${view.usageMinor} / ${view.budgetMinor}`],
            ["Stacking / priority", `${view.stacking} · ${view.priority}`],
            ["Schedule", view.scheduleSummary],
            ["Impact", view.impactSummary],
            ["History", view.historySummary],
          ] as const
        ).map(([label, value]) => (
          <StatePanel heading={label} key={label}>
            <p>{value}</p>
          </StatePanel>
        ))}
      </div>
      <h3>Representative basket simulations</h3>
      <div className="store-card-grid">
        {view.simulations.map((item) => (
          <article className="store-card" key={item.basketCode}>
            <header>
              <h3>{item.basketCode}</h3>
            </header>
            <p>
              {item.subtotalMinor} − {item.discountMinor} = {item.totalMinor} CAD minor units
            </p>
            <p>{item.decisionSummary}</p>
          </article>
        ))}
      </div>
      <div className="card-actions" aria-label="Promotion editor actions">
        {[
          "Save draft",
          "Validate",
          "Simulate representative baskets",
          "Compare",
          "Submit review",
          "Approve",
          "Publish / schedule",
        ].map((action) => (
          <button disabled key={action} title="A command-capable Pricing BFF is not connected">
            {action}
          </button>
        ))}
      </div>
    </AppFrame>
  );
}
export function PromotionListPage({
  client = unavailablePromotionClient,
}: {
  readonly client?: PromotionClient;
}) {
  const load = useCallback(() => client.list().then(parsePromotionListView), [client]);
  const state = useLoad(load, "promotions");
  return state.kind === "Found" ? (
    <PromotionListScreen view={state.view} />
  ) : (
    <AppFrame title="Promotions" description="PROMO-LIST">
      <PromotionState state={state.kind} />
    </AppFrame>
  );
}
export function PromotionEditorPage({
  client = unavailablePromotionClient,
}: {
  readonly client?: PromotionClient;
}) {
  let reference: string | null = null;
  try {
    reference = parsePromotionRouteReference(useParams().id);
  } catch {
    reference = null;
  }
  const load = useCallback(
    () =>
      reference === null
        ? Promise.reject(new PromotionClientError("NotFound"))
        : client.load(reference).then((value) => {
            const view = parsePromotionEditorView(value);
            if (view.promotionReference !== reference) throw new PromotionClientError("NotFound");
            return view;
          }),
    [client, reference],
  );
  const state = useLoad(load, reference ?? "invalid");
  return state.kind === "Found" ? (
    <PromotionEditorScreen view={state.view} />
  ) : (
    <AppFrame title="Promotion" description="PROMO-EDITOR">
      <PromotionState state={state.kind} />
    </AppFrame>
  );
}
