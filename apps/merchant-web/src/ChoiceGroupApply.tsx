import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AllergenFields, type AllergenAnswer } from "./dish-allergens.js";
import {
  additionsFor,
  appliedDishCommand,
  choicesChangedHere,
  dishGroupExtras,
  hasEveryChoice,
  mergedDeclaration,
  planChangesNothing,
  planDishApply,
  runDishApply,
  summarisePriceChanges,
  type ApplySection,
  type DishApplyPlan,
} from "./dish-choice-apply.js";
import { dishEditorSource } from "./dish-editor-source.js";
import { countOf, t } from "./i18n/i18n.js";
import type { MenuDish } from "./one-store-menu.js";
import { newOperationReference } from "./operation-reference.js";
import type { ProductOptionSetChoice } from "./product-pages.js";
import { menuErrorText } from "./StoreMenuPages.js";
import {
  MenuPageError,
  type AllergenChoice,
  type AllergenClassification,
  type MenuClient,
  type SaveDishCommand,
} from "./store-menu-pages.js";

interface AllergenAnswerForChoice {
  readonly contains: boolean;
  readonly values: ReadonlyMap<string, AllergenAnswer>;
}
const dishLabel = (dish: MenuDish) => (dish.nameZh ? `${dish.name} ${dish.nameZh}` : dish.name);
const names = (dishes: readonly MenuDish[]) => dishes.map(dishLabel).join(t(", "));

/**
 * WP-2423 item 3 F: a new topping or a new extra reaches many dishes. By default a run adds what each
 * chosen dish is missing, at this dish's extra, and touches nothing else. Changing extras a dish
 * already has is a separate choice: every line is shown, and the owner confirms the money. The
 * browser sends one dish at a time, so progress shows and a run that stopped carries on.
 */
export function ChoiceGroupApply({
  menuReference,
  group,
  extras,
  read,
  sections,
  allergenChoices,
  client,
  thisDishName,
  thisDishReady,
  saveThisDish,
  onRunning,
  onFinished,
  onClose,
}: {
  readonly menuReference: string;
  readonly group: ProductOptionSetChoice;
  /** This dish's ticked choices of the group (dollars), as the form says now. */
  readonly extras: ReadonlyMap<string, string>;
  /** The same as read, before any change here. */
  readonly read: ReadonlyMap<string, string> | undefined;
  readonly sections: readonly ApplySection[];
  readonly allergenChoices: readonly AllergenChoice[];
  readonly client: MenuClient;
  readonly thisDishName: string;
  /** The form can be saved: the run saves this dish first. */
  readonly thisDishReady: boolean;
  /** Saves the dish on screen; false when there was nothing to save. */
  readonly saveThisDish: () => Promise<boolean>;
  readonly onRunning: (running: boolean) => void;
  readonly onFinished: (message: string) => void;
  readonly onClose: () => void;
}) {
  const [has, setHas] = useState<ReadonlyMap<string, ReadonlyMap<string, string>> | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [changeExisting, setChangeExisting] = useState(false);
  const [spared, setSpared] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, AllergenAnswerForChoice>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  // Across "Try again": each stopped dish's command, the dishes done, and this dish once saved.
  const memory = useRef(new Map<string, SaveDishCommand>());
  const outcome = useRef({ applied: [] as MenuDish[], waiting: [] as MenuDish[] });
  const thisDish = useRef({ done: false, saved: false });
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    if (client.loadChoicePrices === undefined) return;
    let active = true;
    void client
      .loadChoicePrices()
      .then((prices) => {
        if (!active) return;
        setHas(dishGroupExtras(prices, group.optionSetReference));
        setReadFailed(false);
      })
      .catch(() => {
        if (active) setReadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, group.optionSetReference, readAgain]);
  const changedHere = useMemo(() => choicesChangedHere(extras, read), [extras, read]);
  const allDishes = useMemo(() => sections.flatMap((section) => section.dishes), [sections]);
  const planOf = (dish: MenuDish, change: boolean): DishApplyPlan =>
    planDishApply({
      group,
      extras,
      has: has?.get(dish.productReference as string),
      changeExisting: change,
      changedHere,
    });
  const chosenDishes = allDishes.filter((dish) => selected.has(dish.productReference as string));
  const plans = chosenDishes.map((dish) => ({
    dish,
    plan: planOf(dish, changeExisting && !spared.has(dish.productReference as string)),
  }));
  const toRun = plans.filter((entry) => !planChangesNothing(entry.plan));
  // Asked once per choice being added, of the dishes chosen now, in the group's order.
  const addedChoices = new Map(
    plans.flatMap((entry) => entry.plan.adds).map((add) => [add.optionReference, add]),
  );
  const adding = group.options.flatMap((option) => {
    const add = addedChoices.get(option.optionReference);
    return add === undefined ? [] : [add];
  });
  const asksAllergens = allergenChoices.length > 0;
  const answered = adding.every((add) => {
    if (!asksAllergens) return true;
    const answer = answers.get(add.optionReference);
    return (
      answer !== undefined &&
      (!answer.contains || [...answer.values.values()].some((value) => value !== "None"))
    );
  });
  const answerMap = useMemo(
    () =>
      new Map(
        [...answers]
          .filter(([, answer]) => answer.contains)
          .map(([option, answer]) => [
            option,
            new Map(
              [...answer.values].filter(
                (entry): entry is [string, AllergenClassification] => entry[1] !== "None",
              ),
            ),
          ]),
      ),
    [answers],
  );
  // Every line a run could change, so a dish left out can be put back.
  const changeLines = changeExisting
    ? chosenDishes.flatMap((dish) => {
        const { changes } = planOf(dish, true);
        return changes.length === 0 ? [] : [{ dish, changes }];
      })
    : [];
  const priceChanges = summarisePriceChanges(toRun.map((entry) => entry.plan));
  const changesPrices = priceChanges.length > 0;
  const addsAllergens = answerMap.size > 0;
  const recipeDishes = addsAllergens
    ? toRun.filter((e) => e.dish.allergens.source === "Recipe").map((e) => e.dish)
    : [];
  const canStart = !running && toRun.length > 0 && answered && thisDishReady;
  const run = async () => {
    setConfirming(false);
    setStopped(null);
    setRunning(true);
    onRunning(true);
    try {
      if (!thisDish.current.done) {
        setProgress({ done: 0, total: toRun.length + 1 });
        thisDish.current.saved = await saveThisDish();
        thisDish.current.done = true;
      }
    } catch (error) {
      setStopped(stoppedText(thisDishName, error));
      setRunning(false);
      onRunning(false);
      return;
    }
    const left = toRun.filter(
      (entry) =>
        !outcome.current.applied.includes(entry.dish) &&
        !outcome.current.waiting.includes(entry.dish),
    );
    const result = await runDishApply({
      dishes: left.map((entry) => entry.dish),
      memory: memory.current,
      counted:
        (thisDish.current.saved ? 1 : 0) +
        outcome.current.applied.length +
        outcome.current.waiting.length,
      stillOpen: () => open.current,
      load: async (productReference) => {
        if (client.loadDish === undefined) throw new MenuPageError("Unavailable");
        return dishEditorSource(productReference, await client.loadDish(productReference));
      },
      commandFor: (dish, source) => {
        const productReference = dish.productReference as string;
        const plan = planDishApply({
          group,
          extras,
          has: source.chosen.get(group.optionSetReference),
          changeExisting: changeExisting && !spared.has(productReference),
          changedHere,
        });
        return appliedDishCommand({
          menuReference,
          productReference,
          operationReference: newOperationReference(),
          source,
          optionSetReference: group.optionSetReference,
          plan,
          allergens: mergedDeclaration(dish.allergens, additionsFor(plan, answerMap)),
        });
      },
      save: async (command) => {
        if (client.oneStore === undefined) throw new MenuPageError("Unavailable");
        return client.oneStore(command);
      },
      onProgress: (done, total) => setProgress({ done, total }),
    });
    outcome.current.applied.push(...result.applied);
    outcome.current.waiting.push(...result.waiting);
    setRunning(false);
    onRunning(false);
    if (result.failed !== null) {
      setStopped(stoppedText(dishLabel(result.failed.dish), result.failed.error));
      return;
    }
    if (!open.current) return;
    const applied = outcome.current.applied.length + (thisDish.current.saved ? 1 : 0);
    onFinished(
      [
        t("Applied to {dishes}. Guests see it when the menu is listed.", {
          dishes: countOf(applied, "dish"),
        }),
        outcome.current.waiting.length > 0
          ? t("Still waiting for allergens: {items}.", { items: names(outcome.current.waiting) })
          : "",
        recipeDishes.length > 0
          ? t("Allergens come from a recipe, so they did not change: {items}.", {
              items: names(recipeDishes),
            })
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  };
  const toggle = (references: readonly string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const reference of references)
        if (on) next.add(reference);
        else next.delete(reference);
      return next;
    });
  const label = t("Use {group} on other dishes", { group: group.name });
  return (
    <div className="dish-editor__apply" role="group" aria-label={label}>
      <p className="dish-editor__note">
        {t("Adds what each dish is missing, at this dish's extra. Nothing else on it changes.")}{" "}
        {t("Dishes with sizes are changed on the Products page.")}{" "}
        <Link to="/app/commerce/products">{t("Open products")}</Link>
      </p>
      {readFailed ? (
        <p role="alert">
          {t("The dishes could not be read. Check the connection and try again.")}{" "}
          <button type="button" onClick={() => setReadAgain((value) => value + 1)}>
            {t("Read again")}
          </button>
        </p>
      ) : has === null ? (
        <p role="status">{t("Reading the dishes…")}</p>
      ) : (
        <>
          {sections.length === 0 ? (
            <p className="dish-editor__note">{t("No other dish can take it.")}</p>
          ) : null}
          {sections.map((section) => {
            const references = section.dishes.map((dish) => dish.productReference as string);
            return (
              <fieldset key={section.code} disabled={running}>
                <legend>
                  {section.nameZh ? `${section.name} ${section.nameZh}` : section.name}
                </legend>
                <label className="dish-editor__confirm">
                  <input
                    type="checkbox"
                    checked={references.every((reference) => selected.has(reference))}
                    onChange={(event) => toggle(references, event.target.checked)}
                  />
                  {t("All in this section")}
                </label>
                <ul className="dish-editor__apply-dishes">
                  {section.dishes.map((dish) => {
                    const reference = dish.productReference as string;
                    return (
                      <li key={reference}>
                        <label className="dish-editor__confirm">
                          <input
                            type="checkbox"
                            checked={selected.has(reference)}
                            onChange={(event) => toggle([reference], event.target.checked)}
                          />
                          {dishLabel(dish)}
                        </label>
                        {hasEveryChoice(extras, has.get(reference)) ? (
                          <span className="dish-editor__note">{t("has it")}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}
          {asksAllergens
            ? adding.map((add) => {
                const answer = answers.get(add.optionReference);
                const set = (next: AllergenAnswerForChoice) =>
                  setAnswers((current) => new Map(current).set(add.optionReference, next));
                return (
                  <fieldset key={add.optionReference} disabled={running}>
                    <legend>
                      {t("Does {choice} contain anything on your allergen list?", {
                        choice: add.name,
                      })}
                    </legend>
                    <div className="dish-editor__kind">
                      <label>
                        <input
                          type="radio"
                          name={`apply-allergen-${add.optionReference}`}
                          checked={answer?.contains === false}
                          onChange={() => set({ contains: false, values: new Map() })}
                        />
                        {t("No")}
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`apply-allergen-${add.optionReference}`}
                          checked={answer?.contains === true}
                          onChange={() =>
                            set({ contains: true, values: answer?.values ?? new Map() })
                          }
                        />
                        {t("Yes")}
                      </label>
                    </div>
                    {answer?.contains === false ? (
                      <p className="dish-editor__note">
                        {t("{choice} adds nothing: these dishes' allergens do not change.", {
                          choice: add.name,
                        })}
                      </p>
                    ) : null}
                    {answer?.contains === true ? (
                      <>
                        <p className="dish-editor__note">
                          {t(
                            "Each dish that declares its allergens gains these and keeps what it has.",
                          )}
                        </p>
                        <AllergenFields
                          fieldKey={`apply-${add.optionReference}`}
                          choices={allergenChoices}
                          values={answer.values}
                          onChange={(allergen, next) =>
                            set({
                              contains: true,
                              values: new Map(answer.values).set(allergen, next),
                            })
                          }
                        />
                      </>
                    ) : null}
                  </fieldset>
                );
              })
            : null}
          {sections.length > 0 ? (
            <label className="dish-editor__confirm">
              <input
                type="checkbox"
                checked={changeExisting}
                disabled={running}
                onChange={(event) => setChangeExisting(event.target.checked)}
              />
              {changedHere.size > 0
                ? t("Also change this extra on dishes that already have it")
                : t("Also change existing extras")}
            </label>
          ) : null}
          {changeExisting ? (
            changeLines.length === 0 ? (
              <p className="dish-editor__note">
                {t("The dishes chosen already have these extras.")}
              </p>
            ) : (
              <ul className="dish-editor__apply-dishes">
                {changeLines.map(({ dish, changes }) => {
                  const reference = dish.productReference as string;
                  return (
                    <li key={reference}>
                      <label className="dish-editor__confirm">
                        <input
                          type="checkbox"
                          checked={!spared.has(reference)}
                          disabled={running}
                          onChange={(event) =>
                            setSpared((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.delete(reference);
                              else next.add(reference);
                              return next;
                            })
                          }
                        />
                        <span>
                          {dishLabel(dish)}:{" "}
                          {changes
                            .map((change) =>
                              t("{choice} {from} to {to}", {
                                choice: change.name,
                                from: `$${change.from}`,
                                to: `$${change.to}`,
                              }),
                            )
                            .join(t(", "))}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
          {recipeDishes.length > 0 ? (
            <p className="dish-editor__note">
              {t("Allergens come from a recipe, so they will not change: {items}.", {
                items: names(recipeDishes),
              })}
            </p>
          ) : null}
          {thisDishReady ? null : (
            <p className="dish-editor__note">
              {t("Finish this dish first: its name, price and extras are saved before the run.")}
            </p>
          )}
          {selected.size > 0 && toRun.length === 0 ? (
            <p className="dish-editor__note">{t("The dishes chosen already have it.")}</p>
          ) : null}
          {confirming ? (
            <div role="alert">
              <p>
                {t(
                  "This changes the extra price on {dishes}: {lines}. Guests see it when the menu is listed.",
                  {
                    dishes: countOf(
                      toRun.filter((entry) => entry.plan.changes.length > 0).length,
                      "dish",
                    ),
                    lines: priceChanges
                      .map((line) =>
                        t("{choice} {from} to {to}", {
                          choice: line.choice,
                          from: `$${line.from}`,
                          to: `$${line.to}`,
                        }),
                      )
                      .join(t(", ")),
                  },
                )}
              </p>
              <div className="dish-editor__actions">
                <button type="button" className="one-menu__primary" onClick={() => void run()}>
                  {t("Change these prices")}
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  {t("Go back")}
                </button>
              </div>
            </div>
          ) : (
            <div className="dish-editor__actions">
              <button
                type="button"
                className="one-menu__primary"
                disabled={!canStart}
                onClick={() => {
                  if (changesPrices) setConfirming(true);
                  else void run();
                }}
              >
                {stopped !== null
                  ? t("Try again")
                  : t("Apply to {dishes}", { dishes: countOf(toRun.length, "dish") })}
              </button>
              <button type="button" disabled={running} onClick={onClose}>
                {t("Not now")}
              </button>
            </div>
          )}
        </>
      )}
      {progress !== null && running ? (
        <p role="status">
          {t("Applied to {done} of {total}. Keep this screen on.", {
            done: progress.done,
            total: progress.total,
          })}
        </p>
      ) : null}
      {stopped !== null ? (
        <p className="dish-editor__problem" role="alert">
          {stopped}
        </p>
      ) : null}
    </div>
  );
}

function stoppedText(item: string, error: unknown): string {
  return t("Stopped at {item}. {reason} What was applied stays; try again to carry on.", {
    item,
    reason:
      error instanceof MenuPageError
        ? menuErrorText[error.code]
        : t("That didn't go through. Read the menu again and retry."),
  });
}
