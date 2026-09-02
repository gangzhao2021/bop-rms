import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import {
  parseTaxConfigView,
  TaxConfigClientError,
  unavailableTaxConfigClient,
  type TaxConfigClient,
  type TaxConfigClientErrorCode,
  type TaxConfigView,
} from "./tax-config-page.js";

type LoadState =
  | { readonly kind: "Loading" | TaxConfigClientErrorCode }
  | { readonly kind: "Found"; readonly view: TaxConfigView };

export function TaxConfigState({ state }: { readonly state: Exclude<LoadState["kind"], "Found"> }) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Tax Configuration projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your Store scope does not allow this Tax Configuration.",
        "error",
      ],
      NotFound: [
        "Tax Configuration unavailable",
        "No configuration is available in the authorized Store scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Tax administration disabled",
        "This phase capability is disabled for the current Store.",
        "neutral",
      ],
      Stale: ["Tax data is stale", "Refresh before simulating or publishing.", "offline"],
      Conflict: [
        "Tax Configuration changed",
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
        "Cached tax facts may be viewed, but commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Pricing service unavailable",
        "The Tax Configuration BFF is unavailable. No Pricing fact changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
    </StatePanel>
  );
}

export function TaxConfigScreen({ view }: { readonly view: TaxConfigView }) {
  const [query, setQuery] = useState("");
  const [jurisdiction, setJurisdiction] = useState("All");
  const [period, setPeriod] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const categories = view.categories.filter(
    (item) =>
      needle === "" ||
      [item.categoryCode, item.receiptCode].some((value) =>
        value.toLocaleLowerCase("en-CA").includes(needle),
      ),
  );
  return (
    <AppFrame
      title="Tax Configuration"
      description={`TAX-CONFIG · query.tax_config · Expected Version ${view.aggregateVersion}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {view.stableCode} · {view.jurisdictionCode}
          </p>
          <h2>Tax Configuration administration</h2>
          <p>
            {view.storeSummary} · {view.lifecycle}
          </p>
        </div>
        <strong>{view.fixtureStatus} fixture</strong>
      </header>
      <div className="list-filters" role="search">
        <label>
          Category or code
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Jurisdiction
          <select
            value={jurisdiction}
            onChange={(event) => setJurisdiction(event.currentTarget.value)}
          >
            <option>All</option>
            <option>{view.jurisdictionCode}</option>
          </select>
        </label>
        <label>
          Effective status
          <select value={period} onChange={(event) => setPeriod(event.currentTarget.value)}>
            <option>All</option>
            <option>Active</option>
            <option>Future</option>
          </select>
        </label>
      </div>
      <StatePanel heading="Professional evidence and applicability">
        <p>{view.registrationApplicability}</p>
        <p>
          {view.effectivePeriod} · {view.historySummary}
        </p>
        <p>
          Selected filters: {jurisdiction} · {period}
        </p>
      </StatePanel>
      {categories.length === 0 ? (
        <StatePanel heading="No matching tax categories" status>
          <p>Change filters or create a professional-fixture-backed Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {categories.map((item) => (
            <article className="store-card" key={item.categoryReference}>
              <header>
                <h3>{item.categoryCode}</h3>
                <strong>{item.treatment}</strong>
              </header>
              <dl>
                <div>
                  <dt>Rate</dt>
                  <dd>{item.rate}</dd>
                </div>
                <div>
                  <dt>Display</dt>
                  <dd>{item.priceInclusion}</dd>
                </div>
                <div>
                  <dt>Receipt code</dt>
                  <dd>{item.receiptCode}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
      <StatePanel heading="Approved fixture receipt preview">
        <dl>
          {view.receiptPreview.map((line) => (
            <div key={line.labelCode}>
              <dt>{line.labelCode}</dt>
              <dd>{line.amountMinor} CAD minor units</dd>
            </div>
          ))}
        </dl>
      </StatePanel>
      <div className="card-actions" aria-label="Tax Configuration actions">
        {[
          "Create fixture-backed draft",
          "Simulate basket",
          "Simulate refund",
          "Submit review",
          "Approve",
          "Publish",
        ].map((action) => (
          <button disabled key={action} title="A command-capable Pricing BFF is not connected">
            {action}
          </button>
        ))}
      </div>
    </AppFrame>
  );
}

export function TaxConfigPage({
  client = unavailableTaxConfigClient,
}: {
  readonly client?: TaxConfigClient;
}) {
  const load = useCallback(() => client.load().then(parseTaxConfigView), [client]);
  const [state, setState] = useState<LoadState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof TaxConfigClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [load]);
  return state.kind === "Found" ? (
    <TaxConfigScreen view={state.view} />
  ) : (
    <AppFrame title="Tax Configuration" description="TAX-CONFIG">
      <TaxConfigState state={state.kind} />
    </AppFrame>
  );
}
