import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parseRecipeEditorView,
  parseRecipeListView,
  parseRecipeRouteReference,
  RecipeClientError,
  unavailableRecipeClient,
  type RecipeClient,
  type RecipeClientErrorCode,
  type RecipeEditorView,
  type RecipeListView,
} from "./recipe-pages.js";
type LoadState<T> =
  | { readonly kind: "Loading" | RecipeClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };
function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => active && setState({ kind: "Found", view }))
      .catch(
        (error: unknown) =>
          active &&
          setState({ kind: error instanceof RecipeClientError ? error.code : "Unavailable" }),
      );
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}
export function RecipeState({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const content: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading the authorized Recipe projection…", "neutral"],
      PermissionDenied: [
        "Permission denied",
        "Your Recipe scope does not allow this view.",
        "error",
      ],
      NotFound: [
        "Recipe unavailable",
        "The Recipe is unavailable in the authorized Brand scope.",
        "neutral",
      ],
      FeatureDisabled: [
        "Recipes disabled",
        "This phase capability is disabled for the current Brand.",
        "neutral",
      ],
      Stale: ["Recipe data is stale", "Refresh before recalculating or reviewing.", "offline"],
      Conflict: ["Recipe changed", "Reload the Expected Version before retrying.", "offline"],
      CommandFailed: [
        "Command failed",
        "No Recipe fact changed. Retry with the same idempotency reference.",
        "error",
      ],
      Offline: [
        "Offline read-only",
        "Cached Recipe facts may be viewed, but commands are disabled.",
        "offline",
      ],
      Unavailable: [
        "Recipe service unavailable",
        "The Recipe BFF is unavailable. No fact changed.",
        "error",
      ],
    };
  const selected = content[state];
  return (
    <StatePanel heading={selected[0]} tone={selected[2]} status>
      <p>{selected[1]}</p>
      <Link to="/app/commerce/recipes">Return to Recipes</Link>
    </StatePanel>
  );
}
export function RecipeListScreen({ view }: { readonly view: RecipeListView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [issue, setIssue] = useState("All");
  const needle = query.trim().toLocaleLowerCase("en-CA");
  const items = view.items.filter(
    (item) =>
      (status === "All" || item.lifecycle === status) &&
      (issue === "All" ||
        (issue === "Unverified allergen" && item.allergenStatus !== "Verified") ||
        (issue === "Missing mapping" && item.mappingMissing) ||
        (issue === "Cost changed" && item.costChanged)) &&
      (needle === "" ||
        [item.name, item.stableCode, item.ingredientSummary].some((value) =>
          value.toLocaleLowerCase("en-CA").includes(needle),
        )),
  );
  return (
    <AppFrame title="Recipes" description="RECIPE-LIST · query.recipe_list · recipe_admin_v1">
      <header className="screen-heading">
        <div>
          <h2>Recipe management</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Recipe BFF is not connected">
          Create
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Name / code / Ingredient
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            {["All", "Draft", "Published", "Invalidated", "Archived"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Review issue
          <select value={issue} onChange={(event) => setIssue(event.currentTarget.value)}>
            {["All", "Unverified allergen", "Missing mapping", "Cost changed"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Recipes" status>
          <p>Change filters or create an authorized Draft.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <article className="store-card" key={item.recipeReference}>
              <header>
                <div>
                  <p className="bop-eyebrow">
                    {item.stableCode} · {item.effectiveVersion}
                  </p>
                  <h3>{item.name}</h3>
                </div>
                <strong>{item.lifecycle}</strong>
              </header>
              <dl>
                <div>
                  <dt>Yield / cost</dt>
                  <dd>
                    {item.yieldSummary} · {item.costMinor} CAD minor units
                  </dd>
                </div>
                <div>
                  <dt>Allergen verification</dt>
                  <dd>{item.allergenStatus}</dd>
                </div>
                <div>
                  <dt>Product / SKU usage</dt>
                  <dd>{item.usageSummary}</dd>
                </div>
                <div>
                  <dt>Mapping / change</dt>
                  <dd>
                    {item.mappingMissing ? "Missing mapping" : "Mapped"} ·{" "}
                    {item.costChanged ? "Cost changed" : "Cost stable"}
                  </dd>
                </div>
              </dl>
              <div className="card-actions">
                <Link to={`/app/commerce/recipes/${item.recipeReference}/edit`}>Edit</Link>
                {["Duplicate", "Review", "Publish", "Archive"].map((action) => (
                  <button
                    key={action}
                    disabled
                    title="A command-capable Recipe BFF is not connected"
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
export function RecipeEditorScreen({ view }: { readonly view: RecipeEditorView }) {
  return (
    <AppFrame
      title={view.name}
      description={`RECIPE-EDITOR · ${view.lifecycle} · Expected Version ${view.aggregateVersion}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {view.stableCode} · {view.effectiveVersion}
          </p>
          <h2>Recipe editor</h2>
          <p>{view.yieldSummary}</p>
        </div>
        <Link className="shell-action" to="/app/commerce/recipes">
          All Recipes
        </Link>
      </header>
      <div className="store-card-grid">
        {(
          [
            ["Preparation version", view.preparationSummary],
            ["Substitution policy", view.substitutionPolicySummary],
            ["Allergen union / evidence", view.allergenUnionSummary],
            ["Cost derivation", view.costDerivationSummary],
            ["Product / SKU usage", view.productSkuUsageSummary],
            ["Dual review", view.reviewSummary],
            ["Usage / history", view.historySummary],
          ] as const
        ).map(([label, value]) => (
          <StatePanel heading={label} key={label}>
            <p>{value}</p>
          </StatePanel>
        ))}
      </div>
      <h3>Ingredient requirements</h3>
      <div className="store-card-grid">
        {view.ingredients.map((item) => (
          <article className="store-card" key={item.sourceReference}>
            <header>
              <h3>{item.sourceName}</h3>
              <strong>{item.sourceKind}</strong>
            </header>
            <p>
              {item.quantitySummary} · {item.lossSummary}
            </p>
            <p>
              {item.allergenSummary} · {item.evidenceSummary}
            </p>
            <p>{item.mappingStatus}</p>
          </article>
        ))}
      </div>
      <div className="card-actions" aria-label="Recipe editor actions">
        {[
          "Save draft",
          "Recalculate yield / cost / allergens",
          "Validate",
          "Submit dual review",
          "Publish",
          "Invalidate",
        ].map((action) => (
          <button disabled key={action} title="A command-capable Recipe BFF is not connected">
            {action}
          </button>
        ))}
      </div>
    </AppFrame>
  );
}
export function RecipeListPage({
  client = unavailableRecipeClient,
}: {
  readonly client?: RecipeClient;
}) {
  const load = useCallback(() => client.list().then(parseRecipeListView), [client]);
  const state = useLoad(load, "recipes");
  return state.kind === "Found" ? (
    <RecipeListScreen view={state.view} />
  ) : (
    <AppFrame title="Recipes" description="RECIPE-LIST">
      <RecipeState state={state.kind} />
    </AppFrame>
  );
}
export function RecipeEditorPage({
  client = unavailableRecipeClient,
}: {
  readonly client?: RecipeClient;
}) {
  let reference: string | null = null;
  try {
    reference = parseRecipeRouteReference(useParams().id);
  } catch {
    reference = null;
  }
  const load = useCallback(
    () =>
      reference === null
        ? Promise.reject(new RecipeClientError("NotFound"))
        : client.load(reference).then((value) => {
            const view = parseRecipeEditorView(value);
            if (view.recipeReference !== reference) throw new RecipeClientError("NotFound");
            return view;
          }),
    [client, reference],
  );
  const state = useLoad(load, reference ?? "invalid");
  return state.kind === "Found" ? (
    <RecipeEditorScreen view={state.view} />
  ) : (
    <AppFrame title="Recipe" description="RECIPE-EDITOR">
      <RecipeState state={state.kind} />
    </AppFrame>
  );
}
