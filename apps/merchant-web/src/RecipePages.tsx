import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
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
  unitText,
} from "./recipe-pages.js";

/** WP-2423 / DEC-RECIPE-AUTHORING: Brand recipes — drafts, independent review, publication, SKUs. */
const copy: Record<RecipeErrorCode | "Loading", string> = {
  Loading: t("Loading recipes…"),
  PermissionDenied: t("You do not have permission for this recipe action at Brand level."),
  NotFound: t("This recipe does not exist for the Brand."),
  Conflict: t("The recipe changed or this step was already recorded. Refresh and check again."),
  CodeTaken: t("Another recipe of the Brand already uses this code."),
  AllergenUndeclared: t(
    "The highlighted ingredient has no current allergen declaration in this version. Declare it under Allergens, then save the recipe again (its reviews start over).",
  ),
  ReviewRequired: t(
    "Publishing needs an approved Cost review and an approved Food safety review of exactly this version, by two different reviewers who are not the author and still hold reviewer permission.",
  ),
  ReviewerNotIndependent: t(
    "A reviewer cannot be the author, and one person cannot give both reviews.",
  ),
  SoleOperatorNotInEffect: t(
    "Someone else now also holds recipe review, so another person must review. Refresh to see who.",
  ),
  NeedsReverification: t("Confirm it is you with your authenticator code, then review again."),
  Lifecycle: t("This step is not possible in the recipe's current state."),
  InUse: t(
    "The recipe is used by a SKU or by another recipe. Move those to another recipe first (Store-specific assignments can be removed in their Store).",
  ),
  LineInvalid: t(
    "The highlighted line is not valid: check the item or sub-recipe (active, stock-tracked), quantity, loss, cost and kitchen station.",
  ),
  Invalid: t(
    "The recipe is not valid. A name, a code (capital letters, digits, hyphen), a yield, at least one ingredient and one kitchen step are required.",
  ),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Recipes are unavailable."),
};
const lifecycleText: Record<string, string> = {
  Draft: t("Draft"),
  Published: t("Published"),
  Invalidated: t("Invalidated"),
  Archived: t("Archived"),
};
const kindText = { Cost: t("Cost"), FoodSafety: t("Food safety") } as const;

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
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Recipes")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
    </StatePanel>
  );
}
const skuName = (choices: RecipeChoices, sku: string) =>
  choices.skus.find((item) => item.skuReference === sku)?.name ?? t("A size no longer listed");

export function RecipeListPage({
  client = unavailableRecipeClient,
}: {
  readonly client?: RecipeClient;
}) {
  const { state } = useRecipeView(client, null, parseRecipeListView);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: RecipeListView = state.view;
  return (
    <AppFrame title={t("Recipes")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Recipes · Brand")}</p>
          <h2>{t("Recipes")}</h2>
          <p>
            {t(
              "Recipes are shared by every Store of the Brand. A recipe is published after an independent cost review and food safety review; a SKU uses its recipe to reserve and consume stock and to show kitchen instructions. Source as of",
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayEdit ? (
          <Link to="/app/commerce/recipes/new/edit">{t("New recipe")}</Link>
        ) : null}
      </header>
      {view.recipes.length === 0 ? (
        <StatePanel heading={t("No recipes yet")} status>
          <p>
            {t("Create a recipe for each item you sell, and for batch preparations used in them.")}
          </p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Recipe")}</th>
              <th>{t("Code")}</th>
              <th>{t("Status")}</th>
              <th>{t("Yield")}</th>
              <th>{t("Standard cost")}</th>
              <th>{t("Kitchen instructions")}</th>
              <th>{t("Used by")}</th>
            </tr>
          </thead>
          <tbody>
            {view.recipes.map((recipe) => (
              <tr key={recipe.recipeReference}>
                <td>
                  <Link to={`/app/commerce/recipes/${recipe.recipeReference}/edit`}>
                    {recipe.name}
                  </Link>
                  {recipe.familyRevision > 1
                    ? t(" (revision {familyRevision})", { familyRevision: recipe.familyRevision })
                    : ""}
                </td>
                <td>{recipe.code}</td>
                <td>{lifecycleText[recipe.lifecycle]}</td>
                <td>
                  {recipe.yieldQuantity} {unitText(recipe.yieldUnit)}
                </td>
                <td>${centsText(recipe.standardCostCents)}</td>
                <td>{recipe.kitchenInstructions === "Published" ? t("Published") : "—"}</td>
                <td>
                  {recipe.bindings
                    .map(
                      (binding) =>
                        skuName(view.choices, binding.skuReference) +
                        (binding.storeReference ? t(" (this Store)") : ""),
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
      <h3>{t("Recipe")}</h3>
      <label>
        {t("Name")}
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
        {t("Code {value}", { value: codeEditable ? t("(cannot be changed later)") : "" })}
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
        {t("Yield")}
        <input
          required
          inputMode="decimal"
          value={yieldQuantity}
          onChange={(event) => setYieldQuantity(event.currentTarget.value)}
        />
      </label>
      <label>
        {t("Yield unit")}
        <select value={yieldUnit} onChange={(event) => setYieldUnit(event.currentTarget.value)}>
          {choices.yieldUnits.map((unit) => (
            <option key={unit} value={unit}>
              {unit === "EACH"
                ? t("each (portions sold as a size)")
                : unitText(unit) + t(" (batch preparation)")}
            </option>
          ))}
        </select>
      </label>
      <h3>{t("Ingredients")}</h3>
      {choices.items.length === 0 ? (
        <p>{t("Activate stock-tracked inventory items (mass, volume or count) first.")}</p>
      ) : null}
      {ingredients.map((item, index) => {
        const flagged = errorLine === index + 1;
        const unit = unitText(
          item.kind === "InventoryItem"
            ? items.get(item.sourceReference)?.unitCode
            : subs.get(item.sourceReference)?.yieldUnit,
        );
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
            <legend>{t("Ingredient {value}", { value: index + 1 })}</legend>
            <label>
              {t("Type")}
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
                <option value="InventoryItem">{t("Inventory item")}</option>
                <option value="SubRecipe" disabled={choices.subRecipes.length === 0}>
                  {t("Published sub-recipe")}
                </option>
              </select>
            </label>
            <label>
              {item.kind === "InventoryItem" ? t("Item") : t("Sub-recipe")}
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
                        {option.name} ({unitText(option.unitCode)})
                      </option>
                    ))
                  : choices.subRecipes.map((option) => (
                      <option key={option.recipeReference} value={option.recipeReference}>
                        {option.name} ({unitText(option.yieldUnit)})
                      </option>
                    ))}
              </select>
            </label>
            {item.kind === "InventoryItem" && item.sourceReference ? (
              <p>
                {t("Allergens: {value}", {
                  value: (() => {
                    const status = items.get(item.sourceReference)?.allergens;
                    if (!status || status.status === "Missing")
                      return t("not declared — declare under Allergens before publishing");
                    if (status.status === "Outdated")
                      return t("declaration out of date — declare again under Allergens");
                    return allergenText(status);
                  })(),
                })}
              </p>
            ) : null}
            <label>
              {t("Quantity ({unit})", { unit: unit })}
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
              {t("Preparation loss %")}
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
                {t("Standard cost per {unit} ($)", { unit: unit })}
                <input
                  inputMode="decimal"
                  value={item.unitCost}
                  onChange={(event) =>
                    updateIngredient(index, { unitCost: event.currentTarget.value })
                  }
                />
              </label>
            ) : null}
            {cents !== null ? <p>{t("Line cost: ${cents}", { cents: centsText(cents) })}</p> : null}
            <button
              type="button"
              onClick={() => setIngredients((current) => current.filter((_, i) => i !== index))}
            >
              {t("Remove ingredient")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={choices.items.length === 0}
        onClick={() => setIngredients((current) => [...current, newIngredient()])}
      >
        {t("Add ingredient")}
      </button>
      <p>
        {t("Standard cost of the yield (inventory items): ${value}", {
          value: centsText(total.toString()),
        })}
      </p>
      <h3>{t("Kitchen steps")}</h3>
      {choices.stations.length === 0 ? (
        <p>{t("This Store has no kitchen station configured; kitchen steps need a station.")}</p>
      ) : null}
      {steps.map((step, index) => (
        <fieldset key={step.key}>
          <legend>{t("Step {value}", { value: index + 1 })}</legend>
          <label>
            {t("Order (steps with the same number may run in parallel)")}
            <input
              inputMode="numeric"
              value={step.sequence}
              onChange={(event) => updateStep(index, { sequence: event.currentTarget.value })}
            />
          </label>
          <label>
            {t("Instruction")}
            <textarea
              required
              maxLength={500}
              value={step.instruction}
              onChange={(event) => updateStep(index, { instruction: event.currentTarget.value })}
            />
          </label>
          <label>
            {t("Duration (minutes)")}
            <input
              inputMode="decimal"
              value={step.minutes}
              onChange={(event) => updateStep(index, { minutes: event.currentTarget.value })}
            />
          </label>
          <label>
            {t("Kitchen station")}
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
            {t("Remove step")}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={choices.stations.length === 0}
        onClick={() => setSteps((current) => [...current, newStep()])}
      >
        {t("Add step")}
      </button>{" "}
      <button disabled={busy || ingredients.length === 0 || steps.length === 0}>
        {t("Save draft")}
      </button>
      {localError ? (
        <StatePanel heading={t("Not saved")} tone="error" status>
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
  if (entry.kind === "SubRecipe") return t("From the sub-recipe");
  if (!entry.declared) return t("Not declared");
  return allergenText(entry) + (entry.current ? "" : t(" (declaration since replaced)"));
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
      <strong>{t("Allergens from ingredients:")}</strong>{" "}
      {t("{value}. Sub-recipes add their own.", {
        value: undeclared
          ? t("unknown — {undeclared} ingredient(s) not declared", { undeclared: undeclared }) +
            (contains.length || mayContain.length
              ? t("; declared so far: ") + allergenText({ contains, mayContain })
              : "")
          : allergenText({ contains, mayContain }),
      })}
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
      <h3>{t("Ingredients")}</h3>
      <table>
        <thead>
          <tr>
            <th>{t("Ingredient")}</th>
            <th>{t("Quantity")}</th>
            <th>{t("Loss %")}</th>
            <th>{t("Standard cost per unit")}</th>
            <th>{t("Allergens (this version)")}</th>
          </tr>
        </thead>
        <tbody>
          {recipe.draft.ingredients.map((item, index) => (
            <tr key={index}>
              <td>
                {item.kind === "InventoryItem"
                  ? (items.get(item.sourceReference)?.name ?? t("Inactive item"))
                  : (subs.get(item.sourceReference)?.name ?? t("Sub-recipe"))}
              </td>
              <td>
                {item.quantity}{" "}
                {unitText(
                  item.kind === "InventoryItem"
                    ? items.get(item.sourceReference)?.unitCode
                    : subs.get(item.sourceReference)?.yieldUnit,
                )}
              </td>
              <td>{item.lossPercent}</td>
              <td>
                {item.kind === "InventoryItem"
                  ? "$" + centsToDollarsText(item.unitCostCents ?? "0")
                  : "—"}
              </td>
              <td>{lineAllergens(recipe, index + 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AllergenSummary recipe={recipe} />
      <h3>{t("Kitchen steps")}</h3>
      <ol>
        {recipe.draft.steps.map((step, index, all) => (
          <li key={index}>
            {t("Step {value}: {instruction} — {value2} min, {value3}{value4}", {
              value: index + 1,
              instruction: step.instruction,
              value2: Math.round(step.durationSeconds / 6) / 10,
              value3: stations.get(step.capabilityReference) ?? t("station"),
              value4:
                index > 0 && all[index - 1]?.sequence === step.sequence
                  ? t(" (at the same time as the step before)")
                  : "",
            })}
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
  csrf,
}: {
  readonly view: RecipeEditorView;
  readonly subject: "Recipe" | "Preparation";
  readonly busy: boolean;
  readonly run: (command: RecipeCommand) => void;
  readonly csrf: string | undefined;
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
              <strong>{t("{value} review:", { value: kindText[kind] })}</strong>{" "}
              {review ? (
                <>
                  {t("{decision} by {reviewerLabel} on", {
                    decision: review.decision,
                    reviewerLabel: review.reviewerLabel,
                  })}{" "}
                  <SourceTime instant={review.reviewedAt} />
                  {review.comment ? ` — “${review.comment}”` : ""}
                  {review.current ? "" : t(" (content changed since)")}
                </>
              ) : (
                t("waiting")
              )}
            </li>
          );
        })}
      </ul>
      {view.permissions.mayReview && !isAuthor && !reviewedHere ? (
        <div>
          <label>
            {t("Review comment (required to reject)")}
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
                    {decision === "Approved" ? t("Approve") : t("Reject")}{" "}
                    {kindText[kind].toLowerCase()}
                  </button>
                ))}{" "}
              </span>
            ))}
        </div>
      ) : view.permissions.mayReview &&
        (isAuthor || reviewedHere) &&
        (["Cost", "FoodSafety"] as const).some(
          (kind) => !reviews.some((review) => review.kind === kind),
        ) ? (
        // WP-2423 Q19: the sole operator may give the remaining review(s) alone.
        (() => {
          const kind =
            (["Cost", "FoodSafety"] as const).find(
              (item) => !reviews.some((review) => review.kind === item),
            ) ?? "Cost";
          return (
            <SoleOperatorSelfApproval
              key={kind}
              gate={view.soleOperator}
              csrf={csrf}
              what={t("the {value} of this version", { value: kindText[kind].toLowerCase() })}
              permissionName={t("recipe review")}
              yourPart={
                isAuthor
                  ? "You wrote this version"
                  : `You already gave the ${kindText[kind === "Cost" ? "FoodSafety" : "Cost"].toLowerCase()} review`
              }
              busy={busy}
              actionLabel={t("Approve {value} on my own", { value: kindText[kind].toLowerCase() })}
              summary={
                <p>
                  {t("{name} ({code}) — {value} review{value2}.{value3}", {
                    name: recipe.name,
                    code: recipe.code,
                    value: kindText[kind].toLowerCase(),
                    value2: subject === "Preparation" ? t(" of the kitchen steps") : "",
                    value3: isAuthor
                      ? t(" You wrote this version.")
                      : t(" You gave the other review."),
                  })}
                </p>
              }
              onApprove={() =>
                run({
                  action: "Review",
                  operationReference: newOperationReference(),
                  recipeReference: recipe.recipeReference,
                  versionReference: recipe.versionReference,
                  subject,
                  kind,
                  decision: "Approved",
                  comment: null,
                  approvalMode: "SoleOperator",
                })
              }
            />
          );
        })()
      ) : isAuthor ? (
        <p>{t("You wrote this version; two other reviewers decide.")}</p>
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
    <StatePanel heading={t("Used by SKUs")}>
      {recipe.bindings.length === 0 ? <p>{t("No SKU uses this recipe yet.")}</p> : null}
      <ul>
        {recipe.bindings.map((binding) => (
          <li key={binding.bindingReference}>
            {t("{choices} · {value} · since", {
              choices: skuName(view.choices, binding.skuReference),
              value: binding.storeReference ? t("this Store only") : t("all Stores of the Brand"),
            })}{" "}
            <SourceTime instant={binding.since} />{" "}
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
                {t("Remove Store-specific recipe")}
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
            {t("SKU")}
            <select value={sku} onChange={(event) => setSku(event.currentTarget.value)}>
              <option value="">{t("Choose a SKU")}</option>
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
            {t("Only in this Store (other Stores keep the Brand recipe)")}
          </label>
          <button disabled={busy || !sku}>{t("Use this recipe")}</button>
          <p>
            {t("The SKU's previous recipe in the same scope stops applying at the same moment.")}
          </p>
        </form>
      ) : recipe.lifecycle === "Published" && recipe.yieldUnit !== "EACH" ? (
        <p>{t("Batch recipes are used as sub-recipes, not by SKUs.")}</p>
      ) : null}
    </StatePanel>
  );
}

/** One editor instance per route: a new recipe, a revision of one, or an existing recipe. */
export function RecipeEditorPage(props: {
  readonly client?: RecipeClient;
  /** For the second-factor check of a sole operator's own review. */
  readonly csrf?: string;
}) {
  const params = useParams();
  const [search] = useSearchParams();
  return <RecipeEditor key={`${params.id ?? ""}?${search.toString()}`} {...props} />;
}

function RecipeEditor({
  client = unavailableRecipeClient,
  csrf,
}: {
  readonly client?: RecipeClient;
  readonly csrf?: string;
}) {
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
    <StatePanel heading={t("Not recorded")} tone="error" status>
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
      <AppFrame title={t("New recipe")} description={t("Recipe")}>
        <header className="screen-heading">
          <div>
            <p className="bop-eyebrow">
              {t("Recipe · {value}", { value: base ? t("Revision") : t("New") })}
            </p>
            <h2>{base ? t("Revise {name}", { name: base.name }) : t("New recipe")}</h2>
            <p>
              {base
                ? t(
                    "The published recipe stays in use until this revision is reviewed, published and assigned to its SKUs.",
                  )
                : t(
                    "Save a draft, then two reviewers check cost and food safety before it can be published.",
                  )}
            </p>
          </div>
          <Link to="/app/commerce/recipes">{t("All recipes")}</Link>
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
    <AppFrame title={recipe.name} description={t("Recipe")}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {t("Recipe · {code}{value}", {
              code: recipe.code,
              value:
                recipe.familyRevision > 1
                  ? t(" · revision {familyRevision}", { familyRevision: recipe.familyRevision })
                  : "",
            })}
          </p>
          <h2>{recipe.name}</h2>
          <p>
            {lifecycleText[recipe.lifecycle]} {t("· yield")} {recipe.yieldQuantity}{" "}
            {unitText(recipe.yieldUnit)} {t("· standard cost $")}
            {centsText(recipe.standardCostCents)} {t("· written by")} {recipe.authorLabel}
          </p>
        </div>
        <Link to="/app/commerce/recipes">{t("All recipes")}</Link>
      </header>
      {errorPanel}
      {recipe.family.length > 1 ? (
        <p>
          {t("Revisions:")}{" "}
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
        <StatePanel heading={t("Review and publication")}>
          <p>{t("Saving the draft again starts the reviews over for the new version.")}</p>
          <ReviewPanel
            view={view}
            subject="Recipe"
            busy={busy}
            run={(command) => void run(command)}
            csrf={csrf}
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
              {t("Publish recipe")}
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      {recipe.lifecycle === "Published" ? (
        <StatePanel heading={t("Kitchen instructions")}>
          {recipe.kitchenInstructions === "Published" ? (
            <p>
              {t(
                "Published. Kitchen tickets show these steps for every SKU that uses this recipe.",
              )}
            </p>
          ) : (
            <>
              <p>
                {t(
                  "The kitchen steps of the published version are reviewed once more (cost and food safety) before kitchen tickets can show them.",
                )}
              </p>
              <ReviewPanel
                view={view}
                subject="Preparation"
                busy={busy}
                run={(command) => void run(command)}
                csrf={csrf}
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
                  {t("Publish kitchen instructions")}
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
            {t("Revise this recipe")}
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
          {t("Archive recipe")}
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
