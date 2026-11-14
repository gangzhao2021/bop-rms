import { currentLanguage, t } from "./i18n/i18n.js";
import { Link } from "react-router";
import type { MenuBuilderView } from "./store-menu-pages.js";
import { minorToDollars } from "./store-price-pages.js";
import { allergensText } from "./dish-allergens.js";

/** Whether a menu language is the one this person reads the page in. */
const readsIn = (locale: string) =>
  currentLanguage() === "zh-Hans" ? /^zh\b/u.test(locale) : !/^zh\b/u.test(locale);
const languageName = (locale: string) =>
  /^zh\b/u.test(locale)
    ? t("Chinese")
    : /^en\b/u.test(locale)
      ? t("English")
      : t("another language");

/**
 * WP-2423 M72 (v15 2026-11-11 b10): one line per renamed dish — the name in this person's language
 * before → now, else the other language's name before → now with the dish as named here.
 */
export function renameLines(
  renames: NonNullable<MenuBuilderView["dishRenames"]>,
  dishName: (skuReference: string) => string,
): readonly string[] {
  const lines = renames.flatMap((dish) =>
    dish.renamed.map((name) =>
      readsIn(name.locale) && name.from !== "" && name.to !== ""
        ? t("Renamed: {from} → {to}", { from: name.from, to: name.to })
        : name.from === ""
          ? t("{dish}: {language} name added: {to}", {
              dish: dishName(dish.skuReference),
              language: languageName(name.locale),
              to: name.to,
            })
          : name.to === ""
            ? t("{dish}: {language} name taken off ({from})", {
                dish: dishName(dish.skuReference),
                language: languageName(name.locale),
                from: name.from,
              })
            : t("{dish}: {language} name {from} → {to}", {
                dish: dishName(dish.skuReference),
                language: languageName(name.locale),
                from: name.from,
                to: name.to,
              }),
    ),
  );
  // Sizes of one dish share its name: said once.
  return [...new Set(lines)];
}

const money = (minor: string | null) => (minor === null ? null : "$" + minorToDollars(minor));

/**
 * WP-2423 M69/M71: what "List it" will put live, read before anything is written. The prices
 * waiting in the menu's own price draft (from → to, at every Store), whether someone else changed
 * them, the waiting extra (choice) prices, each new dish that goes on sale (or stays hidden) at
 * each other Store of a Brand with several, with its Store and a count, the price changes started on the Prices page (never listed from here), and dishes whose
 * allergens nobody answered (listing waits for them). "List it" here confirms exactly the prices
 * shown: anything saved after the review was read is refused, nothing goes live unseen.
 */
export function MenuListingReview({
  view,
  undeclared,
  busy,
  onList,
  onRebase,
  onShowUndeclared,
  onBack,
}: {
  readonly view: Pick<
    MenuBuilderView,
    | "priceDraft"
    | "priceChangesOnPricesPage"
    | "sellables"
    | "pricePowers"
    | "choicePriceChanges"
    | "otherStores"
    | "dishRenames"
    | "latestRelease"
    | "menu"
    | "allergenChoices"
  >;
  /** Names of dishes on the menu whose allergens are not answered. */
  readonly undeclared: readonly string[];
  readonly busy: boolean;
  readonly onList: () => void;
  readonly onRebase: () => void;
  readonly onShowUndeclared: () => void;
  readonly onBack: () => void;
}) {
  const draft = view.priceDraft ?? null;
  const several = view.pricePowers?.severalStores === true;
  const nameOf = (sku: string) => {
    const found = view.sellables.find((x) => x.skuReference === sku);
    if (found === undefined) return t("a dish");
    const sized = found.sizeName !== "" && found.sizeName !== found.productName;
    return sized ? `${found.productName} — ${found.sizeName}` : found.productName;
  };
  const dishOf = (productReference: string) =>
    view.sellables.find((x) => x.productReference === productReference)?.productName ?? t("a dish");
  const choices = view.choicePriceChanges ?? [];
  const others = view.otherStores ?? null;
  // Every new dish at each other Store that has not decided it, with its Store and a count:
  // nothing goes live there unseen.
  const otherStores = (
    others?.stores ?? [{ storeName: null, notDecided: others?.notDecided ?? [] }]
  ).filter((store) => store.notDecided.length > 0);
  const elsewhere = view.priceChangesOnPricesPage ?? 0;
  const moved = draft?.movedSinceStart === true;
  // Allergens are named here, and the server's own check refuses the listing until they are
  // answered (a recipe at this Store answers them although this page cannot always tell).
  const blocked = moved;
  // WP-2423 M72: names and allergens guests read differently once listed, by dish on this menu.
  const onMenu = new Set(
    view.menu.sections.flatMap((section) => section.items.map((item) => item.skuReference)),
  );
  const renames =
    view.dishRenames === undefined || view.dishRenames === null
      ? []
      : renameLines(
          view.dishRenames.filter((dish) => onMenu.has(dish.skuReference)),
          nameOf,
        );
  const allergenLines = [
    ...new Set(
      view.sellables
        .filter((sku) => onMenu.has(sku.skuReference) && sku.allergens?.changedByRecipe === true)
        .map((sku) =>
          t("{dish}: allergens changed · {allergens}", {
            dish: sku.productName,
            allergens: allergensText(
              sku.allergens ?? { source: "None", declared: [] },
              view.allergenChoices ?? [],
            ),
          }),
        ),
    ),
  ];
  return (
    <section className="one-menu__pending one-menu__review" aria-labelledby="listing-review">
      <h2 id="listing-review">{t("What goes live")}</h2>
      <ul>
        <li>{t("The menu as it is on this page: dishes, sections, photos and descriptions.")}</li>
        {draft === null || draft.prices.length === 0 ? (
          <li>{t("No price changes.")}</li>
        ) : (
          draft.prices.map((price) => (
            <li key={price.skuReference}>
              {price.fromMinor === null
                ? t("{dish}: {to} (new)", {
                    dish: nameOf(price.skuReference),
                    to: money(price.toMinor) ?? "",
                  })
                : t("{dish}: {from} → {to}", {
                    dish: nameOf(price.skuReference),
                    from: money(price.fromMinor) ?? "",
                    to: money(price.toMinor) ?? "",
                  })}
              {several ? " " + t("(every Store)") : null}
            </li>
          ))
        )}
      </ul>
      {view.latestRelease === null ? null : (
        <>
          <h3>{t("Names and allergens")}</h3>
          <ul>
            {renames.map((line) => (
              <li key={line}>{line}</li>
            ))}
            {allergenLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
            {view.dishRenames === null ? (
              <li>
                {t(
                  "Name changes could not be checked just now. The names go live as they are on this page.",
                )}
              </li>
            ) : renames.length === 0 && allergenLines.length === 0 ? (
              <li>{t("No name or allergen changes.")}</li>
            ) : null}
          </ul>
        </>
      )}
      {choices.length > 0 ? (
        <>
          <h3>{t("Extra prices")}</h3>
          <ul>
            {choices.map((choice) => (
              <li key={choice.productReference + choice.optionReference}>
                {choice.fromMinor === null
                  ? t("{dish}, {choice}: +{to} (new)", {
                      dish: dishOf(choice.productReference),
                      choice: choice.optionName || t("a choice"),
                      to: money(choice.toMinor) ?? "",
                    })
                  : t("{dish}, {choice}: +{from} → +{to}", {
                      dish: dishOf(choice.productReference),
                      choice: choice.optionName || t("a choice"),
                      from: money(choice.fromMinor) ?? "",
                      to: money(choice.toMinor) ?? "",
                    })}
                {several ? " " + t("(every Store)") : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {others !== null && otherStores.length > 0 ? (
        <div className="one-menu__note" role="note">
          <p>
            {others.listingOffers
              ? t(
                  "New dishes go on sale at the other Stores once listed. A Store that should not sell one hides it there.",
                )
              : t(
                  "New dishes stay hidden at the other Stores until each Store shows them to guests.",
                )}
          </p>
          <ul>
            {otherStores.map((store, index) => (
              <li key={(store.storeName ?? "") + index}>
                {store.notDecided.length === 1
                  ? t("{store}, 1 dish: {dishes}", {
                      store: store.storeName ?? t("another Store"),
                      dishes: store.notDecided.map(nameOf).join(t(", ")),
                    })
                  : t("{store}, {count} dishes: {dishes}", {
                      store: store.storeName ?? t("another Store"),
                      count: String(store.notDecided.length),
                      dishes: store.notDecided.map(nameOf).join(t(", ")),
                    })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {draft !== null && draft.prices.length > 0 && !draft.startedByViewer ? (
        <p className="one-menu__note">
          {t("Someone else changed these prices. Listing them is your review: check each one.")}
        </p>
      ) : null}
      {elsewhere > 0 ? (
        <>
          <h3>{t("Not included")}</h3>
          <p className="one-menu__note">
            {elsewhere === 1
              ? t(
                  "1 price change started on the Prices page stays there; it does not go live with the menu.",
                )
              : t(
                  "{count} price changes started on the Prices page stay there; they do not go live with the menu.",
                  { count: elsewhere },
                )}{" "}
            <Link to="/app/commerce/pricing">{t("See them")}</Link>
          </p>
        </>
      ) : null}
      {moved ? (
        <p className="one-menu__note" role="alert">
          {t(
            "Another price change went live after these menu prices were changed. Listing them as they are would undo it.",
          )}{" "}
          <button type="button" disabled={busy} onClick={onRebase}>
            {t("Apply my price changes to the prices in use")}
          </button>
        </p>
      ) : null}
      {undeclared.length > 0 ? (
        <p className="one-menu__note" role="alert">
          {t("Answer allergens for {count} first: {dishes}.", {
            count:
              undeclared.length === 1
                ? t("1 dish")
                : t("{count} dishes", { count: undeclared.length }),
            dishes: undeclared.slice(0, 8).join(t(", ")) + (undeclared.length > 8 ? "…" : ""),
          })}{" "}
          <button type="button" onClick={onShowUndeclared}>
            {t("Answer allergens")}
          </button>
        </p>
      ) : null}
      <div className="one-menu__pending-actions">
        <button
          type="button"
          className="one-menu__primary"
          disabled={busy || blocked}
          onClick={onList}
        >
          {t("List it")}
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          {t("Back")}
        </button>
      </div>
    </section>
  );
}
