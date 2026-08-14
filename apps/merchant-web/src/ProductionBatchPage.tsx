import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  parseProductionBatchView,
  ProductionBatchClientError,
  unavailableProductionBatchClient,
  type ProductionBatchClient,
  type ProductionBatchClientErrorCode,
  type ProductionBatchView,
} from "./production-batch-page.js";

type State =
  | { readonly kind: "Loading" | ProductionBatchClientErrorCode }
  | { readonly kind: "Found"; readonly view: ProductionBatchView };

export function ProductionBatchState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Production Batch plans…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Kitchen Lead or Inventory authorization is required for this Store.",
      "error",
    ],
    NotFound: ["Batch unavailable", "The Production Batch was not found in this Store.", "neutral"],
    FeatureDisabled: [
      "Production Batch disabled",
      "This phase capability is disabled for the current Store.",
      "neutral",
    ],
    Stale: [
      "Batch data is stale",
      "Refresh the pinned Recipe and Inventory references.",
      "offline",
    ],
    Conflict: ["Batch changed", "Reload the latest aggregate version before retrying.", "offline"],
    CommandFailed: [
      "Command failed",
      "No Batch fact changed. Retry with the same idempotency reference.",
      "error",
    ],
    Offline: [
      "Offline read-only",
      "Cached Batch evidence may be viewed; all commands are disabled.",
      "offline",
    ],
    Unavailable: [
      "Production Batch unavailable",
      "The authorized BFF is unavailable. No Batch or Inventory fact changed.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
      <Link to="/operations/kitchen">Return to Kitchen</Link>
    </StatePanel>
  );
}

export function ProductionBatchScreen({ view }: { readonly view: ProductionBatchView }) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState("All");
  const [station, setStation] = useState("All");
  const [date, setDate] = useState("");
  const [variance, setVariance] = useState("All");
  const [hold, setHold] = useState("All");
  const stations = useMemo(
    () => [...new Set(view.items.map((item) => item.stationCode))].sort(),
    [view.items],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return view.items.filter(
      (item) =>
        (!query ||
          item.batchCode.toLocaleLowerCase().includes(query) ||
          item.recipeName.toLocaleLowerCase().includes(query)) &&
        (state === "All" || item.status === state) &&
        (station === "All" || item.stationCode === station) &&
        (!date || item.plannedDate === date) &&
        (variance === "All" ||
          (variance === "With variance"
            ? (item.varianceBasisPoints ?? 0) > 0
            : (item.varianceBasisPoints ?? 0) === 0)) &&
        (hold === "All" || item.qualityHold === (hold === "On hold")),
    );
  }, [date, hold, search, state, station, variance, view.items]);
  return (
    <AppFrame
      title="Production Batches"
      description="KIT-PRODUCTION-BATCH · query.kit_production_batch · kitchen_production_batch_v1"
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Store-scoped production control</p>
          <h2>Batch planning, yield and consumption</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Kitchen BFF is not connected">
          Create plan
        </button>
      </header>
      <section className="detail-section" aria-labelledby="batch-filters">
        <h3 id="batch-filters">Batch / Recipe filters</h3>
        <div className="list-filters">
          <label>
            Batch / Recipe
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          <label>
            State
            <select value={state} onChange={(event) => setState(event.currentTarget.value)}>
              {["All", "Planned", "InProgress", "Completed", "Quarantined"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Station
            <select value={station} onChange={(event) => setStation(event.currentTarget.value)}>
              <option>All</option>
              {stations.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
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
            Variance
            <select value={variance} onChange={(event) => setVariance(event.currentTarget.value)}>
              {["All", "With variance", "No variance"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Quality hold
            <select value={hold} onChange={(event) => setHold(event.currentTarget.value)}>
              {["All", "On hold", "Clear"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {visible.length === 0 ? (
        <StatePanel heading="No Production Batches" status>
          <p>No Batch matches the authorized Store scope and active filters.</p>
        </StatePanel>
      ) : (
        <div className="store-grid">
          {visible.map((item) => (
            <article className="store-card" key={item.batchReference}>
              <div className="card-heading">
                <div>
                  <p className="bop-eyebrow">{item.status}</p>
                  <h3>{item.batchCode}</h3>
                </div>
                <span>{item.qualityHold ? "Quality hold" : "Quality clear"}</span>
              </div>
              <dl>
                <div>
                  <dt>Recipe / version</dt>
                  <dd>
                    {item.recipeName} · {item.recipeVersion}
                  </dd>
                </div>
                <div>
                  <dt>Planned / actual yield</dt>
                  <dd>
                    {item.plannedYieldMicrounits} / {item.actualYieldMicrounits ?? "Not recorded"}{" "}
                    microunits
                  </dd>
                </div>
                <div>
                  <dt>Station / date</dt>
                  <dd>
                    {item.stationCode} · {item.plannedDate}
                  </dd>
                </div>
                <div>
                  <dt>Variance</dt>
                  <dd>
                    {item.varianceBasisPoints === null
                      ? "Not observed"
                      : `${item.varianceBasisPoints} basis points`}
                  </dd>
                </div>
              </dl>
              <h4>Ingredient / Lot references</h4>
              <ul>
                {item.ingredients.map((ingredient) => (
                  <li
                    key={`${ingredient.inventoryItemReference}:${ingredient.lotReference ?? "none"}`}
                  >
                    Item {ingredient.inventoryItemReference} · Lot{" "}
                    {ingredient.lotReference ?? "Unpinned"} · {ingredient.plannedQuantityMicrounits}{" "}
                    / {ingredient.actualQuantityMicrounits ?? "Not recorded"} microunits
                  </li>
                ))}
              </ul>
              <div className="card-actions">
                <button disabled>Start</button>
                <button disabled>Record yield / consumption</button>
                <button disabled>Complete</button>
                <button disabled>Quarantine / exception</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="bop-muted">
        Commands remain disabled until an authorized Kitchen BFF supplies permission, idempotency,
        expected version and audit context. Inventory movement and valuation remain Inventory-owned.
      </p>
    </AppFrame>
  );
}

export function ProductionBatchPage({
  client = unavailableProductionBatchClient,
}: {
  readonly client?: ProductionBatchClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const load = useCallback(async () => parseProductionBatchView(await client.load()), [client]);
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({
            kind: error instanceof ProductionBatchClientError ? error.code : "Unavailable",
          }),
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state.kind === "Found" ? (
    <ProductionBatchScreen view={state.view} />
  ) : (
    <ProductionBatchState state={state.kind} />
  );
}
