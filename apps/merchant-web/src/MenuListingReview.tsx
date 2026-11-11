import { t } from "./i18n/i18n.js";
import { Link } from "react-router";
import type { MenuBuilderView } from "./store-menu-pages.js";
import { minorToDollars } from "./store-price-pages.js";

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
