import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  OptionRecipePageError,
  microText,
  optionRecipeStatus,
  parseOptionRecipeView,
  unavailableOptionRecipeClient,
  type OptionRecipeChangeContent,
  type OptionRecipeChangeKind,
  type OptionRecipeClient,
  type OptionRecipeCommand,
  type OptionRecipeErrorCode,
  type OptionRecipeRow,
  type OptionRecipeStatus,
  type OptionRecipeView,
} from "./store-option-recipes-page.js";

/** WP-2423 slice 4.4: what each option does to a product's recipes, reviewed and published. */
const copy: Record<OptionRecipeErrorCode | "Loading", string> = {
  Loading: "Loading option recipes…",
  PermissionDenied: "You do not have permission for this recipe action at Brand level.",
  NotFound: "That option is no longer on the product. Refresh and check.",
  Conflict: "This changed since you opened the page, or was already decided. Refresh and check.",
  NoRecipe:
    "A size of this product has no published recipe. Publish and bind its recipe under Recipes first.",
  IngredientMissing: "A size's recipe does not use the ingredient to replace or remove.",
  IngredientPresent:
    "A size's recipe already uses the new ingredient. Choose “Add” to use more of it.",
  UnitMismatch:
    "The ingredients are measured differently (for example weight and volume), so the same amount cannot be used.",
  ItemUnavailable: "The new ingredient is not an active stock item.",
  AllergenUndeclared:
    "The new ingredient has no current allergen declaration. Declare it under Allergens first.",
  ReviewRequired:
    "Publishing needs an approved cost review and an approved food-safety review, by two people other than the author.",
  ReviewerNotIndependent: "The person who saved this change cannot review it.",
  Invalid: "The change is not valid. Check the amounts.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Option recipes are unavailable.",
};
const statusText: Record<OptionRecipeStatus, string> = {
  NotSet: "Not set — customers cannot choose it",
  NeedsReview: "Waiting for reviews",
  Rejected: "Rejected — change and save again",
  ReadyToPublish: "Approved — ready to publish",
  Published: "Published",
  NeedsUpdate: "A recipe changed — save again",
};
const kindText: Record<OptionRecipeChangeKind, string> = {
  NoChange: "No change to the recipe",
  Replace: "Replace an ingredient (same amount)",
  Add: "Add an amount of an ingredient per one chosen",
  Remove: "Remove an ingredient",
};
const blank: OptionRecipeChangeContent = {
  kind: "NoChange",
  fromItemReference: null,
  toItemReference: null,
  quantity: null,
  unitCostCents: null,
  lossPercent: "0",
};

export function StoreOptionRecipesPage({
  client = unavailableOptionRecipeClient,
}: {
  readonly client?: OptionRecipeClient;
}) {
  const [state, setState] = useState<
    | { readonly kind: "Loading" | OptionRecipeErrorCode }
    | { readonly kind: "Found"; readonly view: OptionRecipeView }
  >({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<OptionRecipeChangeContent>(blank);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<OptionRecipeCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseOptionRecipeView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OptionRecipePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, generation]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading="Option recipes"
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const item = (reference: string | null) =>
    view.ingredients.find((candidate) => candidate.itemReference === reference);
  const amount = (micro: string | null, reference: string | null) =>
    micro === null ? "" : `${microText(micro)} ${item(reference)?.unitCode.toLowerCase() ?? ""}`;
  const keyOf = (row: OptionRecipeRow) => row.bindingReference + ":" + row.optionReference;
  const summary = (content: OptionRecipeChangeContent) => {
    const from = item(content.fromItemReference)?.name ?? "";
    const to = item(content.toItemReference)?.name ?? "";
    if (content.kind === "NoChange") return "No change to the recipe";
    if (content.kind === "Replace") return `${from} → ${to} (same amount)`;
    if (content.kind === "Remove") return `Without ${from}`;
    return `+ ${content.quantity ?? ""} ${item(content.toItemReference)?.unitCode.toLowerCase() ?? ""} ${to} per one chosen`;
  };
  const send = async (command: OptionRecipeCommand, done: string) => {
    if (!client.command) return;
    const actual = pending !== null && pending.action === command.action ? pending : command;
    setBusy(true);
    setMessage(null);
    setPending(actual);
    try {
      await client.command(actual);
      setPending(null);
      setEditing(null);
      setComment("");
      try {
        setState({ kind: "Found", view: parseOptionRecipeView(await client.load()) });
      } catch {
        reload();
      }
      setMessage({ tone: "neutral", text: done });
    } catch (error) {
      const code = error instanceof OptionRecipePageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      const size =
        error instanceof OptionRecipePageError && error.skuReference !== null
          ? view.options
              .flatMap((row) => row.sizes)
              .find((candidate) => candidate.skuReference === error.skuReference)?.name
          : undefined;
      setMessage({ tone: "error", text: copy[code] + (size ? ` (${size})` : "") });
    } finally {
      setBusy(false);
    }
  };
  const valid =
    draft.kind === "NoChange" ||
    (draft.kind === "Remove" && draft.fromItemReference !== null) ||
    (draft.kind === "Replace" &&
      draft.fromItemReference !== null &&
      draft.toItemReference !== null &&
      draft.fromItemReference !== draft.toItemReference) ||
    (draft.kind === "Add" &&
      draft.toItemReference !== null &&
      /^\d{1,9}(\.\d{1,6})?$/u.test(draft.quantity ?? "") &&
      Number(draft.quantity) > 0);
  const products = [...new Set(view.options.map((row) => row.productName))];
  const editor = (row: OptionRecipeRow) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        void send(
          {
            action: "Save",
            operationReference: newOperationReference(),
            bindingReference: row.bindingReference,
            optionReference: row.optionReference,
            expectedVersion: row.change?.version ?? null,
            change: {
              ...draft,
              quantity: draft.kind === "Add" ? draft.quantity : null,
              unitCostCents:
                draft.kind === "Replace" || draft.kind === "Add"
                  ? draft.unitCostCents === ""
                    ? null
                    : draft.unitCostCents
                  : null,
              lossPercent:
                draft.kind === "Replace" || draft.kind === "Add" ? draft.lossPercent : "0",
              fromItemReference:
                draft.kind === "Replace" || draft.kind === "Remove"
                  ? draft.fromItemReference
                  : null,
              toItemReference:
                draft.kind === "Replace" || draft.kind === "Add" ? draft.toItemReference : null,
            },
          },
          "Saved. Two reviewers (cost and food safety) can now approve it.",
        );
      }}
    >
      <fieldset disabled={busy}>
        <legend>{`${row.setName} · ${row.optionName} on ${row.productName}`}</legend>
        <label>
          What choosing it does
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft({ ...blank, kind: event.target.value as OptionRecipeChangeKind })
            }
          >
            {(Object.keys(kindText) as OptionRecipeChangeKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kindText[kind]}
              </option>
            ))}
          </select>
        </label>
        {draft.kind === "Replace" || draft.kind === "Remove" ? (
          <label>
            {draft.kind === "Replace" ? "Ingredient to replace" : "Ingredient to remove"}
            <select
              value={draft.fromItemReference ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, fromItemReference: event.target.value || null })
              }
            >
              <option value="">Choose…</option>
              {view.ingredients.map((choice) => (
                <option key={choice.itemReference} value={choice.itemReference}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {draft.kind === "Replace" || draft.kind === "Add" ? (
          <>
            <label>
              {draft.kind === "Replace" ? "Replace with" : "Ingredient to add"}
              <select
                value={draft.toItemReference ?? ""}
                onChange={(event) => {
                  const chosen = item(event.target.value);
                  setDraft({
                    ...draft,
                    toItemReference: event.target.value || null,
                    unitCostCents: chosen?.latestUnitCostCents ?? draft.unitCostCents,
                  });
                }}
              >
                <option value="">Choose…</option>
                {view.ingredients.map((choice) => (
                  <option key={choice.itemReference} value={choice.itemReference}>
                    {choice.name}
                    {choice.declared ? "" : " (no allergen declaration)"}
                  </option>
                ))}
              </select>
            </label>
            {draft.kind === "Add" ? (
              <label>
                {`Amount per one chosen (${item(draft.toItemReference)?.unitCode.toLowerCase() ?? "unit"})`}
                <input
                  inputMode="decimal"
                  value={draft.quantity ?? ""}
                  onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
                />
              </label>
            ) : null}
            <label>
              {`Cost (cents per ${item(draft.toItemReference)?.unitCode.toLowerCase() ?? "unit"}; empty if unknown)`}
              <input
                inputMode="decimal"
                value={draft.unitCostCents ?? ""}
                onChange={(event) => setDraft({ ...draft, unitCostCents: event.target.value })}
              />
            </label>
          </>
        ) : null}
        <p>
          Saving applies this to every size's recipe
          {row.quantities.length > 1 ? ` and each quantity up to ${row.quantities.length}` : ""};
          reviewers see the result for each size.
        </p>
        <button type="submit" disabled={!valid || busy}>
          {pending?.action === "Save" ? "Retry" : "Save change"}
        </button>
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </fieldset>
    </form>
  );
  const actions = (row: OptionRecipeRow) => {
    const change = row.change;
    const status = optionRecipeStatus(row);
    const buttons = [];
    if (view.permissions.mayEdit && editing !== keyOf(row))
      buttons.push(
        <button
          key="edit"
          type="button"
          disabled={busy}
          onClick={() => {
            setEditing(keyOf(row));
            setDraft(change?.content ?? blank);
          }}
        >
          {change === null ? "Set" : "Change"}
        </button>,
      );
    if (change !== null && !change.published && !change.byViewer && view.permissions.mayReview)
      for (const kind of ["Cost", "FoodSafety"] as const)
        if (!change.reviews.some((review) => review.kind === kind))
          buttons.push(
            <button
              key={"approve-" + kind}
              type="button"
              disabled={busy || change.reviews.some((review) => review.byViewer)}
              onClick={() =>
                void send(
                  {
                    action: "Review",
                    operationReference: newOperationReference(),
                    changeVersionReference: change.changeVersionReference,
                    kind,
                    decision: "Approved",
                    comment: null,
                  },
                  kind === "Cost" ? "Cost review recorded." : "Food-safety review recorded.",
                )
              }
            >
              {kind === "Cost" ? "Approve cost" : "Approve food safety"}
            </button>,
          );
    if (status === "ReadyToPublish" && view.permissions.mayPublish && change !== null)
      buttons.push(
        <button
          key="publish"
          type="button"
          disabled={busy}
          onClick={() =>
            void send(
              {
                action: "Publish",
                operationReference: newOperationReference(),
                changeVersionReference: change.changeVersionReference,
              },
              "Published. The next menu publication offers this option with its recipe.",
            )
          }
        >
          Publish
        </button>,
      );
    return buttons;
  };
  const rejectable = view.options.filter(
    (row) =>
      row.change !== null &&
      !row.change.published &&
      !row.change.byViewer &&
      view.permissions.mayReview &&
      row.change.reviews.length < 2,
  );
  return (
    <AppFrame title="Option recipes" description="RECIPE-OPTION-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">RECIPE-OPTION-LIST · Brand</p>
          <h2>Option recipes</h2>
          <p>
            What choosing an option does to each size's recipe — for stock, cost, kitchen and the
            allergens customers see. A change needs a cost review and a food-safety review by two
            people other than its author, then publication. Source as of{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/option-sets">Options</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not done" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {view.options.length === 0 ? (
        <StatePanel heading="No options on products" status>
          <p>Add option sets to products on the product page first.</p>
        </StatePanel>
      ) : null}
      {products.map((product) => (
        <section key={product} className="detail-section">
          <h3>{product}</h3>
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Recipe change</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {view.options
                .filter((row) => row.productName === product)
                .map((row) => (
                  <tr key={keyOf(row)}>
                    <td>
                      {row.setName} · {row.optionName}
                      {row.offered ? "" : " (not offered)"}
                    </td>
                    <td data-label="Recipe change">
                      {row.change === null ? "—" : summary(row.change.content)}
                      {row.change !== null && row.change.lines.length > 0 ? (
                        <ul aria-label={`Result per size for ${row.optionName}`}>
                          {row.change.lines.map((line) => (
                            <li key={line.skuReference + ":" + line.quantity}>
                              {row.sizes.find((size) => size.skuReference === line.skuReference)
                                ?.name ?? ""}
                              {row.quantities.length > 1 ? ` ×${line.quantity}` : ""}:{" "}
                              {line.changes.length === 0
                                ? "as recipe"
                                : line.changes
                                    .map((change) =>
                                      change.fromItemReference === change.toItemReference
                                        ? `${item(change.toItemReference)?.name ?? ""} ${amount(change.fromQuantityMicrounits, change.fromItemReference)} → ${amount(change.toQuantityMicrounits, change.toItemReference)}`
                                        : [
                                            change.fromItemReference === null
                                              ? ""
                                              : `${item(change.fromItemReference)?.name ?? ""} ${amount(change.fromQuantityMicrounits, change.fromItemReference)}`,
                                            change.toItemReference === null
                                              ? "removed"
                                              : `${item(change.toItemReference)?.name ?? ""} ${amount(change.toQuantityMicrounits, change.toItemReference)}`,
                                          ]
                                            .filter(Boolean)
                                            .join(" → "),
                                    )
                                    .join("; ")}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td data-label="Status">
                      {statusText[optionRecipeStatus(row)]}
                      {row.change !== null && row.change.reviews.length > 0 ? (
                        <ul aria-label={`Reviews for ${row.optionName}`}>
                          {row.change.reviews.map((review) => (
                            <li key={review.kind}>
                              {review.kind === "Cost" ? "Cost" : "Food safety"}: {review.decision}
                              {review.comment ? ` — ${review.comment}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td>{editing === keyOf(row) ? editor(row) : actions(row)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
      {rejectable.length > 0 ? (
        <section className="detail-section" aria-labelledby="reject-change">
          <h3 id="reject-change">Reject a change</h3>
          <p>Tell the author what to fix; they save a corrected change for review.</p>
          <label>
            Reason
            <input
              value={comment}
              maxLength={500}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <ul>
            {rejectable.map((row) => (
              <li key={keyOf(row)}>
                {row.productName} · {row.setName} · {row.optionName}{" "}
                {(["Cost", "FoodSafety"] as const)
                  .filter((kind) => !row.change?.reviews.some((review) => review.kind === kind))
                  .map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={busy || comment.trim() === ""}
                      onClick={() =>
                        row.change &&
                        void send(
                          {
                            action: "Review",
                            operationReference: newOperationReference(),
                            changeVersionReference: row.change.changeVersionReference,
                            kind,
                            decision: "Rejected",
                            comment: comment.trim(),
                          },
                          "Rejection recorded.",
                        )
                      }
                    >
                      {kind === "Cost" ? "Reject cost" : "Reject food safety"}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppFrame>
  );
}
