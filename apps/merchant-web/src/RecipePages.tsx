import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  RecipePageError,
  centsText,
  lineCostCentsText,
  parseRecipeEditorView,
  parseRecipeListView,
  parseRecipeRouteReference,
  suggestRecipeCode,
  unavailableRecipeClient,
  type RecipeChoices,
  type RecipeClient,
  type RecipeCommand,
  type RecipeDetail,
  type RecipeDraft,
  type RecipeEditorView,
  type RecipeErrorCode,
  type RecipeListView,
  allergenText,
} from "./recipe-pages.js";

/** WP-2423 / DEC-RECIPE-AUTHORING: Brand recipes — drafts, independent review, publication, SKUs. */
const copy: Record<RecipeErrorCode | "Loading", string> = {
  Loading: "Loading recipes…",
  PermissionDenied: "You do not have permission for this recipe action at Brand level.",
  NotFound: "This recipe does not exist for the Brand.",
  Conflict: "The recipe changed or this step was already recorded. Refresh and check again.",
  CodeTaken: "Another recipe of the Brand already uses this code.",
  AllergenUndeclared:
    "The highlighted ingredient has no current allergen declaration in this version. Declare it under Allergens, then save the recipe again (its reviews start over).",
  ReviewRequired:
    "Publishing needs an approved Cost review and an approved Food safety review of exactly this version, by two different reviewers who are not the author and still hold reviewer permission.",
  ReviewerNotIndependent:
    "A reviewer cannot be the author, and one person cannot give both reviews.",
  Lifecycle: "This step is not possible in the recipe's current state.",
  InUse:
    "The recipe is used by a SKU or by another recipe. Move those to another recipe first (Store-specific assignments can be removed in their Store).",
  LineInvalid:
    "The highlighted line is not valid: check the item or sub-recipe (active, stock-tracked), quantity, loss, cost and kitchen station.",
  Invalid:
    "The recipe is not valid. A name, a code (capital letters, digits, hyphen), a yield, at least one ingredient and one kitchen step are required.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Recipes are unavailable.",
};
const lifecycleText: Record<string, string> = {
  Draft: "Draft",
  Published: "Published",
  Invalidated: "Invalidated",
  Archived: "Archived",
};
const kindText = { Cost: "Cost", FoodSafety: "Food safety" } as const;

type State<V> =
  { readonly kind: "Loading" | RecipeErrorCode } | { readonly kind: "Found"; readonly view: V };
function useRecipeView<V>(
  client: RecipeClient,
  recipeReference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(recipeReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof RecipePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, recipeReference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { code: RecipeErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Recipes" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const skuName = (choices: RecipeChoices, sku: string) =>
  choices.skus.find((item) => item.skuReference === sku)?.name ?? "SKU " + sku.slice(-4);

export function RecipeListPage({
  client = unavailableRecipeClient,
}: {
  readonly client?: RecipeClient;
}) {
  const { state } = useRecipeView(client, null, parseRecipeListView);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: RecipeListView = state.view;
  return (
    <AppFrame title="Recipes" description="RECIPE-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-LIST · Brand</p>
          <h2>Recipes</h2>
          <p>
            Recipes are shared by every Store of the Brand. A recipe is published after an
            independent cost review and food safety review; a SKU uses its recipe to reserve and
            consume stock and to show kitchen instructions. Source as of {view.sourceAsOf}
          </p>
        </div>
        {view.permissions.mayEdit ? (
          <Link to="/app/commerce/recipes/new/edit">New recipe</Link>
        ) : null}
      </header>
      {view.recipes.length === 0 ? (
        <StatePanel heading="No recipes yet" status>
          <p>Create a recipe for each item you sell, and for batch preparations used in them.</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Recipe</th>
              <th>Code</th>
              <th>Status</th>
              <th>Yield</th>
              <th>Standard cost (CAD)</th>
              <th>Kitchen instructions</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {view.recipes.map((recipe) => (
              <tr key={recipe.recipeReference}>
                <td>
                  <Link to={`/app/commerce/recipes/${recipe.recipeReference}/edit`}>
                    {recipe.name}
                  </Link>
                  {recipe.familyRevision > 1 ? ` (revision ${recipe.familyRevision})` : ""}
                </td>
                <td>{recipe.code}</td>
                <td>{lifecycleText[recipe.lifecycle]}</td>
                <td>
                  {recipe.yieldQuantity} {recipe.yieldUnit}
                </td>
                <td>{centsText(recipe.standardCostCents)}</td>
                <td>{recipe.kitchenInstructions === "Published" ? "Published" : "—"}</td>
                <td>
                  {recipe.bindings
                    .map(
                      (binding) =>
                        skuName(view.choices, binding.skuReference) +
                        (binding.storeReference ? " (this Store)" : ""),
                    )
                    .join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}

interface EditableIngredient {
  readonly key: string;
  kind: "InventoryItem" | "SubRecipe";
  sourceReference: string;
  quantity: string;
  lossPercent: string;
  /** CAD per base unit as typed (up to 6 decimals). */
  unitCost: string;
}
interface EditableStep {
  readonly key: string;
  sequence: string;
  instruction: string;
  minutes: string;
  capabilityReference: string;
}
/** Dollars per unit (≤ 6 decimals) → cents per unit (≤ 4 decimals), exact. */
export function dollarsToCentsText(value: string): string | null {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match) return null;
  const micro = BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(6, "0"));
  const whole = micro / 10_000n,
    fraction = (micro % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
export function centsToDollarsText(value: string | number | null): string {
  if (value === null) return "";
  const match = /^(\d+)(?:\.(\d{1,4}))?$/u.exec(String(value));
  if (!match) return "";
  const micro = BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(4, "0"));
  const whole = micro / 1_000_000n,
    fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length < 2 ? `${whole}.${fraction.padEnd(2, "0")}` : `${whole}.${fraction}`;
}
const editableFrom = (draft: RecipeDraft) => ({
  ingredients: draft.ingredients.map((item) => ({
    key: newOperationReference(),
    kind: item.kind,
    sourceReference: item.sourceReference,
    quantity: item.quantity,
    lossPercent: item.lossPercent,
    unitCost: centsToDollarsText(item.unitCostCents),
  })),
  steps: draft.steps.map((step) => ({
    key: newOperationReference(),
    sequence: String(step.sequence),
    instruction: step.instruction,
    minutes: String(Math.round((step.durationSeconds / 60) * 100) / 100),
    capabilityReference: step.capabilityReference,
  })),
});

function DraftForm({
  choices,
  initial,
  codeEditable,
  busy,
  errorLine,
  onSave,
}: {
  readonly choices: RecipeChoices;
  readonly initial: RecipeDraft | null;
  readonly codeEditable: boolean;
  readonly busy: boolean;
  readonly errorLine: number | null;
  readonly onSave: (draft: RecipeDraft) => void;
}) {
  const start = initial ? editableFrom(initial) : null;
  const [name, setName] = useState(initial?.name ?? ""),
    [code, setCode] = useState(initial?.code ?? ""),
    [codeTouched, setCodeTouched] = useState(initial !== null),
    [yieldQuantity, setYieldQuantity] = useState(initial?.yieldQuantity ?? "1"),
    [yieldUnit, setYieldUnit] = useState(initial?.yieldUnit ?? "EACH"),
    [ingredients, setIngredients] = useState<EditableIngredient[]>(start?.ingredients ?? []),
    [steps, setSteps] = useState<EditableStep[]>(start?.steps ?? []),
    [localError, setLocalError] = useState<string | null>(null);
  const items = useMemo(
    () => new Map(choices.items.map((item) => [item.itemReference, item])),
    [choices],
  );
  const subs = useMemo(
    () => new Map(choices.subRecipes.map((recipe) => [recipe.recipeReference, recipe])),
    [choices],
  );
  const newIngredient = (): EditableIngredient => {
    const first = choices.items[0];
    return {
      key: newOperationReference(),
      kind: "InventoryItem",
      sourceReference: first?.itemReference ?? "",
      quantity: "",
      lossPercent: "0",
      unitCost: centsToDollarsText(first?.latestUnitCostCents ?? null),
    };
  };
  const newStep = (): EditableStep => ({
    key: newOperationReference(),
    sequence: String(steps.length),
    instruction: "",
    minutes: "1",
    capabilityReference: choices.stations[0]?.capabilityReference ?? "",
  });
  const updateIngredient = (index: number, patch: Partial<EditableIngredient>) =>
    setIngredients((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  const updateStep = (index: number, patch: Partial<EditableStep>) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  let total = 0n;
  const submit = () => {
    setLocalError(null);
    const payloadIngredients = [];
    for (const [index, item] of ingredients.entries()) {
      const cost = item.kind === "InventoryItem" ? dollarsToCentsText(item.unitCost || "0") : null;
      if (item.kind === "InventoryItem" && cost === null) {
        setLocalError(`Line ${index + 1}: enter the cost per unit in dollars (up to 6 decimals).`);
        return;
      }
      payloadIngredients.push({
        kind: item.kind,
        sourceReference: item.sourceReference,
        quantity: item.quantity.trim(),
        lossPercent: item.lossPercent.trim() || "0",
        unitCostCents: cost,
      });
    }
    const payloadSteps = [];
    for (const [index, step] of steps.entries()) {
      const minutes = Number(step.minutes);
      const sequence = Number(step.sequence);
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(sequence)) {
        setLocalError(`Step ${index + 1}: enter the order number and a duration in minutes.`);
        return;
      }
      payloadSteps.push({
        sequence,
        instruction: step.instruction.trim(),
        durationSeconds: Math.max(1, Math.round(minutes * 60)),
        capabilityReference: step.capabilityReference,
      });
    }
    onSave({
      name: name.trim(),
      code: code.trim(),
      yieldQuantity: yieldQuantity.trim(),
      yieldUnit,
      ingredients: payloadIngredients,
      steps: payloadSteps,
    });
  };
  return (
    <form
      className="detail-section"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3>Recipe</h3>
      <label>
        Name
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setName(value);
            if (codeEditable && !codeTouched) setCode(suggestRecipeCode(value));
          }}
        />
      </label>
      <label>
        Code {codeEditable ? "(cannot be changed later)" : ""}
        <input
          required
          maxLength={40}
          readOnly={!codeEditable}
          value={code}
          onChange={(event) => {
            setCodeTouched(true);
            setCode(event.currentTarget.value.toUpperCase());
          }}
        />
      </label>
      <label>
        Yield
        <input
          required
          inputMode="decimal"
          value={yieldQuantity}
          onChange={(event) => setYieldQuantity(event.currentTarget.value)}
        />
      </label>
      <label>
        Yield unit
        <select value={yieldUnit} onChange={(event) => setYieldUnit(event.currentTarget.value)}>
          {choices.yieldUnits.map((unit) => (
            <option key={unit} value={unit}>
              {unit === "EACH" ? "EACH (portions sold as a SKU)" : unit + " (batch preparation)"}
            </option>
          ))}
        </select>
      </label>
      <h3>Ingredients</h3>
      {choices.items.length === 0 ? (
        <p>Activate stock-tracked inventory items (mass, volume or count) first.</p>
      ) : null}
      {ingredients.map((item, index) => {
        const flagged = errorLine === index + 1;
        const unit =
          item.kind === "InventoryItem"
            ? items.get(item.sourceReference)?.unitCode
            : subs.get(item.sourceReference)?.yieldUnit;
        const cents =
          item.kind === "InventoryItem"
            ? lineCostCentsText(
                item.quantity || "0",
                item.lossPercent || "0",
                dollarsToCentsText(item.unitCost || "0"),
              )
            : null;
        if (cents !== null) total += BigInt(cents);
        return (
          <fieldset
            key={item.key}
            aria-invalid={flagged}
            style={flagged ? { outline: "2px solid #b42318" } : undefined}
          >
            <legend>Ingredient {index + 1}</legend>
            <label>
              Type
              <select
                value={item.kind}
                onChange={(event) => {
                  const kind = event.currentTarget.value as EditableIngredient["kind"];
                  updateIngredient(index, {
                    kind,
                    sourceReference:
                      kind === "InventoryItem"
                        ? (choices.items[0]?.itemReference ?? "")
                        : (choices.subRecipes[0]?.recipeReference ?? ""),
                    unitCost: "",
                  });
                }}
              >
                <option value="InventoryItem">Inventory item</option>
                <option value="SubRecipe" disabled={choices.subRecipes.length === 0}>
                  Published sub-recipe
                </option>
              </select>
            </label>
            <label>
              {item.kind === "InventoryItem" ? "Item" : "Sub-recipe"}
              <select
                value={item.sourceReference}
                onChange={(event) => {
                  const source = event.currentTarget.value;
                  updateIngredient(index, {
                    sourceReference: source,
                    ...(item.kind === "InventoryItem"
                      ? {
                          unitCost: centsToDollarsText(
                            items.get(source)?.latestUnitCostCents ?? null,
                          ),
                        }
                      : {}),
                  });
                }}
              >
                {item.kind === "InventoryItem"
                  ? choices.items.map((option) => (
                      <option key={option.itemReference} value={option.itemReference}>
                        {option.name} ({option.unitCode})
                      </option>
                    ))
                  : choices.subRecipes.map((option) => (
                      <option key={option.recipeReference} value={option.recipeReference}>
                        {option.name} ({option.yieldUnit})
                      </option>
                    ))}
              </select>
            </label>
            {item.kind === "InventoryItem" && item.sourceReference ? (
              <p>
                Allergens:{" "}
                {(() => {
                  const status = items.get(item.sourceReference)?.allergens;
                  if (!status || status.status === "Missing")
                    return "not declared — declare under Allergens before publishing";
                  if (status.status === "Outdated")
                    return "declaration out of date — declare again under Allergens";
                  return allergenText(status);
                })()}
              </p>
            ) : null}
            <label>
              Quantity ({unit ?? "unit"})
              <input
                required
                inputMode="decimal"
                value={item.quantity}
                onChange={(event) =>
                  updateIngredient(index, { quantity: event.currentTarget.value })
                }
              />
            </label>
            <label>
              Preparation loss %
              <input
                inputMode="decimal"
                value={item.lossPercent}
                onChange={(event) =>
                  updateIngredient(index, { lossPercent: event.currentTarget.value })
                }
              />
            </label>
            {item.kind === "InventoryItem" ? (
              <label>
                Standard cost (CAD per {unit ?? "unit"})
                <input
                  inputMode="decimal"
                  value={item.unitCost}
                  onChange={(event) =>
                    updateIngredient(index, { unitCost: event.currentTarget.value })
                  }
                />
              </label>
            ) : null}
            {cents !== null ? <p>Line cost: ${centsText(cents)}</p> : null}
            <button
              type="button"
              onClick={() => setIngredients((current) => current.filter((_, i) => i !== index))}
            >
              Remove ingredient
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={choices.items.length === 0}
        onClick={() => setIngredients((current) => [...current, newIngredient()])}
      >
        Add ingredient
      </button>
      <p>Standard cost of the yield (inventory items): ${centsText(total.toString())}</p>
      <h3>Kitchen steps</h3>
      {choices.stations.length === 0 ? (
        <p>This Store has no kitchen station configured; kitchen steps need a station.</p>
      ) : null}
      {steps.map((step, index) => (
        <fieldset key={step.key}>
          <legend>Step {index + 1}</legend>
          <label>
            Order (steps with the same number may run in parallel)
            <input
              inputMode="numeric"
              value={step.sequence}
              onChange={(event) => updateStep(index, { sequence: event.currentTarget.value })}
            />
          </label>
          <label>
            Instruction
            <textarea
              required
              maxLength={500}
              value={step.instruction}
              onChange={(event) => updateStep(index, { instruction: event.currentTarget.value })}
            />
          </label>
          <label>
            Duration (minutes)
            <input
              inputMode="decimal"
              value={step.minutes}
              onChange={(event) => updateStep(index, { minutes: event.currentTarget.value })}
            />
          </label>
          <label>
            Kitchen station
            <select
              value={step.capabilityReference}
              onChange={(event) =>
                updateStep(index, { capabilityReference: event.currentTarget.value })
              }
            >
              {choices.stations.map((station) => (
                <option key={station.capabilityReference} value={station.capabilityReference}>
                  {station.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
          >
            Remove step
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={choices.stations.length === 0}
        onClick={() => setSteps((current) => [...current, newStep()])}
      >
        Add step
      </button>{" "}
      <button disabled={busy || ingredients.length === 0 || steps.length === 0}>Save draft</button>
      {localError ? (
        <StatePanel heading="Not saved" tone="error" status>
          <p>{localError}</p>
        </StatePanel>
      ) : null}
    </form>
  );
}

/** WP-2423 / DEC-ALLERGEN-DECLARATIONS: a saved version's allergens for one ingredient line. */
function lineAllergens(recipe: RecipeDetail, line: number): string {
  const entry = recipe.ingredientAllergens?.find((item) => item.line === line);
  if (!entry) return "—";
  if (entry.kind === "SubRecipe") return "From the sub-recipe";
  if (!entry.declared) return "Not declared";
  return allergenText(entry) + (entry.current ? "" : " (declaration since replaced)");
}
function AllergenSummary({ recipe }: { readonly recipe: RecipeDetail }) {
  const lines = (recipe.ingredientAllergens ?? []).filter((line) => line.kind === "InventoryItem");
  if (!lines.length) return null;
  const contains = [...new Set(lines.flatMap((line) => line.contains))].sort();
  const mayContain = [...new Set(lines.flatMap((line) => line.mayContain))]
    .filter((name) => !contains.includes(name))
    .sort();
  const undeclared = lines.filter((line) => !line.declared).length;
  return (
    <p>
      <strong>Allergens from ingredients:</strong>{" "}
      {undeclared
        ? `unknown — ${undeclared} ingredient(s) not declared` +
          (contains.length || mayContain.length
            ? "; declared so far: " + allergenText({ contains, mayContain })
            : "")
        : allergenText({ contains, mayContain })}
      . Sub-recipes add their own.
    </p>
  );
}

function ReadOnlyRecipe({
  recipe,
  choices,
}: {
  readonly recipe: RecipeDetail;
  readonly choices: RecipeChoices;
}) {
  const items = new Map(choices.items.map((item) => [item.itemReference, item]));
  const subs = new Map(choices.subRecipes.map((item) => [item.recipeReference, item]));
  const stations = new Map(choices.stations.map((item) => [item.capabilityReference, item.name]));
  return (
    <section className="detail-section">
      <h3>Ingredients</h3>
      <table>
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>Quantity</th>
            <th>Loss %</th>
            <th>Standard cost (CAD per unit)</th>
            <th>Allergens (this version)</th>
          </tr>
        </thead>
        <tbody>
          {recipe.draft.ingredients.map((item, index) => (
            <tr key={index}>
              <td>
                {item.kind === "InventoryItem"
                  ? (items.get(item.sourceReference)?.name ?? "Inactive item")
                  : (subs.get(item.sourceReference)?.name ?? "Sub-recipe")}
              </td>
              <td>
                {item.quantity}{" "}
                {item.kind === "InventoryItem"
                  ? items.get(item.sourceReference)?.unitCode
                  : subs.get(item.sourceReference)?.yieldUnit}
              </td>
              <td>{item.lossPercent}</td>
              <td>
                {item.kind === "InventoryItem"
                  ? centsToDollarsText(item.unitCostCents ?? "0")
                  : "—"}
              </td>
              <td>{lineAllergens(recipe, index + 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AllergenSummary recipe={recipe} />
      <h3>Kitchen steps</h3>
      <ol>
        {recipe.draft.steps.map((step, index) => (
          <li key={index}>
            [{step.sequence}] {step.instruction} — {Math.round(step.durationSeconds / 6) / 10} min,{" "}
            {stations.get(step.capabilityReference) ?? "station"}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewPanel({
  view,
  subject,
  busy,
  run,
}: {
  readonly view: RecipeEditorView;
  readonly subject: "Recipe" | "Preparation";
  readonly busy: boolean;
  readonly run: (command: RecipeCommand) => void;
}) {
  const recipe = view.recipe;
  const reviews = recipe.reviews.filter((review) => review.subject === subject);
  const [comment, setComment] = useState("");
  const isAuthor = view.viewer === recipe.authorReference;
  const reviewedHere = reviews.some((review) => review.reviewerReference === view.viewer);
  return (
    <div>
      <ul>
        {(["Cost", "FoodSafety"] as const).map((kind) => {
          const review = reviews.find((item) => item.kind === kind);
          return (
            <li key={kind}>
              <strong>{kindText[kind]} review:</strong>{" "}
              {review
                ? `${review.decision} by ${review.reviewerLabel} at ${review.reviewedAt}${review.comment ? ` — “${review.comment}”` : ""}${review.current ? "" : " (content changed since)"}`
                : "waiting"}
            </li>
          );
        })}
      </ul>
      {view.permissions.mayReview && !isAuthor && !reviewedHere ? (
        <div>
          <label>
            Review comment (required to reject)
            <textarea
              maxLength={500}
              value={comment}
              onChange={(event) => setComment(event.currentTarget.value)}
            />
          </label>
          {(["Cost", "FoodSafety"] as const)
            .filter((kind) => !reviews.some((review) => review.kind === kind))
            .map((kind) => (
              <span key={kind}>
                {(["Approved", "Rejected"] as const).map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={busy || (decision === "Rejected" && comment.trim() === "")}
                    onClick={() =>
                      run({
                        action: "Review",
                        operationReference: newOperationReference(),
                        recipeReference: recipe.recipeReference,
                        versionReference: recipe.versionReference,
                        subject,
                        kind,
                        decision,
                        comment: comment.trim() === "" ? null : comment.trim(),
                      })
                    }
                  >
                    {decision === "Approved" ? "Approve" : "Reject"} {kindText[kind].toLowerCase()}
                  </button>
                ))}{" "}
              </span>
            ))}
        </div>
      ) : isAuthor ? (
        <p>You wrote this version; two other reviewers decide.</p>
      ) : null}
    </div>
  );
}

function Bindings({
  view,
  busy,
  run,
}: {
  readonly view: RecipeEditorView;
  readonly busy: boolean;
  readonly run: (command: RecipeCommand) => void;
}) {
  const recipe = view.recipe;
  const candidates = view.choices.skus.filter((sku) => sku.unitOfSale === recipe.yieldUnit);
  const [sku, setSku] = useState(""),
    [storeOnly, setStoreOnly] = useState(false);
  return (
    <StatePanel heading="Used by SKUs">
      {recipe.bindings.length === 0 ? <p>No SKU uses this recipe yet.</p> : null}
      <ul>
        {recipe.bindings.map((binding) => (
          <li key={binding.bindingReference}>
            {skuName(view.choices, binding.skuReference)} ·{" "}
            {binding.storeReference ? "this Store only" : "all Stores of the Brand"} · since{" "}
            {binding.since}{" "}
            {binding.storeReference && view.permissions.mayPublish ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run({
                    action: "EndStoreBinding",
                    operationReference: newOperationReference(),
                    bindingReference: binding.bindingReference,
                  })
                }
              >
                Remove Store-specific recipe
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {view.permissions.mayPublish &&
      recipe.lifecycle === "Published" &&
      recipe.kitchenInstructions === "Published" &&
      recipe.yieldUnit === "EACH" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sku)
              run({
                action: "BindSku",
                operationReference: newOperationReference(),
                recipeReference: recipe.recipeReference,
                skuReference: sku,
                storeOnly,
              });
          }}
        >
          <label>
            SKU
            <select value={sku} onChange={(event) => setSku(event.currentTarget.value)}>
              <option value="">Choose a SKU</option>
              {candidates.map((option) => (
                <option key={option.skuReference} value={option.skuReference}>
                  {option.name} ({option.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={storeOnly}
              onChange={(event) => setStoreOnly(event.currentTarget.checked)}
            />{" "}
            Only in this Store (other Stores keep the Brand recipe)
          </label>
          <button disabled={busy || !sku}>Use this recipe</button>
          <p>The SKU's previous recipe in the same scope stops applying at the same moment.</p>
        </form>
      ) : recipe.lifecycle === "Published" && recipe.yieldUnit !== "EACH" ? (
        <p>Batch recipes are used as sub-recipes, not by SKUs.</p>
      ) : null}
    </StatePanel>
  );
}

/** One editor instance per route: a new recipe, a revision of one, or an existing recipe. */
export function RecipeEditorPage(props: { readonly client?: RecipeClient }) {
  const params = useParams();
  const [search] = useSearchParams();
  return <RecipeEditor key={`${params.id ?? ""}?${search.toString()}`} {...props} />;
}

function RecipeEditor({ client = unavailableRecipeClient }: { readonly client?: RecipeClient }) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const isNew = params.id === "new";
  const reference = useMemo(() => {
    if (isNew) return null;
    try {
      return parseRecipeRouteReference(params.id);
    } catch {
      return undefined;
    }
  }, [isNew, params.id]);
  const parse = useCallback(
    (value: unknown) => (isNew ? parseRecipeListView(value) : parseRecipeEditorView(value)),
    [isNew],
  );
  const { state, reload } = useRecipeView<RecipeListView | RecipeEditorView>(
    client,
    reference ?? null,
    parse,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<{ code: RecipeErrorCode; line: number | null } | null>(null),
    [newReference] = useState(newOperationReference),
    [createOperation] = useState(newOperationReference);
  const run = useCallback(
    async (command: RecipeCommand, after?: () => void) => {
      if (!client.command) return;
      setBusy(true);
      setError(null);
      try {
        await client.command(command);
        if (after) after();
        else reload();
      } catch (failure) {
        setError(
          failure instanceof RecipePageError
            ? { code: failure.code, line: failure.line }
            : { code: "Unavailable", line: null },
        );
      } finally {
        setBusy(false);
      }
    },
    [client, reload],
  );
  if (reference === undefined) return <Failure code="NotFound" />;
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const errorPanel = error ? (
    <StatePanel heading="Not recorded" tone="error" status>
      <p>{copy[error.code]}</p>
    </StatePanel>
  ) : null;
  if (view.screenId === "RECIPE-LIST") {
    if (!view.permissions.mayEdit) return <Failure code="PermissionDenied" />;
    const revisionOf = search.get("revisionOf");
    const base = revisionOf
      ? view.recipes.find((recipe) => recipe.recipeReference === revisionOf)
      : undefined;
    return (
      <AppFrame title="New recipe" description="RECIPE-EDITOR">
        <header className="screen-heading">
          <div>
            <p className="bop-eyebrow">RECIPE-EDITOR · {base ? "Revision" : "New"}</p>
            <h2>{base ? `Revise ${base.name}` : "New recipe"}</h2>
            <p>
              {base
                ? "The published recipe stays in use until this revision is reviewed, published and assigned to its SKUs."
                : "Save a draft, then two reviewers check cost and food safety before it can be published."}
            </p>
          </div>
          <Link to="/app/commerce/recipes">All recipes</Link>
        </header>
        <RevisionSeed client={client} base={revisionOf}>
          {(initial) => (
            <DraftForm
              choices={view.choices}
              initial={initial}
              codeEditable
              busy={busy}
              errorLine={error?.line ?? null}
              onSave={(draft) =>
                void run(
                  {
                    action: "SaveDraft",
                    operationReference: createOperation,
                    recipeReference: newReference,
                    expectedAggregateVersion: null,
                    revisionOf: base ? base.recipeReference : null,
                    draft,
                  },
                  () => navigate(`/app/commerce/recipes/${newReference}/edit`),
                )
              }
            />
          )}
        </RevisionSeed>
        {errorPanel}
      </AppFrame>
    );
  }
  const recipe = view.recipe;
  const editable = recipe.lifecycle === "Draft" && view.permissions.mayEdit;
  const approvals = (subject: "Recipe" | "Preparation") =>
    recipe.reviews.filter(
      (review) => review.subject === subject && review.decision === "Approved" && review.current,
    ).length === 2;
  return (
    <AppFrame title={recipe.name} description="RECIPE-EDITOR">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            RECIPE-EDITOR · {recipe.code}
            {recipe.familyRevision > 1 ? ` · revision ${recipe.familyRevision}` : ""}
          </p>
          <h2>{recipe.name}</h2>
          <p>
            {lifecycleText[recipe.lifecycle]} · yield {recipe.yieldQuantity} {recipe.yieldUnit} ·
            standard cost ${centsText(recipe.standardCostCents)} · written by {recipe.authorLabel}
          </p>
        </div>
        <Link to="/app/commerce/recipes">All recipes</Link>
      </header>
      {errorPanel}
      {recipe.family.length > 1 ? (
        <p>
          Revisions:{" "}
          {recipe.family.map((member, index) => (
            <span key={member.recipeReference}>
              {index > 0 ? ", " : ""}
              {member.recipeReference === recipe.recipeReference ? (
                <strong>
                  {member.revision} ({member.lifecycle})
                </strong>
              ) : (
                <Link to={`/app/commerce/recipes/${member.recipeReference}/edit`}>
                  {member.revision} ({member.lifecycle})
                </Link>
              )}
            </span>
          ))}
        </p>
      ) : null}
      {editable ? (
        <DraftForm
          key={recipe.versionReference}
          choices={view.choices}
          initial={recipe.draft}
          codeEditable={false}
          busy={busy}
          errorLine={error?.line ?? null}
          onSave={(draft) =>
            void run({
              action: "SaveDraft",
              operationReference: newOperationReference(),
              recipeReference: recipe.recipeReference,
              expectedAggregateVersion: recipe.aggregateVersion,
              revisionOf: null,
              draft,
            })
          }
        />
      ) : (
        <ReadOnlyRecipe recipe={recipe} choices={view.choices} />
      )}
      {recipe.lifecycle === "Draft" ? (
        <StatePanel heading="Review and publication">
          <p>Saving the draft again starts the reviews over for the new version.</p>
          <ReviewPanel
            view={view}
            subject="Recipe"
            busy={busy}
            run={(command) => void run(command)}
          />
          {view.permissions.mayPublish ? (
            <button
              type="button"
              disabled={busy || !approvals("Recipe")}
              onClick={() =>
                void run({
                  action: "Publish",
                  operationReference: newOperationReference(),
                  recipeReference: recipe.recipeReference,
                  expectedAggregateVersion: recipe.aggregateVersion,
                })
              }
            >
              Publish recipe
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      {recipe.lifecycle === "Published" ? (
        <StatePanel heading="Kitchen instructions">
          {recipe.kitchenInstructions === "Published" ? (
            <p>Published. Kitchen tickets show these steps for every SKU that uses this recipe.</p>
          ) : (
            <>
              <p>
                The kitchen steps of the published version are reviewed once more (cost and food
                safety) before kitchen tickets can show them.
              </p>
              <ReviewPanel
                view={view}
                subject="Preparation"
                busy={busy}
                run={(command) => void run(command)}
              />
              {view.permissions.mayPublish ? (
                <button
                  type="button"
                  disabled={busy || !approvals("Preparation")}
                  onClick={() =>
                    void run({
                      action: "PublishKitchen",
                      operationReference: newOperationReference(),
                      recipeReference: recipe.recipeReference,
                    })
                  }
                >
                  Publish kitchen instructions
                </button>
              ) : null}
            </>
          )}
        </StatePanel>
      ) : null}
      {recipe.lifecycle === "Published" ? (
        <Bindings view={view} busy={busy} run={(command) => void run(command)} />
      ) : null}
      {recipe.lifecycle === "Published" && view.permissions.mayEdit ? (
        <p>
          <Link to={`/app/commerce/recipes/new/edit?revisionOf=${recipe.recipeReference}`}>
            Revise this recipe
          </Link>
        </p>
      ) : null}
      {recipe.lifecycle !== "Archived" && view.permissions.mayPublish ? (
        <button
          type="button"
          disabled={busy || recipe.bindings.length > 0}
          onClick={() =>
            void run({
              action: "Archive",
              operationReference: newOperationReference(),
              recipeReference: recipe.recipeReference,
              expectedAggregateVersion: recipe.aggregateVersion,
            })
          }
        >
          Archive recipe
        </button>
      ) : null}
    </AppFrame>
  );
}

/** Loads the published recipe a revision starts from, so the form opens with its content. */
function RevisionSeed({
  client,
  base,
  children,
}: {
  readonly client: RecipeClient;
  readonly base: string | null;
  readonly children: (initial: RecipeDraft | null) => ReactNode;
}) {
  const [seed, setSeed] = useState<RecipeDraft | null | "Loading">(base ? "Loading" : null);
  useEffect(() => {
    if (!base) return;
    let active = true;
    void client
      .load(base)
      .then((value) => {
        if (!active) return;
        const draft = parseRecipeEditorView(value).recipe.draft;
        const revision = /-R(\d+)$/u.exec(draft.code);
        setSeed({
          ...draft,
          code: revision
            ? draft.code.replace(/-R\d+$/u, "-R" + (Number(revision[1]) + 1))
            : draft.code + "-R2",
        });
      })
      .catch(() => {
        if (active) setSeed(null);
      });
    return () => {
      active = false;
    };
  }, [client, base]);
  if (seed === "Loading") return <Failure code="Loading" />;
  return <>{children(seed)}</>;
}
