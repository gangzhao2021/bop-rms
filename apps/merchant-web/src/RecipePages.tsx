import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  assertRecipeViewScope,
  parseRecipeEditorView,
  parseRecipeListView,
  parseRecipeRouteReference,
  RecipeClientError,
  recipeSummaryText,
  unavailableRecipeClient,
  type RecipeClient,
  type RecipeClientErrorCode,
  type RecipeEditorView,
  type RecipeListView,
  type RecipeSummary,
  type RecipeViewMetadata,
} from "./recipe-pages.js";
type LoadState<T> =
  | { readonly kind: "Loading" | RecipeClientErrorCode }
  | { readonly kind: "Found"; readonly view: T };
function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [result, setResult] = useState<{ load: typeof load; key: string; state: LoadState<T> }>({
    load,
    key,
    state: { kind: "Loading" },
  });
  useEffect(() => {
    let active = true;
    const setState = (state: LoadState<T>) => setResult({ load, key, state });
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
  return result.load === load && result.key === key ? result.state : { kind: "Loading" };
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
        "Recipe data unavailable",
        "The authorized Recipe source is unavailable. No Recipe fact changed.",
        "offline",
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
        [
          item.name,
          item.stableCode,
          item.ingredientSummary.status === "Available" ? item.ingredientSummary.value : "",
        ].some((value) => value.toLocaleLowerCase("en-CA").includes(needle))),
  );
  return (
    <AppFrame title="COMMERCE" description="REVIEW" className="recipe-screen">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-LIST · PHASE 2</p>
          <h2>Recipe management</h2>
          <p className="bop-muted">As of {view.asOfUtc}</p>
        </div>
        <button disabled title="A command-capable Recipe BFF is not connected">
          Create
        </button>
      </header>
      <ProjectionStatus view={view} />
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
                    {item.yieldSummary} ·{" "}
                    {item.cost.status === "Available"
                      ? `${item.cost.value.amountMinor} ${item.cost.value.currencyCode} minor units`
                      : item.cost.status === "PermissionHidden"
                        ? "Restricted"
                        : "Unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Allergen verification</dt>
                  <dd>{item.allergenStatus}</dd>
                </div>
                <div>
                  <dt>Product / SKU usage</dt>
                  <dd>
                    <SummaryValue value={item.usageSummary} view={view} />
                  </dd>
                </div>
                <div>
                  <dt>Mapping / change</dt>
                  <dd>
                    {item.mappingMissing === null
                      ? "Mapping unavailable"
                      : item.mappingMissing
                        ? "Missing mapping"
                        : "Mapped"}{" "}
                    ·{" "}
                    {item.costChanged === null
                      ? "Cost change unavailable"
                      : item.costChanged
                        ? "Cost changed"
                        : "Cost stable"}
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
function ProjectionStatus({ view }: { readonly view: RecipeViewMetadata }) {
  return (
    <section aria-label="Recipe data status">
      <p role="status">
        {view.freshness === "Stale" ? "Stale · read-only" : "Fresh"}
        {view.partial ? " · Partial data" : ""}
      </p>
      <ul>
        {Object.entries(view.sources).map(([kind, source]) => (
          <li key={kind}>
            {kind}: {source.status === "PermissionHidden" ? "Restricted" : source.status}
            {source.status === "Current" || source.status === "Stale" ? ` · ${source.asOfUtc}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
function SummaryValue({
  value,
  view,
  safety = false,
}: {
  readonly value: RecipeSummary;
  readonly view: RecipeViewMetadata;
  readonly safety?: boolean;
}) {
  if (
    safety &&
    (view.freshness === "Stale" ||
      Object.entries(view.sources).some(
        ([kind, source]) => kind !== "Usage" && source.status !== "Current",
      ))
  )
    return <>Verification unavailable</>;
  return (
    <>
      {value.status === "Available" && view.freshness === "Stale" ? "Stale · " : ""}
      {recipeSummaryText(value)}
    </>
  );
}
export function RecipeEditorScreen({ view }: { readonly view: RecipeEditorView }) {
  return (
    <AppFrame title="COMMERCE" description="REVIEW" className="recipe-screen">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-EDITOR · PHASE 2</p>
          <h2>Recipe editor</h2>
          <p className="bop-muted">
            {view.name} · {view.stableCode} · {view.effectiveVersion}
          </p>
        </div>
        <Link className="shell-action" to="/app/commerce/recipes">
          All Recipes
        </Link>
      </header>
      <p className="bop-muted">As of {view.asOfUtc}</p>
      <ProjectionStatus view={view} />
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
            <p>
              <SummaryValue
                value={value}
                view={view}
                safety={label === "Allergen union / evidence" || label === "Dual review"}
              />
            </p>
          </StatePanel>
        ))}
      </div>
      <h3>Ingredient requirements</h3>
      <div className="store-card-grid">
        {view.ingredients.map((item) => (
          <article className="store-card" key={item.sourceReference}>
            <header>
              <h3>
                <SummaryValue value={item.sourceName} view={view} />
              </h3>
              <strong>{item.sourceKind}</strong>
            </header>
            <p>
              {item.quantitySummary} · {item.lossSummary}
            </p>
            <p>
              <SummaryValue value={item.allergenSummary} view={view} /> ·{" "}
              <SummaryValue value={item.evidenceSummary} view={view} safety />
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
  const load = useCallback(
    () =>
      client.list().then((value) => {
        const view = parseRecipeListView(value);
        assertRecipeViewScope(view, client.scope);
        return view;
      }),
    [client],
  );
  const state = useLoad(load, "recipes");
  return state.kind === "Found" ? (
    <RecipeListScreen view={state.view} />
  ) : (
    <AppFrame
      title="COMMERCE"
      description="REVIEW"
      className={`recipe-screen${state.kind === "Unavailable" ? " recipe-screen--unavailable" : ""}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-LIST · PHASE 2</p>
          <h2>Recipe management</h2>
        </div>
      </header>
      {state.kind === "Unavailable" ? (
        <>
          <RecipeSourceNotice editor={false} />
          <RecipeListUnavailable />
        </>
      ) : (
        <RecipeState state={state.kind} />
      )}
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
            assertRecipeViewScope(view, client.scope);
            if (view.recipeReference !== reference) throw new RecipeClientError("NotFound");
            return view;
          }),
    [client, reference],
  );
  const state = useLoad(load, reference ?? "invalid");
  return state.kind === "Found" ? (
    <RecipeEditorScreen view={state.view} />
  ) : (
    <AppFrame
      title="COMMERCE"
      description="REVIEW"
      className={`recipe-screen${state.kind === "Unavailable" ? " recipe-screen--unavailable" : ""}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-EDITOR · PHASE 2</p>
          <h2>Recipe editor</h2>
        </div>
        <Link className="shell-action" to="/app/commerce/recipes">
          All Recipes
        </Link>
      </header>
      {state.kind === "Unavailable" ? (
        <>
          <RecipeSourceNotice editor />
          <RecipeEditorUnavailable />
        </>
      ) : (
        <RecipeState state={state.kind} />
      )}
    </AppFrame>
  );
}

function RecipeListUnavailable() {
  return (
    <section className="recipe-list-unavailable" aria-labelledby="recipe-list-unavailable-title">
      <h3 id="recipe-list-unavailable-title">Recipes</h3>
      <div className="recipe-list-unavailable__controls" role="search">
        <label>
          Name / code / ingredient
          <input disabled placeholder="Search name, code or ingredient" />
        </label>
        <label>
          Status
          <select disabled defaultValue="Unavailable">
            <option>Unavailable</option>
          </select>
        </label>
        <label>
          Review issue
          <select disabled defaultValue="Unavailable">
            <option>Unavailable</option>
          </select>
        </label>
        <button disabled title="Recipe commands are unavailable without an authorized projection">
          Create · unavailable
        </button>
      </div>
      <p className="recipe-list-unavailable__empty" role="status">
        Recipe records are unavailable from the current authorized source.
      </p>
      <p className="recipe-list-unavailable__note">
        Registry fields remain unavailable until their owning projections are connected. Actions
        stay disabled.
      </p>
    </section>
  );
}

function RecipeEditorUnavailable() {
  const fields = [
    ["Identity and yield", "Recipe name, code, status, yield and unit are unavailable."],
    ["Ingredients", "Ingredient references, quantities and loss summaries are unavailable."],
    ["Preparation and substitution", "Preparation steps and substitution policy are unavailable."],
    [
      "Allergen and cost review",
      "Allergen evidence and cost derivation require owner projections.",
    ],
    [
      "Product usage and version",
      "Usage and effective version require authorized source coverage.",
    ],
  ] as const;
  return (
    <section className="recipe-editor-unavailable" aria-label="Recipe fields unavailable">
      <div className="recipe-editor-unavailable__groups">
        {fields.map(([heading, description]) => (
          <section className="recipe-editor-unavailable__group" key={heading}>
            <h3>{heading}</h3>
            <p>{description}</p>
          </section>
        ))}
      </div>
      <p className="recipe-list-unavailable__note">
        Registry fields remain unavailable until their owning projections are connected. Editing and
        publish actions stay disabled.
      </p>
    </section>
  );
}

function RecipeSourceNotice({ editor }: { readonly editor: boolean }) {
  return (
    <aside className="recipe-source-notice" role="status">
      <strong>
        {editor ? "Editing and publish commands unavailable" : "Source-backed values unavailable"}
      </strong>
      <p>
        {editor
          ? "Source versions and authorized multi-domain inputs are not composed for this route."
          : "Cost, allergen verification, Product / SKU usage and effective version require their owning projections."}
      </p>
    </aside>
  );
}
